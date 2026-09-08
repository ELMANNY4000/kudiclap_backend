/**
 * config/firebase.js
 *
 * Initializes and exports the Firebase Admin SDK connection.
 *
 * Firebase Admin SDK gives us server-side access to Firestore (our database),
 * Firebase Auth, and other Firebase services. This file reads credentials
 * from environment variables so we never hardcode secrets in the codebase.
 *
 * Usage: const { db } = require('./config/firebase');
 */

const admin = require('firebase-admin');

/**
 * Build the Firebase service account credential object from environment variables.
 *
 * When you generate a private key from the Firebase console it gives you a JSON
 * file — we're reading those same values from .env instead of storing the file
 * in the repo (which would be a security risk).
 *
 * The private key is stored as a string in .env with literal \n characters.
 * We replace those with real newlines so the key is formatted correctly.
 */
const serviceAccount = {
  type: 'service_account',
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY
    ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    : undefined,
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
};

/**
 * Initialize the Firebase Admin app.
 *
 * admin.apps.length check prevents re-initializing on hot reloads (e.g. nodemon).
 * If the app is already initialized, we skip initialization to avoid errors.
 */
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

/**
 * Firestore database instance.
 *
 * This is the main object we use throughout the app to read/write data.
 * Firestore is a NoSQL document database — data is organized into
 * collections (like tables) and documents (like rows).
 *
 * Our collections:
 *   - creators      → creator profiles
 *   - transactions  → every tip that has been made
 *   - withdrawals   → every withdrawal request from a creator
 */
const db = admin.firestore();

module.exports = { db, admin };
