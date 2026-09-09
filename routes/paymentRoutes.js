/**
 * routes/paymentRoutes.js
 *
 * Payment-related routes — powered by Payaza.
 *
 * Base path: /api/payments  (registered in app.js)
 *
 * Public routes (no auth required):
 *   GET  /api/payments/banks              → List of Nigerian banks + codes
 *   POST /api/payments/tip                → Initiate a tip (checkout params or card charge)
 *   POST /api/payments/verify/:txRef      → Verify + credit after payment completes
 *   POST /api/payments/card-callback      → Payaza POSTs card result here after 3DS
 *   POST /api/payments/webhook            → All Payaza event notifications (HMAC-SHA512)
 *
 * Protected routes (login required):
 *   GET  /api/payments/enquire            → Resolve account number to account name
 *                                           ?accountNumber=0123456789&bankCode=044
 */

const express = require('express');
const router = express.Router();

const {
  processTip,
  verifyPayment,
  handleCardCallback,
  handleWebhook,
} = require('../controllers/paymentController');

const {
  getBankList,
  accountNameEnquiry,
} = require('../controllers/paymentHelperController');

const { protect } = require('../middlewares/authMiddleware');

// ── Public ────────────────────────────────────────────────────────────────────

// GET /api/payments/banks
// Returns list of Nigerian banks + bank codes for the "Add bank account" screen.
// Public — frontend needs this before a creator even signs in.
// Cached in memory for 24 hours.
router.get('/banks', getBankList);

// POST /api/payments/tip
// Initiates a tip. Returns Payaza checkout params or charges card directly.
router.post('/tip', processTip);

// POST /api/payments/verify/:txRef
// Server-side verification after checkout / 3DS completes. Credits creator on success.
router.post('/verify/:txRef', verifyPayment);

// POST /api/payments/card-callback
// Payaza POSTs the final card payment result here after 3DS authentication.
router.post('/card-callback', handleCardCallback);

// POST /api/payments/webhook
// All Payaza event notifications — verified via HMAC-SHA512 in x-payaza-signature.
// app.js registers express.raw() on this path before express.json() so the
// raw body Buffer is available for signature verification.
router.post('/webhook', handleWebhook);

// ── Protected ─────────────────────────────────────────────────────────────────

// GET /api/payments/enquire?accountNumber=0123456789&bankCode=044
// Resolves a bank account number + code to the account holder name.
// Creator calls this before saving their bank account to confirm it's correct.
router.get('/enquire', protect, accountNameEnquiry);

module.exports = router;
