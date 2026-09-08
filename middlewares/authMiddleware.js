/**
 * middlewares/authMiddleware.js
 *
 * Production-grade authentication middleware for KudiClap.
 *
 * Token flow recap:
 *   1. Creator logs in → Firebase Auth returns idToken (1-hour JWT)
 *   2. Frontend stores idToken, sends it on every protected request:
 *         Authorization: Bearer <idToken>
 *   3. protect() here verifies the token cryptographically using Firebase Admin SDK
 *   4. On success, req.user is populated with the decoded token claims
 *   5. Downstream middleware (isSameUser) and controllers use req.user.uid
 *
 * Token revocation check:
 *   After logout, we store tokensRevokedAt in Firestore.
 *   protect() compares the token's issuedAt time against tokensRevokedAt —
 *   if the token was issued BEFORE revocation, it's rejected even if Firebase
 *   still considers it cryptographically valid (1-hour window after revocation).
 *
 * Exported:
 *   - protect       → verifies Firebase ID token, populates req.user
 *   - isSameUser    → checks req.user.uid matches :id or :creatorId in route params
 */

const { admin, db } = require('../config/firebase');

// ─────────────────────────────────────────────────────────────────────────────
// protect
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verifies the Firebase ID token from the Authorization header.
 *
 * On success:  populates req.user with decoded token claims and calls next()
 * On failure:  returns 401 with a descriptive error message
 *
 * req.user properties (from Firebase token):
 *   - uid     → Firebase user ID (matches Firestore creator doc ID)
 *   - email   → Creator's email
 *   - iat     → Token issued-at timestamp (Unix seconds)
 *   - exp     → Token expiry timestamp (Unix seconds)
 *
 * @param {object}   req
 * @param {object}   res
 * @param {Function} next
 */
const protect = async (req, res, next) => {
  try {
    // ── Extract token from Authorization header ───────────────────────────────
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'Access denied. Please provide a valid authentication token.',
      });
    }

    const idToken = authHeader.split(' ')[1];

    if (!idToken) {
      return res.status(401).json({
        success: false,
        error: 'Access denied. Token is empty.',
      });
    }

    // ── Verify token with Firebase Admin SDK ─────────────────────────────────
    // checkRevoked: true makes Firebase check if this specific token has been
    // revoked via revokeRefreshTokens(). Adds a network round-trip but is necessary
    // for secure logout behavior.
    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(idToken, true /* checkRevoked */);
    } catch (firebaseError) {
      // Map Firebase error codes to clean responses
      if (firebaseError.code === 'auth/id-token-expired') {
        return res.status(401).json({
          success: false,
          error: 'Session expired. Please log in again.',
          code: 'TOKEN_EXPIRED',
        });
      }
      if (firebaseError.code === 'auth/id-token-revoked') {
        return res.status(401).json({
          success: false,
          error: 'Session has been terminated. Please log in again.',
          code: 'TOKEN_REVOKED',
        });
      }
      if (firebaseError.code === 'auth/user-disabled') {
        return res.status(403).json({
          success: false,
          error: 'This account has been disabled. Please contact support.',
          code: 'ACCOUNT_DISABLED',
        });
      }
      // Invalid signature, wrong project, malformed token, etc.
      return res.status(401).json({
        success: false,
        error: 'Invalid authentication token. Please log in again.',
        code: 'TOKEN_INVALID',
      });
    }

    // ── Check tokensRevokedAt for server-side logout ──────────────────────────
    // Firebase's checkRevoked above handles refresh token revocation, but there
    // is a small window (~1 min) where Firebase's own cache can serve revoked tokens.
    // We double-check against our Firestore record for immediate invalidation.
    const creatorDoc = await db.collection('creators').doc(decodedToken.uid).get();

    if (creatorDoc.exists) {
      const { tokensRevokedAt } = creatorDoc.data();

      if (tokensRevokedAt) {
        // Convert Firestore Timestamp to Unix seconds for comparison
        const revokedAtSeconds = tokensRevokedAt.toDate
          ? tokensRevokedAt.toDate().getTime() / 1000
          : new Date(tokensRevokedAt).getTime() / 1000;

        // decodedToken.iat = token issued-at time in Unix seconds
        if (decodedToken.iat < revokedAtSeconds) {
          return res.status(401).json({
            success: false,
            error: 'Session has been terminated. Please log in again.',
            code: 'TOKEN_REVOKED',
          });
        }
      }
    }

    // ── Attach decoded user to request ────────────────────────────────────────
    // Controllers and downstream middleware access this as req.user
    req.user = decodedToken;

    next();

  } catch (err) {
    // Unexpected error (network issue, Firestore read failure, etc.)
    console.error('protect middleware unexpected error:', err.message);
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// isSameUser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks that the authenticated user is accessing their OWN resource.
 *
 * Works with both :id and :creatorId route params — covers all resource routes:
 *   GET  /api/creators/dashboard/:id      → checks req.params.id
 *   PUT  /api/creators/:id                → checks req.params.id
 *   GET  /api/withdrawals/:creatorId      → checks req.params.creatorId
 *   GET  /api/transactions/:creatorId     → checks req.params.creatorId
 *
 * Must always be used AFTER protect() — it needs req.user to be populated.
 *
 * @param {object}   req
 * @param {object}   res
 * @param {Function} next
 */
const isSameUser = (req, res, next) => {
  // Support both :id and :creatorId param names across different route files
  const resourceId = req.params.id || req.params.creatorId;

  if (!resourceId) {
    // Route param is missing — this is a server configuration error
    return res.status(500).json({
      success: false,
      error: 'Route configuration error: no resource ID param found.',
    });
  }

  if (req.user.uid !== resourceId) {
    return res.status(403).json({
      success: false,
      error: 'Forbidden. You can only access your own resources.',
    });
  }

  next();
};

module.exports = { protect, isSameUser };
