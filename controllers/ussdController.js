/**
 * controllers/ussdController.js
 *
 * Handles KudiClap USSD shortcode payments.
 *
 * ── What happens when a fan dials *388*12345# ─────────────────────────────────
 *
 *   In production (with a real USSD gateway):
 *     1. Fan dials *388*12345# on any phone
 *     2. The telco routes the request to our USSD gateway (e.g. Twilio, Infobip,
 *        or a direct MTN/Airtel USSD API partnership)
 *     3. The gateway POSTs to POST /api/ussd with the code + fan phone number
 *     4. We look up the creator, initiate a Payaza checkout, and return a
 *        USSD menu response telling the fan to confirm the payment on their phone
 *
 *   For the hackathon / MVP (simulated USSD):
 *     The frontend renders a form where the fan types the USSD code, their
 *     phone number, and the tip amount. The form POSTs to /api/ussd.
 *     We look up the creator and return a Payaza checkout reference.
 *     The fan then completes payment via the Payaza modal on the web.
 *
 * ── Why we no longer call Flutterwave here ────────────────────────────────────
 *   The previous implementation called flw.MobileMoney.ng() directly.
 *   We now generate a Payaza checkout reference and return it — consistent
 *   with how all other payment methods work in paymentController.js.
 *
 * Exported functions:
 *   - processUssdPayment → POST /api/ussd
 */

const { db } = require('../config/firebase');
const { validateUssdPayment } = require('../utils/validation');

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ussd
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Processes a USSD tip request — looks up the creator and returns a
 * Payaza checkout reference for the fan to complete payment.
 *
 * Steps:
 *   1. Validate the USSD code, amount, and fan phone number
 *   2. Look up the creator that owns this USSD code in Firestore
 *   3. Generate a unique transaction reference
 *   4. Store a pending payment record (same as processTip does)
 *   5. Return the checkout params the frontend (or USSD gateway) needs
 *
 * @route  POST /api/ussd
 * @access Public — simulates what a USSD gateway POSTs to us
 */
const processUssdPayment = async (req, res, next) => {
  try {
    // ── Validate the incoming USSD request ────────────────────────────────────
    const { error, value } = validateUssdPayment(req.body);
    if (error) {
      return res.status(400).json({ success: false, error: error.details[0].message });
    }

    const { ussdCode, amount, fanPhoneNumber } = value;

    // ── Look up the creator by their USSD code ────────────────────────────────
    // ussdCode is unique per creator — stored in Firestore when they sign up.
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

    // ── Generate a unique transaction reference ───────────────────────────────
    // Same format as processTip — kc-{creatorId prefix}-{timestamp suffix}
    const txRef = `kc-${creatorId.substring(0, 8)}-${Date.now().toString().slice(-6)}`;

    // ── Store a pending payment record ────────────────────────────────────────
    // verifyPayment() and handleWebhook() look this up to credit the creator.
    await db.collection('pendingPayments').doc(txRef).set({
      txRef,
      creatorId,
      amount,
      paymentMethod: 'ussd',           // Identifies this as a USSD-initiated payment
      fanName: 'USSD User',            // Fan is anonymous on USSD
      fanEmail: '',
      fanPhoneNumber,
      ussdCode,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30-minute expiry
    });

    // ── Return checkout params for the fan to complete payment ────────────────
    // In production with a real USSD gateway, we'd return a USSD menu response
    // and the gateway would handle the STK push / PIN entry on the fan's phone.
    //
    // For the MVP, we return the Payaza checkout params so the fan can complete
    // payment via the web modal if needed.
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
        // Payaza Web Checkout SDK params for the frontend to render the modal
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
          additional_details: {
            creatorId,
            source: 'kudiclap-ussd',
            ussdCode,
          },
        },
      },
    });

  } catch (err) {
    next(err);
  }
};

module.exports = { processUssdPayment };
