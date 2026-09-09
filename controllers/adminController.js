/**
 * controllers/adminController.js
 *
 * Admin-only endpoints for managing KudiClap platform settings.
 *
 * ── Access control ────────────────────────────────────────────────────────────
 *
 *   All admin routes require:
 *     1. A valid Firebase idToken (protect middleware)
 *     2. The authenticated user's email must be in the ADMIN_EMAILS env var
 *        (comma-separated list, e.g. "ulodo@gmail.com,admin@kudiclap.com")
 *
 *   This is enforced by the adminOnly() middleware exported here.
 *   It runs AFTER protect() so req.user.uid and req.user.email are available.
 *
 * ── Commission management ─────────────────────────────────────────────────────
 *
 *   GET  /api/admin/commissions          → list all commission rules
 *   GET  /api/admin/commissions/:type    → get one rule by transactionType
 *   PUT  /api/admin/commissions/:type    → create or update a rule
 *
 * ── Platform stats (future) ───────────────────────────────────────────────────
 *
 *   GET  /api/admin/stats                → total creators, tips, volume
 *
 * Exported:
 *   - adminOnly            → middleware: blocks non-admins
 *   - getCommissions       → GET  /api/admin/commissions
 *   - getCommission        → GET  /api/admin/commissions/:type
 *   - updateCommission     → PUT  /api/admin/commissions/:type
 *   - getPlatformStats     → GET  /api/admin/stats
 */

const { db } = require('../config/firebase');
const {
  getCommission: fetchCommission,
  setCommission,
} = require('../services/commissionService');

// Valid transaction types — prevents arbitrary keys in the commissions collection
const VALID_TYPES = ['withdraw', 'deposit', 'payment'];

// ─────────────────────────────────────────────────────────────────────────────
// adminOnly middleware
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Middleware that restricts a route to admin users only.
 *
 * Admin emails are stored in the ADMIN_EMAILS environment variable as a
 * comma-separated list. This avoids storing role flags in Firestore — simple,
 * easy to manage, and requires no DB read per request.
 *
 * Example in .env:
 *   ADMIN_EMAILS=ulodo@gmail.com,admin@kudiclap.com
 *
 * Must be used AFTER protect() middleware — needs req.user.email.
 */
const adminOnly = (req, res, next) => {
  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  if (adminEmails.length === 0) {
    // ADMIN_EMAILS not configured — only allow in development as a fallback
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({
        success: false,
        error: 'Admin access not configured. Contact the system administrator.',
      });
    }
    // Dev mode — allow through with a warning
    console.warn('[Admin] ADMIN_EMAILS not set — allowing admin access in dev mode.');
    return next();
  }

  const userEmail = (req.user?.email || '').toLowerCase();

  if (!adminEmails.includes(userEmail)) {
    return res.status(403).json({
      success: false,
      error: 'Forbidden. This endpoint requires admin access.',
    });
  }

  next();
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/commissions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns all commission rules from Firestore.
 *
 * @route  GET /api/admin/commissions
 * @access Admin only
 */
