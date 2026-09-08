/**
 * controllers/ussdController.js
 *
 * Handles all USSD-related flows for KudiClap.
 *
 * ── Two separate USSD use cases ───────────────────────────────────────────────
 *
 *   1. Fan tipping via USSD shortcode (POST /api/ussd/tip)
 *      A fan dials *388*12345# → we look up the creator → return Payaza
 *      checkout params for the fan to complete payment on their phone/web.
 *
 *   2. Creator withdrawing via USSD (POST /api/ussd/withdraw/initiate)
 *      A creator initiates a withdrawal using their PIN via USSD simulation.
 *      This mirrors what would happen on a real USSD gateway — the creator
 *      dials a code, enters their PIN, and approves the withdrawal.
 *
 *      For the MVP: this is simulated via API calls (no real USSD gateway).
 *      The flow is:
 *        a. POST /api/ussd/withdraw/initiate  → verify PIN → create pending withdrawal
 *        b. POST /api/ussd/withdraw/verify    → confirm with a verification code → execute withdrawal
 *        c. POST /api/ussd/withdraw/cancel    → cancel a pending USSD withdrawal
 *
 * ── Commission deduction on USSD withdrawals ─────────────────────────────────
 *   Commission rates are fetched from the commissions Firestore collection.
 *   If no commission is configured, the withdrawal proceeds fee-free.
 *
 * Exported functions:
 *   - processUssdTip              → POST /api/ussd/tip
 *   - initiateUssdWithdrawal      → POST /api/ussd/withdraw/initiate  (protected)
 *   - verifyUssdWithdrawal        → POST /api/ussd/withdraw/verify    (protected)
 *   - cancelUssdWithdrawal        → POST /api/ussd/withdraw/cancel    (protected)
 */

const bcrypt = require('bcrypt');
const { db } = require('../config/firebase');
const { validateUssdPayment, validateUssdWithdrawal, validateUssdVerify } = require('../utils/validation');
const { calculateCommission } = require('../services/commissionService');

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ussd/tip
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fan-facing: processes a tip initiated via a USSD shortcode.
 *
 * The fan dials the creator's USSD code (e.g. *388*12345#), provides
 * their phone number and the tip amount. We look up the creator and
 * return Payaza checkout params for them to complete payment.
 *
 * @route  POST /api/ussd/tip
 * @access Public
 */
