/**
 * config/payaza.js
 *
 * Exports a singleton Payaza SDK client for use across all controllers.
 *
 * We now use the official payaza-node-sdk package instead of manual axios calls.
 * The SDK handles:
 *   - Base64-encoding the public key automatically
 *   - Attaching the correct Authorization, X-TenantID, X-ProductID headers
 *   - Throwing PayazaError on non-2xx responses (with .status and .response)
 *   - TypeScript types (if we ever migrate to TS)
 *
 * SDK client options:
 *   publicKey   → your raw Payaza public key from the dashboard (not pre-encoded)
 *   environment → "test" for sandbox (no real money), "live" for production
 *   productId   → "app" — only required on mobile money collection endpoints
 *   timeoutMs   → 30 seconds per request
 *
 * Available namespaces on the client:
 *   payaza.account            → view balances, nameEnquiry, getBankCodes, getTransactionStatus
 *   payaza.transfers          → initiate, getStatus
 *   payaza.cards              → charge, getTransactionStatus
 *   payaza.virtualAccounts    → create, getStatus, getTransactionStatus
 *   payaza.mobileMoneyCollections → collect, getTransactionStatus
 *   payaza.subAccounts        → create, get
 *   payaza.refunds            → initiate, getStatus, getHistory
 *
 * Also exported:
 *   verifyWebhookSignature(rawBody, signature, secret)
 *   → Verifies Payaza webhook HMAC-SHA512 signatures
 *   → rawBody must be a Buffer (use express.raw() on the webhook route)
 *
 * Usage in controllers:
 *   const { payaza, verifyWebhookSignature } = require('../config/payaza');
 *   const result = await payaza.transfers.initiate({ ... });
 *   const isValid = verifyWebhookSignature(req.body, sig, secret);
 */

const { Payaza, verifyWebhookSignature } = require('payaza-node-sdk');

// ── Validate that the required env var is present at startup ──────────────────
// Fail fast — better to crash on boot than get a confusing runtime error
// deep inside a payment flow.
if (!process.env.PAYAZA_PUBLIC_KEY) {
  // In test environments (e.g. CI without .env) just warn, don't crash
  // In production this MUST be set or payments will fail
  console.warn('[Payaza] WARNING: PAYAZA_PUBLIC_KEY is not set in environment variables.');
}

// ── Create the singleton Payaza SDK client ────────────────────────────────────
// We create ONE instance at module load time and reuse it everywhere.
// This avoids creating a new client on every request (wasteful) and
// ensures all API calls share the same configuration.
const payaza = new Payaza({
  // The raw public key from business.payaza.africa → Settings → Developers
  // The SDK base64-encodes it and prepends "Payaza " automatically on every request
  publicKey: process.env.PAYAZA_PUBLIC_KEY || '',

  // "test" sends requests to Payaza's sandbox — no real money moves
  // "live" sends real transactions — only switch when going to production
  environment: (process.env.PAYAZA_ENV === 'live' ? 'live' : 'test'),

  // X-ProductID header — required on mobile money collection endpoints
  // "app" is the default and correct value for KudiClap
  productId: 'app',

  // Per-request timeout — 30 seconds is generous but safe for Africa networks
  timeoutMs: 30_000,
});

// Export both the client and the webhook verification helper so controllers
// don't need to import from the SDK directly
module.exports = { payaza, verifyWebhookSignature };
