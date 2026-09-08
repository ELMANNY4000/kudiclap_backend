/**
 * server.js
 *
 * Entry point for the KudiClap backend server.
 *
 * This file's only job is to:
 *   1. Load environment variables from the .env file
 *   2. Import the configured Express app from app.js
 *   3. Start the HTTP server on the configured port
 *
 * We keep this separate from app.js so the app configuration
 * can be imported independently (e.g. for testing) without
 * actually binding to a port and starting to listen.
 *
 * To start the server:
 *   node server.js          (production)
 *   npm run dev             (development — uses nodemon for auto-restart)
 */

// Load .env file into process.env BEFORE importing anything else.
// This ensures environment variables are available when app.js and the
// config files (firebase.js, flutterwave.js) are first required.
require('dotenv').config();

const app = require('./app');

// Use the PORT from environment variables (Railway/Heroku set this automatically)
// Fall back to port 3000 for local development
const PORT = process.env.PORT || 3000;

// Start the HTTP server and begin listening for incoming requests
app.listen(PORT, () => {
  console.log('─────────────────────────────────────────────');
  console.log(`  KudiClap Backend running on port ${PORT}`);
  console.log(`  Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`  Health check: http://localhost:${PORT}/health`);
  console.log('─────────────────────────────────────────────');
});
