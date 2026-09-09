/**
 * server.js
 *
 * Entry point for the KudiClap backend server.
 *
 * Responsibilities:
 *   1. Load environment variables from .env
 *   2. Import and start the Express app
 *   3. Run one-time startup tasks (e.g. seed default Firestore documents)
 *
 * Separation of concerns:
 *   app.js    → Express configuration (routes, middleware) — importable without side effects
 *   server.js → HTTP server startup + side effects (Firestore seeding, cron jobs, etc.)
 *
 * Commands:
 *   node server.js          (production / Railway)
 *   npm run dev             (development — nodemon auto-restarts on file change)
 */

// Load .env BEFORE importing anything else so env vars are available
// in every module that runs on require() (firebase.js, payaza.js, etc.)
require('dotenv').config();

const app = require('./app');
const { seedDefaultCommissions } = require('./services/commissionService');

const PORT = process.env.PORT || 3000;

// Start the HTTP server
app.listen(PORT, async () => {
  console.log('─────────────────────────────────────────────');
  console.log(`  KudiClap Backend running on port ${PORT}`);
  console.log(`  Environment : ${process.env.NODE_ENV || 'development'}`);
  console.log(`  Payaza mode : ${process.env.PAYAZA_ENV || 'test'}`);
  console.log(`  Health check: http://localhost:${PORT}/health`);
  console.log('─────────────────────────────────────────────');

  // ── One-time startup tasks ──────────────────────────────────────────────────
  // These run after the server is already accepting requests so they never
  // delay the first incoming connection.

  // Seed Firestore with default commission rules (0% for withdraw/deposit/payment).
  // Idempotent — skips any type that already has a document.
  await seedDefaultCommissions();
});
