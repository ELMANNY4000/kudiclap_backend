/**
 * routes/creatorRoutes.js
 *
 * Creator profile routes for KudiClap.
 *
 * Base path: /api/creators  (registered in app.js)
 *
 * Route ordering matters — specific paths before wildcard params:
 *   /u/:username  must come before /:id
 *   /dashboard/:id must come before /:id
 *   /:id/bank must come before /:id
 *
 * Public routes:
 *   GET /api/creators/u/:username       → Fan tip page (by username)
 *   GET /api/creators/:id               → Public profile (by Firestore ID)
 *
 * Protected routes:
 *   GET /api/creators/dashboard/:id     → Private dashboard + recent transactions
 *   PUT /api/creators/:id               → Update name, bio, profilePicture
 *   PUT /api/creators/:id/bank          → Save/update bank account for withdrawals
 */

const express = require('express');
const router = express.Router();

const {
  getCreatorByUsername,
  getCreatorProfile,
  getCreatorDashboard,
  updateCreatorProfile,
  updateBankAccount,
} = require('../controllers/creatorController');

const { protect, isSameUser } = require('../middlewares/authMiddleware');

// ── Public ────────────────────────────────────────────────────────────────────
router.get('/u/:username', getCreatorByUsername);

// ── Protected — specific paths before wildcard ────────────────────────────────
router.get('/dashboard/:id', protect, isSameUser, getCreatorDashboard);

// ── Public (after specific protected routes) ─────────────────────────────────
router.get('/:id', getCreatorProfile);

// ── Protected — updates ───────────────────────────────────────────────────────
router.put('/:id/bank', protect, isSameUser, updateBankAccount);
router.put('/:id', protect, isSameUser, updateCreatorProfile);

module.exports = router;
