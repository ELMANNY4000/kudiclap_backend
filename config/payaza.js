/**
 * config/payaza.js
 *
 * Payaza API configuration and shared HTTP client for KudiClap.
 *
 * Payaza is our payment gateway — it handles:
 *   - Card collections (Visa, Mastercard, Verve) — via Web Checkout or Card Charge API
 *   - Virtual account / bank transfer collections
 *   - NGN bank transfers (payouts to creators)
 *
 * ── Key Payaza differences from Flutterwave ───────────────────────────────────
 *
 *   1. NO SDK — all calls are plain HTTPS via axios (no npm package needed)
 *
 *   2. Auth header format:
 *        Authorization: Payaza <Base64-encoded public key>
 *      NOT "Bearer" — it is literally the word "Payaza" followed by the key
 *
 *   3. Two required extra headers on every request:
 *        X-TenantID:  "test" (sandbox) or "live" (production)
 *        X-ProductID: "app"  (always — this value never changes)
 *
 *   4. Single API base URL for both test and live:
 *        https://api.payaza.africa/live/
 *      The "/live/" is a fixed path prefix — it does NOT indicate environment.
 *      The X-TenantID header controls test vs live behaviour.
 *
 *   5. Webhook signature uses a different scheme — see paymentController.js
 *
 * ── How to get your API keys ───────────────────────────────────────────────────
 *   1. Sign up / log in at business.payaza.africa
 *   2. Settings → Developers → API Keys → Generate
 *   3. Copy both test and live public keys to your .env file
 *
 * Usage:
 *   const payaza = require('../config/payaza');
 *   const response = await payaza.post('/endpoint', { ...payload });
 */

const axios = require('axios');

// ── Payaza API base URL ────────────────────────────────────────────────────────
// This is fixed — the "/live/" segment is a path prefix, not an environment flag.
// The X-TenantID header controls whether the request is test or live.
const PAYAZA_BASE_URL = 'https://api.payaza.africa/live';

// ── Build the Authorization header value ──────────────────────────────────────
// Payaza requires: "Payaza <Base64-encoded public API key>"
// We encode the key at startup (not per-request) so it's computed once.
const getAuthHeader = () => {
  const publicKey = process.env.PAYAZA_PUBLIC_KEY;

  if (!publicKey) {
    throw new Error('PAYAZA_PUBLIC_KEY is not set in environment variables.');
  }

  // Buffer.from().toString('base64') encodes the key to Base64
  const encoded = Buffer.from(publicKey).toString('base64');

  // The word "Payaza" is literally part of the header value (not "Bearer")
  return `Payaza ${encoded}`;
};

// ── Build the shared request headers ──────────────────────────────────────────
// These three headers are required on EVERY Payaza API request.
const getHeaders = () => ({
  'Authorization': getAuthHeader(),
  'X-TenantID': process.env.PAYAZA_ENV || 'test',  // 'test' or 'live'
  'X-ProductID': 'app',                            // Always 'app' — never changes
  'Content-Type': 'application/json',
});

// ── Create a pre-configured axios instance ─────────────────────────────────────
// This lets controllers call payaza.post(), payaza.get() etc. without
// manually setting headers on every single request.
//
// We use a factory function (not a singleton) so headers are freshly built
// on each call — this ensures env vars are always read from the current
// process.env (important if keys are rotated without restarting the server).
const createPayazaClient = () => {
  return axios.create({
    baseURL: PAYAZA_BASE_URL,
    headers: getHeaders(),
    // 30-second timeout — Payaza's API is typically fast but we set a ceiling
    // to avoid hanging requests blocking the event loop
    timeout: 30000,
  });
};

/**
 * Exported helper — make a POST request to the Payaza API.
 *
 * @param {string} endpoint - Path after the base URL, e.g. '/merchant/api/v1/card/charge'
 * @param {object} data     - Request body (will be JSON-serialized)
 * @returns {Promise<object>} - Payaza response data
 * @throws Will throw if the HTTP request fails (network error or non-2xx status)
 */
const post = async (endpoint, data) => {
  const client = createPayazaClient();
  const response = await client.post(endpoint, data);
  return response.data;
};

/**
 * Exported helper — make a GET request to the Payaza API.
 *
 * @param {string} endpoint - Path after the base URL
 * @param {object} params   - Optional query parameters
 * @returns {Promise<object>} - Payaza response data
 */
const get = async (endpoint, params = {}) => {
  const client = createPayazaClient();
  const response = await client.get(endpoint, { params });
  return response.data;
};

module.exports = { post, get, getHeaders, PAYAZA_BASE_URL };
