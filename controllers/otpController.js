/**
 * controllers/otpController.js
 *
 * OTP (One-Time Password) flows for KudiClap.
 *
 * OTPs are 6-digit codes stored in a Firestore "otps" collection with
 * a 10-minute expiry. They are used for:
 *
 *   forgot_password         → creator requests a password reset link via email
 *   reset_pin               → creator resets their withdrawal PIN after forgetting it
 *   withdrawal_verification → extra confirmation step for large withdrawals (future)
 *
 * ── OTP collection structure ───────────────────────────────────────────────────
 *
 *   Collection: otps
 *   Document ID: auto-generated
 *
 *   Fields:
 *     email      String  — creator's email address
 *     creatorId  String  — Firestore creator doc ID (Firebase UID)
 *     otpCode    String  — 6-digit numeric code (hashed with bcrypt for security)
 *     purpose    String  — "forgot_password" | "reset_pin" | "withdrawal_verification"
 *     used       Boolean — true after the OTP has been consumed
 *     expiresAt  Date    — 10 minutes from creation
 *     createdAt  Date
 *
 * ── Email delivery ──────────────────────────────────────────────────────────────
 *
 *   In production: integrate nodemailer (or a service like SendGrid/Resend)
 *   to email the OTP code to the creator.
 *
 *   For MVP/hackathon: the OTP is returned in the API response so it can be
 *   tested without setting up an email service. Set RETURN_OTP_IN_RESPONSE=true
 *   in .env to enable this — NEVER enable it in production.
 *
 * Exported functions:
 *   - requestOtp  → POST /api/auth/request-otp
 *   - verifyOtp   → POST /api/auth/verify-otp
 *   - resetPin    → POST /api/auth/reset-pin  (uses verified OTP to set new PIN)
 */

const bcrypt = require('bcrypt');
const { db } = require('../config/firebase');
const { validateRequestOtp, validateVerifyOtp, validateResetPin } = require('../utils/validation');
const { sendOtp: sendOtpEmail } = require('../services/emailService');

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper — generate a 6-digit OTP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates a cryptographically secure random 6-digit OTP code.
 *
 * Uses Node's built-in crypto.randomBytes() which reads from the OS
 * cryptographically secure pseudorandom number generator (CSPRNG).
 * This is significantly more secure than Math.random() which is NOT
 * cryptographically random and could be predicted by an attacker.
 *
 * Process:
 *   - randomBytes(3) gives 3 bytes = 24 bits of randomness = 0–16,777,215
 *   - We take modulo 1,000,000 to get 0–999,999
 *   - Pad with leading zeros to always return exactly 6 digits
 *
 * @returns {string} A 6-digit string like "048392"
 */
