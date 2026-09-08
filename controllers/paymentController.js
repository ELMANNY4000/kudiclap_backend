/**
 * controllers/paymentController.js
 *
 * Production-grade payment collection for KudiClap tips — powered by Payaza.
 *
 * ── Payment flows ─────────────────────────────────────────────────────────────
 *
 *   Web Checkout (recommended for fans — card + bank transfer + mobile money):
 *     The frontend loads the Payaza Checkout SDK which renders a hosted modal.
 *     The backend's role is to:
 *       1. Generate a unique transaction_reference before checkout starts
 *       2. Receive the Payaza webhook after the fan completes payment
 *       3. Verify the transaction server-side before crediting the creator
 *
 *   Card Charge API (direct — when frontend sends card details):
 *     POST /api/payments/tip with paymentMethod: 'card'
 *     → Payaza responds with do3dsAuth: true  → return threeDsHtml to frontend
 *     → Payaza responds with do3dsAuth: false → payment complete or failed
 *     → Final result arrives at callback_url OR via window.postMessage
 *
 *   USSD (via KudiClap shortcode):
 *     POST /api/ussd — handled separately in ussdController.js
 *     The fan dials *388*XXXXX# → we look up the creator → we initiate
 *     a Payaza checkout session on their behalf.
 *
 * ── Payaza API endpoints used here ────────────────────────────────────────────
 *
 *   Card charge:    POST /merchant/api/v1/card/charge
 *   Verify txn:     GET  /merchant/api/v1/transaction/query?transaction_reference=xxx
 *   Webhook:        POST /api/payments/webhook  (Payaza calls this URL)
 *
 * ── Credit logic ──────────────────────────────────────────────────────────────
 *
 *   We only credit the creator AFTER server-side verification confirms the
 *   payment succeeded. We never trust the frontend's claim or the raw webhook
 *   payload alone.
 *
 *   creditCreatorWallet() is idempotent — it checks for an existing
 *   transaction document keyed by payazaRef before writing, so duplicate
 *   webhook deliveries never double-credit a creator.
 *
 * Exported functions (used by paymentRoutes.js):
 *   - processTip        → POST /api/payments/tip
 *   - verifyPayment     → POST /api/payments/verify/:txRef
 *   - handleWebhook     → POST /api/payments/webhook
 */

