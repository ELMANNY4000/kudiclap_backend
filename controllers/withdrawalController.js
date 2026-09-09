/**
 * controllers/withdrawalController.js
 *
 * Creator payout processing — powered by the Payaza Node.js SDK.
 *
 * ── Withdrawal flow ────────────────────────────────────────────────────────────
 *
 *   1. Creator submits { creatorId, amount, pin }
 *   2. Validate input + verify 4-digit PIN (bcrypt compare)
 *   3. Calculate commission from Firestore commissions collection
 *   4. Check walletBalance >= totalDeduction (amount + commission)
 *   5. Atomically deduct totalDeduction from wallet + create withdrawal doc
 *   6. Fetch our Payaza account reference via payaza.account.view()
 *   7. Initiate payout via payaza.transfers.initiate()
 *   8. On failure: atomically reverse deduction + mark withdrawal failed
 *   9. Final confirmation via transfer.success/failed webhook in paymentController
 *
 * ── SDK methods used ──────────────────────────────────────────────────────────
 *
 *   payaza.account.view()
 *     → Returns all currency sub-accounts. We find the NGN one and extract
 *       payazaAccountReference — required in every transfer request.
 *
 *   payaza.transfers.initiate(payload)
 *     → Queues a NUBAN bank transfer to the creator's account.
 *     → Returns { data: { id, reference, status: 'NEW', ... } }
 *     → Status 'NEW' means queued — webhook fires when it completes.
 *
 *   payaza.transfers.getStatus(reference)
 *     → Checks the current status of a transfer by our reference.
 *     → Used in getWithdrawalStatus() to poll if webhook was delayed.
 *
 * ── Transaction_reference format ─────────────────────────────────────────────
 *   Payaza requires unique references >= 10 characters.
 *   We use: kc-wd-{10 chars of withdrawalId}-{4 digit timestamp}
 *   This stays <= 25 chars (narration limit) and is traceable back to Firestore.
 *
 * Exported:
 *   - requestWithdrawal      → POST /api/withdrawals
 *   - getCreatorWithdrawals  → GET  /api/withdrawals/:creatorId
 *   - getWithdrawalStatus    → GET  /api/withdrawals/status/:withdrawalId
 */

const bcrypt = require('bcrypt');
const { payaza } = require('../config/payaza');
const { PayazaError } = require('payaza-node-sdk');
const { db } = require('../config/firebase');
const { validateWithdrawal } = require('../utils/validation');
const { calculateCommission } = require('../services/commissionService');
const { sendWithdrawalUpdate } = require('../services/emailService');

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper — get our NGN Payaza account reference
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches KudiClap's NGN Payaza account reference.
 *
 * payaza.account.view() returns all currency sub-accounts under our business.
 * We find the NGN one and extract payazaAccountReference — Payaza requires
 * this on every transfer request to know which wallet to debit.
 *
 * @returns {Promise<string>} The NGN payazaAccountReference
 * @throws  If the API call fails or no NGN account is found
 */