const generateOtpCode = () => {
  const crypto = require('crypto');
  // 3 random bytes → integer 0–16,777,215 → modulo to 0–999,999 → pad to 6 digits
  const randomInt = crypto.randomBytes(3).readUIntBE(0, 3) % 1_000_000;
  return randomInt.toString().padStart(6, '0');
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/request-otp
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates a new OTP and sends it to the creator's email.
 *
 * Rate-limiting note: this endpoint is behind the auth limiter in app.js
 * (10 requests / 15 min per IP), which prevents OTP spam.
 *
 * Steps:
 *   1. Validate email + purpose
 *   2. Look up the creator by email in Firestore
 *   3. Invalidate any existing unused OTPs for this email + purpose
 *   4. Generate a new 6-digit OTP, hash it, store in Firestore
 *   5. Email the OTP to the creator (or return it in response in dev mode)
 *
 * @route  POST /api/auth/request-otp
 * @access Public — no auth required (used for password reset)
 */
const requestOtp = async (req, res, next) => {
  try {
    const { error, value } = validateRequestOtp(req.body);
    if (error) {
      return res.status(400).json({ success: false, error: error.details[0].message });
    }

    const { email, purpose } = value;

    // Look up the creator by email
    const creatorSnapshot = await db
      .collection('creators')
      .where('email', '==', email)
      .limit(1)
      .get();

    if (creatorSnapshot.empty) {
      // Don't reveal whether the email exists — security best practice
      return res.status(200).json({
        success: true,
        message: 'If an account with that email exists, an OTP has been sent.',
      });
    }

    const creatorId = creatorSnapshot.docs[0].id;

    // Invalidate existing unused OTPs for this email + purpose
    // Prevents confusion if the user requests multiple OTPs in quick succession
    const existingOtps = await db
      .collection('otps')
      .where('email', '==', email)
      .where('purpose', '==', purpose)
      .where('used', '==', false)
      .get();

    const invalidatePromises = existingOtps.docs.map((doc) =>
      doc.ref.update({ used: true })
    );
    await Promise.all(invalidatePromises);

    // Generate a new OTP code
    const rawOtpCode = generateOtpCode();
    const hashedOtpCode = await bcrypt.hash(rawOtpCode, 10);

    // Store in Firestore with 10-minute expiry
    const otpRef = await db.collection('otps').add({
      email,
      creatorId,
      otpCode: hashedOtpCode,
      purpose,
      used: false,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes from now
      createdAt: new Date(),
    });

    // ── Email delivery ────────────────────────────────────────────────────────
    // Send the OTP to the creator's email via emailService (nodemailer).
    // sendOtpEmail() falls back to console.log() if EMAIL_HOST is not set.
    const creatorSnap = await db.collection('creators').doc(creatorId).get();
    const creatorName = creatorSnap.exists ? creatorSnap.data().name : 'Creator';

    await sendOtpEmail({
      to: email,
      otpCode: rawOtpCode,
      purpose,
      name: creatorName,
    });

    console.log(`[OTP] Generated for ${email} (${purpose}): ${rawOtpCode} (ID: ${otpRef.id})`);

    const responseData = {
      success: true,
      message: 'If an account with that email exists, an OTP has been sent.',
    };

    // Return OTP in response ONLY in development mode — NEVER in production
    if (process.env.RETURN_OTP_IN_RESPONSE === 'true' && process.env.NODE_ENV !== 'production') {
      responseData.devOtp = rawOtpCode; // For testing without email setup
    }

    return res.status(200).json(responseData);

  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/verify-otp
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verifies an OTP code and returns a short-lived verification token.
 *
 * The verification token (stored in Firestore) is then passed to
 * the /reset-pin endpoint to authorize the PIN reset.
 * This two-step flow prevents replay attacks.
 *
 * @route  POST /api/auth/verify-otp
 * @access Public
 */
const verifyOtp = async (req, res, next) => {
  try {
    const { error, value } = validateVerifyOtp(req.body);
    if (error) {
      return res.status(400).json({ success: false, error: error.details[0].message });
    }

    const { email, otpCode, purpose } = value;

    // Find the most recent unused, unexpired OTP for this email + purpose
    const otpSnapshot = await db
      .collection('otps')
      .where('email', '==', email)
      .where('purpose', '==', purpose)
      .where('used', '==', false)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();

    if (otpSnapshot.empty) {
      return res.status(400).json({
        success: false,
        error: 'No valid OTP found. Please request a new one.',
      });
    }

    const otpDoc = otpSnapshot.docs[0];
    const otpData = otpDoc.data();

    // Check expiry
    const expiresAt = otpData.expiresAt.toDate ? otpData.expiresAt.toDate() : new Date(otpData.expiresAt);
    if (new Date() > expiresAt) {
      await otpDoc.ref.update({ used: true }); // Mark expired OTPs as used
      return res.status(400).json({
        success: false,
        error: 'OTP has expired. Please request a new one.',
      });
    }

    // Verify the OTP code against the stored hash
    const isValid = await bcrypt.compare(otpCode.toString(), otpData.otpCode);
    if (!isValid) {
      return res.status(400).json({
        success: false,
        error: 'Invalid OTP code. Please check and try again.',
      });
    }

    // Mark the OTP as used — it cannot be reused
    await otpDoc.ref.update({ used: true });

    // Issue a short-lived verification token stored in Firestore
    // The client passes this token to /reset-pin to authorize the action
    const verificationToken = require('crypto').randomBytes(32).toString('hex');
    await db.collection('otpVerifications').doc(verificationToken).set({
      email,
      creatorId: otpData.creatorId,
      purpose,
      used: false,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5 minutes to use it
      createdAt: new Date(),
    });

    return res.status(200).json({
      success: true,
      message: 'OTP verified successfully.',
      data: { verificationToken },
    });

  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/reset-pin
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resets a creator's withdrawal PIN using a verified OTP token.
 *
 * Requires the verificationToken from /verify-otp (with purpose: "reset_pin").
 * The token is single-use and expires in 5 minutes.
 *
 * @route  POST /api/auth/reset-pin
 * @access Public (but requires valid verificationToken from /verify-otp)
 */
const resetPin = async (req, res, next) => {
  try {
    const { error, value } = validateResetPin(req.body);
    if (error) {
      return res.status(400).json({ success: false, error: error.details[0].message });
    }

    const { verificationToken, newPin } = value;

    // Look up the verification token
    const tokenDoc = await db.collection('otpVerifications').doc(verificationToken).get();

    if (!tokenDoc.exists) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired verification token. Please request a new OTP.',
      });
    }

    const tokenData = tokenDoc.data();

    // Check it hasn't been used
    if (tokenData.used) {
      return res.status(400).json({
        success: false,
        error: 'This verification token has already been used.',
      });
    }

    // Check it hasn't expired
    const expiresAt = tokenData.expiresAt.toDate ? tokenData.expiresAt.toDate() : new Date(tokenData.expiresAt);
    if (new Date() > expiresAt) {
      return res.status(400).json({
        success: false,
        error: 'Verification token has expired. Please request a new OTP.',
      });
    }

    // Check it was issued for PIN reset
    if (tokenData.purpose !== 'reset_pin') {
      return res.status(400).json({
        success: false,
        error: 'This token is not valid for PIN reset.',
      });
    }

    // Hash the new PIN and save it
    const hashedPin = await bcrypt.hash(newPin.toString(), 10);

    await db.collection('creators').doc(tokenData.creatorId).update({
      pin: hashedPin,
      updatedAt: new Date(),
    });

    // Mark the token as used
    await tokenDoc.ref.update({ used: true });

    return res.status(200).json({
      success: true,
      message: 'PIN reset successfully. You can now use your new PIN for withdrawals.',
    });

  } catch (err) {
    next(err);
  }
};

module.exports = { requestOtp, verifyOtp, resetPin };
