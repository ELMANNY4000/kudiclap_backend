/**
 * utils/validation.js
 *
 * Centralizes all input validation schemas for the KudiClap API.
 *
 * We use the Joi library (https://joi.dev) to define and validate the shape
 * of data coming into our endpoints. Validating early — before any business
 * logic runs — means cleaner errors and safer database writes.
 *
 * How to use in a controller:
 *   const { validateCreatorSignup } = require('../utils/validation');
 *   const { error } = validateCreatorSignup(req.body);
 *   if (error) return res.status(400).json({ error: error.details[0].message });
 */

const Joi = require('joi');

// ─────────────────────────────────────────────────────────────────────────────
// Creator schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates the request body for POST /api/auth/signup
 *
 * Required:
 *   - name               → creator's full name
 *   - email              → valid email address
 *   - password           → min 8 chars, must contain a letter and a number
 *   - username           → unique handle for their public tip page (kudiclap.com/:username)
 *   - mobileMoneyNumber  → Nigerian phone number (starts with 070, 080, 081, 090, 091)
 *
 * Optional:
 *   - bio                → short description of the creator (max 300 chars)
 *   - profilePicture     → a valid URL to their profile image
 *
 * @param {object} data - req.body from the signup request
 */
const validateCreatorSignup = (data) => {
  const schema = Joi.object({
    name: Joi.string().min(2).max(100).required().messages({
      'string.empty': 'Name is required',
      'string.min': 'Name must be at least 2 characters',
    }),

    email: Joi.string().email().required().messages({
      'string.email': 'Please provide a valid email address',
      'string.empty': 'Email is required',
    }),

    // Password: min 8 chars, at least one letter and one number
    // Firebase Auth enforces a minimum of 6 chars on its end — we enforce 8 for safety
    password: Joi.string()
      .min(8)
      .pattern(/^(?=.*[A-Za-z])(?=.*\d).+$/)
      .required()
      .messages({
        'string.min': 'Password must be at least 8 characters',
        'string.pattern.base': 'Password must contain at least one letter and one number',
        'string.empty': 'Password is required',
      }),

    // Username: lowercase letters, numbers, and underscores only — no spaces
    // This becomes their public link: kudiclap.com/:username
    username: Joi.string()
      .min(3)
      .max(30)
      .pattern(/^[a-zA-Z0-9_]+$/)
      .required()
      .messages({
        'string.min': 'Username must be at least 3 characters',
        'string.max': 'Username cannot exceed 30 characters',
        'string.pattern.base': 'Username can only contain letters, numbers, and underscores',
        'string.empty': 'Username is required',
      }),

    // Nigerian mobile numbers: 11 digits, starting with 070, 080, 081, 090, 091
    mobileMoneyNumber: Joi.string()
      .pattern(/^(070|080|081|090|091)\d{8}$/)
      .required()
      .messages({
        'string.pattern.base':
          'Mobile money number must be a valid Nigerian number (e.g. 08012345678)',
        'string.empty': 'Mobile money number is required',
      }),

    bio: Joi.string().max(300).allow('').optional(),

    profilePicture: Joi.string().uri().allow('').optional().messages({
      'string.uri': 'Profile picture must be a valid URL',
    }),
  });

  return schema.validate(data);
};

/**
 * Validates the request body for POST /api/auth/login
 *
 * Required:
 *   - email    → the creator's registered email
 *   - password → their password (sent to Firebase Auth REST API for verification)
 *
 * @param {object} data - req.body from the login request
 */
const validateLogin = (data) => {
  const schema = Joi.object({
    email: Joi.string().email().required().messages({
      'string.email': 'Please provide a valid email address',
      'string.empty': 'Email is required',
    }),
    password: Joi.string().required().messages({
      'string.empty': 'Password is required',
    }),
  });

  return schema.validate(data);
};

/**
 * Validates the request body for PUT /api/creators/:id (profile update)
 *
 * All fields are optional here since a creator may only want to update
 * one field at a time.
 *
 * @param {object} data - req.body from the update request
 */
const validateCreatorUpdate = (data) => {
  const schema = Joi.object({
    bio: Joi.string().max(300).allow('').optional(),
    profilePicture: Joi.string().uri().allow('').optional().messages({
      'string.uri': 'Profile picture must be a valid URL',
    }),
    name: Joi.string().min(2).max(100).optional(),
  });

  return schema.validate(data);
};

// ─────────────────────────────────────────────────────────────────────────────
// Payment schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates the request body for POST /api/payments/tip
 *
 * Required for all methods:
 *   - creatorId      → Firestore document ID of the creator being tipped
 *   - amount         → tip amount in Naira (minimum ₦100)
 *   - paymentMethod  → 'checkout' | 'mobileMoney' | 'bankTransfer' | 'card' | 'ussd'
 *
 * Required for 'card' only:
 *   - cardNumber, cardCvv, cardExpiryMonth, cardExpiryYear
 *   - cardPin — required for NGN card charges (Payaza requirement)
 *
 * Optional for all:
 *   - fanName, fanEmail, fanPhoneNumber
 *
 * Note: 'checkout', 'mobileMoney', and 'bankTransfer' all use the Payaza
 * Web Checkout modal — the backend returns checkout params, not a charge result.
 *
 * @param {object} data - req.body from the tip request
 */
