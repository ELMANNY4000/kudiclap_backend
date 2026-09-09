/**
 * app.js
 *
 * Creates and configures the Express application.
 *
 * This file is the heart of the server — it wires together:
 *   - Global middleware (CORS, JSON parsing, request logging)
 *   - All API route handlers
 *   - The global error handler (must be last)
 *
 * We separate app setup (this file) from server startup (server.js) so that
 * the app can be imported in tests without actually starting the HTTP server.
 *
 * Request lifecycle for every API call:
 *   Client → CORS check → JSON parser → Morgan logger → Route handler
 *   → Controller → Firebase/Payaza → Response
 *   (on error: → errorMiddleware → JSON error response)
 */

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

// ── Route handlers ────────────────────────────────────────────────────────────
const authRoutes        = require('./routes/authRoutes');         // signup, login, logout, me, PIN, OTP
const creatorRoutes     = require('./routes/creatorRoutes');      // profile reads + updates + bank account
const paymentRoutes     = require('./routes/paymentRoutes');      // tip, webhook, card-callback, banks, enquire
const ussdRoutes        = require('./routes/ussdRoutes');         // USSD tip + USSD withdrawal
const withdrawalRoutes  = require('./routes/withdrawalRoutes');   // cash-out requests + history
const transactionRoutes = require('./routes/transactionRoutes');  // tip history + summary
const adminRoutes       = require('./routes/adminRoutes');        // admin: commissions, stats

// ── Global error middleware (must be imported for use at the bottom) ───────────
const errorMiddleware = require('./middlewares/errorMiddleware');

// Create the Express app instance
const app = express();

// ─────────────────────────────────────────────────────────────────────────────
// Global Middleware
// These run on EVERY incoming request, in the order they are registered.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * CORS — Cross-Origin Resource Sharing
 *
 * Allows the frontend (running on a different domain/port) to call our API.
 * Without this, browsers block cross-origin requests by default.
 *
 * In production, replace the wildcard origin with your actual frontend URL:
 *   origin: 'https://kudiclap.vercel.app'
 *
 * During development, allowing all origins (*) is fine.
 */
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

/**
 * Webhook raw body — MUST be registered BEFORE express.json()
 *
 * Payaza verifies webhook signatures using HMAC-SHA512 over the RAW request
 * body buffer. Once express.json() parses the body, the raw bytes are gone
 * and signature verification will always fail.
 *
 * By registering express.raw() on the webhook route first, that specific
 * route receives req.body as a Buffer. handleWebhook() in paymentController
 * calls JSON.parse(req.body.toString('utf-8')) manually after verifying.
 *
 * All other routes continue to receive parsed JSON from express.json() below.
 */
app.use(
  '/api/payments/webhook',
  express.raw({ type: 'application/json' })
);

/**
 * JSON body parser
 *
 * Parses incoming request bodies with Content-Type: application/json
 * and makes the parsed data available as req.body in controllers.
 * Without this, req.body would always be undefined.
 * Note: does NOT apply to /api/payments/webhook (handled above).
 */
app.use(express.json());

/**
 * Morgan — HTTP request logger
 *
 * Logs each incoming request to the console in a readable format.
 * 'dev' format shows: METHOD /path STATUS response-time ms
 * Example: POST /api/creators/signup 201 45.231 ms
 *
 * In production you might switch to 'combined' format for more detail,
 * or pipe logs to a service like Datadog or Papertrail.
 */
app.use(morgan('dev'));

// ─────────────────────────────────────────────────────────────────────────────
// Rate Limiting
//
// Protects the API from abuse — brute-force login attempts, tip spam,
// and denial-of-service attacks.
//
// We use different limits for different route groups:
//   Auth routes (login/signup) → tighter limit — brute force risk
//   Payment routes (tip)       → medium limit — prevents tip flooding
//   General API                → generous limit — normal usage headroom
// ─────────────────────────────────────────────────────────────────────────────

// General limit: 100 requests per 15 minutes per IP — covers all routes
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,    // Return rate limit info in RateLimit-* headers
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many requests from this IP. Please wait a few minutes and try again.',
  },
});

// Auth limit: 10 requests per 15 minutes per IP — prevents password brute-forcing
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many login attempts. Please wait 15 minutes before trying again.',
  },
});

// Payment limit: 20 tip requests per 15 minutes per IP — prevents tip spam
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many payment requests. Please slow down and try again shortly.',
  },
});

// Apply general limiter to all routes as a baseline
app.use(generalLimiter);

// ─────────────────────────────────────────────────────────────────────────────
// Health Check Route
//
// GET /health — returns 200 OK with a status message.
// Used by Railway to confirm the server is running after deploy.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'KudiClap backend is running.',
    timestamp: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// API Routes
//
// Each router handles a group of related endpoints.
// The base path here + the path in each router file = the full endpoint URL.
//
// /api/auth         → signup, login, logout, me, PIN management, OTP
// /api/creators     → profile reads (by ID or username), dashboard, bank account
// /api/payments     → tip processing, Payaza webhook, card callback
// /api/ussd         → USSD tip + USSD withdrawal flow
// /api/withdrawals  → cash-out requests + history
// /api/transactions → tip history
// ─────────────────────────────────────────────────────────────────────────────
app.use('/api/auth',         authLimiter, authRoutes);
app.use('/api/creators',    creatorRoutes);
app.use('/api/payments',    paymentLimiter, paymentRoutes);
app.use('/api/ussd',        paymentLimiter, ussdRoutes);
app.use('/api/withdrawals', withdrawalRoutes);
app.use('/api/transactions',transactionRoutes);
app.use('/api/admin',       adminRoutes);

// ─────────────────────────────────────────────────────────────────────────────
// 404 Handler
//
// If a request reaches here, no route above matched it.
// We return a clear 404 instead of letting Express send an ugly HTML error page.
// ─────────────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `Route ${req.method} ${req.originalUrl} not found.`,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Global Error Handler
//
// MUST be registered LAST — after all routes and other middleware.
// Catches any error passed via next(err) or thrown inside async controllers.
// See middlewares/errorMiddleware.js for the implementation.
// ─────────────────────────────────────────────────────────────────────────────
app.use(errorMiddleware);

module.exports = app;
