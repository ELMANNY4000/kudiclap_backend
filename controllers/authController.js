/**
 * controllers/authController.js
 *
 * Handles all authentication flows for KudiClap creators.
 *
 * Auth strategy: Firebase Auth manages identity (passwords, tokens, sessions).
 * We never store or hash passwords — Firebase does that securely.
 * Firestore stores the creator's profile data keyed by Firebase UID.
 *
 * Creator PIN is a SEPARATE 4-digit number used only to authorize
 * sensitive actions (withdrawals, USSD withdrawals). It is stored as a
 * bcrypt hash in the creator's Firestore document — completely separate
 * from the login password which Firebase Auth manages.
 *
 * Token flow:
 *   Signup  → Firebase Auth creates user → Firestore profile created
 *   Login   → Firebase Auth REST API verifies password → returns idToken
 *   Request → Frontend sends "Authorization: Bearer <idToken>"
 *   Verify  → authMiddleware.protect() verifies idToken with Firebase Admin SDK
 *   Logout  → revokeRefreshTokens() invalidates all sessions server-side
 *
 * Exported functions:
 *   - signup         → POST /api/auth/signup
 *   - login          → POST /api/auth/login
 *   - logout         → POST /api/auth/logout         (protected)
 *   - me             → GET  /api/auth/me             (protected)
 *   - changePassword → POST /api/auth/change-password (protected)
 *   - setPin         → POST /api/auth/set-pin         (protected)
 *   - changePin      → POST /api/auth/change-pin      (protected)
 */

const axios = require('axios');
const bcrypt = require('bcrypt');
const { db, admin } = require('../config/firebase');
const { generateUssdCode } = require('../utils/generateUssdCode');
const {
  validateCreatorSignup,
  validateLogin,
  validateChangePassword,
  validateSetPin,
  validateChangePin,
} = require('../utils/validation');

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/signup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registers a new creator.
 *
 * Steps:
 *   1. Validate input
 *   2. Check username uniqueness in Firestore
 *   3. Create Firebase Auth user (password hashed by Firebase)
 *   4. Generate unique USSD code
 *   5. Write Firestore profile using Firebase UID as doc ID
 *   6. Return custom token (frontend exchanges for idToken via Firebase SDK)
 *
 * @route  POST /api/auth/signup
 * @access Public
 */
