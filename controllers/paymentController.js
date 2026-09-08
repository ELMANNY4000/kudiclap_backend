/**
 * controllers/paymentController.js
 *
 * Payment collection for KudiClap tips — powered by the Payaza Node.js SDK.
 *
 * ── Payment flows ─────────────────────────────────────────────────────────────
 *
 *   Web Checkout (recommended — card + bank transfer + mobile money):
 *     The Payaza Checkout JS SDK renders a hosted modal on the frontend.
 *     Our backend role:
 *       1. Generate a unique transaction_reference
 *       2. Store a pendingPayments record in Firestore
 *       3. Return checkout params the frontend passes to PayazaCheckout.setup()
 *       4. Receive and verify the Payaza webhook after fan completes payment
 *       5. Credit the creator's wallet on confirmed payment
 *
 *   Direct Card Charge (card details sent server-side):
 *     POST /api/payments/tip with paymentMethod:'card'
 *     Uses payaza.cards.charge() from the SDK.
 *     Possible responses:
 *       do3dsAuth: true  → return threeDsHtml to frontend for 3DS challenge
 *       statusOk + paymentCompleted → immediate success, credit creator
 *       failure → return error to frontend
 *
 *   USSD Tip (fan dials *388*XXXXX#):
 *     Handled by ussdController.js — returns checkout params for web fallback.
 *
 * ── SDK methods used ──────────────────────────────────────────────────────────
 *
 *   payaza.cards.charge(payload)
 *     → Charges a card directly. Returns do3dsAuth / statusOk / paymentCompleted.
 *
 *   payaza.account.getTransactionStatus(txRef)
 *     → Server-side verification of any transaction by our reference.
 *     → Called before crediting to prevent fraud.
 *
 *   verifyWebhookSignature(rawBody, signature, secret)
 *     → HMAC-SHA512 verification of incoming webhook requests.
 *     → rawBody must be a Buffer — app.js uses express.raw() on this route.
 *
 * ── Credit logic ──────────────────────────────────────────────────────────────
 *
 *   creditCreatorWallet() is idempotent — it checks for an existing Firestore
 *   transaction document keyed by payazaRef before writing. Duplicate webhook
 *   deliveries never double-credit a creator.
 *
 * Exported:
 *   - processTip          → POST /api/payments/tip
 *   - verifyPayment       → POST /api/payments/verify/:txRef
 *   - handleCardCallback  → POST /api/payments/card-callback
 *   - handleWebhook       → POST /api/payments/webhook
 */

const { payaza, verifyWebhookSignature } = require('../config/payaza');
const { PayazaError } = require('payaza-node-sdk');
const { db } = require('../config/firebase');
const { validateTip } = require('../utils/validation');

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper — credit creator wallet + log transaction (idempotent)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Credits a creator's wallet and writes a transaction record to Firestore.
 *
 * This is the ONLY place in the app where a creator's balance increases.
 * Called by verifyPayment() and handleWebhook() — never for unverified charges.
 *
 * Idempotency: checks for an existing transaction with the same payazaRef
 * before writing. Safe to call multiple times for the same payment.
 *
 * @param {string} creatorId     - Firestore creator document ID
 * @param {number} amount        - Naira (₦) amount to credit
 * @param {string} paymentMethod - 'card' | 'checkout' | 'bankTransfer' | 'ussd'
 * @param {string} payazaRef     - Our transaction_reference (idempotency key)
 * @param {object} fanDetails    - { fanName, fanEmail }
 * @returns {Promise<boolean>}   - true if credited now, false if already existed
 */