const getCommissions = async (req, res, next) => {
  try {
    const snapshot = await db.collection('commissions').get();
    const commissions = snapshot.docs.map((doc) => doc.data());

    return res.status(200).json({
      success: true,
      count: commissions.length,
      data: commissions,
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/commissions/:type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a single commission rule by transactionType.
 *
 * @route  GET /api/admin/commissions/:type
 * @access Admin only
 */
const getCommission = async (req, res, next) => {
  try {
    const { type } = req.params;

    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({
        success: false,
        error: `Invalid type "${type}". Must be one of: ${VALID_TYPES.join(', ')}`,
      });
    }

    const commission = await fetchCommission(type);

    return res.status(200).json({
      success: true,
      data: { transactionType: type, ...commission },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/admin/commissions/:type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates or updates a commission rule.
 *
 * Body fields (all optional — only sends what you want to change):
 *   flatAmount   number   — fixed fee in Naira (₦), e.g. 50
 *   percentage   number   — percentage of transaction amount, e.g. 1.5
 *   isActive     boolean  — whether the commission is applied
 *   description  string   — human-readable note for the admin dashboard
 *
 * Examples:
 *   Enable 1.5% withdrawal fee:
 *     PUT /api/admin/commissions/withdraw
 *     { "percentage": 1.5, "isActive": true }
 *
 *   Add a flat ₦50 charge on top:
 *     PUT /api/admin/commissions/withdraw
 *     { "percentage": 1.5, "flatAmount": 50, "isActive": true }
 *
 *   Disable all fees temporarily:
 *     PUT /api/admin/commissions/withdraw
 *     { "isActive": false }
 *
 * @route  PUT /api/admin/commissions/:type
 * @access Admin only
 */
const updateCommission = async (req, res, next) => {
  try {
    const { type } = req.params;

    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({
        success: false,
        error: `Invalid type "${type}". Must be one of: ${VALID_TYPES.join(', ')}`,
      });
    }

    const { flatAmount, percentage, isActive, description } = req.body;

    // Basic validation — amounts must be non-negative numbers
    if (flatAmount !== undefined && (typeof flatAmount !== 'number' || flatAmount < 0)) {
      return res.status(400).json({ success: false, error: 'flatAmount must be a non-negative number.' });
    }
    if (percentage !== undefined && (typeof percentage !== 'number' || percentage < 0 || percentage > 100)) {
      return res.status(400).json({ success: false, error: 'percentage must be a number between 0 and 100.' });
    }

    await setCommission(type, { flatAmount, percentage, isActive, description });

    // Fetch and return the updated rule so the admin UI can reflect it
    const updated = await fetchCommission(type);

    console.log(`[Admin] Commission updated: type=${type}, active=${updated.isActive}, %=${updated.percentage}, flat=₦${updated.flatAmount} by ${req.user.email}`);

    return res.status(200).json({
      success: true,
      message: `Commission rule for "${type}" updated successfully.`,
      data: { transactionType: type, ...updated },
    });
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/stats
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns high-level platform statistics.
 *
 * Reads counts from Firestore collections. For large datasets this would
 * need to be replaced with pre-aggregated counters, but for the MVP/hackathon
 * the counts are small enough to query directly.
 *
 * @route  GET /api/admin/stats
 * @access Admin only
 */
const getPlatformStats = async (req, res, next) => {
  try {
    // Run all count queries in parallel for speed
    const [creatorsSnap, transactionsSnap, withdrawalsSnap] = await Promise.all([
      db.collection('creators').get(),
      db.collection('transactions').get(),
      db.collection('withdrawals').get(),
    ]);

    const transactions = transactionsSnap.docs.map((d) => d.data());
    const withdrawals  = withdrawalsSnap.docs.map((d) => d.data());

    // Total tip volume
    const totalTipVolume = transactions.reduce((sum, t) => sum + (t.amount || 0), 0);

    // Total withdrawal volume (completed only)
    const totalWithdrawalVolume = withdrawals
      .filter((w) => w.status === 'completed')
      .reduce((sum, w) => sum + (w.amount || 0), 0);

    // Tips by payment method
    const tipsByMethod = {};
    for (const t of transactions) {
      const m = t.paymentMethod || 'unknown';
      if (!tipsByMethod[m]) tipsByMethod[m] = { count: 0, total: 0 };
      tipsByMethod[m].count++;
      tipsByMethod[m].total += t.amount || 0;
    }

    return res.status(200).json({
      success: true,
      data: {
        totalCreators:          creatorsSnap.size,
        totalTips:              transactions.length,
        totalTipVolume:         totalTipVolume,
        totalWithdrawals:       withdrawals.length,
        totalWithdrawalVolume:  totalWithdrawalVolume,
        pendingWithdrawals:     withdrawals.filter((w) => w.status === 'pending').length,
        tipsByMethod,
        generatedAt:            new Date().toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  adminOnly,
  getCommissions,
  getCommission,
  updateCommission,
  getPlatformStats,
};
