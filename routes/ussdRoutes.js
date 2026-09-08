/**
 * routes/ussdRoutes.js
 *
 * USSD routes for KudiClap.
 *
 * Base path: /api/ussd  (registered in app.js)
 *
 * Fan-facing (public):
 *   POST /api/ussd/tip                   → Fan tips a creator via USSD shortcode
 *
 * Creator-facing (protected — PIN required in request body):
 *   POST /api/ussd/withdraw/initiate     → Initiate a USSD withdrawal (PIN-verified)
 *   POST /api/ussd/withdraw/verify       → Confirm with the USSD confirmation code
 *   POST /api/ussd/withdraw/cancel       → Cancel a pending USSD withdrawal
 *
 * The legacy POST / route is kept for backward compatibility with any existing
 * clients that hit /api/ussd directly (maps to fan tipping).
 */

const express = require('express');
const router = express.Router();

const {
  processUssdTip,
  initiateUssdWithdrawal,
  verifyUssdWithdrawal,
  cancelUssdWithdrawal,
} = require('../controllers/ussdController');

const { protect } = require('../middlewares/authMiddleware');

// Fan tipping via USSD shortcode — public
router.post('/tip', processUssdTip);
router.post('/', processUssdTip); // Legacy compatibility (old frontend may use POST /api/ussd)

// Creator USSD withdrawal — all require authentication
router.post('/withdraw/initiate', protect, initiateUssdWithdrawal);
router.post('/withdraw/verify', protect, verifyUssdWithdrawal);
router.post('/withdraw/cancel', protect, cancelUssdWithdrawal);

module.exports = router;
