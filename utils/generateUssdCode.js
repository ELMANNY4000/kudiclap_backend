/**
 * utils/generateUssdCode.js
 *
 * Utility function that generates a unique USSD code for each creator
 * when they sign up on KudiClap.
 *
 * How USSD codes work on KudiClap:
 *   - Every creator gets a unique code like *388*12345#
 *   - Fans dial this code on any phone (no internet needed) to send a tip
 *   - The *388* prefix is KudiClap's identifier on the USSD gateway
 *   - The 5-digit number uniquely identifies the creator
 *
 * NOTE: For the hackathon, USSD is simulated via a frontend input field.
 * In production, this code would be registered with a real USSD gateway
 * (e.g. Twilio, MFS Africa, or a telco partner like MTN/Airtel).
 */

/**
 * Generates a random USSD short code in the format *388*XXXXX#
 *
 * The random number is between 10000 and 99999 (5 digits) to keep
 * codes consistent in length and easier to dial.
 *
 * @returns {string} A USSD code string, e.g. "*388*47291#"
 */
const generateUssdCode = () => {
  // Generate a random 5-digit number (10000–99999)
  const randomNum = Math.floor(10000 + Math.random() * 90000);

  // Format it into the KudiClap USSD pattern
  return `*388*${randomNum}#`;
};

module.exports = { generateUssdCode };
