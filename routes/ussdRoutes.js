/**
 * routes/ussdRoutes.js
 *
 * Defines the route for USSD payment simulation.
 *
 * Base path: /api/ussd  (set in app.js)
 *
 * Routes:
 *   POST /api/ussd  → Simulate a USSD payment from a fan to a creator
 *
 * How this is used:
 *   In a real USSD setup, the telco's gateway (Twilio, MFS Africa) would POST
 *   to this endpoint automatically when a fan dials a USSD code on their phone.
 *
 *   For the hackathon, the frontend simulates this with a form where the fan
 *   enters the creator's USSD code, their phone number, and the tip amount —
 *   then the frontend POSTs directly to this endpoint.
 *
 * Accepts: { ussdCode, amount, fanPhoneNumber }
 * Example: { "ussdCode": "*388*47291#", "amount": 500, "fanPhoneNumber": "08012345678" }
 */

const express = require('express');
const router = express.Router();

// Controller function for USSD payment simulation
const { processUssdPayment } = require('../controllers/ussdController');

// POST /api/ussd
// Publicly accessible — simulates the USSD gateway calling our backend
router.post('/', processUssdPayment);

module.exports = router;
