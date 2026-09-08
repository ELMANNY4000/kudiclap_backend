/**
 * controllers/withdrawalController.js
 *
 * Production-grade creator payout processing — powered by Payaza Transfers.
 *
 * ── Withdrawal flow ────────────────────────────────────────────────────────────
 *
 *   1. Creator submits: { creatorId, amount, pin }
 *   2. Validate input + verify PIN (bcrypt compare against stored hash)
 *   3. Calculate commission (from Firestore commissions collection)
 *   4. Check walletBalance >= amount + commission
 *   5. Atomically deduct wallet + create withdrawal doc (status: pending)
 *   6. Fetch Payaza account reference
 *   7. Call Payaza Transfer API (nuban for Nigerian bank accounts)
 *   8. On Payaza failure: reverse deduction, mark withdrawal failed
 *   9. Final status via transfer.success / transfer.failed webhook
 *
 * ── PIN requirement ───────────────────────────────────────────────────────────
 *   Every withdrawal requires the creator's 4-digit PIN (set via /api/auth/set-pin).
 *   This is separate from their login password — it is an application-level
 *   authorization check stored as a bcrypt hash in Firestore.
 *
 * ── Commission deduction ─────────────────────────────────────────────────────
 *   Commission is fetched from the commissions Firestore collection.
 *   The commission amount is deducted from the wallet in addition to the
 *   withdrawal amount. If no commission is configured, none is deducted.
 *
 * Exported functions:
 *   - requestWithdrawal      → POST /api/withdrawals
 *   - getCreatorWithdrawals  → GET  /api/withdrawals/:creatorId
 *   - getWithdrawalStatus    → GET  /api/withdrawals/status/:withdrawalId
 */

const bcrypt = require('bcrypt');
const payaza = require('../config/payaza');
const { db } = require('../config/firebase');
const { validateWithdrawal } = require('../utils/validation');
const { calculateCommission } = require('../services/commissionService');

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper — fetch our Payaza account reference
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches KudiClap's Payaza account reference for NGN.
 *
 * The payazaAccountReference is required in every transfer request — it tells
 * Payaza which of our wallets to debit. This changes per currency, so we
 * always fetch it fresh rather than hardcoding it.
 *
 * @returns {Promise<string>} The payazaAccountReference for NGN
 * @throws If the API call fails or the NGN account is not found
 */
