/**
 * services/commissionService.js
 *
 * Manages commission/fee configuration for KudiClap transactions.
 *
 * Commission rates are stored in a Firestore "commissions" collection
 * so they can be updated from the admin dashboard without redeploying code.
 *
 * ── Commission collection structure ───────────────────────────────────────────
 *
 *   Collection: commissions
 *   Document ID: the transactionType (e.g. "withdraw", "deposit", "payment")
 *
 *   Fields:
 *     transactionType  String  — "withdraw" | "deposit" | "payment"
 *     flatAmount       Number  — Fixed fee in Naira (₦) added on top of the amount
 *     percentage       Number  — Percentage of the amount (0–100), applied before flat fee
 *     isActive         Boolean — Whether this commission rule is active
 *     description      String  — Human-readable description for the admin dashboard
 *     updatedAt        Date    — When this rule was last changed
 *
 *   Example (withdraw): flatAmount=0, percentage=1.5
 *     → A ₦10,000 withdrawal deducts ₦150 in commission
 *
 * ── Default commission rates ───────────────────────────────────────────────────
 *
 *   withdraw: 0% flat, 0 flat fee (free for now — can be enabled later)
 *   deposit:  0% (collections via Payaza — Payaza charges their own fee)
 *   payment:  0% (tips are zero-fee — core KudiClap value proposition)
 *
 * Exported functions:
 *   - getCommission(transactionType) → returns { flatAmount, percentage }
 *   - calculateCommission(amount, transactionType) → returns { commission, totalDeduction }
 *   - setCommission(transactionType, data) → admin: creates/updates a commission rule
 */

const { db } = require('../config/firebase');

// ─────────────────────────────────────────────────────────────────────────────
// getCommission
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches the commission configuration for a given transaction type.
 *
 * Returns the stored Firestore document, or safe defaults if no document
 * exists (0 commission) — so the app never breaks if the collection is empty.
 *
 * @param {string} transactionType - 'withdraw' | 'deposit' | 'payment'
 * @returns {Promise<{flatAmount: number, percentage: number, isActive: boolean}>}
 */
const getCommission = async (transactionType) => {
  try {
    const doc = await db.collection('commissions').doc(transactionType).get();

    if (!doc.exists) {
      // No commission configured for this type — default to zero fees
      return { flatAmount: 0, percentage: 0, isActive: false };
    }

    const data = doc.data();
    return {
      flatAmount: data.flatAmount || 0,
      percentage: data.percentage || 0,
      isActive: data.isActive !== false, // Default to active if field is missing
    };
  } catch (err) {
    // If Firestore is unreachable, fall back to zero fees rather than blocking the transaction
    console.error('[Commission] Could not fetch commission for', transactionType, ':', err.message);
    return { flatAmount: 0, percentage: 0, isActive: false };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// calculateCommission
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculates the commission fee for a given transaction amount and type.
 *
 * Commission formula:
 *   percentageFee = amount × (percentage / 100)
 *   totalCommission = percentageFee + flatAmount
 *
 * Example: amount=₦10,000, percentage=1.5, flatAmount=50
 *   percentageFee = 10000 × 0.015 = 150
 *   totalCommission = 150 + 50 = 200
 *   totalDeduction = 10000 + 200 = 10200
 *
 * @param {number} amount          - Transaction amount in Naira
 * @param {string} transactionType - 'withdraw' | 'deposit' | 'payment'
 * @returns {Promise<{commission: number, totalDeduction: number, breakdown: object}>}
 */
const calculateCommission = async (amount, transactionType) => {
  const { flatAmount, percentage, isActive } = await getCommission(transactionType);

  // If commission is inactive or zero, return clean zeros
  if (!isActive || (flatAmount === 0 && percentage === 0)) {
    return {
      commission: 0,
      totalDeduction: amount,
      breakdown: { flatAmount: 0, percentageFee: 0, percentage: 0 },
    };
  }

  const percentageFee = parseFloat((amount * (percentage / 100)).toFixed(2));
  const commission = parseFloat((percentageFee + flatAmount).toFixed(2));
  const totalDeduction = parseFloat((amount + commission).toFixed(2));

  return {
    commission,
    totalDeduction,
    breakdown: { flatAmount, percentageFee, percentage },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// setCommission (admin use)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates or updates a commission rule in Firestore.
 *
 * This is called by the admin panel (not yet built) to adjust commission rates
 * without code changes or redeployments.
 *
 * @param {string} transactionType - 'withdraw' | 'deposit' | 'payment'
 * @param {object} data            - { flatAmount, percentage, isActive, description }
 */
const setCommission = async (transactionType, data) => {
  await db.collection('commissions').doc(transactionType).set(
    {
      transactionType,
      flatAmount: data.flatAmount ?? 0,
      percentage: data.percentage ?? 0,
      isActive: data.isActive ?? true,
      description: data.description || '',
      updatedAt: new Date(),
    },
    { merge: true } // merge: true means we only update the fields we send
  );
};

module.exports = { getCommission, calculateCommission, setCommission };