const signup = async (req, res, next) => {
  try {
    const { error, value } = validateCreatorSignup(req.body);
    if (error) {
      return res.status(400).json({ success: false, error: error.details[0].message });
    }

    const { name, email, password, username, mobileMoneyNumber, bio, profilePicture } = value;

    // Check username is not already taken
    const usernameCheck = await db
      .collection('creators')
      .where('username', '==', username.toLowerCase())
      .limit(1)
      .get();

    if (!usernameCheck.empty) {
      return res.status(409).json({
        success: false,
        error: `Username "${username}" is already taken. Please choose another.`,
      });
    }

    // Create the Firebase Auth user — Firebase stores and hashes the password
    let firebaseUser;
    try {
      firebaseUser = await admin.auth().createUser({
        email,
        password,
        displayName: name,
      });
    } catch (firebaseError) {
      if (firebaseError.code === 'auth/email-already-exists') {
        return res.status(409).json({
          success: false,
          error: 'An account with this email already exists.',
        });
      }
      if (firebaseError.code === 'auth/weak-password') {
        return res.status(400).json({
          success: false,
          error: 'Password is too weak. Use at least 8 characters with letters and numbers.',
        });
      }
      throw firebaseError;
    }

    const uid = firebaseUser.uid;

    // Generate a unique USSD shortcode for this creator (e.g. *388*47291#)
    let ussdCode;
    let isUnique = false;
    while (!isUnique) {
      ussdCode = generateUssdCode();
      const codeCheck = await db
        .collection('creators')
        .where('ussdCode', '==', ussdCode)
        .limit(1)
        .get();
      if (codeCheck.empty) isUnique = true;
    }

    // Write Firestore profile — Firebase UID is the document ID
    // This guarantees req.user.uid === Firestore doc ID everywhere in the app
    await db.collection('creators').doc(uid).set({
      id: uid,
      name,
      email,
      username: username.toLowerCase(),
      mobileMoneyNumber,
      ussdCode,
      bio: bio || '',
      profilePicture: profilePicture || '',
      // Wallet fields
      totalEarnings: 0,    // Lifetime tips received — never decreases
      walletBalance: 0,    // Currently available to withdraw
      // Security fields
      pin: null,           // 4-digit withdrawal PIN (bcrypt hash) — set separately via /set-pin
      // Bank account — required before withdrawals (set via PUT /api/creators/:id)
      bankAccountNumber: null,
      bankCode: null,
      bankName: null,
      bankAccountName: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Return a custom token — frontend exchanges this for idToken + refreshToken
    // via Firebase Auth client SDK signInWithCustomToken()
    const customToken = await admin.auth().createCustomToken(uid);

    return res.status(201).json({
      success: true,
      message: 'Account created successfully. Welcome to KudiClap!',
      data: {
        uid,
        username: username.toLowerCase(),
        ussdCode,
        customToken,
      },
    });

  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/login
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Authenticates a creator and returns a Firebase ID token.
 *
 * Firebase Admin SDK cannot verify passwords server-side — we call the
 * Firebase Auth REST API instead, which returns idToken + refreshToken.
 *
 * @route  POST /api/auth/login
 * @access Public
 */
const login = async (req, res, next) => {
  try {
    const { error, value } = validateLogin(req.body);
    if (error) {
      return res.status(400).json({ success: false, error: error.details[0].message });
    }

    const { email, password } = value;

    const FIREBASE_WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY;
    if (!FIREBASE_WEB_API_KEY) {
      throw new Error('FIREBASE_WEB_API_KEY is not set in environment variables.');
    }

    let firebaseResponse;
    try {
      firebaseResponse = await axios.post(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_WEB_API_KEY}`,
        { email, password, returnSecureToken: true }
      );
    } catch (axiosError) {
      const code = axiosError.response?.data?.error?.message;
      // Log the exact Firebase error code for debugging
      console.error('[Login] Firebase error code:', code, '| Full error:', JSON.stringify(axiosError.response?.data));

      if (!code) {
        // Network error or unexpected response shape — bubble up
        throw axiosError;
      }

      if (['EMAIL_NOT_FOUND', 'INVALID_PASSWORD', 'INVALID_LOGIN_CREDENTIALS'].includes(code)) {
        return res.status(401).json({ success: false, error: 'Invalid email or password.' });
      }
      if (code === 'USER_DISABLED') {
        return res.status(403).json({ success: false, error: 'This account has been disabled.' });
      }
      if (code === 'TOO_MANY_ATTEMPTS_TRY_LATER') {
        return res.status(429).json({ success: false, error: 'Too many login attempts. Try again later.' });
      }
      // Catch-all for any other Firebase 400 codes — return the raw message
      return res.status(401).json({ success: false, error: `Authentication failed: ${code}` });
    }

    const { idToken, refreshToken, localId: uid } = firebaseResponse.data;

    // Fetch Firestore profile to return with the token
    const creatorDoc = await db.collection('creators').doc(uid).get();
    if (!creatorDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Creator profile not found. Please contact support.',
      });
    }

    const creatorData = creatorDoc.data();

    return res.status(200).json({
      success: true,
      message: 'Login successful.',
      data: {
        idToken,
        refreshToken,
        expiresIn: 3600,
        creator: {
          uid,
          name: creatorData.name,
          username: creatorData.username,
          email: creatorData.email,
          ussdCode: creatorData.ussdCode,
          totalEarnings: creatorData.totalEarnings,
          walletBalance: creatorData.walletBalance,
          profilePicture: creatorData.profilePicture,
          bio: creatorData.bio,
          hasPin: !!creatorData.pin, // Tell frontend whether PIN has been set (boolean only)
        },
      },
    });

  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/logout
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Logs out a creator by revoking Firebase refresh tokens server-side.
 * Also stores tokensRevokedAt in Firestore for immediate token invalidation.
 *
 * @route  POST /api/auth/logout
 * @access Private
 */
const logout = async (req, res, next) => {
  try {
    const uid = req.user.uid;

    await admin.auth().revokeRefreshTokens(uid);

    await db.collection('creators').doc(uid).update({
      tokensRevokedAt: new Date(),
      updatedAt: new Date(),
    });

    return res.status(200).json({ success: true, message: 'Logged out successfully.' });

  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/me
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the authenticated creator's profile.
 * Used to restore session on frontend app load.
 *
 * @route  GET /api/auth/me
 * @access Private
 */
const me = async (req, res, next) => {
  try {
    const uid = req.user.uid;

    const creatorDoc = await db.collection('creators').doc(uid).get();
    if (!creatorDoc.exists) {
      return res.status(404).json({ success: false, error: 'Creator profile not found.' });
    }

    const creatorData = creatorDoc.data();

    return res.status(200).json({
      success: true,
      data: {
        uid,
        name: creatorData.name,
        username: creatorData.username,
        email: creatorData.email,
        ussdCode: creatorData.ussdCode,
        bio: creatorData.bio,
        profilePicture: creatorData.profilePicture,
        totalEarnings: creatorData.totalEarnings,
        walletBalance: creatorData.walletBalance,
        hasPin: !!creatorData.pin,
        // Bank account details for dashboard display
        bankAccountNumber: creatorData.bankAccountNumber || null,
        bankName: creatorData.bankName || null,
        bankAccountName: creatorData.bankAccountName || null,
        createdAt: creatorData.createdAt,
      },
    });

  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/change-password
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Changes the creator's login password via Firebase Auth.
 *
 * Flow:
 *   1. Verify the old password by calling Firebase REST sign-in API
 *   2. If valid, update the password in Firebase Auth
 *   3. Revoke all existing tokens (forces all devices to log in again)
 *
 * We verify the old password first to prevent an attacker who has a valid
 * session token (e.g. stolen from local storage) from immediately changing
 * the password and locking out the real user.
 *
 * @route  POST /api/auth/change-password
 * @access Private
 */
const changePassword = async (req, res, next) => {
  try {
    const { error, value } = validateChangePassword(req.body);
    if (error) {
      return res.status(400).json({ success: false, error: error.details[0].message });
    }

    const { oldPassword, newPassword } = value;
    const uid = req.user.uid;

    // Get creator's email from Firestore (needed for Firebase REST API call)
    const creatorDoc = await db.collection('creators').doc(uid).get();
    if (!creatorDoc.exists) {
      return res.status(404).json({ success: false, error: 'Creator not found.' });
    }

    const { email } = creatorDoc.data();

    // Step 1: Verify the old password by attempting sign-in
    const FIREBASE_WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY;
    try {
      await axios.post(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_WEB_API_KEY}`,
        { email, password: oldPassword, returnSecureToken: false }
      );
    } catch (axiosError) {
      const code = axiosError.response?.data?.error?.message;
      if (['EMAIL_NOT_FOUND', 'INVALID_PASSWORD', 'INVALID_LOGIN_CREDENTIALS'].includes(code)) {
        return res.status(400).json({ success: false, error: 'Current password is incorrect.' });
      }
      throw axiosError;
    }

    // Step 2: Update the password in Firebase Auth
    await admin.auth().updateUser(uid, { password: newPassword });

    // Step 3: Revoke all tokens — creator must log in again with new password
    await admin.auth().revokeRefreshTokens(uid);
    await db.collection('creators').doc(uid).update({
      tokensRevokedAt: new Date(),
      updatedAt: new Date(),
    });

    return res.status(200).json({
      success: true,
      message: 'Password changed successfully. Please log in again with your new password.',
    });

  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/set-pin
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sets the creator's 4-digit withdrawal PIN for the first time.
 *
 * The PIN is NOT the login password. It is used only to authorize:
 *   - Direct withdrawals (POST /api/withdrawals)
 *   - USSD withdrawals (POST /api/ussd/withdraw)
 *
 * The PIN is stored as a bcrypt hash in Firestore — never as plaintext.
 * We use bcrypt (not Firebase Auth) because this is application-level
 * data, not identity data.
 *
 * @route  POST /api/auth/set-pin
 * @access Private — must be logged in to set PIN
 */
const setPin = async (req, res, next) => {
  try {
    const { error, value } = validateSetPin(req.body);
    if (error) {
      return res.status(400).json({ success: false, error: error.details[0].message });
    }

    const { pin } = value;
    const uid = req.user.uid;

    // Check if PIN is already set — use change-pin endpoint to update it
    const creatorDoc = await db.collection('creators').doc(uid).get();
    if (!creatorDoc.exists) {
      return res.status(404).json({ success: false, error: 'Creator not found.' });
    }

    if (creatorDoc.data().pin) {
      return res.status(400).json({
        success: false,
        error: 'PIN is already set. Use /api/auth/change-pin to update it.',
      });
    }

    // Hash the PIN with bcrypt (10 salt rounds)
    const hashedPin = await bcrypt.hash(pin.toString(), 10);

    await db.collection('creators').doc(uid).update({
      pin: hashedPin,
      updatedAt: new Date(),
    });

    return res.status(200).json({ success: true, message: 'PIN set successfully.' });

  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/change-pin
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Changes the creator's existing withdrawal PIN.
 *
 * Requires the current PIN to be provided as verification before setting
 * the new one — prevents unauthorized PIN changes if the account is
 * compromised via a stolen session token.
 *
 * @route  POST /api/auth/change-pin
 * @access Private
 */
const changePin = async (req, res, next) => {
  try {
    const { error, value } = validateChangePin(req.body);
    if (error) {
      return res.status(400).json({ success: false, error: error.details[0].message });
    }

    const { currentPin, newPin } = value;
    const uid = req.user.uid;

    const creatorDoc = await db.collection('creators').doc(uid).get();
    if (!creatorDoc.exists) {
      return res.status(404).json({ success: false, error: 'Creator not found.' });
    }

    const creatorData = creatorDoc.data();

    if (!creatorData.pin) {
      return res.status(400).json({
        success: false,
        error: 'No PIN set. Use /api/auth/set-pin to set one first.',
      });
    }

    // Verify the current PIN
    const pinValid = await bcrypt.compare(currentPin.toString(), creatorData.pin);
    if (!pinValid) {
      return res.status(400).json({ success: false, error: 'Current PIN is incorrect.' });
    }

    // Hash and save the new PIN
    const hashedPin = await bcrypt.hash(newPin.toString(), 10);

    await db.collection('creators').doc(uid).update({
      pin: hashedPin,
      updatedAt: new Date(),
    });

    return res.status(200).json({ success: true, message: 'PIN changed successfully.' });

  } catch (err) {
    next(err);
  }
};

module.exports = { signup, login, logout, me, changePassword, setPin, changePin };