const getPayazaAccountReference = async () => {
  const response = await payaza.get('/payaza-account/api/v1/account/details');

  // Response contains an array of currency accounts — find NGN
  const accounts = response.data || response;
  const ngnAccount = Array.isArray(accounts)
    ? accounts.find((acc) => acc.currency === 'NGN' || acc.currency_code === 'NGN')
    : accounts;

  if (!ngnAccount || !ngnAccount.payazaAccountReference) {
    throw new Error('Could not retrieve NGN Payaza account reference. Check your dashboard.');
  }

  return ngnAccount.payazaAccountReference;
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/withdrawals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Processes a withdrawal request — sends real money to the creator's bank account.
 *
 * Steps:
 *   1. Validate input (creatorId, amount — minimum ₦500)
 *   2. Ownership check — creator can only withdraw from their own wallet
 *   3. Load creator, check balance
 *   4. Atomically deduct walletBalance + create withdrawal doc (status: pending)
 *   5. Fetch our Payaza account reference
 *   6. Call Payaza Transfer API to initiate the payout
 *   7. Update withdrawal doc with Payaza's transfer reference
 *   8. If Payaza fails, reverse the deduction immediately
 *   9. Final status comes via transfer.success / transfer.failed webhook
 *
 * @route  POST /api/withdrawals
 * @access Private — protect middleware required
 */
const requestWithdrawal = async (req, res, next) => {
  try {
    // ── Validate request body ─────────────────────────────────────────────────
    const { error, value } = validateWithdrawal(req.body);
    if (error) {
      return res.status(400).json({ success: false, error: error.details[0].message });
    }

    const { creatorId, amount, pin } = value;

    // ── Ownership check ───────────────────────────────────────────────────────
    if (req.user.uid !== creatorId) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden. You can only withdraw from your own account.',
      });
    }

    // ── Fetch creator profile ─────────────────────────────────────────────────
    const creatorRef = db.collection('creators').doc(creatorId);
    const creatorDoc = await creatorRef.get();

    if (!creatorDoc.exists) {
      return res.status(404).json({ success: false, error: 'Creator not found.' });
    }

    const creatorData = creatorDoc.data();

    // ── Verify PIN ────────────────────────────────────────────────────────────
    // PIN is required for every withdrawal — it is separate from the login password
    if (!creatorData.pin) {
      return res.status(400).json({
        success: false,
        error: 'No withdrawal PIN set. Please set your PIN at /api/auth/set-pin first.',
      });
    }

    const pinValid = await bcrypt.compare(pin.toString(), creatorData.pin);
    if (!pinValid) {
      return res.status(400).json({ success: false, error: 'Invalid PIN.' });
    }

    // ── Check bank account details are set ───────────────────────────────────
    if (!creatorData.bankAccountNumber || !creatorData.bankCode) {
      return res.status(400).json({
        success: false,
        error: 'No bank account on file. Please add your bank account at PUT /api/creators/:id/bank.',
      });
    }

    // ── Calculate commission ──────────────────────────────────────────────────
    const { commission, totalDeduction, breakdown } = await calculateCommission(amount, 'withdraw');

    // ── Pre-check balance (including commission) ──────────────────────────────
    if (creatorData.walletBalance < totalDeduction) {
      return res.status(400).json({
        success: false,
        error: `Insufficient balance. Available: ₦${creatorData.walletBalance.toLocaleString()}. Required (inc. fees): ₦${totalDeduction.toLocaleString()}`,
      });
    }

    // ── Generate a unique Payaza transfer reference ───────────────────────────
    // Payaza requires a unique transaction_reference per transfer.
    // We use the withdrawal doc ID so we can match webhook events back to it.
    const withdrawalRef = db.collection('withdrawals').doc();
    const withdrawalId = withdrawalRef.id;
    const payazaReference = `kc-wd-${withdrawalId.substring(0, 10)}-${Date.now().toString().slice(-4)}`;

    // ── Atomic Firestore: deduct balance + record withdrawal ──────────────────
    let newWalletBalance;

    try {
      await db.runTransaction(async (firestoreTx) => {
        const freshDoc = await firestoreTx.get(creatorRef);
        const freshData = freshDoc.data();

        // Re-check inside the transaction — balance may have changed
        if (amount > freshData.walletBalance) {
          throw Object.assign(
            new Error(`Insufficient balance. Available: ₦${freshData.walletBalance.toLocaleString()}`),
            { statusCode: 400 }
          );
        }

        newWalletBalance = freshData.walletBalance - amount;

        // Deduct from wallet (this is the race-condition lock)
        firestoreTx.update(creatorRef, {
          walletBalance: newWalletBalance,
          updatedAt: new Date(),
        });

        // Record the withdrawal document with pending status
        firestoreTx.set(withdrawalRef, {
          id: withdrawalId,
          creatorId,
          amount,
          commission,
          totalDeduction,
          commissionBreakdown: breakdown,
          bankAccountNumber: creatorData.bankAccountNumber,
          bankCode: creatorData.bankCode,
          bankName: creatorData.bankName || '',
          accountName: creatorData.bankAccountName || creatorData.name,
          status: 'pending',            // Updated to completed/failed via webhook
          payazaReference,              // Our unique ref — used to match webhook events
          payazaTransferId: null,       // Set after Payaza responds
          timestamp: new Date(),
          updatedAt: new Date(),
        });
      });
    } catch (txError) {
      if (txError.statusCode === 400) {
        return res.status(400).json({ success: false, error: txError.message });
      }
      throw txError;
    }

    // ── Fetch our Payaza account reference ────────────────────────────────────
    let payazaAccountReference;
    try {
      payazaAccountReference = await getPayazaAccountReference();
    } catch (accError) {
      // Reverse the deduction — can't proceed without the account reference
      await db.runTransaction(async (firestoreTx) => {
        const freshDoc = await firestoreTx.get(creatorRef);
        firestoreTx.update(creatorRef, {
          walletBalance: freshDoc.data().walletBalance + totalDeduction, // restore amount + commission
          updatedAt: new Date(),
        });
        firestoreTx.update(withdrawalRef, {
          status: 'failed',
          failureReason: accError.message,
          updatedAt: new Date(),
        });
      });

      return res.status(502).json({
        success: false,
        error: 'Could not connect to payment gateway. Your balance has been restored. Please try again.',
      });
    }

    // ── Call Payaza Transfer API ──────────────────────────────────────────────
    // transaction_type: "nuban" = Nigerian bank account (NUBAN standard)
    // All NGN transfers use nuban — regardless of whether it's a traditional
    // bank, OPay, PalmPay, or Kuda (they all have NUBAN account numbers).
    const transferPayload = {
      transaction_type: 'nuban',
      service_payload: {
        payout_amount: amount,
        transaction_pin: process.env.PAYAZA_TRANSACTION_PIN, // Set in dashboard + .env
        account_reference: payazaAccountReference,           // Our Payaza wallet ref
        currency: 'NGN',
        country: 'NGA',
      },
      payout_beneficiaries: [
        {
          credit_amount: amount,
          account_number: creatorData.bankAccountNumber,  // Creator's NUBAN account
          account_name: creatorData.bankAccountName || creatorData.name,
          bank_code: creatorData.bankCode,                // e.g. "044" for Access Bank
          transaction_reference: payazaReference,         // Our unique ref
          narration: `KudiClap payout to ${creatorData.name}`,
          sender: {
            sender_name: 'KudiClap',
            sender_phone_number: '08000000000', // KudiClap's registered business number
            sender_address: 'Nigeria',
          },
        },
      ],
    };

    let transferResponse;
    try {
      transferResponse = await payaza.post('/api/v1/transfers/initiate-transfer', transferPayload);
    } catch (payazaError) {
      // ── Payaza rejected the transfer — reverse the wallet deduction ──────────
      console.error(`[Withdrawal] Payaza Transfer error for ${withdrawalId}:`, payazaError.response?.data || payazaError.message);

      await db.runTransaction(async (firestoreTx) => {
        const freshDoc = await firestoreTx.get(creatorRef);
        firestoreTx.update(creatorRef, {
          walletBalance: freshDoc.data().walletBalance + totalDeduction,
          updatedAt: new Date(),
        });
        firestoreTx.update(withdrawalRef, {
          status: 'failed',
          failureReason: payazaError.response?.data?.message || payazaError.message,
          updatedAt: new Date(),
        });
      });

      return res.status(502).json({
        success: false,
        error: 'Withdrawal could not be processed. Your balance has been restored. Please try again.',
      });
    }

    // ── Payaza accepted the transfer ──────────────────────────────────────────
    // The transfer is now queued — final confirmation comes via webhook.
    const payazaTransferId = transferResponse?.data?.id || transferResponse?.transfer_id;

    await withdrawalRef.update({
      payazaTransferId: payazaTransferId || null,
      updatedAt: new Date(),
    });

    console.log(`[Withdrawal] Initiated: creatorId=${creatorId}, ₦${amount}, ref=${payazaReference}, payazaId=${payazaTransferId}`);

    return res.status(200).json({
      success: true,
      message: `Withdrawal of ₦${amount.toLocaleString()} is being processed to your bank account. This typically takes 1–5 minutes.`,
      data: {
        withdrawalId,
        payazaReference,
        amount,
        commission,
        totalDeducted: totalDeduction,
        newBalance: newWalletBalance,
        status: 'pending',
      },
    });

  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/withdrawals/:creatorId
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a creator's withdrawal history, newest first.
 * Supports ?limit query param (default 20, max 100).
 *
 * @route  GET /api/withdrawals/:creatorId
 * @access Private — protect + isSameUser in route
 */
