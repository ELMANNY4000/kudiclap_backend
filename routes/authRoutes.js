/**
 * routes/authRoutes.js
 *
 * Defines all authentication-related routes.
 *
 * Base path: /api/auth  (registered in app.js)
 *
 * Routes:
 *   POST /api/auth/signup  → Create Firebase Auth user + Firestore profile
 *   POST /api/auth/login   → Verify email/password, return idToken + refreshToken
 *   POST /api/auth/logout  → Revoke refresh tokens server-side (protected)
 *   GET  /api/auth/me      → Return current creator's profile (protected)
 *
 * Token lifecycle on the frontend:
 *   1. Call /signup or /login → store idToken + refreshToken
 *   2. Every protected API request → Authorization: Bearer <idToken>
 *   3. When idToken expires (1 hour) → use Firebase client SDK to refresh
 *      OR call Firebase REST: POST /token?key=FIREBASE_WEB_API_KEY with refreshToken
 *   4. On logout → call /logout to invalidate server-side
 */

const express = require('express');
const router = express.Router();

const { signup, login, logout, me } = require('../controllers/authController');
const { protect } = require('../middlewares/authMiddleware');

// ── Public routes ─────────────────────────────────────────────────────────────

// POST /api/auth/signup
// Creates a new Firebase Auth user + Firestore creator profile
// Body: { name, email, password, username, mobileMoneyNumber, bio?, profilePicture? }
router.post('/signup', signup);

// POST /api/auth/login
// Authenticates with email + password via Firebase Auth REST API
// Body: { email, password }
// Returns: { idToken, refreshToken, expiresIn, creator: { ... } }
router.post('/login', login);

// ── Protected routes (valid Firebase token required) ─────────────────────────

// POST /api/auth/logout
// Revokes all refresh tokens for the authenticated creator
router.post('/logout', protect, logout);

// GET /api/auth/me
// Returns the authenticated creator's full profile
// Useful for restoring session on page reload
router.get('/me', protect, me);

module.exports = router;