const validateTip = (data) => {
  const schema = Joi.object({
    creatorId: Joi.string().required().messages({
      'string.empty': 'Creator ID is required',
    }),

    // Minimum ₦100 — keeps tips meaningful and covers Payaza's minimum charge
    amount: Joi.number().min(100).required().messages({
      'number.min': 'Minimum tip amount is ₦100',
      'any.required': 'Amount is required',
    }),

    paymentMethod: Joi.string()
      .valid('checkout', 'mobileMoney', 'bankTransfer', 'card', 'ussd')
      .required()
      .messages({
        'any.only': 'Payment method must be one of: checkout, mobileMoney, bankTransfer, card, ussd',
      }),

    // ── Fan info (optional — fans can tip anonymously) ────────────────────────
    fanName: Joi.string().max(100).allow('').optional(),
    fanEmail: Joi.string().email().allow('').optional(),
    fanPhoneNumber: Joi.string()
      .pattern(/^(070|080|081|090|091)\d{8}$/)
      .allow('')
      .optional()
      .messages({
        'string.pattern.base': 'Fan phone number must be a valid Nigerian number (e.g. 08012345678)',
      }),

    // ── Card specific (only required when paymentMethod === 'card') ───────────
    // These are sent to Payaza's Card Charge API.
    // For PCI compliance, prefer 'checkout' mode — Payaza's hosted modal
    // handles card data without it ever touching your server.
    cardNumber: Joi.string().creditCard().optional().messages({
      'string.creditCard': 'Please provide a valid card number',
    }),
    cardCvv: Joi.string().pattern(/^\d{3,4}$/).optional().messages({
      'string.pattern.base': 'CVV must be 3 or 4 digits',
    }),
    cardExpiryMonth: Joi.string().pattern(/^(0[1-9]|1[0-2])$/).optional().messages({
      'string.pattern.base': 'Expiry month must be in MM format (01–12)',
    }),
    cardExpiryYear: Joi.string().pattern(/^\d{2}$/).optional().messages({
      'string.pattern.base': 'Expiry year must be in YY format (e.g. 27)',
    }),
    // Payaza requires the card PIN for NGN card charges
    cardPin: Joi.string().pattern(/^\d{4}$/).optional().messages({
      'string.pattern.base': 'Card PIN must be 4 digits',
    }),
  });

  return schema.validate(data);
};

/**
 * Validates the request body for POST /api/payments/ussd (USSD simulation)
 *
 * Required:
 *   - ussdCode       → the creator's USSD code (e.g. *388*12345#)
 *   - amount         → tip amount in Naira (minimum ₦100)
 *   - fanPhoneNumber → the fan's phone number (simulates the dialing phone)
 *
 * @param {object} data - req.body from the USSD payment request
 */
const validateUssdPayment = (data) => {
  const schema = Joi.object({
    // USSD codes follow the KudiClap pattern: *388*XXXXX#
    ussdCode: Joi.string()
      .pattern(/^\*388\*\d{5}#$/)
      .required()
      .messages({
        'string.pattern.base': 'USSD code must be in the format *388*XXXXX#',
        'string.empty': 'USSD code is required',
      }),

    amount: Joi.number().min(100).required().messages({
      'number.min': 'Minimum tip amount is ₦100',
    }),

    fanPhoneNumber: Joi.string()
      .pattern(/^(070|080|081|090|091)\d{8}$/)
      .required()
      .messages({
        'string.pattern.base': 'Fan phone number must be a valid Nigerian number',
        'string.empty': 'Fan phone number is required',
      }),
  });

  return schema.validate(data);
};

// ─────────────────────────────────────────────────────────────────────────────
// Withdrawal schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates the request body for POST /api/withdrawals
 *
 * Required:
 *   - creatorId → the ID of the creator requesting the withdrawal
 *   - amount    → amount to withdraw in Naira (minimum ₦500)
 *
 * The destination mobile money number is pulled from the creator's profile
 * in Firestore — we don't ask for it again here to reduce friction.
 *
 * @param {object} data - req.body from the withdrawal request
 */
const validateWithdrawal = (data) => {
  const schema = Joi.object({
    creatorId: Joi.string().required().messages({
      'string.empty': 'Creator ID is required',
    }),

    // Minimum withdrawal is ₦500 to avoid tiny payouts that cost more to process
    amount: Joi.number().min(500).required().messages({
      'number.min': 'Minimum withdrawal amount is ₦500',
      'any.required': 'Amount is required',
    }),
  });

  return schema.validate(data);
};

module.exports = {
  validateCreatorSignup,
  validateLogin,
  validateCreatorUpdate,
  validateTip,
  validateUssdPayment,
  validateWithdrawal,
};
