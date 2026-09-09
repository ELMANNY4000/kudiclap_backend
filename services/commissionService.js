/**
 * services/commissionService.js
 *
 * Manages commission/fee configuration for KudiClap transactions.
 *
 * Rates live in the Firestore "commissions" collection so they can be updated
 * from the admin dashboard without a code deploy. Each document is keyed by
 * transactionType (e.g. "withdraw", "deposit", "payment").
 *
 * ── Default rates (seeded on server start) ────────────────────────────────────
 *
 *   withdraw : 0% + ₦0 flat  → free payouts (KudiClap's zero-fee promise)
 *   deposit  : 0% + ₦0 flat  → Payaza charges their own fee externally
 *   payment  : 0% + ₦0 flat  → tipping is zero-fee for fans
 *
 * ── Seeding logic ─────────────────────────────────────────────────────────────
 *
 *   seedDefaultCommissions() is called once when the server starts.
 *   It uses { merge: true } so it NEVER overwrites rates that have already
 *   been configured by an admin — it only writes if the document is missing.
 *
 * Exported:
 *   - getCommission(type)              → { flatAmount, percentage, isActive }
 *   - calculateCommission(amount,type) → { commission, totalDeduction, breakdown }
 *   - setCommission(type, data)        → upsert a commission rule (admin)
 *   - seedDefaultCommissions()         → idempotent seed on startup
 */

const { db } = require('../config/firebase');

// ─────────────────────────────────────────────────────────────────────────────
// Default commission definitions
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_COMMISSIONS = [
  {
    transactionType: 'withdraw',
    flatAmount: 0,
    percentage: 0,
    isActive: false,   // inactive = zero fees; admin can flip to true when ready
    description: 'Fee on creator withdrawals. Zero by default per KudiClap promise.',
  },
  {
    transactionType: 'deposit',
    flatAmount: 0,
    percentage: 0,
    isActive: false,
    description: 'Fee on fan tips/deposits. Zero — Payaza charges its own gateway fee.',
  },
  {
    transactionType: 'payment',
    flatAmount: 0,
    percentage: 0,
    isActive: false,
    description: 'General payment commission. Zero by default.',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// seedDefaultCommissions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Seeds default commission documents into Firestore on server start.
 *
 * Safe to call every time the server boots:
 *   - Uses { merge: false } via set() only when the document does NOT exist.
 *   - Checks existence first — never overwrites admin-configured rates.
 *   - Runs all checks in parallel for fast startup.
 *
 * Called from server.js after the HTTP server starts listening.
 */
const seedDefaultCommissions = async () => {
  try {
    const batch = db.batch();
    let seededCount = 0;

    // Check all three types in parallel
    const checks = await Promise.all(
      DEFAULT_COMMISSIONS.map((comm) =>
        db.collection('commissions').doc(comm.transactionType).get()
      )
    );

    checks.forEach((docSnap, i) => {
      if (!docSnap.exists) {
        // Document doesn't exist yet — seed it
        const comm = DEFAULT_COMMISSIONS[i];
        batch.set(db.collection('commissions').doc(comm.transactionType), {
          ...comm,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        seededCount++;
      }
    });

    if (seededCount > 0) {
      await batch.commit();
      console.log(`[Commission] Seeded ${seededCount} default commission rule(s).`);
    } else {
      console.log('[Commission] Commission rules already exist — skipping seed.');
    }
  } catch (err) {
    // Non-fatal — log and continue. Missing commission docs fall back to 0%.
    console.error('[Commission] Seed failed (non-fatal):', err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// getCommission
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches the commission config for a given transaction type.
 * Falls back to zero fees if the document doesn't exist or Firestore is down.
 *
 * @param {string} transactionType - 'withdraw' | 'deposit' | 'payment'
 * @returns {Promise<{flatAmount: number, percentage: number, isActive: boolean}>}
 */
const getCommission = async (transactionType) => {
  try {
    const doc = await db.collection('commissions').doc(transactionType).get();

    if (!doc.exists) {
      return { flatAmount: 0, percentage: 0, isActive: false };
    }

    const data = doc.data();
    return {
      flatAmount:  data.flatAmount  ?? 0,
      percentage:  data.percentage  ?? 0,
      isActive:    data.isActive    ?? false,
      description: data.description || '',
    };
  } catch (err) {
    console.error('[Commission] getCommission failed for', transactionType, ':', err.message);
    return { flatAmount: 0, percentage: 0, isActive: false };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// calculateCommission
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculates the fee for a given amount and transaction type.
 *
 * Formula:
 *   percentageFee  = amount × (percentage / 100)
 *   commission     = percentageFee + flatAmount
 *   totalDeduction = amount + commission
 *
 * @param {number} amount           - Transaction amount in Naira
 * @param {string} transactionType  - 'withdraw' | 'deposit' | 'payment'
 * @returns {Promise<{commission, totalDeduction, breakdown}>}
 */
const calculateCommission = async (amount, transactionType) => {
  const { flatAmount, percentage, isActive } = await getCommission(transactionType);

  if (!isActive || (flatAmount === 0 && percentage === 0)) {
    return {
      commission:     0,
      totalDeduction: amount,
      breakdown: { flatAmount: 0, percentageFee: 0, percentage: 0 },
    };
  }

  const percentageFee    = parseFloat((amount * (percentage / 100)).toFixed(2));
  const commission       = parseFloat((percentageFee + flatAmount).toFixed(2));
  const totalDeduction   = parseFloat((amount + commission).toFixed(2));

  return {
    commission,
    totalDeduction,
    breakdown: { flatAmount, percentageFee, percentage },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// setCommission
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates or updates a commission rule in Firestore.
 * Called by adminController — not exposed to creators.
 *
 * @param {string} transactionType - 'withdraw' | 'deposit' | 'payment'
 * @param {object} data            - { flatAmount, percentage, isActive, description }
 */
const setCommission = async (transactionType, data) => {
  await db.collection('commissions').doc(transactionType).set(
    {
      transactionType,
      flatAmount:  data.flatAmount  ?? 0,
      percentage:  data.percentage  ?? 0,
      isActive:    data.isActive    ?? true,
      description: data.description || '',
      updatedAt:   new Date(),
    },
    { merge: true }
  );
};

module.exports = {
  getCommission,
  calculateCommission,
  setCommission,
  seedDefaultCommissions,
};
