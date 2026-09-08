/**
 * controllers/transactionController.js
 *
 * Handles fetching transaction history for creators.
 *
 * A "transaction" in KudiClap is any tip that has been sent to a creator.
 * Transactions are written to Firestore automatically when a tip is processed
 * (inside paymentController.js). This controller only handles READ operations —
 * listing and viewing individual transactions.
 *
 * The creator uses this data on their dashboard to see:
 *   - Who tipped them and how much
 *   - Which payment method was used
 *   - Their transaction history over time
 *
 * Exported functions (used by transactionRoutes.js):
 *   - getCreatorTransactions → GET /api/transactions/:creatorId
 *   - getSingleTransaction   → GET /api/transactions/single/:id
 */

const { db } = require('../config/firebase');

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/transactions/:creatorId
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns all transactions (tips received) for a specific creator.
 *
 * Supports optional query params for pagination and filtering:
 *   - ?limit=20     → number of results to return (default: 20, max: 100)
 *   - ?method=card  → filter by payment method (mobileMoney, card, ussd)
 *
 * Results are ordered newest first so the dashboard always shows recent activity.
 *
 * @route  GET /api/transactions/:creatorId
 * @access Private — only the creator should see their full transaction list
 */
const getCreatorTransactions = async (req, res, next) => {
  try {
    const { creatorId } = req.params;

    // Parse optional query parameters
    const limitCount = Math.min(parseInt(req.query.limit) || 20, 100); // Cap at 100
    const methodFilter = req.query.method; // e.g. 'card', 'mobileMoney', 'ussd'

    // Start building the Firestore query
    let query = db
      .collection('transactions')
      .where('creatorId', '==', creatorId)
      .orderBy('timestamp', 'desc')
      .limit(limitCount);

    // Apply payment method filter if provided
    // e.g. GET /api/transactions/abc123?method=mobileMoney
    if (methodFilter) {
      query = query.where('paymentMethod', '==', methodFilter);
    }

    const snapshot = await query.get();

    // Convert Firestore snapshot documents to plain JavaScript objects
    const transactions = snapshot.docs.map((doc) => doc.data());

    return res.status(200).json({
      success: true,
      count: transactions.length,
      data: transactions,
    });

  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/transactions/single/:id
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a single transaction by its Firestore document ID.
 *
 * Used when the creator or admin wants to inspect a specific tip —
 * e.g. to verify the details of a particular transaction for a dispute.
 *
 * @route  GET /api/transactions/single/:id
 * @access Private — requires auth
 */
const getSingleTransaction = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Fetch the specific transaction document from Firestore
    const txnDoc = await db.collection('transactions').doc(id).get();

    if (!txnDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Transaction not found.',
      });
    }

    return res.status(200).json({
      success: true,
      data: txnDoc.data(),
    });

  } catch (err) {
    next(err);
  }
};

module.exports = { getCreatorTransactions, getSingleTransaction };
