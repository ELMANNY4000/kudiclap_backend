/**
 * controllers/authController.js
 *
 * Handles all authentication flows for KudiClap creators.
 *
 * Why Firebase Auth?
 * ─────────────────
 * Firebase Auth manages passwords securely (bcrypt under the hood),
 * issues short-lived ID tokens (1 hour), and refresh tokens that stay valid
 * until explicitly revoked. We never store or see passwords — Firebase does.
 *
 * Token flow:
 *   Signup  → Firebase Auth creates user → we store profile in Firestore
 *   Login   → Firebase Auth REST API verifies password → returns idToken + refreshToken
 *   Request → Frontend sends "Authorization: Bearer <idToken>" on every protected call
 *   Verify  → authMiddleware calls admin.auth().verifyIdToken() to authenticate
 *   Logout  → We revoke the refresh token server-side so old tokens stop working
 *
 * Important: The Firebase Auth UID becomes the Firestore document ID for that
 * creator. This means req.user.uid (from the token) always matches the Firestore
 * document — no extra lookups needed for ownership checks.
 *
 * Exported functions (used by authRoutes.js):
 *   - signup  → POST /api/auth/signup
 *   - login   → POST /api/auth/login
 *   - logout  → POST /api/auth/logout  (protected)
 *   - me      → GET  /api/auth/me      (protected — returns current user profile)
 */

const axios = require('axios');
const { db, admin } = require('../config/firebase');
const { generateUssdCode } = require('../utils/generateUssdCode');
const { validateCreatorSignup, validateLogin } = require('../utils/validation');

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/signup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registers a new creator — creates a Firebase Auth user AND a Firestore profile.
 *
 * Steps:
 *   1. Validate input (name, email, password, mobileMoneyNumber)
 *   2. Check username is not already taken
 *   3. Create the user in Firebase Auth (gets a UID back)
 *   4. Generate a unique USSD code
 *   5. Write the creator profile to Firestore using the Firebase UID as doc ID
 *   6. Return the ID token so the frontend can immediately authenticate
 *
 * Why create the Firestore doc with the Firebase UID?
 *   Because authMiddleware gives us req.user.uid from the token — if the
 *   Firestore doc ID matches the UID, we never need a separate "find creator
 *   by email" query for ownership checks. It's faster and simpler.
 *
 * @route  POST /api/auth/signup
 * @access Public
 */
