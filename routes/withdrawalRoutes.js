/**
 * routes/withdrawalRoutes.js
 *
 * Defines all HTTP routes for creator withdrawal requests.
 *
 * Base path: /api/withdrawals  (registered in app.js)
 *
 * Routes:
 *   POST /api/withdrawals                      → Request a cash-out
 *   GET  /api/withdrawals/:creatorId           → Creator's withdrawal history
 *   GET  /api/withdrawals/status/:withdrawalId → Status of a specific withdrawal
 *
 * Route ordering matters here:
 *   /status/:withdrawalId MUST come before /:creatorId — otherwise Express
 *   matches the string "status" as the :creatorId value.
 *
 * All routes require authentication — creators can only access their own data.
 */

const express = require('express');
const router = express.Router();

const {
  requestWithdrawal,
  getCreatorWithdrawals,
  getWithdrawalStatus,
} = require('../controllers/withdrawalController');

const { protect, isSameUser } = require('../middlewares/authMiddleware');

// POST /api/withdrawals
// Initiates a real Flutterwave Transfer payout to the creator's mobile number.
// Body: { creatorId, amount }  (minimum ₦500)
router.post('/', protect, requestWithdrawal);

// GET /api/withdrawals/status/:withdrawalId
// Returns current status of a single withdrawal — polls Flutterwave if still pending.
// MUST be defined before /:creatorId to avoid route collision.
router.get('/status/:withdrawalId', protect, getWithdrawalStatus);

// GET /api/withdrawals/:creatorId
// Returns full withdrawal history for a creator (newest first).
// Supports ?limit query param.
router.get('/:creatorId', protect, isSameUser, getCreatorWithdrawals);

module.exports = router;
