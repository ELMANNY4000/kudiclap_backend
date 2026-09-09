/**
 * controllers/transactionController.js
 *
 * Handles fetching transaction history for KudiClap creators.
 *
 * Transactions are written automatically by paymentController.creditCreatorWallet()
 * every time a tip is confirmed. This controller handles READ operations only.
 *
 * ── Firestore query rules ─────────────────────────────────────────────────────
 *
 *   Firestore requires composite indexes for queries that combine:
 *     .where() + .orderBy() on different fields
 *   or multiple .where() clauses on different fields.
 *
 *   Our queries:
 *     1. creatorId == X  +  orderBy timestamp   → needs composite index:
 *          Collection: transactions
 *          Fields: creatorId ASC, timestamp DESC
 *          (create this in Firebase Console → Firestore → Indexes)
 *
 *     2. creatorId == X  +  paymentMethod == Y  +  orderBy timestamp
 *          → needs composite index:
 *          Collection: transactions
 *          Fields: creatorId ASC, paymentMethod ASC, timestamp DESC
 *
 *   If the indexes don't exist yet, Firestore will throw an error with a link
 *   to create them automatically — click the link in the error message.
 *
 * ── Pagination ────────────────────────────────────────────────────────────────
 *
 *   We support cursor-based pagination via ?after=<lastTimestamp>.
 *   This is more reliable than offset-based pagination for real-time data.
 *
 * Exported:
 *   - getCreatorTransactions → GET /api/transactions/:creatorId
 *   - getSingleTransaction   → GET /api/transactions/single/:id
 *   - getTransactionSummary  → GET /api/transactions/:creatorId/summary
 */

const { db } = require('../config/firebase');

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/transactions/:creatorId
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a creator's tip transaction history.
 *
 * Query params:
 *   ?limit=20        → results per page (default 20, max 100)
 *   ?method=card     → filter by payment method: card | mobileMoney | bankTransfer | ussd | checkout
 *   ?after=<ISO>     → cursor for next page — pass the timestamp of the last item received
 *
 * Firestore indexes required:
 *   - transactions: [creatorId ASC, timestamp DESC]
 *   - transactions: [creatorId ASC, paymentMethod ASC, timestamp DESC]  (when ?method is used)
 *
 * @route  GET /api/transactions/:creatorId
 * @access Private — protect middleware
 */