const getCreatorWithdrawals = async (req, res, next) => {
  try {
    const { creatorId } = req.params;
    const limitCount = Math.min(parseInt(req.query.limit) || 20, 100);

    const snapshot = await db
      .collection('withdrawals')
      .where('creatorId', '==', creatorId)
      .orderBy('timestamp', 'desc')
      .limit(limitCount)
      .get();

    const withdrawals = snapshot.docs.map((doc) => doc.data());

    return res.status(200).json({
      success: true,
      count: withdrawals.length,
      data: withdrawals,
    });

  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/withdrawals/status/:withdrawalId
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the current status of a specific withdrawal.
 *
 * For pending withdrawals with a Payaza transfer reference, we query Payaza
 * directly to get the latest status — useful if the webhook was delayed.
 * If Payaza confirms failure, we auto-refund the creator's wallet here.
 *
 * @route  GET /api/withdrawals/status/:withdrawalId
 * @access Private — protect middleware
 */
const getWithdrawalStatus = async (req, res, next) => {
  try {
    const { withdrawalId } = req.params;

    const withdrawalDoc = await db.collection('withdrawals').doc(withdrawalId).get();

    if (!withdrawalDoc.exists) {
      return res.status(404).json({ success: false, error: 'Withdrawal not found.' });
    }

    const withdrawalData = withdrawalDoc.data();

    // ── Ownership check ───────────────────────────────────────────────────────
    if (req.user.uid !== withdrawalData.creatorId) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden. You can only view your own withdrawals.',
      });
    }

    // ── For pending withdrawals, query Payaza directly ────────────────────────
    if (withdrawalData.status === 'pending' && withdrawalData.payazaReference) {
      try {
        const statusResponse = await payaza.get(
          `/api/v1/transfers/transaction-status?transaction_reference=${withdrawalData.payazaReference}`
        );

        const payazaStatus = statusResponse?.data?.status || statusResponse?.status;

        if (payazaStatus === 'NIP_SUCCESS' || payazaStatus === 'TRANSACTION_SUCCESSFUL') {
          // Payout confirmed — update Firestore record
          await withdrawalDoc.ref.update({ status: 'completed', updatedAt: new Date() });
          withdrawalData.status = 'completed';

        } else if (payazaStatus === 'NIP_FAILURE' || payazaStatus === 'TRANSACTION_FAILED') {
          // Payout failed — refund the creator
          const creatorRef = db.collection('creators').doc(withdrawalData.creatorId);

          await db.runTransaction(async (firestoreTx) => {
            const creatorDoc = await firestoreTx.get(creatorRef);
            const creatorInfo = creatorDoc.data();

            firestoreTx.update(creatorRef, {
              walletBalance: creatorInfo.walletBalance + withdrawalData.amount,
              updatedAt: new Date(),
            });

            firestoreTx.update(withdrawalDoc.ref, {
              status: 'failed',
              failureReason: statusResponse?.data?.message || 'Transfer failed',
              updatedAt: new Date(),
            });
          });

          withdrawalData.status = 'failed';
          console.log(`[Withdrawal Status] Auto-refunded ₦${withdrawalData.amount} to creator ${withdrawalData.creatorId}`);
        }
        // NIP_PENDING — still processing, return current status

      } catch (statusError) {
        // Can't reach Payaza — return what we have in Firestore
        console.warn(`[Withdrawal Status] Could not query Payaza for ${withdrawalId}:`, statusError.message);
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        id: withdrawalData.id,
        amount: withdrawalData.amount,
        status: withdrawalData.status,
        bankAccountNumber: withdrawalData.bankAccountNumber,
        bankName: withdrawalData.bankName,
        payazaReference: withdrawalData.payazaReference,
        timestamp: withdrawalData.timestamp,
        updatedAt: withdrawalData.updatedAt,
      },
    });

  } catch (err) {
    next(err);
  }
};

module.exports = {
  requestWithdrawal,
  getCreatorWithdrawals,
  getWithdrawalStatus,
};