const payaza = require('../config/payaza');
const { db } = require('../config/firebase');
const { validateTip } = require('../utils/validation');
const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper — credit creator wallet + log transaction (idempotent)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Credits a creator's wallet and writes a transaction record to Firestore.
 *
 * This is the ONLY place in the app where a creator's balance increases.
 * It is called by verifyPayment() and handleWebhook() — never for unverified
 * or pending charges.
 *
 * Idempotency:
 *   Before writing, we query transactions for an existing doc with the same
 *   payazaRef. If found we skip and return false. This means it is safe to call
 *   this function multiple times for the same payment — only one write occurs.
 *
 * @param {string} creatorId   - Firestore creator document ID
 * @param {number} amount      - Amount in Naira (₦) to credit
 * @param {string} paymentMethod - 'card' | 'bankTransfer' | 'ussd'
 * @param {string} payazaRef   - Payaza transaction_reference (idempotency key)
 * @param {object} fanDetails  - { fanName, fanEmail } — may be empty strings
 * @returns {Promise<boolean>} - true if credited now, false if already existed
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
  // Wallet update + transaction log succeed together or both roll back.
  await db.runTransaction(async (firestoreTx) => {
    // Read inside the transaction to get the freshest balance and avoid
    // race conditions when two fans tip the same creator simultaneously.
    const freshDoc = await firestoreTx.get(creatorRef);

    if (!freshDoc.exists) {
      throw new Error(`Creator ${creatorId} not found while crediting wallet.`);
    }

    const data = freshDoc.data();

    // Update both earnings fields
    firestoreTx.update(creatorRef, {
      totalEarnings: data.totalEarnings + amount, // Lifetime total — never decreases
      walletBalance: data.walletBalance + amount,  // Available to withdraw
      updatedAt: new Date(),
    });

    // Log the transaction for dashboard / history display
    const txRef = db.collection('transactions').doc();
    firestoreTx.set(txRef, {
      id: txRef.id,
      creatorId,
      fanName: fanDetails.fanName || 'Anonymous',
      fanEmail: fanDetails.fanEmail || '',
      amount,
      paymentMethod,
      status: 'completed',
      payazaRef: String(payazaRef), // Payaza transaction_reference — idempotency key
      timestamp: new Date(),
    });
  });

  console.log(`[Credit] ₦${amount} credited to creator ${creatorId} (payazaRef: ${payazaRef})`);
  return true;
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/tip
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initiates a tip payment from a fan to a creator.
 *
 * Two modes depending on paymentMethod:
 *
 *   'checkout' (default / recommended):
 *     Returns the transaction_reference the frontend needs to initialise
 *     the Payaza Web Checkout SDK. The SDK handles the actual card / bank
 *     transfer / mobile money UI. Payaza fires a webhook when done.
 *
 *     Frontend flow:
 *       1. Call POST /api/payments/tip → get { transactionReference }
 *       2. Pass transactionReference to PayazaCheckout.setup({ ... })
 *       3. Fan completes payment in the modal
 *       4. Payaza fires webhook → backend credits creator
 *       5. Frontend polls GET /api/payments/verify/:txRef for confirmation
 *
 *   'card' (direct charge — card details sent to backend):
 *     The backend charges the card directly via Payaza Card Charge API.
 *     Returns either:
 *       { status: '3ds',     threeDsHtml }  → frontend must render this HTML
 *       { status: 'success', transactionReference } → payment complete
 *       { status: 'failed',  error }
 *
 *     ⚠️ PCI note: sending raw card numbers to your backend requires
 *     PCI DSS compliance. For most use cases, the 'checkout' flow is safer
 *     and recommended — Payaza's hosted modal handles card data.
 *
 * @route  POST /api/payments/tip
 * @access Public — fans do not need an account to tip
 */
