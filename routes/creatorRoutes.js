/**
 * routes/creatorRoutes.js
 *
 * Defines all HTTP routes related to creator profiles.
 *
 * Base path: /api/creators  (registered in app.js)
 *
 * NOTE: Signup and login routes are in /api/auth (authRoutes.js).
 *       This file handles profile reads and updates only.
 *
 * Routes:
 *   GET /api/creators/u/:username       → Public tip page (by username)
 *   GET /api/creators/dashboard/:id     → Private dashboard (auth required)
 *   GET /api/creators/:id               → Public profile (by Firestore ID)
 *   PUT /api/creators/:id               → Update profile (auth required)
 *
 * Route ordering matters in Express — more specific paths MUST come before
 * wildcard params. The order here is deliberate:
 *   /u/:username must come before /:id
 *   /dashboard/:id must come before /:id
 * Otherwise Express would treat "u" or "dashboard" as the :id value.
 */

const express = require('express');
const router = express.Router();

const {
  getCreatorByUsername,
  getCreatorProfile,
  getCreatorDashboard,
  updateCreatorProfile,
} = require('../controllers/creatorController');

const { protect, isSameUser } = require('../middlewares/authMiddleware');

// ── Public routes ─────────────────────────────────────────────────────────────

// GET /api/creators/u/:username
// The fan-facing tip page — e.g. GET /api/creators/u/ulodo
// Returns: name, bio, profilePicture, ussdCode, totalEarnings
router.get('/u/:username', getCreatorByUsername);

// ── Private routes ────────────────────────────────────────────────────────────

// GET /api/creators/dashboard/:id
// Full private dashboard: wallet, phone, recent transactions
// Requires: valid idToken + token UID must match :id
router.get('/dashboard/:id', protect, isSameUser, getCreatorDashboard);

// ── Public routes (after specific private routes) ────────────────────────────

// GET /api/creators/:id
// Public profile by Firestore doc ID — must come AFTER /dashboard/:id and /u/:username
router.get('/:id', getCreatorProfile);

// ── Private routes (update) ───────────────────────────────────────────────────

// PUT /api/creators/:id
// Update name, bio, or profilePicture — creator can only edit their own profile
router.put('/:id', protect, isSameUser, updateCreatorProfile);

module.exports = router;
