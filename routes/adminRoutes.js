/**
 * routes/adminRoutes.js
 *
 * Admin-only routes for managing KudiClap platform settings.
 *
 * Base path: /api/admin  (registered in app.js)
 *
 * All routes require:
 *   1. Valid Firebase idToken  (protect middleware)
 *   2. Email in ADMIN_EMAILS env var  (adminOnly middleware)
 *
 * Routes:
 *   GET /api/admin/stats                 → platform-wide statistics
 *   GET /api/admin/commissions           → list all commission rules
 *   GET /api/admin/commissions/:type     → single commission rule
 *   PUT /api/admin/commissions/:type     → create or update a commission rule
 */

const express = require('express');
const router = express.Router();

const {
  adminOnly,
  getCommissions,
  getCommission,
  updateCommission,
  getPlatformStats,
} = require('../controllers/adminController');

const { protect } = require('../middlewares/authMiddleware');

// Every route in this file requires both protect + adminOnly
router.use(protect, adminOnly);

router.get('/stats',                    getPlatformStats);
router.get('/commissions',              getCommissions);
router.get('/commissions/:type',        getCommission);
router.put('/commissions/:type',        updateCommission);

module.exports = router;