const signup = async (req, res, next) => {
  try {
    // ── Validate request body ─────────────────────────────────────────────────
    const { error, value } = validateCreatorSignup(req.body);
    if (error) {
      return res.status(400).json({ success: false, error: error.details[0].message });
    }

    const { name, email, password, username, mobileMoneyNumber, bio, profilePicture } = value;

    // ── Check username uniqueness ─────────────────────────────────────────────
    // Usernames power the public profile URLs: kudiclap.com/:username
    // They must be unique across all creators.
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

    // ── Create the Firebase Auth user ─────────────────────────────────────────
    // Firebase Auth stores and hashes the password — we never touch it.
    // admin.auth().createUser() returns a UserRecord with a unique UID.
    let firebaseUser;
    try {
      firebaseUser = await admin.auth().createUser({
        email,
        password,
        displayName: name,
      });
    } catch (firebaseError) {
      // Firebase Auth errors have a code we can map to friendly messages
      if (firebaseError.code === 'auth/email-already-exists') {
        return res.status(409).json({
          success: false,
          error: 'An account with this email already exists.',
        });
      }
      if (firebaseError.code === 'auth/weak-password') {
        return res.status(400).json({
          success: false,
          error: 'Password is too weak. Use at least 6 characters.',
        });
      }
      // Unknown Firebase error — bubble up to global error handler
      throw firebaseError;
    }

    // The UID assigned by Firebase Auth — this becomes the Firestore doc ID
    const uid = firebaseUser.uid;

    // ── Generate a unique USSD code ───────────────────────────────────────────
    // Loop until we find a code not already assigned to another creator
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

    // ── Write Firestore profile using Firebase UID as document ID ─────────────
    // By using uid as the doc ID, we guarantee that req.user.uid === doc.id
    // everywhere in the app — no ambiguity, no extra lookups.
    await db.collection('creators').doc(uid).set({
      id: uid,
      name,
      email,
      username: username.toLowerCase(), // Always store lowercase for consistent lookups
      mobileMoneyNumber,
      ussdCode,
      bio: bio || '',
      profilePicture: profilePicture || '',
      totalEarnings: 0,    // Lifetime tips received (₦) — never decreases
      walletBalance: 0,    // Current available balance (₦) — decreases on withdrawal
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // ── Create a custom token so the frontend can sign in immediately ──────────
    // admin.auth().createCustomToken() produces a token the frontend exchanges
    // for a real idToken + refreshToken via Firebase Auth client SDK.
    // This saves the user from having to log in manually right after signing up.
    const customToken = await admin.auth().createCustomToken(uid);

    return res.status(201).json({
      success: true,
      message: 'Account created successfully. Welcome to KudiClap!',
      data: {
        uid,
        username: username.toLowerCase(),
        ussdCode,
        customToken, // Frontend exchanges this for idToken via signInWithCustomToken()
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
 * Firebase Admin SDK cannot verify passwords directly — that's by design
 * (the admin SDK is for server-side privileged operations, not user auth).
 *
 * To verify email + password, we call the Firebase Auth REST API:
 *   POST https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword
 *
 * On success, Firebase returns:
 *   - idToken      → short-lived JWT (1 hour), sent in Authorization header
 *   - refreshToken → long-lived token, used to get new idTokens when they expire
 *   - expiresIn    → seconds until idToken expires (always 3600)
 *
 * The frontend stores these tokens and uses idToken for API requests.
 * When idToken expires, the frontend uses refreshToken to get a new one
 * via Firebase Auth client SDK (signInWithEmailAndPassword / onAuthStateChanged).
 *
 * @route  POST /api/auth/login
 * @access Public
 */
const login = async (req, res, next) => {
  try {
    // ── Validate input ────────────────────────────────────────────────────────
    const { error, value } = validateLogin(req.body);
    if (error) {
      return res.status(400).json({ success: false, error: error.details[0].message });
    }

    const { email, password } = value;

    // ── Call Firebase Auth REST API to verify the password ────────────────────
    // The Web API key is the public key from Firebase project settings.
    // It is safe to use server-side (it identifies the project, not a secret).
    const FIREBASE_WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY;

    if (!FIREBASE_WEB_API_KEY) {
      throw new Error('FIREBASE_WEB_API_KEY is not set in environment variables.');
    }

    let firebaseResponse;
    try {
      firebaseResponse = await axios.post(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_WEB_API_KEY}`,
        {
          email,
          password,
          returnSecureToken: true, // Must be true to get the idToken back
        }
      );
    } catch (axiosError) {
      // Firebase returns 400 with an error code for wrong credentials
      const firebaseErrorCode = axiosError.response?.data?.error?.message;

      if (
        firebaseErrorCode === 'EMAIL_NOT_FOUND' ||
        firebaseErrorCode === 'INVALID_PASSWORD' ||
        firebaseErrorCode === 'INVALID_LOGIN_CREDENTIALS'
      ) {
        // Deliberately vague message — don't tell attacker which one is wrong
        return res.status(401).json({
          success: false,
          error: 'Invalid email or password.',
        });
      }

      if (firebaseErrorCode === 'USER_DISABLED') {
        return res.status(403).json({
          success: false,
          error: 'This account has been disabled. Please contact support.',
        });
      }

      if (firebaseErrorCode === 'TOO_MANY_ATTEMPTS_TRY_LATER') {
        return res.status(429).json({
          success: false,
          error: 'Too many failed login attempts. Please try again later.',
        });
      }

      throw axiosError;
    }

    const { idToken, refreshToken, localId: uid } = firebaseResponse.data;

    // ── Fetch the creator's Firestore profile to return with the token ─────────
    // The frontend needs the creator's profile data right after login
    // to display the dashboard — returning it here saves an extra API call.
    const creatorDoc = await db.collection('creators').doc(uid).get();

    if (!creatorDoc.exists) {
      // Firebase Auth user exists but Firestore profile is missing — data inconsistency
      // This shouldn't happen in normal flow but handle it gracefully
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
        idToken,       // Send in Authorization: Bearer <idToken> for protected routes
        refreshToken,  // Frontend uses this to refresh the idToken when it expires
        expiresIn: 3600, // idToken expires in 1 hour (3600 seconds)
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
 * Logs out a creator by revoking all their Firebase refresh tokens.
 *
 * Why server-side logout matters:
 * Just deleting the token on the frontend isn't secure — the token is still
 * valid until it expires (1 hour). If someone stole the token, they'd still
 * have 1 hour of access. Revoking refresh tokens means:
 *   - All existing refresh tokens are immediately invalidated
 *   - New idTokens cannot be minted from those refresh tokens
 *   - The creator must log in again to get a fresh token
 *
 * Note: Already-issued idTokens remain valid for up to 1 hour after revocation
 * (Firebase limitation). For higher security, check token issuance time in
 * authMiddleware against the revocation time stored in Firestore.
 *
 * @route  POST /api/auth/logout
 * @access Private — requires valid token (protect middleware)
 */
const logout = async (req, res, next) => {
  try {
    // req.user.uid is set by the protect middleware after verifying the token
    const uid = req.user.uid;

    // Revoke all refresh tokens for this user in Firebase Auth
    await admin.auth().revokeRefreshTokens(uid);

    // Store the revocation timestamp in Firestore so authMiddleware can
    // reject idTokens issued before this time (optional but more secure)
    await db.collection('creators').doc(uid).update({
      tokensRevokedAt: new Date(),
      updatedAt: new Date(),
    });

    return res.status(200).json({
      success: true,
      message: 'Logged out successfully.',
    });

  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/me
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the currently authenticated creator's full profile.
 *
 * A convenience endpoint — the frontend can call this on app load to
 * restore the user session without storing sensitive data in localStorage.
 * Just store the idToken, call /me on startup, and you have the full profile.
 *
 * @route  GET /api/auth/me
 * @access Private — requires valid token (protect middleware)
 */
const me = async (req, res, next) => {
  try {
    const uid = req.user.uid;

    const creatorDoc = await db.collection('creators').doc(uid).get();

    if (!creatorDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Creator profile not found.',
      });
    }

    const creatorData = creatorDoc.data();

    // Return all profile fields except the mobile money number
    // (sensitive — only returned on the full dashboard endpoint)
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
        createdAt: creatorData.createdAt,
      },
    });

  } catch (err) {
    next(err);
  }
};

module.exports = { signup, login, logout, me };