const getNgnAccountReference = async () => {
  // SDK call — throws PayazaError on non-2xx
  const response = await payaza.account.view();

  // response.data is an array of account objects, one per currency
  const accounts = Array.isArray(response.data) ? response.data : [response.data];

  const ngnAccount = accounts.find(
    (acc) =>
      acc.currency === 'NGN' ||
      acc.currency_code === 'NGN' ||
      acc.accountCurrency === 'NGN'
  );

  if (!ngnAccount) {
    throw new Error('No NGN account found on your Payaza dashboard. Please contact support.');
  }

  const ref =
    ngnAccount.payazaAccountReference ||
    ngnAccount.account_reference ||
    ngnAccount.accountReference;

  if (!ref) {
    throw new Error('NGN account found but payazaAccountReference is missing. Contact support.');
  }

  return ref;
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/withdrawals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Processes a withdrawal — sends real money to the creator's Nigerian bank account.
 *
 * @route  POST /api/withdrawals
 * @access Private — protect middleware (creator must be logged in)
 */
const requestWithdrawal = async (req, res, next) => {
  try {
    // ── Validate ──────────────────────────────────────────────────────────────
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

    // ── Fetch creator ─────────────────────────────────────────────────────────
    const creatorRef = db.collection('creators').doc(creatorId);
    const creatorDoc = await creatorRef.get();

    if (!creatorDoc.exists) {
      return res.status(404).json({ success: false, error: 'Creator not found.' });
    }

    const creatorData = creatorDoc.data();

    // ── PIN verification ──────────────────────────────────────────────────────
    // The PIN is stored as a bcrypt hash in Firestore.
    // It is separate from the Firebase Auth login password.
    if (!creatorData.pin) {
      return res.status(400).json({
        success: false,
        error: 'No withdrawal PIN set. Please set your PIN at POST /api/auth/set-pin first.',
      });
    }

    const pinValid = await bcrypt.compare(pin.toString(), creatorData.pin);
    if (!pinValid) {
      return res.status(400).json({ success: false, error: 'Invalid PIN.' });
    }

    // ── Bank account check ────────────────────────────────────────────────────
    if (!creatorData.bankAccountNumber || !creatorData.bankCode) {
      return res.status(400).json({
        success: false,
        error: 'No bank account on file. Add your account at PUT /api/creators/:id/bank first.',
      });
    }

    // ── Commission calculation ────────────────────────────────────────────────
    // Rates come from the Firestore "commissions" collection — zero by default.
    const { commission, totalDeduction, breakdown } = await calculateCommission(amount, 'withdraw');

    // ── Balance check (pre-transaction quick check) ───────────────────────────
    if (creatorData.walletBalance < totalDeduction) {
      return res.status(400).json({
        success: false,
        error: `Insufficient balance. Available: ₦${creatorData.walletBalance.toLocaleString()}. Required (inc. fees): ₦${totalDeduction.toLocaleString()}`,
      });
    }

    // ── Prepare IDs and references ────────────────────────────────────────────
    const withdrawalRef = db.collection('withdrawals').doc();
    const withdrawalId = withdrawalRef.id;

    // Payaza reference — unique, >= 10 chars, <= 25 chars for narration
    const payazaReference = `kc-wd-${withdrawalId.substring(0, 10)}-${Date.now().toString().slice(-4)}`;

    // ── Atomic Firestore: deduct wallet + create withdrawal record ────────────
    // Both writes succeed together or both roll back.
    // The wallet deduction acts as a concurrency lock — prevents a second
    // withdrawal request from passing the balance check simultaneously.
    let newWalletBalance;

    try {
      await db.runTransaction(async (firestoreTx) => {
        // Re-read inside the transaction — gets the freshest balance
        const freshDoc = await firestoreTx.get(creatorRef);
        const freshData = freshDoc.data();

        // Re-check balance inside the transaction (may have changed since pre-check)
        if (freshData.walletBalance < totalDeduction) {
          throw Object.assign(
            new Error(`Insufficient balance. Available: ₦${freshData.walletBalance.toLocaleString()}`),
            { statusCode: 400 }
          );
        }

        newWalletBalance = freshData.walletBalance - totalDeduction;

        // Deduct the full totalDeduction (amount + commission) from wallet
        firestoreTx.update(creatorRef, {
          walletBalance: newWalletBalance,
          updatedAt: new Date(),
        });

        // Create the withdrawal document — status starts as 'pending'
        // It is updated to 'completed' or 'failed' by the webhook handler
        firestoreTx.set(withdrawalRef, {
          id: withdrawalId,
          creatorId,
          amount,                       // The amount the creator receives
          commission,                   // Fee deducted on top
          totalDeduction,               // amount + commission — what left the wallet
          commissionBreakdown: breakdown,
          bankAccountNumber: creatorData.bankAccountNumber,
          bankCode: creatorData.bankCode,
          bankName: creatorData.bankName || '',
          accountName: creatorData.bankAccountName || creatorData.name,
          status: 'pending',
          payazaReference,              // Matches this to webhook transfer events
          payazaTransferId: null,       // Set after SDK call responds
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

    // ── Helper: reverse the Firestore deduction on any downstream failure ──────
    // Restores totalDeduction (amount + commission) to the creator's wallet
    // and marks the withdrawal as failed.
    const reverseDeduction = async (reason) => {
      try {
        await db.runTransaction(async (firestoreTx) => {
          const freshDoc = await firestoreTx.get(creatorRef);
          firestoreTx.update(creatorRef, {
            walletBalance: freshDoc.data().walletBalance + totalDeduction,
            updatedAt: new Date(),
          });
          firestoreTx.update(withdrawalRef, {
            status: 'failed',
            failureReason: reason,
            updatedAt: new Date(),
          });
        });
        console.log(`[Withdrawal] Reversed ₦${totalDeduction} for ${withdrawalId}: ${reason}`);
      } catch (reverseErr) {
        // Log but don't throw — we're already in an error path
        console.error('[Withdrawal] CRITICAL: failed to reverse deduction:', reverseErr.message);
      }
    };

    // ── Fetch Payaza account reference ────────────────────────────────────────
    let accountReference;
    try {
      accountReference = await getNgnAccountReference();
    } catch (accError) {
      await reverseDeduction(accError.message);
      return res.status(502).json({
        success: false,
        error: 'Could not connect to payment gateway. Your balance has been restored. Please try again.',
      });
    }

    // ── Initiate the Payaza transfer ──────────────────────────────────────────
    // payaza.transfers.initiate() — SDK call, throws PayazaError on failure
    //
    // transaction_type: "nuban" = Nigerian bank account (NUBAN standard)
    // Works for all Nigerian banks including OPay (999992), Kuda (090267),
    // PalmPay (999991), and traditional banks like Access (044), GTBank (058).
    const transferPayload = {
      transaction_type: 'nuban',
      service_payload: {
        payout_amount: amount,
        // 6-digit PIN set in the Payaza dashboard — authorises the payout
        transaction_pin: parseInt(process.env.PAYAZA_TRANSACTION_PIN, 10),
        account_reference: accountReference,
        currency: 'NGN',
        payout_beneficiaries: [
          {
            credit_amount: amount,
            account_number: creatorData.bankAccountNumber,
            account_name: creatorData.bankAccountName || creatorData.name,
            bank_code: creatorData.bankCode,
            // Narration shown on creator's bank statement (keep <= 25 chars)
            narration: `KudiClap payout`,
            // Our unique ref — used to match this transfer in webhook events
            transaction_reference: payazaReference,
            sender: {
              sender_name: 'KudiClap',
              sender_phone_number: process.env.KUDICLAP_PHONE || '08000000000',
              sender_address: 'Nigeria',
            },
          },
        ],
      },
    };

    let transferResponse;
    try {
      transferResponse = await payaza.transfers.initiate(transferPayload);
    } catch (payazaError) {
      const errMsg = payazaError instanceof PayazaError
        ? payazaError.message
        : payazaError.message;

      console.error(`[Withdrawal] SDK transfer error for ${withdrawalId}:`, errMsg);
      await reverseDeduction(errMsg);

      return res.status(502).json({
        success: false,
        error: 'Withdrawal could not be processed. Your balance has been restored. Please try again.',
      });
    }

    // ── Update withdrawal doc with Payaza's transfer ID ───────────────────────
    // transferResponse.data.id is Payaza's internal ID (e.g. "trf_XXXXX")
    const payazaTransferId = transferResponse?.data?.id || null;

    await withdrawalRef.update({
      payazaTransferId,
      updatedAt: new Date(),
    });

    console.log(`[Withdrawal] Initiated: creatorId=${creatorId}, ₦${amount}, ref=${payazaReference}, payazaId=${payazaTransferId}`);

    // ── Email notification ──────────────────────────────────────────────────
    // Fire-and-forget — don't let email failure block the response
    sendWithdrawalUpdate({
      to:          creatorData.email,
      creatorName: creatorData.name,
      amount,
      status:      'pending',
      bankName:    creatorData.bankName || 'your bank account',
    }).catch((err) => console.error('[Withdrawal] Email failed:', err.message));

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
 * @access Private — protect + isSameUser
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
 * For pending withdrawals, polls Payaza via payaza.transfers.getStatus()
 * to get the latest status without waiting for a webhook.
 * Auto-refunds the creator if Payaza confirms a failure.
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

    // Ownership check
    if (req.user.uid !== withdrawalData.creatorId) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden. You can only view your own withdrawals.',
      });
    }

    // ── Poll Payaza for pending withdrawals ───────────────────────────────────
    if (withdrawalData.status === 'pending' && withdrawalData.payazaReference) {
      try {
        // payaza.transfers.getStatus(reference) — SDK call
        const statusResponse = await payaza.transfers.getStatus(withdrawalData.payazaReference);
        const payazaStatus = statusResponse?.data?.status || statusResponse?.status;

        if (payazaStatus === 'NIP_SUCCESS' || payazaStatus === 'TRANSACTION_SUCCESSFUL' || payazaStatus === 'SUCCESSFUL') {
          await withdrawalDoc.ref.update({ status: 'completed', updatedAt: new Date() });
          withdrawalData.status = 'completed';

        } else if (payazaStatus === 'NIP_FAILURE' || payazaStatus === 'TRANSACTION_FAILED' || payazaStatus === 'FAILED') {
          // Payout failed — refund totalDeduction back to creator's wallet
          const creatorRef = db.collection('creators').doc(withdrawalData.creatorId);
          const refundAmount = withdrawalData.totalDeduction || withdrawalData.amount;

          await db.runTransaction(async (firestoreTx) => {
            const creatorDoc = await firestoreTx.get(creatorRef);
            firestoreTx.update(creatorRef, {
              walletBalance: creatorDoc.data().walletBalance + refundAmount,
              updatedAt: new Date(),
            });
            firestoreTx.update(withdrawalDoc.ref, {
              status: 'failed',
              failureReason: statusResponse?.data?.complete_message || 'Transfer failed',
              updatedAt: new Date(),
            });
          });

          withdrawalData.status = 'failed';
          console.log(`[Withdrawal Status] Auto-refunded ₦${refundAmount} to creator ${withdrawalData.creatorId}`);
        }
        // 'NEW' or 'PENDING' — still processing, return current status

      } catch (statusError) {
        // Payaza unreachable — return what we have in Firestore
        console.warn(`[Withdrawal Status] Could not poll Payaza for ${withdrawalId}:`, statusError.message);
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        id: withdrawalData.id,
        amount: withdrawalData.amount,
        commission: withdrawalData.commission,
        totalDeducted: withdrawalData.totalDeduction,
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
