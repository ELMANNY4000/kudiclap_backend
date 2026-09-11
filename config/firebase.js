/**
 * config/firebase.js
 *
 * Initializes and exports the Firebase Admin SDK connection.
 *
 * Supports two credential methods:
 *
 *   Method 1 — Environment variables (local dev + Railway):
 *     FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
 *     The private key uses literal \n — we replace them with real newlines.
 *
 *   Method 2 — Service account JSON file (fallback):
 *     If FIREBASE_KEY_PATH is set, we load the JSON file directly.
 *     Useful when the private key env var causes formatting issues on some hosts.
 *
 * Usage: const { db, admin } = require('./config/firebase');
 */

const admin = require('firebase-admin');

let credential;

if (process.env.FIREBASE_KEY_PATH) {
  // Method 2 — load from JSON file path (fallback)
  const serviceAccount = require(process.env.FIREBASE_KEY_PATH);
  credential = admin.credential.cert(serviceAccount);
} else {
  // Method 1 — load from environment variables (default)
  // Railway and some hosts store the private key with literal \n — replace them
  const privateKey = process.env.FIREBASE_PRIVATE_KEY
    ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    : undefined;

  if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !privateKey) {
    console.error('[Firebase] Missing required environment variables:');
    if (!process.env.FIREBASE_PROJECT_ID) console.error('  - FIREBASE_PROJECT_ID');
    if (!process.env.FIREBASE_CLIENT_EMAIL) console.error('  - FIREBASE_CLIENT_EMAIL');
    if (!privateKey) console.error('  - FIREBASE_PRIVATE_KEY');
    process.exit(1); // Crash immediately with a clear error rather than a cryptic one later
  }

  const serviceAccount = {
    type: 'service_account',
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key: privateKey,
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
  };

  credential = admin.credential.cert(serviceAccount);
}

// Prevent re-initialization on hot reloads (nodemon)
if (!admin.apps.length) {
  admin.initializeApp({ credential });
}

const db = admin.firestore();

module.exports = { db, admin };