const getCreatorTransactions = async (req, res, next) => {
  try {
    const { creatorId } = req.params;
    const limitCount = Math.min(parseInt(req.query.limit) || 20, 100);
    const methodFilter = req.query.method;    // optional payment method filter
    const afterCursor  = req.query.after;     // optional ISO timestamp cursor for pagination

    // ── Build the Firestore query ─────────────────────────────────────────────
    // All .where() clauses must come before .orderBy() in Firestore SDK.
    // Putting where() after orderBy() causes a "must not contain a field that
    // does not appear in an equality filter" error.

    let query = db.collection('transactions').where('creatorId', '==', creatorId);

    // Add payment method filter if provided
    // This requires the composite index: creatorId + paymentMethod + timestamp
    if (methodFilter) {
      query = query.where('paymentMethod', '==', methodFilter);
    }

    // Order by timestamp descending — newest tips first
    query = query.orderBy('timestamp', 'desc');

    // Cursor-based pagination — start after the last item from the previous page
    // The client passes the ISO timestamp of the last transaction it received
    if (afterCursor) {
      try {
        const cursorDate = new Date(afterCursor);
        query = query.startAfter(cursorDate);
      } catch (_) {
        // Invalid cursor — just ignore it and start from the beginning
      }
    }

    query = query.limit(limitCount);

    const snapshot = await query.get();
    const transactions = snapshot.docs.map((doc) => doc.data());

    // Send the timestamp of the last item so the client can use it as the next cursor
    const lastTimestamp =
      transactions.length > 0
        ? transactions[transactions.length - 1].timestamp
        : null;

    return res.status(200).json({
      success: true,
      count: transactions.length,
      nextCursor: lastTimestamp, // Pass this as ?after= in the next request for pagination
      data: transactions,
    });

  } catch (err) {
    // Firestore will throw an error with a URL to create missing composite indexes.
    // Log it clearly so the developer knows exactly what to do.
    if (err.code === 9 || (err.message && err.message.includes('index'))) {
      console.error(
        '[transactionController] Firestore composite index missing.\n',
        'Create it here:', err.message
      );
      return res.status(500).json({
        success: false,
        error: 'Database index not ready. Please try again in a few minutes.',
      });
    }
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/transactions/single/:id
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a single transaction by its Firestore document ID.
 *
 * Includes an ownership check — a creator can only view transactions
 * that belong to them (their creatorId matches the transaction's creatorId).
 *
 * @route  GET /api/transactions/single/:id
 * @access Private — protect middleware
 */
const getSingleTransaction = async (req, res, next) => {
  try {
    const { id } = req.params;

    const txnDoc = await db.collection('transactions').doc(id).get();

    if (!txnDoc.exists) {
      return res.status(404).json({ success: false, error: 'Transaction not found.' });
    }

    const txnData = txnDoc.data();

    // Ownership check — creator can only view their own transactions
    if (req.user.uid !== txnData.creatorId) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden. You can only view your own transactions.',
      });
    }

    return res.status(200).json({
      success: true,
      data: txnData,
    });

  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/transactions/:creatorId/summary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns aggregated statistics for a creator's tips.
 *
 * Calculates:
 *   - totalTips      → number of completed tips
 *   - totalAmount    → sum of all tip amounts (₦)
 *   - averageTip     → average tip amount (₦)
 *   - byMethod       → breakdown by payment method (count + total per method)
 *   - recentTips     → last 5 tips for a quick preview
 *
 * Note: for large datasets this could be slow since we fetch all transactions
 * and aggregate in memory. For production scale, consider storing running
 * totals in the creator document and updating them on each tip (already done
 * for totalEarnings and walletBalance — this adds more granular breakdowns).
 *
 * @route  GET /api/transactions/:creatorId/summary
 * @access Private — protect middleware
 */
const getTransactionSummary = async (req, res, next) => {
  try {
    const { creatorId } = req.params;

    // Ownership check — creator can only view their own summary
    if (req.user.uid !== creatorId) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden. You can only view your own transaction summary.',
      });
    }

    // Fetch all completed transactions for this creator
    const snapshot = await db
      .collection('transactions')
      .where('creatorId', '==', creatorId)
      .where('status', '==', 'completed')
      .orderBy('timestamp', 'desc')
      .get();

    const transactions = snapshot.docs.map((doc) => doc.data());

    if (transactions.length === 0) {
      return res.status(200).json({
        success: true,
        data: {
          totalTips: 0,
          totalAmount: 0,
          averageTip: 0,
          byMethod: {},
          recentTips: [],
        },
      });
    }

    // Aggregate statistics
    const totalAmount = transactions.reduce((sum, t) => sum + (t.amount || 0), 0);
    const averageTip = parseFloat((totalAmount / transactions.length).toFixed(2));

    // Breakdown by payment method — { mobileMoney: { count, total }, card: { count, total }, ... }
    const byMethod = {};
    for (const t of transactions) {
      const method = t.paymentMethod || 'unknown';
      if (!byMethod[method]) {
        byMethod[method] = { count: 0, total: 0 };
      }
      byMethod[method].count += 1;
      byMethod[method].total += t.amount || 0;
    }

    // Last 5 tips for the quick preview panel on the dashboard
    const recentTips = transactions.slice(0, 5).map((t) => ({
      id: t.id,
      fanName: t.fanName,
      amount: t.amount,
      paymentMethod: t.paymentMethod,
      timestamp: t.timestamp,
    }));

    return res.status(200).json({
      success: true,
      data: {
        totalTips: transactions.length,
        totalAmount,
        averageTip,
        byMethod,
        recentTips,
      },
    });

  } catch (err) {
    if (err.code === 9 || (err.message && err.message.includes('index'))) {
      console.error('[transactionController] Firestore index missing:', err.message);
      return res.status(500).json({
        success: false,
        error: 'Database index not ready. Please try again in a few minutes.',
      });
    }
    next(err);
  }
};

module.exports = {
  getCreatorTransactions,
  getSingleTransaction,
  getTransactionSummary,
};
