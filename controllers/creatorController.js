/**
 * controllers/creatorController.js
 *
 * Handles all creator profile operations.
 *
 * Auth/signup/login/PIN/password are in authController.js.
 * This controller is purely for profile reads and updates.
 *
 * Firestore creator document fields:
 *   id, name, email, username, mobileMoneyNumber, ussdCode,
 *   bio, profilePicture, totalEarnings, walletBalance, pin (bcrypt),
 *   bankAccountNumber, bankCode, bankName, bankAccountName,
 *   createdAt, updatedAt, tokensRevokedAt
 *
 * Exported functions:
 *   - getCreatorByUsername  → GET /api/creators/u/:username   (public — fan tip page)
 *   - getCreatorProfile     → GET /api/creators/:id           (public)
 *   - getCreatorDashboard   → GET /api/creators/dashboard/:id (private)
 *   - updateCreatorProfile  → PUT /api/creators/:id           (private)
 *   - updateBankAccount     → PUT /api/creators/:id/bank      (private)
 */

const { db, admin } = require('../config/firebase');
const { validateCreatorUpdate, validateBankAccount } = require('../utils/validation');

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/creators/u/:username
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a creator's public profile by username.
 *
 * This is the fan-facing tip page — kudiclap.com/ulodo.
 * Only public-safe fields are returned (no wallet, no phone, no PIN).
 *
 * @route  GET /api/creators/u/:username
 * @access Public
 */