const processUssdTip = async (req, res, next) => {
  try {
    const { error, value } = validateUssdPayment(req.body);
    if (error) {
      return res.status(400).json({ success: false, error: error.details[0].message });
    }

    const { ussdCode, amount, fanPhoneNumber } = value;

    // Look up the creator who owns this USSD code
    const creatorsSnapshot = await db
      .collection('creators')
      .where('ussdCode', '==', ussdCode)
      .limit(1)
      .get();

    if (creatorsSnapshot.empty) {
      return res.status(404).json({
        success: false,
        error: `No creator found for USSD code ${ussdCode}. Please check the code and try again.`,
      });
    }

    const creatorData = creatorsSnapshot.docs[0].data();
    const creatorId = creatorsSnapshot.docs[0].id;

    // Generate a unique Payaza transaction reference
    const txRef = `kc-${creatorId.substring(0, 8)}-${Date.now().toString().slice(-6)}`;

    // Store the pending payment so handleWebhook() can credit the creator
    await db.collection('pendingPayments').doc(txRef).set({
      txRef,
      creatorId,
      amount,
      paymentMethod: 'ussd',
      fanName: 'USSD User',
      fanEmail: '',
      fanPhoneNumber,
      ussdCode,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });

    return res.status(200).json({
      success: true,
      status: 'checkout',
      message: `Sending ₦${amount} tip to ${creatorData.name}. Complete payment below.`,
      data: {
        transactionReference: txRef,
        creator: {
          name: creatorData.name,
          username: creatorData.username,
        },
        amount,
        // Payaza Web Checkout SDK params
        checkoutParams: {
          merchant_key: process.env.PAYAZA_PUBLIC_KEY,
          connection_mode: process.env.PAYAZA_ENV === 'live' ? 'Live' : 'Test',
          checkout_amount: amount,
          currency_code: 'NGN',
          email_address: 'anonymous@kudiclap.com',
          first_name: 'USSD',
          last_name: 'User',
          phone_number: fanPhoneNumber,
          transaction_reference: txRef,
          additional_details: { creatorId, source: 'kudiclap-ussd', ussdCode },
        },
      },
    });

  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ussd/withdraw/initiate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creator-facing: initiates a USSD withdrawal with PIN verification.
 *
 * The creator provides their PIN and the amount to withdraw.
 * We verify the PIN, calculate commission, check the balance, and create
 * a pending USSD withdrawal record. A 6-digit confirmation code is returned
 * (simulates the confirmation code sent to the creator's phone via USSD).
 *
 * The creator must then call /verify with the confirmation code to execute
 * the actual Payaza transfer — or /cancel to abort.
 *
 * @route  POST /api/ussd/withdraw/initiate
 * @access Private — creator must be logged in
 */
const initiateUssdWithdrawal = async (req, res, next) => {
  try {
    const { error, value } = validateUssdWithdrawal(req.body);
    if (error) {
      return res.status(400).json({ success: false, error: error.details[0].message });
    }

    const { amount, pin } = value;
    const uid = req.user.uid;

    // Fetch creator profile
    const creatorRef = db.collection('creators').doc(uid);
    const creatorDoc = await creatorRef.get();

    if (!creatorDoc.exists) {
      return res.status(404).json({ success: false, error: 'Creator not found.' });
    }

    const creatorData = creatorDoc.data();

    // Creator must have set a PIN before using USSD withdrawal
    if (!creatorData.pin) {
      return res.status(400).json({
        success: false,
        error: 'No withdrawal PIN set. Please set your PIN at /api/auth/set-pin first.',
      });
    }

    // Creator must have bank account details for the Payaza transfer
    if (!creatorData.bankAccountNumber || !creatorData.bankCode) {
      return res.status(400).json({
        success: false,
        error: 'No bank account on file. Please add your bank account at PUT /api/creators/:id/bank.',
      });
    }

    // Verify the PIN
    const pinValid = await bcrypt.compare(pin.toString(), creatorData.pin);
    if (!pinValid) {
      return res.status(400).json({ success: false, error: 'Invalid PIN.' });
    }

    // Calculate commission deduction for this withdrawal
    const { commission, totalDeduction, breakdown } = await calculateCommission(amount, 'withdraw');

    // Check the creator has enough balance including commission
    if (creatorData.walletBalance < totalDeduction) {
      return res.status(400).json({
        success: false,
        error: `Insufficient balance. Available: ₦${creatorData.walletBalance.toLocaleString()}. Required (inc. commission): ₦${totalDeduction.toLocaleString()}`,
      });
    }

    // Generate a 6-digit confirmation code (simulates USSD callback to creator's phone)
    const confirmationCode = Math.floor(100000 + Math.random() * 900000).toString();
    const reference = `USSD-${Date.now()}-${uid.substring(0, 4)}`;

    // Store the pending USSD withdrawal
    await db.collection('ussdWithdrawals').doc(reference).set({
      reference,
      creatorId: uid,
      amount,
      commission,
      totalDeduction,
      commissionBreakdown: breakdown,
      confirmationCode, // In production this would NOT be stored in plain text
                        // and would be sent securely to the creator's phone
      status: 'pending',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10-minute expiry
    });

    return res.status(200).json({
      success: true,
      message: 'USSD withdrawal initiated. Use the confirmation code to complete.',
      data: {
        reference,
        amount,
        commission,
        totalDeduction,
        // Return confirmation code in dev/test — in production this goes to phone via USSD
        ...(process.env.NODE_ENV !== 'production' && { confirmationCode }),
        expiresInMinutes: 10,
      },
    });

  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ussd/withdraw/verify
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Completes a USSD withdrawal by verifying the confirmation code.
 *
 * Steps:
 *   1. Find the pending USSD withdrawal by reference
 *   2. Verify the confirmation code
 *   3. Atomically deduct walletBalance + commission from creator
 *   4. Create a withdrawal record for tracking
 *   5. Queue the Payaza Transfer (handled by withdrawalController logic)
 *
 * @route  POST /api/ussd/withdraw/verify
 * @access Private
 */
const verifyUssdWithdrawal = async (req, res, next) => {
  try {
    const { error, value } = validateUssdVerify(req.body);
    if (error) {
      return res.status(400).json({ success: false, error: error.details[0].message });
    }

    const { reference, confirmationCode } = value;
    const uid = req.user.uid;

    // Fetch the pending USSD withdrawal
    const ussdDoc = await db.collection('ussdWithdrawals').doc(reference).get();

    if (!ussdDoc.exists) {
      return res.status(404).json({ success: false, error: 'USSD withdrawal not found.' });
    }

    const ussdData = ussdDoc.data();

    // Ownership check
    if (ussdData.creatorId !== uid) {
      return res.status(403).json({ success: false, error: 'Forbidden.' });
    }

    // Check status
    if (ussdData.status !== 'pending') {
      return res.status(400).json({
        success: false,
        error: `This withdrawal is already ${ussdData.status}.`,
      });
    }

    // Check expiry
    const expiresAt = ussdData.expiresAt.toDate ? ussdData.expiresAt.toDate() : new Date(ussdData.expiresAt);
    if (new Date() > expiresAt) {
      await ussdDoc.ref.update({ status: 'expired' });
      return res.status(400).json({
        success: false,
        error: 'USSD withdrawal has expired. Please initiate a new one.',
      });
    }

    // Verify confirmation code
    if (ussdData.confirmationCode !== confirmationCode.toString()) {
      return res.status(400).json({ success: false, error: 'Invalid confirmation code.' });
    }

    const creatorRef = db.collection('creators').doc(uid);
    const withdrawalRef = db.collection('withdrawals').doc();

    // Atomically: deduct wallet + record withdrawal
    let newWalletBalance;
    try {
      await db.runTransaction(async (firestoreTx) => {
        const freshDoc = await firestoreTx.get(creatorRef);
        const freshData = freshDoc.data();

        if (freshData.walletBalance < ussdData.totalDeduction) {
          throw Object.assign(
            new Error(`Insufficient balance. Available: ₦${freshData.walletBalance.toLocaleString()}`),
            { statusCode: 400 }
          );
        }

        newWalletBalance = freshData.walletBalance - ussdData.totalDeduction;

        firestoreTx.update(creatorRef, {
          walletBalance: newWalletBalance,
          updatedAt: new Date(),
        });

        firestoreTx.set(withdrawalRef, {
          id: withdrawalRef.id,
          creatorId: uid,
          amount: ussdData.amount,
          commission: ussdData.commission,
          totalDeduction: ussdData.totalDeduction,
          bankAccountNumber: freshData.bankAccountNumber,
          bankCode: freshData.bankCode,
          bankName: freshData.bankName || '',
          accountName: freshData.bankAccountName || freshData.name,
          status: 'pending',
          source: 'ussd', // This withdrawal was initiated via USSD
          payazaReference: `kc-wd-${withdrawalRef.id.substring(0, 10)}-${Date.now().toString().slice(-4)}`,
          payazaTransferId: null,
          timestamp: new Date(),
          updatedAt: new Date(),
        });

        // Mark the USSD withdrawal as completed
        firestoreTx.update(ussdDoc.ref, { status: 'completed' });
      });
    } catch (txError) {
      if (txError.statusCode === 400) {
        return res.status(400).json({ success: false, error: txError.message });
      }
      throw txError;
    }

    return res.status(200).json({
      success: true,
      message: 'USSD withdrawal verified. Payout is being processed.',
      data: {
        withdrawalId: withdrawalRef.id,
        amount: ussdData.amount,
        commission: ussdData.commission,
        newBalance: newWalletBalance,
      },
    });

  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ussd/withdraw/cancel
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cancels a pending USSD withdrawal before it is verified.
 *
 * @route  POST /api/ussd/withdraw/cancel
 * @access Private
 */
const cancelUssdWithdrawal = async (req, res, next) => {
  try {
    const { reference } = req.body;

    if (!reference) {
      return res.status(400).json({ success: false, error: 'Reference is required.' });
    }

    const uid = req.user.uid;
    const ussdDoc = await db.collection('ussdWithdrawals').doc(reference).get();

    if (!ussdDoc.exists) {
      return res.status(404).json({ success: false, error: 'USSD withdrawal not found.' });
    }

    const ussdData = ussdDoc.data();

    if (ussdData.creatorId !== uid) {
      return res.status(403).json({ success: false, error: 'Forbidden.' });
    }

    if (ussdData.status !== 'pending') {
      return res.status(400).json({
        success: false,
        error: `Cannot cancel — this withdrawal is already ${ussdData.status}.`,
      });
    }

    await ussdDoc.ref.update({ status: 'cancelled', updatedAt: new Date() });

    return res.status(200).json({
      success: true,
      message: 'USSD withdrawal cancelled successfully.',
    });

  } catch (err) {
    next(err);
  }
};

module.exports = {
  processUssdTip,
  initiateUssdWithdrawal,
  verifyUssdWithdrawal,
  cancelUssdWithdrawal,
};