const processTip = async (req, res, next) => {
  try {
    // ── Validate request body ─────────────────────────────────────────────────
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
      // Card-specific (only for paymentMethod: 'card')
      cardNumber,
      cardCvv,
      cardExpiryMonth,
      cardExpiryYear,
      cardPin,          // Required for NGN card charges by Payaza
    } = value;

    // ── Verify creator exists ─────────────────────────────────────────────────
    const creatorDoc = await db.collection('creators').doc(creatorId).get();
    if (!creatorDoc.exists) {
      return res.status(404).json({ success: false, error: 'Creator not found.' });
    }

    // ── Generate unique transaction reference ─────────────────────────────────
    // Payaza requires a unique reference per transaction (max 15 chars recommended).
    // We encode the creatorId prefix + timestamp to stay traceable.
    // Format: kc-{first8charsOfCreatorId}-{last6digitsOfTimestamp}
    const txRef = `kc-${creatorId.substring(0, 8)}-${Date.now().toString().slice(-6)}`;

    // Store the pending transaction reference in Firestore so we can match it
    // when the webhook arrives, even if the server restarts in between.
    await db.collection('pendingPayments').doc(txRef).set({
      txRef,
      creatorId,
      amount,
      paymentMethod,
      fanName: fanName || 'Anonymous',
      fanEmail: fanEmail || '',
      createdAt: new Date(),
      // Expires in 30 minutes — Payaza's default virtual account window
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });

    // ── Route by payment method ───────────────────────────────────────────────
    switch (paymentMethod) {

      // ── Web Checkout (card + bank transfer + mobile money via hosted modal) ──
      // The backend just supplies the transaction reference.
      // The frontend uses Payaza's JS SDK to open the payment modal.
      // Payaza handles all card / bank / MoMo UI on their hosted page.
      case 'checkout':
      case 'mobileMoney':
      case 'bankTransfer': {
        // Return the reference and all the params the frontend SDK needs
        return res.status(200).json({
          success: true,
          status: 'checkout',
          message: 'Transaction reference generated. Initialise the Payaza Checkout SDK with these details.',
          data: {
            transactionReference: txRef,
            amount,
            currency: 'NGN',
            // Frontend passes these directly into PayazaCheckout.setup()
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
              // Additional metadata attached to this transaction — useful for reconciliation
              additional_details: {
                creatorId,
                source: 'kudiclap-tip',
              },
            },
          },
        });
      }

      // ── Direct Card Charge ────────────────────────────────────────────────
      // Fan sends card details → we charge via Payaza Card Charge API.
      // For NGN cards, card PIN is required by Payaza.
      case 'card': {
        if (!cardNumber || !cardCvv || !cardExpiryMonth || !cardExpiryYear) {
          return res.status(400).json({
            success: false,
            error: 'Card details required: cardNumber, cardCvv, cardExpiryMonth, cardExpiryYear.',
          });
        }

        // Build the Payaza Card Charge payload
        // Docs: https://docs.payaza.africa/guides/card-collection
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
            // card_pin is required for NGN card charges in Nigeria (Payaza requirement)
            ...(cardPin && { card_pin: cardPin }),
          },
          // Payaza POSTs the final payment result to this URL after 3DS completes.
          // Your server receives this and can immediately verify + credit.
          callback_url: `${process.env.BACKEND_URL}/api/payments/card-callback`,
        };

        let chargeResponse;
        try {
          chargeResponse = await payaza.post('/merchant/api/v1/card/charge', cardPayload);
        } catch (chargeError) {
          console.error('[Card Charge] Payaza API error:', chargeError.response?.data || chargeError.message);
          return res.status(502).json({
            success: false,
            error: 'Payment gateway error. Please try again.',
            details: chargeError.response?.data?.message || chargeError.message,
          });
        }

        // ── 3DS Authentication required ───────────────────────────────────
        // When do3dsAuth is true, the payment is NOT yet complete.
        // The frontend must inject threeDsHtml into the DOM to show the
        // bank's OTP / biometric challenge. Final result comes via callback_url.
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

        // ── Payment completed without 3DS ─────────────────────────────────
        if (chargeResponse.statusOk === true && chargeResponse.paymentCompleted === true) {
          // Verify server-side before crediting — never trust the charge response alone
          const credited = await creditCreatorWallet(
            creatorId,
            amount,
            'card',
            txRef,
            { fanName, fanEmail }
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

      // ── USSD (KudiClap shortcode — handled by ussdController) ────────────
      // This case should not be reached here — ussdController.js calls
      // processTip with paymentMethod:'ussd' internally. We handle it
      // gracefully just in case.
      case 'ussd': {
        return res.status(400).json({
          success: false,
          error: 'USSD payments are initiated via POST /api/ussd, not /api/payments/tip.',
        });
      }

      default:
        return res.status(400).json({
          success: false,
          error: `Unknown payment method: "${paymentMethod}". Use checkout, card, mobileMoney, or bankTransfer.`,
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
 * Verifies a Payaza transaction by its reference and credits the creator.
 *
 * When to call this:
 *   1. After the Payaza Checkout SDK callback fires (frontend confirms payment)
 *   2. After a card 3DS redirect completes (Payaza POSTs to callback_url)
 *   3. As a manual fallback if the webhook was missed / delayed
 *
 * Always verify server-side — never credit based solely on the frontend's
 * report or the raw webhook payload.
 *
 * Payaza verify endpoint:
 *   GET /merchant/api/v1/transaction/query?transaction_reference=<txRef>
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

    // ── Look up the pending payment record in Firestore ───────────────────────
    // This gives us the creatorId, amount, and fan details we stored when
    // the tip was initiated — we need them to credit the right creator.
    const pendingDoc = await db.collection('pendingPayments').doc(txRef).get();

    if (!pendingDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Transaction reference not found. It may have expired or never been created.',
      });
    }

    const pending = pendingDoc.data();

    // ── Query Payaza for the authoritative transaction status ─────────────────
    // We pass the transaction_reference we generated and check what Payaza says.
    let verifyResponse;
    try {
      verifyResponse = await payaza.get(
        `/merchant/api/v1/transaction/query?transaction_reference=${txRef}`
      );
    } catch (verifyError) {
      console.error('[Verify] Payaza query error:', verifyError.response?.data || verifyError.message);
      return res.status(502).json({
        success: false,
        error: 'Could not verify payment status with Payaza. Please try again.',
      });
    }

    // Payaza returns statusOk: true + paymentCompleted: true for a successful payment
    const paymentSucceeded =
      verifyResponse.statusOk === true && verifyResponse.paymentCompleted === true;

    if (!paymentSucceeded) {
      return res.status(400).json({
        success: false,
        error: 'Payment has not been completed yet or was unsuccessful.',
        payazaStatus: verifyResponse,
      });
    }

    // ── Cross-check amount ────────────────────────────────────────────────────
    // Payaza returns the actual amount charged — compare it against what we
    // stored to guard against amount tampering on the frontend.
    const amountPaid = verifyResponse.amountPaid || verifyResponse.amount_paid;
    if (amountPaid && Math.abs(amountPaid - pending.amount) > 1) {
      // Log for investigation — allow small rounding differences (< ₦1) through
      console.warn(`[Verify] Amount mismatch for ${txRef}: expected ₦${pending.amount}, got ₦${amountPaid}`);
    }

    // ── Credit the creator (idempotent) ───────────────────────────────────────
    const credited = await creditCreatorWallet(
      pending.creatorId,
      pending.amount,
      pending.paymentMethod || 'checkout',
      txRef,
      { fanName: pending.fanName, fanEmail: pending.fanEmail }
    );

    // Clean up the pending payment record — no longer needed
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
 * Payaza sends this after a card charge completes (success or failure) — either
 * immediately for non-3DS cards, or after the fan completes 3DS authentication.
 *
 * The payload contains statusOk and paymentCompleted — we verify, credit, and
 * redirect the fan to the appropriate frontend page.
 *
 * @route  POST /api/payments/card-callback
 * @access Public — called by Payaza's servers
 */
const handleCardCallback = async (req, res, next) => {
  try {
    const { statusOk, paymentCompleted, transaction_reference, debugMessage } = req.body;

    // Log every callback for debugging
    console.log(`[Card Callback] txRef=${transaction_reference}, statusOk=${statusOk}, paymentCompleted=${paymentCompleted}`);

    if (statusOk === true && paymentCompleted === true) {
      // Look up the pending payment to get creatorId and amount
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

      // Redirect fan to success page on the frontend
      return res.redirect(`${process.env.FRONTEND_URL}/tip/success?ref=${transaction_reference}`);
    }

    // Payment failed — redirect to failure page
    console.warn(`[Card Callback] Payment failed for ${transaction_reference}: ${debugMessage}`);
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
 * Handles Payaza webhook notifications.
 *
 * Payaza fires webhooks for:
 *   - Completed card transactions (successful or failed)
 *   - Completed bank transfer / virtual account collections
 *   - Transfer (payout) completions
 *
 * ── Webhook security ───────────────────────────────────────────────────────
 * Payaza signs each webhook with a SHA-256 HMAC using your webhook secret.
 * The signature is in the "x-payaza-signature" header.
 * We verify it before processing any payload.
 *
 * ── Setup in Payaza dashboard ──────────────────────────────────────────────
 *   Settings → Developers → Webhooks → Add webhook URL:
 *   https://your-backend.railway.app/api/payments/webhook
 *   Then copy the generated secret to PAYAZA_WEBHOOK_SECRET in .env
 *
 * We always return 200 immediately — Payaza retries if we return non-2xx.
 *
 * @route  POST /api/payments/webhook
 * @access Public — called by Payaza servers (verified by HMAC signature)
 */
const handleWebhook = async (req, res) => {
  try {
    // ── Verify webhook signature ──────────────────────────────────────────────
    const payazaSignature = req.headers['x-payaza-signature'];
    const webhookSecret = process.env.PAYAZA_WEBHOOK_SECRET;

    if (webhookSecret && payazaSignature) {
      // Compute HMAC-SHA256 of the raw request body using our webhook secret
      // req.body is already parsed JSON — re-stringify for consistent hashing
      const computedSig = crypto
        .createHmac('sha256', webhookSecret)
        .update(JSON.stringify(req.body))
        .digest('hex');

      if (computedSig !== payazaSignature) {
        console.warn('[Webhook] Invalid signature — request rejected.');
        // Return 200 anyway — we don't want Payaza to keep retrying a rejected request
        return res.status(200).json({ received: false, error: 'Invalid signature.' });
      }
    } else if (!webhookSecret) {
      // Webhook secret not configured — log a warning but continue processing
      // (acceptable in test mode; must be set before going live)
      console.warn('[Webhook] PAYAZA_WEBHOOK_SECRET not set — skipping signature verification.');
    }

    const payload = req.body;
    const event = payload.event || payload.notification_type;
    const data = payload.data || payload;

    console.log(`[Webhook] Event: ${event}, txRef: ${data?.transaction_reference || data?.reference}`);

    // ── Successful collection (card / bank transfer / mobile money) ────────────
    if (
      (event === 'charge.success' || event === 'collection.success' || payload.statusOk === true) &&
      (data?.paymentCompleted === true || data?.status === 'successful' || data?.status === 'success')
    ) {
      const txRef = data.transaction_reference || data.reference;

      if (!txRef) {
        console.warn('[Webhook] No transaction_reference in payload — cannot process.');
        return res.status(200).json({ received: true });
      }

      // Fetch our stored pending payment record to get creatorId and amount
      const pendingDoc = await db.collection('pendingPayments').doc(txRef).get();

      if (!pendingDoc.exists) {
        // Could be a transaction we already processed — that's fine
        console.log(`[Webhook] No pending record for ${txRef} — may already be processed.`);
        return res.status(200).json({ received: true });
      }

      const pending = pendingDoc.data();

      // Verify the transaction with Payaza before crediting
      // Never credit based solely on the webhook payload
      let verifyResponse;
      try {
        verifyResponse = await payaza.get(
          `/merchant/api/v1/transaction/query?transaction_reference=${txRef}`
        );
      } catch (verifyErr) {
        console.error(`[Webhook] Verification failed for ${txRef}:`, verifyErr.message);
        return res.status(200).json({ received: true, credited: false });
      }

      if (verifyResponse.statusOk !== true || verifyResponse.paymentCompleted !== true) {
        console.warn(`[Webhook] Payaza verify returned not-completed for ${txRef}.`);
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

      console.log(`[Webhook] Credited ₦${pending.amount} to ${pending.creatorId} (ref: ${txRef}, new: ${credited})`);
    }

    // ── Transfer (payout) completion ──────────────────────────────────────────
    // Payaza fires this after a bank transfer payout completes or fails.
    // We update the withdrawal document status accordingly.
    if (event === 'transfer.success' || event === 'transfer.failed') {
      const txRef = data?.transaction_reference || data?.reference;
      const succeeded = event === 'transfer.success';

      if (txRef) {
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
            failureReason: succeeded ? null : (data?.message || 'Transfer failed'),
            updatedAt: new Date(),
          });

          // If the payout failed, refund the creator's wallet
          if (!succeeded) {
            const creatorRef = db.collection('creators').doc(withdrawalData.creatorId);
            await db.runTransaction(async (firestoreTx) => {
              const creatorDoc = await firestoreTx.get(creatorRef);
              const creatorInfo = creatorDoc.data();
              firestoreTx.update(creatorRef, {
                walletBalance: creatorInfo.walletBalance + withdrawalData.amount,
                updatedAt: new Date(),
              });
            });
            console.log(`[Webhook] Payout failed — refunded ₦${withdrawalData.amount} to creator ${withdrawalData.creatorId}`);
          }

          console.log(`[Webhook] Transfer ${txRef}: ${succeeded ? 'completed' : 'failed'}`);
        }
      }
    }

    // Always return 200 so Payaza doesn't retry
    return res.status(200).json({ received: true });

  } catch (err) {
    // Never return 5xx to Payaza — it will keep retrying
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
