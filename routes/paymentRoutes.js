/**
 * routes/paymentRoutes.js
 *
 * Payment collection routes — powered by Payaza.
 *
 * Base path: /api/payments  (registered in app.js)
 *
 * Routes:
 *   POST /api/payments/tip                  → Initiate a tip (returns checkout params or charges card)
 *   POST /api/payments/verify/:txRef        → Verify + credit after checkout completes
 *   POST /api/payments/card-callback        → Payaza POSTs card result here after 3DS
 *   POST /api/payments/webhook              → All Payaza event notifications
 *
 * Auth:
 *   All collection routes are PUBLIC — fans don't need accounts to tip.
 *   The webhook is verified via HMAC-SHA256 signature.
 *   The card-callback is called by Payaza's servers (no user auth).
 *
 * Payaza Web Checkout flow:
 *   1. Frontend calls POST /tip → gets { transactionReference, checkoutParams }
 *   2. Frontend calls PayazaCheckout.setup(checkoutParams) to open the modal
 *   3. Fan completes payment → Payaza fires webhook → creator credited
 *   4. Frontend calls POST /verify/:txRef to get confirmation + new balance
 *
 * Direct card flow:
 *   1. Frontend calls POST /tip with paymentMethod:'card' + card details
 *   2. If { status:'3ds' } returned → frontend renders threeDsHtml
 *   3. After 3DS → Payaza POSTs to /card-callback → creator credited
 *   4. Frontend polls POST /verify/:txRef for confirmation
 */

const express = require('express');
const router = express.Router();

const {
  processTip,
  verifyPayment,
  handleCardCallback,
  handleWebhook,
} = require('../controllers/paymentController');

// POST /api/payments/tip
// Initiates a tip. Returns Payaza checkout params or charges card directly.
router.post('/tip', processTip);

// POST /api/payments/verify/:txRef
// Server-side verification after checkout / 3DS completes. Credits creator on success.
router.post('/verify/:txRef', verifyPayment);

// POST /api/payments/card-callback
// Payaza POSTs the final card payment result here after 3DS authentication.
// Received at the callback_url we pass in the card charge request.
router.post('/card-callback', handleCardCallback);

// POST /api/payments/webhook
// Payaza event notifications — charge completions, transfer results.
// Verified via HMAC-SHA256 signature in the x-payaza-signature header.
router.post('/webhook', handleWebhook);

module.exports = router;
