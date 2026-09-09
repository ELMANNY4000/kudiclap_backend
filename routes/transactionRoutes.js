/**
 * routes/transactionRoutes.js
 *
 * Transaction history routes for KudiClap creators.
 *
 * Base path: /api/transactions  (registered in app.js)
 *
 * All routes require authentication — creators can only access their own data.
 *
 * Route ordering matters — specific paths before wildcard params:
 *   /single/:id and /:creatorId/summary MUST come before /:creatorId
 *   otherwise Express would match "single" or the ID as :creatorId.
 *
 * Routes:
 *   GET /api/transactions/single/:id            → one transaction by Firestore ID
 *   GET /api/transactions/:creatorId/summary    → aggregated stats (total, by method)
 *   GET /api/transactions/:creatorId            → full history (paginated, filterable)
 *
 * Query params on /:creatorId:
 *   ?limit=20       → results per page (default 20, max 100)
 *   ?method=card    → filter by paymentMethod
 *   ?after=<ISO>    → cursor for next page (pass last item's timestamp)
 */

const express = require('express');
const router = express.Router();

const {
  getCreatorTransactions,
  getSingleTransaction,
  getTransactionSummary,
} = require('../controllers/transactionController');

const { protect } = require('../middlewares/authMiddleware');

// GET /api/transactions/single/:id
// Single transaction by Firestore document ID — ownership check inside controller
// MUST be before /:creatorId to avoid route collision
router.get('/single/:id', protect, getSingleTransaction);

// GET /api/transactions/:creatorId/summary
// Aggregated stats for a creator — total tips, total amount, breakdown by method
// MUST be before /:creatorId to avoid "summary" being treated as :creatorId
router.get('/:creatorId/summary', protect, getTransactionSummary);

// GET /api/transactions/:creatorId
// Full transaction history — paginated, filterable by payment method
router.get('/:creatorId', protect, getCreatorTransactions);

module.exports = router;