const getCreatorByUsername = async (req, res, next) => {
  try {
    const username = req.params.username.toLowerCase();

    const snapshot = await db
      .collection('creators')
      .where('username', '==', username)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(404).json({
        success: false,
        error: `No creator found with username "${username}".`,
      });
    }

    const creatorData = snapshot.docs[0].data();

    return res.status(200).json({
      success: true,
      data: {
        id: creatorData.id,
        name: creatorData.name,
        username: creatorData.username,
        bio: creatorData.bio,
        profilePicture: creatorData.profilePicture,
        ussdCode: creatorData.ussdCode,
        totalEarnings: creatorData.totalEarnings, // Social proof — visible publicly
      },
    });

  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/creators/:id
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a creator's public profile by Firestore document ID.
 *
 * @route  GET /api/creators/:id
 * @access Public
 */
const getCreatorProfile = async (req, res, next) => {
  try {
    const { id } = req.params;

    const creatorDoc = await db.collection('creators').doc(id).get();
    if (!creatorDoc.exists) {
      return res.status(404).json({ success: false, error: 'Creator not found.' });
    }

    const creatorData = creatorDoc.data();

    return res.status(200).json({
      success: true,
      data: {
        id: creatorData.id,
        name: creatorData.name,
        username: creatorData.username,
        bio: creatorData.bio,
        profilePicture: creatorData.profilePicture,
        ussdCode: creatorData.ussdCode,
        totalEarnings: creatorData.totalEarnings,
      },
    });

  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/creators/dashboard/:id
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the creator's private dashboard — full profile + recent transactions.
 *
 * Includes wallet balance, phone number, bank account details, and PIN status.
 * Only the creator themselves can access this (protect + isSameUser in routes).
 *
 * @route  GET /api/creators/dashboard/:id
 * @access Private
 */
const getCreatorDashboard = async (req, res, next) => {
  try {
    const { id } = req.params;

    const creatorDoc = await db.collection('creators').doc(id).get();
    if (!creatorDoc.exists) {
      return res.status(404).json({ success: false, error: 'Creator not found.' });
    }

    // Fetch 10 most recent transactions
    // Requires composite index: transactions [creatorId ASC, timestamp DESC]
    // If the index doesn't exist yet, return empty array rather than crashing.
    let recentTransactions = [];
    try {
      const txSnapshot = await db
        .collection('transactions')
        .where('creatorId', '==', id)
        .orderBy('timestamp', 'desc')
        .limit(10)
        .get();
      recentTransactions = txSnapshot.docs.map((doc) => doc.data());
    } catch (indexErr) {
      // Firestore index not created yet — silently return empty transactions
      // Create the index: Firebase Console → Firestore → Indexes
      //   Collection: transactions | Fields: creatorId ASC, timestamp DESC
      console.warn('[Dashboard] Missing Firestore index for transactions query:', indexErr.message.split('\n')[0]);
    }
    const creatorData = creatorDoc.data();

    return res.status(200).json({
      success: true,
      data: {
        id: creatorData.id,
        name: creatorData.name,
        username: creatorData.username,
        email: creatorData.email,
        bio: creatorData.bio,
        profilePicture: creatorData.profilePicture,
        ussdCode: creatorData.ussdCode,
        mobileMoneyNumber: creatorData.mobileMoneyNumber,
        totalEarnings: creatorData.totalEarnings,
        walletBalance: creatorData.walletBalance,
        hasPin: !!creatorData.pin, // Never expose the hash itself
        // Bank account (needed for withdrawal setup)
        bankAccountNumber: creatorData.bankAccountNumber || null,
        bankCode: creatorData.bankCode || null,
        bankName: creatorData.bankName || null,
        bankAccountName: creatorData.bankAccountName || null,
        createdAt: creatorData.createdAt,
        recentTransactions,
      },
    });

  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/creators/:id
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Updates a creator's profile fields (name, bio, profilePicture).
 *
 * Fields that are NOT updatable here:
 *   - email / password → via Firebase Auth directly or /api/auth/change-password
 *   - username → permanent (would break existing tip links)
 *   - ussdCode → permanent once assigned
 *   - mobileMoneyNumber → requires a separate verified-update flow (future)
 *   - bankAccount → use PUT /api/creators/:id/bank instead
 *
 * @route  PUT /api/creators/:id
 * @access Private
 */
const updateCreatorProfile = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { error, value } = validateCreatorUpdate(req.body);
    if (error) {
      return res.status(400).json({ success: false, error: error.details[0].message });
    }

    const creatorRef = db.collection('creators').doc(id);
    const creatorDoc = await creatorRef.get();

    if (!creatorDoc.exists) {
      return res.status(404).json({ success: false, error: 'Creator not found.' });
    }

    // Build update payload — only include fields that were sent
    const updates = { updatedAt: new Date() };
    if (value.name !== undefined) updates.name = value.name;
    if (value.bio !== undefined) updates.bio = value.bio;
    if (value.profilePicture !== undefined) updates.profilePicture = value.profilePicture;

    // Sync name change to Firebase Auth displayName
    if (value.name) {
      await admin.auth().updateUser(id, { displayName: value.name });
    }

    await creatorRef.update(updates);

    return res.status(200).json({ success: true, message: 'Profile updated successfully.' });

  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/creators/:id/bank
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Saves or updates a creator's bank account details.
 *
 * This is required before a creator can request a withdrawal.
 * Payaza NGN transfers use the NUBAN bank account standard — creators must
 * provide their account number and bank code.
 *
 * Common Nigerian bank codes:
 *   Access Bank: 044  |  GTBank: 058  |  First Bank: 011  |  Zenith: 057
 *   UBA: 033          |  OPay: 999992 |  Kuda: 090267     |  PalmPay: 999991
 *
 * @route  PUT /api/creators/:id/bank
 * @access Private
 */
const updateBankAccount = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { error, value } = validateBankAccount(req.body);
    if (error) {
      return res.status(400).json({ success: false, error: error.details[0].message });
    }

    const creatorRef = db.collection('creators').doc(id);
    const creatorDoc = await creatorRef.get();

    if (!creatorDoc.exists) {
      return res.status(404).json({ success: false, error: 'Creator not found.' });
    }

    await creatorRef.update({
      bankAccountNumber: value.bankAccountNumber,
      bankCode: value.bankCode,
      bankName: value.bankName || '',
      bankAccountName: value.bankAccountName,
      updatedAt: new Date(),
    });

    return res.status(200).json({
      success: true,
      message: 'Bank account saved successfully. You can now request withdrawals.',
    });

  } catch (err) {
    next(err);
  }
};

module.exports = {
  getCreatorByUsername,
  getCreatorProfile,
  getCreatorDashboard,
  updateCreatorProfile,
  updateBankAccount,
};
