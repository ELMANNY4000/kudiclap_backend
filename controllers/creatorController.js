/**
 * controllers/creatorController.js
 *
 * Handles all business logic related to KudiClap creator profiles.
 *
 * NOTE: Creator signup and login are handled in authController.js.
 * This controller is purely for profile reads and updates — all the
 * "who is this creator" data, not the "prove who you are" data.
 *
 * Exported functions (used by creatorRoutes.js):
 *   - getCreatorByUsername  → GET /api/creators/u/:username   (public — fan tip page)
 *   - getCreatorProfile     → GET /api/creators/:id           (public — by Firestore ID)
 *   - getCreatorDashboard   → GET /api/creators/dashboard/:id (private)
 *   - updateCreatorProfile  → PUT /api/creators/:id           (private)
 */

const { db, admin } = require('../config/firebase');
const { validateCreatorUpdate } = require('../utils/validation');

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/creators/u/:username
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a creator's public profile by their username.
 *
 * This is the primary public endpoint — it powers the fan-facing tip page at
 * kudiclap.com/ulodo (where "ulodo" is the username). Fans don't know or care
 * about Firestore document IDs; they just follow the creator's link.
 *
 * Returns only public-safe fields — no wallet balance, no phone number.
 *
 * @route  GET /api/creators/u/:username
 * @access Public — this is the page fans visit to tip a creator
 */
const getCreatorByUsername = async (req, res, next) => {
  try {
    // Usernames are stored lowercase — normalize the param for consistent matching
    const username = req.params.username.toLowerCase();

    // Query Firestore for a creator whose username field matches
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

    // Return only public-safe fields
    return res.status(200).json({
      success: true,
      data: {
        id: creatorData.id,
        name: creatorData.name,
        username: creatorData.username,
        bio: creatorData.bio,
        profilePicture: creatorData.profilePicture,
        ussdCode: creatorData.ussdCode,
        // Show total earnings publicly — it builds social proof and trust for the creator
        totalEarnings: creatorData.totalEarnings,
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
 * Returns a creator's public profile by their Firestore document ID.
 *
 * Used internally (e.g. when the frontend has the ID from a previous API call)
 * and as a fallback for direct ID lookups. For fan-facing pages, prefer the
 * username endpoint above.
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

    // Return public-safe fields only
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
 * Returns the creator's private dashboard data.
 *
 * Includes the full profile (wallet balance, mobile money number) plus
 * the 10 most recent transactions. Only the creator themselves can access this.
 *
 * The protect + isSameUser middleware chain in the route definition ensures
 * that req.user.uid === req.params.id before this function ever runs.
 *
 * @route  GET /api/creators/dashboard/:id
 * @access Private — protect + isSameUser in route
 */
const getCreatorDashboard = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Fetch full creator profile from Firestore (including sensitive fields)
    const creatorDoc = await db.collection('creators').doc(id).get();

    if (!creatorDoc.exists) {
      return res.status(404).json({ success: false, error: 'Creator not found.' });
    }

    // Fetch the 10 most recent tips received by this creator
    // Ordered by timestamp descending — newest tips appear first on the dashboard
    const txSnapshot = await db
      .collection('transactions')
      .where('creatorId', '==', id)
      .orderBy('timestamp', 'desc')
      .limit(10)
      .get();

    const recentTransactions = txSnapshot.docs.map((doc) => doc.data());

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
        mobileMoneyNumber: creatorData.mobileMoneyNumber, // Shown on private dashboard
        totalEarnings: creatorData.totalEarnings,
        walletBalance: creatorData.walletBalance,
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
 * Updates a creator's editable profile fields.
 *
 * Creators can update: name, bio, profilePicture.
 * Fields that cannot be changed here: email, username, mobileMoneyNumber, ussdCode.
 *   - email/password changes go through Firebase Auth directly
 *   - username changes are blocked (would break existing tip links)
 *   - mobileMoneyNumber changes need a dedicated verified-update flow (future)
 *   - ussdCode is permanent once assigned
 *
 * @route  PUT /api/creators/:id
 * @access Private — protect + isSameUser in route
 */
const updateCreatorProfile = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Validate only the fields allowed to be updated
    const { error, value } = validateCreatorUpdate(req.body);
    if (error) {
      return res.status(400).json({ success: false, error: error.details[0].message });
    }

    const creatorRef = db.collection('creators').doc(id);
    const creatorDoc = await creatorRef.get();

    if (!creatorDoc.exists) {
      return res.status(404).json({ success: false, error: 'Creator not found.' });
    }

    // Build the update payload — only include fields that were actually sent
    // Spreading undefined values into Firestore update() would cause an error
    const updates = { updatedAt: new Date() };

    if (value.name !== undefined) updates.name = value.name;
    if (value.bio !== undefined) updates.bio = value.bio;
    if (value.profilePicture !== undefined) updates.profilePicture = value.profilePicture;

    // If name is being updated, also update it in Firebase Auth for consistency
    // (Firebase Auth displayName is used in some email templates)
    if (value.name) {
      await admin.auth().updateUser(id, { displayName: value.name });
    }

    await creatorRef.update(updates);

    return res.status(200).json({
      success: true,
      message: 'Profile updated successfully.',
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
};
