/**
 * routes/authRoutes.js
 *
 * Authentication routes for KudiClap creators.
 *
 * Base path: /api/auth  (registered in app.js)
 *
 * Public routes (no auth required):
 *   POST /api/auth/signup           → Create account (Firebase Auth + Firestore)
 *   POST /api/auth/login            → Email + password → returns idToken + refreshToken
 *   POST /api/auth/request-otp      → Request OTP for password reset or PIN reset
 *   POST /api/auth/verify-otp       → Verify OTP → returns verificationToken
 *   POST /api/auth/reset-pin        → Reset PIN using verificationToken from verify-otp
 *
 * Protected routes (valid Firebase idToken required):
 *   POST /api/auth/logout           → Revoke refresh tokens server-side
 *   GET  /api/auth/me               → Return current creator's full profile
 *   POST /api/auth/change-password  → Verify old password → update to new password
 *   POST /api/auth/set-pin          → Set 4-digit withdrawal PIN for the first time
 *   POST /api/auth/change-pin       → Change existing withdrawal PIN
 */

const express = require('express');
const router = express.Router();

const { signup, login, logout, me, changePassword, setPin, changePin } = require('../controllers/authController');
const { requestOtp, verifyOtp, resetPin } = require('../controllers/otpController');
const { protect } = require('../middlewares/authMiddleware');

// ── Public ────────────────────────────────────────────────────────────────────
router.post('/signup', signup);
router.post('/login', login);
router.post('/request-otp', requestOtp);
router.post('/verify-otp', verifyOtp);
router.post('/reset-pin', resetPin);

// ── Protected ─────────────────────────────────────────────────────────────────
router.post('/logout', protect, logout);
router.get('/me', protect, me);
router.post('/change-password', protect, changePassword);
router.post('/set-pin', protect, setPin);
router.post('/change-pin', protect, changePin);

module.exports = router;