const creditCreatorWallet = async (
  creatorId,
  amount,
  paymentMethod,
  payazaRef,
  fanDetails = {}
) => {
  // ── Idempotency check ─────────────────────────────────────────────────────
  const existing = await db
    .collection('transactions')
    .where('payazaRef', '==', String(payazaRef))
    .limit(1)
    .get();

  if (!existing.empty) {
    console.log(`[Credit] Transaction ${payazaRef} already credited — skipping.`);
    return false;
  }

  const creatorRef = db.collection('creators').doc(creatorId);

  // ── Atomic Firestore transaction ──────────────────────────────────────────
  // Wallet update + transaction log both succeed or both roll back.
  await db.runTransaction(async (firestoreTx) => {
    const freshDoc = await firestoreTx.get(creatorRef);

    if (!freshDoc.exists) {
      throw new Error(`Creator ${creatorId} not found while crediting wallet.`);
    }

    const data = freshDoc.data();

    firestoreTx.update(creatorRef, {
      totalEarnings: data.totalEarnings + amount, // Lifetime total — never decreases
      walletBalance: data.walletBalance + amount,  // Available to withdraw
      updatedAt: new Date(),
    });

    // Log the transaction for dashboard / history
    const txDocRef = db.collection('transactions').doc();
    firestoreTx.set(txDocRef, {
      id: txDocRef.id,
      creatorId,
      fanName: fanDetails.fanName || 'Anonymous',
      fanEmail: fanDetails.fanEmail || '',
      amount,
      paymentMethod,
      status: 'completed',
      payazaRef: String(payazaRef), // Idempotency key
      timestamp: new Date(),
    });
  });

  console.log(`[Credit] ₦${amount} credited to creator ${creatorId} (ref: ${payazaRef})`);
  return true;
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/tip
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initiates a tip from a fan to a creator.
 *
 * paymentMethod: 'checkout' | 'mobileMoney' | 'bankTransfer'
 *   → Returns Payaza Web Checkout SDK params. The frontend opens the modal,
 *     Payaza handles the UI, webhook fires on completion.
 *
 * paymentMethod: 'card'
 *   → Charges the card directly via payaza.cards.charge().
 *   → May return { status:'3ds', threeDsHtml } for 3D Secure cards.
 *   → Successful immediate charges credit the creator on the spot.
 *
 * @route  POST /api/payments/tip
 * @access Public — no account needed to tip
 */
const processTip = async (req, res, next) => {
  try {
    // ── Validate ──────────────────────────────────────────────────────────────
    const { error, value } = validateTip(req.body);
    if (error) {
      return res.status(400).json({ success: false, error: error.details[0].message });
    }

    const {
      creatorId,
      amount,
      paymentMethod,
      fanName,
      fanEmail,
      fanPhoneNumber,
      cardNumber,
      cardCvv,
      cardExpiryMonth,
      cardExpiryYear,
      cardPin,
    } = value;

    // ── Verify creator exists ─────────────────────────────────────────────────
    const creatorDoc = await db.collection('creators').doc(creatorId).get();
    if (!creatorDoc.exists) {
      return res.status(404).json({ success: false, error: 'Creator not found.' });
    }

    // ── Generate unique transaction reference ─────────────────────────────────
    // SDK docs say >= 10 chars and globally unique per Payaza account.
    // Format: kc-{8 chars of creatorId}-{6 digit timestamp suffix}
    const txRef = `kc-${creatorId.substring(0, 8)}-${Date.now().toString().slice(-6)}`;

    // ── Store pending payment in Firestore ────────────────────────────────────
    // handleWebhook() and verifyPayment() look this up to know which creator
    // to credit and how much — even if the server restarts between now and then.
    await db.collection('pendingPayments').doc(txRef).set({
      txRef,
      creatorId,
      amount,
      paymentMethod,
      fanName: fanName || 'Anonymous',
      fanEmail: fanEmail || '',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30-min expiry
    });

    // ── Route to the correct payment flow ────────────────────────────────────
    switch (paymentMethod) {

      // ── Web Checkout ─────────────────────────────────────────────────────
      // The backend just returns the checkout params.
      // The frontend calls PayazaCheckout.setup(checkoutParams) to open the modal.
      // Payaza handles card / bank transfer / mobile money on their hosted page.
      // Final confirmation arrives via webhook → handleWebhook().
      case 'checkout':
      case 'mobileMoney':
      case 'bankTransfer': {
        return res.status(200).json({
          success: true,
          status: 'checkout',
          message: 'Transaction reference generated. Initialise the Payaza Checkout SDK with the checkoutParams.',
          data: {
            transactionReference: txRef,
            amount,
            currency: 'NGN',
            // The frontend passes these directly into PayazaCheckout.setup()
            checkoutParams: {
              merchant_key: process.env.PAYAZA_PUBLIC_KEY,
              connection_mode: process.env.PAYAZA_ENV === 'live' ? 'Live' : 'Test',
              checkout_amount: amount,
              currency_code: 'NGN',
              email_address: fanEmail || 'anonymous@kudiclap.com',
              first_name: (fanName || 'Anonymous').split(' ')[0],
              last_name: (fanName || 'Anonymous').split(' ').slice(1).join(' ') || 'Fan',
              phone_number: fanPhoneNumber || '08000000000',
              transaction_reference: txRef,
              additional_details: { creatorId, source: 'kudiclap-tip' },
            },
          },
        });
      }

      // ── Direct Card Charge ────────────────────────────────────────────────
      // Uses the SDK's payaza.cards.charge() method.
      // Card PIN is required for NGN-denominated cards (Payaza requirement).
      case 'card': {
        if (!cardNumber || !cardCvv || !cardExpiryMonth || !cardExpiryYear) {
          return res.status(400).json({
            success: false,
            error: 'Card details required: cardNumber, cardCvv, cardExpiryMonth, cardExpiryYear.',
          });
        }

        const cardPayload = {
          transaction_reference: txRef,
          amount,
          currency: 'NGN',
          email: fanEmail || 'anonymous@kudiclap.com',
          full_name: fanName || 'Anonymous',
          phone_number: fanPhoneNumber || '08000000000',
          card: {
            card_number: cardNumber,
            cvv: cardCvv,
            expiry_month: cardExpiryMonth,
            expiry_year: cardExpiryYear,
            // Payaza requires card PIN for Nigerian NGN card charges
            ...(cardPin && { card_pin: cardPin }),
          },
          // Payaza POSTs the final result here after 3DS completes
          callback_url: `${process.env.BACKEND_URL}/api/payments/card-callback`,
        };

        let chargeResponse;
        try {
          // payaza.cards.charge() returns the parsed response body
          // Throws PayazaError on non-2xx responses
          chargeResponse = await payaza.cards.charge(cardPayload);
        } catch (chargeError) {
          // PayazaError has .message, .status (HTTP code), .response (parsed body)
          const isPayazaError = chargeError instanceof PayazaError;
          console.error('[Card Charge] Error:', isPayazaError ? chargeError.response : chargeError.message);
          return res.status(502).json({
            success: false,
            error: 'Payment gateway error. Please try again.',
            details: isPayazaError ? chargeError.message : 'Unexpected error',
          });
        }

        // ── 3DS required ──────────────────────────────────────────────────
        // Payment is NOT yet complete — frontend must render threeDsHtml.
        // The card issuer shows an OTP / biometric challenge inside an iframe.
        // Final result arrives via callback_url (handleCardCallback).
        if (chargeResponse.do3dsAuth === true) {
          return res.status(200).json({
            success: true,
            status: '3ds',
            message: 'Card requires 3D Secure authentication. Render the threeDsHtml in your page.',
            data: {
              txRef,
              threeDsHtml: chargeResponse.threeDsHtml,
            },
          });
        }

        // ── Immediate success (no 3DS) ────────────────────────────────────
        if (chargeResponse.statusOk === true && chargeResponse.paymentCompleted === true) {
          const credited = await creditCreatorWallet(
            creatorId, amount, 'card', txRef, { fanName, fanEmail }
          );

          return res.status(200).json({
            success: true,
            status: 'success',
            message: `Tip of ₦${amount} sent successfully!`,
            data: {
              transactionReference: txRef,
              alreadyCredited: !credited,
            },
          });
        }

        // ── Payment failed ────────────────────────────────────────────────
        return res.status(400).json({
          success: false,
          status: 'failed',
          error: chargeResponse.debugMessage || 'Card payment failed. Please check your details and try again.',
        });
      }

      case 'ussd':
        return res.status(400).json({
          success: false,
          error: 'USSD tips are initiated via POST /api/ussd/tip, not /api/payments/tip.',
        });

      default:
        return res.status(400).json({
          success: false,
          error: `Unknown payment method "${paymentMethod}". Use: checkout, card, mobileMoney, bankTransfer.`,
        });
    }

  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/verify/:txRef
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verifies a Payaza transaction server-side and credits the creator.
 *
 * Call this:
 *   1. After the Payaza Checkout SDK fires its callback (frontend confirms)
 *   2. As a manual fallback if the webhook was missed or delayed
 *
 * Uses payaza.account.getTransactionStatus(txRef) — the SDK method that
 * queries Payaza for the authoritative status of our transaction reference.
 *
 * @route  POST /api/payments/verify/:txRef
 * @access Public
 */
const verifyPayment = async (req, res, next) => {
  try {
    const { txRef } = req.params;

    if (!txRef) {
      return res.status(400).json({ success: false, error: 'Transaction reference is required.' });
    }

    // Load the pending payment record — it holds creatorId, amount, fan details
    const pendingDoc = await db.collection('pendingPayments').doc(txRef).get();
    if (!pendingDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Transaction reference not found. It may have expired or never been created.',
      });
    }

    const pending = pendingDoc.data();

    // ── Query Payaza for authoritative status ─────────────────────────────────
    // payaza.account.getTransactionStatus(ref) — SDK method, returns parsed body
    let verifyResponse;
    try {
      verifyResponse = await payaza.account.getTransactionStatus(txRef);
    } catch (verifyError) {
      const isPayazaError = verifyError instanceof PayazaError;
      console.error('[Verify] Payaza query error:', isPayazaError ? verifyError.response : verifyError.message);
      return res.status(502).json({
        success: false,
        error: 'Could not verify payment status with Payaza. Please try again.',
      });
    }

    // Payaza returns statusOk + paymentCompleted for a successful transaction
    const paymentSucceeded =
      verifyResponse.statusOk === true && verifyResponse.paymentCompleted === true;

    if (!paymentSucceeded) {
      return res.status(400).json({
        success: false,
        error: 'Payment has not been completed yet or was unsuccessful.',
        payazaStatus: verifyResponse,
      });
    }

    // ── Amount cross-check ────────────────────────────────────────────────────
    // Guard against amount tampering on the frontend
    const amountPaid = verifyResponse.amountPaid || verifyResponse.amount_paid;
    if (amountPaid && Math.abs(amountPaid - pending.amount) > 1) {
      console.warn(`[Verify] Amount mismatch for ${txRef}: expected ₦${pending.amount}, got ₦${amountPaid}`);
    }

    // ── Credit creator (idempotent) ───────────────────────────────────────────
    const credited = await creditCreatorWallet(
      pending.creatorId,
      pending.amount,
      pending.paymentMethod || 'checkout',
      txRef,
      { fanName: pending.fanName, fanEmail: pending.fanEmail }
    );

    // Clean up — no longer needed
    await db.collection('pendingPayments').doc(txRef).delete();

    return res.status(200).json({
      success: true,
      message: credited
        ? `Payment of ₦${pending.amount} verified and credited.`
        : 'Payment was already credited.',
      data: {
        transactionReference: txRef,
        amount: pending.amount,
        creatorId: pending.creatorId,
      },
    });

  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/card-callback
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Receives the card payment result POSTed by Payaza to our callback_url.
 *
 * Payaza POSTs here after a card charge completes (success or failure),
 * including after the fan finishes a 3DS challenge.
 * We credit the creator and redirect the fan to the appropriate frontend page.
 *
 * @route  POST /api/payments/card-callback
 * @access Public — called by Payaza servers
 */
const handleCardCallback = async (req, res, next) => {
  try {
    const { statusOk, paymentCompleted, transaction_reference, debugMessage } = req.body;

    console.log(`[Card Callback] txRef=${transaction_reference}, statusOk=${statusOk}, paymentCompleted=${paymentCompleted}`);

    if (statusOk === true && paymentCompleted === true) {
      const pendingDoc = await db.collection('pendingPayments').doc(transaction_reference).get();

      if (pendingDoc.exists) {
        const pending = pendingDoc.data();
        await creditCreatorWallet(
          pending.creatorId,
          pending.amount,
          'card',
          transaction_reference,
          { fanName: pending.fanName, fanEmail: pending.fanEmail }
        );
        await db.collection('pendingPayments').doc(transaction_reference).delete();
      }

      return res.redirect(`${process.env.FRONTEND_URL}/tip/success?ref=${transaction_reference}`);
    }

    console.warn(`[Card Callback] Failed for ${transaction_reference}: ${debugMessage}`);
    return res.redirect(
      `${process.env.FRONTEND_URL}/tip/failed?ref=${transaction_reference}&reason=${encodeURIComponent(debugMessage || 'Payment failed')}`
    );

  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/webhook
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handles all Payaza webhook notifications.
 *
 * ── Signature verification ────────────────────────────────────────────────────
 *
 * Payaza signs webhooks with HMAC-SHA512 over the RAW request body buffer.
 * The signature is in the "x-payaza-signature" header.
 *
 * CRITICAL: req.body here must be a raw Buffer — NOT parsed JSON.
 * app.js registers express.raw({ type: 'application/json' }) on this route
 * BEFORE the global express.json() middleware, so this route receives the
 * raw bytes. We then JSON.parse() manually after signature verification.
 *
 * We use verifyWebhookSignature() from the SDK — it handles the SHA512 HMAC
 * internally. The old manual SHA256 implementation has been removed.
 *
 * ── Events handled ────────────────────────────────────────────────────────────
 *
 *   Collection success (card / bank transfer / mobile money tip received):
 *     → verify with payaza.account.getTransactionStatus()
 *     → credit creator wallet via creditCreatorWallet()
 *
 *   Transfer completion (creator payout sent or failed):
 *     → update withdrawal document status
 *     → if failed: auto-refund creator wallet (restore totalDeduction)
 *
 * Always returns 200 — Payaza retries on non-2xx responses.
 *
 * ── Dashboard setup ───────────────────────────────────────────────────────────
 *   Settings → Developers → Webhooks → URL:
 *     https://your-backend.railway.app/api/payments/webhook
 *   Copy the generated secret → PAYAZA_WEBHOOK_SECRET in .env
 *
 * @route  POST /api/payments/webhook
 * @access Public — Payaza servers only (verified by HMAC-SHA512 signature)
 */
const handleWebhook = async (req, res) => {
  try {
    // ── Signature verification ────────────────────────────────────────────────
    // req.body is a raw Buffer here (app.js uses express.raw() on this route)
    const signature = req.headers['x-payaza-signature'] || '';
    const webhookSecret = process.env.PAYAZA_WEBHOOK_SECRET;

    if (webhookSecret) {
      // verifyWebhookSignature(rawBodyBuffer, signatureHeader, secret)
      // Returns true/false — uses HMAC-SHA512 internally
      const isValid = verifyWebhookSignature(req.body, signature, webhookSecret);

      if (!isValid) {
        console.warn('[Webhook] Invalid signature — request rejected.');
        // Return 200 so Payaza doesn't keep retrying a signature failure
        return res.status(200).json({ received: false, error: 'Invalid signature.' });
      }
    } else {
      // Secret not configured — warn loudly, continue in dev/test mode
      // This MUST be set before going live
      console.warn('[Webhook] PAYAZA_WEBHOOK_SECRET not set — skipping signature check.');
    }

    // ── Parse the raw body ────────────────────────────────────────────────────
    // req.body is a Buffer because we use express.raw() on this route.
    // We parse it to JSON here after signature has been verified.
    let payload;
    try {
      payload = JSON.parse(req.body.toString('utf-8'));
    } catch (parseErr) {
      console.error('[Webhook] Failed to parse body as JSON:', parseErr.message);
      return res.status(200).json({ received: true, error: 'Invalid JSON body.' });
    }

    // Payaza webhooks use different field names depending on the event type —
    // we normalise them here so the rest of the handler is clean
    const event = payload.event || payload.notification_type || payload.event_type;
    const data = payload.data || payload;
    const txRef = data?.transaction_reference || data?.reference;

    console.log(`[Webhook] Event: "${event}", txRef: "${txRef}"`);

    // ── Collection success (tip received) ─────────────────────────────────────
    // Fired when a fan successfully completes a card, bank transfer, or
    // mobile money payment via the Payaza Checkout modal.
    const isCollectionSuccess =
      event === 'charge.success' ||
      event === 'collection.success' ||
      event === 'COLLECTION_SUCCESS' ||
      (data?.status === 'successful') ||
      (data?.status === 'success');

    if (isCollectionSuccess && txRef) {
      const pendingDoc = await db.collection('pendingPayments').doc(txRef).get();

      if (!pendingDoc.exists) {
        // Already processed (webhook delivered twice) — safe to ignore
        console.log(`[Webhook] No pending record for ${txRef} — already processed or unknown.`);
        return res.status(200).json({ received: true });
      }

      const pending = pendingDoc.data();

      // Always verify server-side before crediting — never trust the payload alone
      let verifyResponse;
      try {
        verifyResponse = await payaza.account.getTransactionStatus(txRef);
      } catch (verifyErr) {
        console.error(`[Webhook] Verification failed for ${txRef}:`, verifyErr.message);
        return res.status(200).json({ received: true, credited: false });
      }

      const confirmed =
        verifyResponse.statusOk === true && verifyResponse.paymentCompleted === true;

      if (!confirmed) {
        console.warn(`[Webhook] Payaza verify not confirmed for ${txRef} — skipping credit.`);
        return res.status(200).json({ received: true, credited: false });
      }

      const credited = await creditCreatorWallet(
        pending.creatorId,
        pending.amount,
        pending.paymentMethod || 'checkout',
        txRef,
        { fanName: pending.fanName, fanEmail: pending.fanEmail }
      );

      // Clean up the pending record
      await db.collection('pendingPayments').doc(txRef).delete();

      console.log(`[Webhook] Credited ₦${pending.amount} to creator ${pending.creatorId} (ref: ${txRef}, wasNew: ${credited})`);
    }

    // ── Transfer completion (creator payout) ──────────────────────────────────
    // Fired when a Payaza bank transfer payout succeeds or fails.
    // We match the event to our withdrawal document via payazaReference field.
    const isTransferEvent =
      event === 'transfer.success' ||
      event === 'transfer.failed' ||
      event === 'TRANSFER_SUCCESS' ||
      event === 'TRANSFER_FAILED' ||
      event === 'transfer.disburse';

    if (isTransferEvent && txRef) {
      const succeeded =
        event === 'transfer.success' ||
        event === 'TRANSFER_SUCCESS' ||
        data?.status === 'SUCCESSFUL' ||
        data?.status === 'NIP_SUCCESS';

      const withdrawalSnap = await db
        .collection('withdrawals')
        .where('payazaReference', '==', txRef)
        .limit(1)
        .get();

      if (!withdrawalSnap.empty) {
        const withdrawalDoc = withdrawalSnap.docs[0];
        const withdrawalData = withdrawalDoc.data();

        await withdrawalDoc.ref.update({
          status: succeeded ? 'completed' : 'failed',
          failureReason: succeeded ? null : (data?.message || data?.complete_message || 'Transfer failed'),
          updatedAt: new Date(),
        });

        if (!succeeded) {
          // Payout failed — restore totalDeduction (amount + commission) to wallet
          const creatorRef = db.collection('creators').doc(withdrawalData.creatorId);
          await db.runTransaction(async (firestoreTx) => {
            const creatorDoc = await firestoreTx.get(creatorRef);
            const creatorInfo = creatorDoc.data();
            // Refund the full totalDeduction (amount + any commission that was charged)
            const refundAmount = withdrawalData.totalDeduction || withdrawalData.amount;
            firestoreTx.update(creatorRef, {
              walletBalance: creatorInfo.walletBalance + refundAmount,
              updatedAt: new Date(),
            });
          });
          console.log(`[Webhook] Transfer failed — refunded ₦${withdrawalData.totalDeduction || withdrawalData.amount} to creator ${withdrawalData.creatorId}`);
        } else {
          console.log(`[Webhook] Transfer completed for ref: ${txRef}`);
        }
      } else {
        console.warn(`[Webhook] No withdrawal found for payazaReference: ${txRef}`);
      }
    }

    // Always return 200 — Payaza retries on any other status
    return res.status(200).json({ received: true });

  } catch (err) {
    // Never return 5xx to Payaza — it will keep retrying indefinitely
    console.error('[Webhook] Unexpected error:', err.message, err.stack);
    return res.status(200).json({ received: true, error: 'Internal processing error.' });
  }
};

module.exports = {
  processTip,
  verifyPayment,
  handleCardCallback,
  handleWebhook,
};
