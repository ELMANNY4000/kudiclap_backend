/**
 * routes/transactionRoutes.js
 *
 * Defines all HTTP routes for reading transaction (tip) history.
 *
 * Base path: /api/transactions  (set in app.js)
 *
 * Routes:
 *   GET /api/transactions/:creatorId          → All transactions for a creator
 *   GET /api/transactions/single/:id          → A single transaction by its ID
 *
 * Query params supported on /:creatorId:
 *   ?limit=20       → how many results to return (default 20, max 100)
 *   ?method=card    → filter by payment method (card, mobileMoney, ussd)
 *
 * Example:
 *   GET /api/transactions/abc123?limit=50&method=mobileMoney
 *   → Returns the last 50 mobile money tips for creator abc123
 *
 * Route ordering note:
 *   /single/:id MUST come before /:creatorId — otherwise Express matches
 *   "single" as the :creatorId value, which would return no results.
 */

const express = require('express');
const router = express.Router();

// Controller functions
const {
  getCreatorTransactions,
  getSingleTransaction,
} = require('../controllers/transactionController');

// Auth middleware
const { protect } = require('../middlewares/authMiddleware');

// GET /api/transactions/single/:id
// Returns one specific transaction — useful for viewing tip details
// Must be defined BEFORE /:creatorId to avoid route collision
router.get('/single/:id', protect, getSingleTransaction);

// GET /api/transactions/:creatorId
// Returns all transactions for a creator, newest first
// Supports ?limit and ?method query filters
router.get('/:creatorId', protect, getCreatorTransactions);

module.exports = router;
