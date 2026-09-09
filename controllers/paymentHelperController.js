/**
 * controllers/paymentHelperController.js
 *
 * Utility endpoints that help the frontend with payment-related lookups.
 *
 * ── Endpoints ─────────────────────────────────────────────────────────────────
 *
 *   GET /api/payments/banks
 *     Returns the list of Nigerian banks supported by Payaza — with their
 *     bank codes. The frontend uses this to populate the bank dropdown on
 *     the "Add bank account" screen (PUT /api/creators/:id/bank).
 *
 *     Uses: payaza.account.getBankCodes('NGN')
 *
 *   GET /api/payments/enquire?accountNumber=0123456789&bankCode=044
 *     Resolves a bank account number + bank code to the account holder's name.
 *     The frontend shows this name to the creator BEFORE they save their bank
 *     account — confirms the account belongs to them and prevents typos.
 *
 *     Uses: payaza.account.nameEnquiry({ service_payload: { ... } })
 *
 * ── Caching ───────────────────────────────────────────────────────────────────
 *
 *   Bank list: cached in memory for 24 hours — it almost never changes.
 *   Name enquiry: NOT cached — account ownership can change.
 *
 * Exported:
 *   - getBankList       → GET /api/payments/banks
 *   - accountNameEnquiry→ GET /api/payments/enquire
 */

const { payaza } = require('../config/payaza');
const { PayazaError } = require('payaza-node-sdk');

// ─────────────────────────────────────────────────────────────────────────────
// Simple in-memory cache for the bank list
// ─────────────────────────────────────────────────────────────────────────────

let bankListCache = null;
let bankListCachedAt = 0;
const BANK_LIST_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payments/banks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the list of Nigerian banks supported by Payaza for NGN transfers.
 *
 * Response includes bank name and bank_code for each bank.
 * The frontend passes bank_code to PUT /api/creators/:id/bank when saving
 * the creator's bank account details.
 *
 * Common banks and their Payaza codes:
 *   Access Bank: 044    GTBank: 058    First Bank: 011    Zenith: 057
 *   UBA: 033            FCMB: 214      Kuda: 090267       OPay: 999992
 *   PalmPay: 999991     Moniepoint: 50515
 *
 * @route  GET /api/payments/banks
 * @access Public — frontend needs this before a creator even logs in
 */
const getBankList = async (req, res, next) => {
  try {
    // ── Check cache ───────────────────────────────────────────────────────────
    const now = Date.now();
    if (bankListCache && now - bankListCachedAt < BANK_LIST_TTL_MS) {
      return res.status(200).json({
        success: true,
        count: bankListCache.length,
        cached: true,
        data: bankListCache,
      });
    }

    // ── Fetch from Payaza SDK ─────────────────────────────────────────────────
    // payaza.account.getBankCodes('NGN') returns an array of bank objects
    // Each has at minimum: { bank_name, bank_code } or similar fields
    let sdkResponse;
    try {
      sdkResponse = await payaza.account.getBankCodes('NGN');
    } catch (sdkError) {
      const isPayazaError = sdkError instanceof PayazaError;
      console.error('[Banks] SDK error:', isPayazaError ? sdkError.response : sdkError.message);

      // If Payaza is down, return a hardcoded fallback list of the most common banks
      // so the UI doesn't break — creators can still add their bank account
      const fallbackBanks = [
        { bank_name: 'Access Bank',         bank_code: '044' },
        { bank_name: 'GTBank',              bank_code: '058' },
        { bank_name: 'First Bank',          bank_code: '011' },
        { bank_name: 'Zenith Bank',         bank_code: '057' },
        { bank_name: 'UBA',                 bank_code: '033' },
        { bank_name: 'FCMB',               bank_code: '214' },
        { bank_name: 'Fidelity Bank',       bank_code: '070' },
        { bank_name: 'Union Bank',          bank_code: '032' },
        { bank_name: 'Sterling Bank',       bank_code: '232' },
        { bank_name: 'Wema Bank',           bank_code: '035' },
        { bank_name: 'Polaris Bank',        bank_code: '076' },
        { bank_name: 'Stanbic IBTC',        bank_code: '221' },
        { bank_name: 'Standard Chartered',  bank_code: '068' },
        { bank_name: 'Citibank',            bank_code: '023' },
        { bank_name: 'Heritage Bank',       bank_code: '030' },
        { bank_name: 'Keystone Bank',       bank_code: '082' },
        { bank_name: 'Providus Bank',       bank_code: '101' },
        { bank_name: 'Jaiz Bank',           bank_code: '301' },
        { bank_name: 'Kuda Bank',           bank_code: '090267' },
        { bank_name: 'OPay',               bank_code: '999992' },
        { bank_name: 'PalmPay',            bank_code: '999991' },
        { bank_name: 'Moniepoint',         bank_code: '50515' },
        { bank_name: 'Carbon',             bank_code: '565' },
        { bank_name: 'VFD Microfinance',   bank_code: '090110' },
      ];

      return res.status(200).json({
        success: true,
        count: fallbackBanks.length,
        cached: false,
        fallback: true, // Tells frontend Payaza was unreachable
        data: fallbackBanks,
      });
    }

    // Normalise the SDK response — the field names may vary
    const banks = (sdkResponse?.data || sdkResponse || []).map((bank) => ({
      bank_name: bank.bank_name || bank.bankName || bank.name || bank.bank || '',
      bank_code: bank.bank_code || bank.bankCode || bank.code || '',
    })).filter((b) => b.bank_name && b.bank_code);

    // ── Cache and return ──────────────────────────────────────────────────────
    bankListCache = banks;
    bankListCachedAt = now;

    return res.status(200).json({
      success: true,
      count: banks.length,
      cached: false,
      data: banks,
    });

  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payments/enquire
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolves a Nigerian bank account number + bank code to the account holder name.
 *
 * Used on the "Add bank account" screen — the creator enters their account
 * number and bank, we show them the account name so they can confirm it's
 * correct before saving it for withdrawals.
 *
 * Query params:
 *   ?accountNumber=0123456789   → 10-digit NUBAN account number
 *   ?bankCode=044               → Payaza bank code (from /api/payments/banks)
 *
 * @route  GET /api/payments/enquire
 * @access Private — protect middleware (only logged-in creators can enquire)
 */
const accountNameEnquiry = async (req, res, next) => {
  try {
    const { accountNumber, bankCode } = req.query;

    // ── Validate query params ─────────────────────────────────────────────────
    if (!accountNumber || !bankCode) {
      return res.status(400).json({
        success: false,
        error: 'accountNumber and bankCode are required query parameters.',
      });
    }

    // Nigerian NUBAN account numbers are exactly 10 digits
    if (!/^\d{10}$/.test(accountNumber)) {
      return res.status(400).json({
        success: false,
        error: 'accountNumber must be exactly 10 digits (NUBAN standard).',
      });
    }

    // ── Call Payaza name enquiry ──────────────────────────────────────────────
    // payaza.account.nameEnquiry() resolves account number + bank code → account name
    // The creator can then confirm it's their account before saving
    let enquiryResponse;
    try {
      enquiryResponse = await payaza.account.nameEnquiry({
        service_payload: {
          currency:       'NGN',
          bank_code:      bankCode,
          account_number: accountNumber,
        },
      });
    } catch (sdkError) {
      const isPayazaError = sdkError instanceof PayazaError;
      console.error('[NameEnquiry] SDK error:', isPayazaError ? sdkError.response : sdkError.message);

      // Payaza returns 400/422 for invalid account numbers — map to user-friendly message
      if (isPayazaError && (sdkError.status === 400 || sdkError.status === 422 || sdkError.status === 404)) {
        return res.status(400).json({
          success: false,
          error: 'Account number not found. Please check the account number and bank, then try again.',
        });
      }

      return res.status(502).json({
        success: false,
        error: 'Could not verify account at this time. Please try again.',
      });
    }

    // Extract the account name from the Payaza response
    // Field name varies — try known possible names
    const accountName =
      enquiryResponse?.response_content?.account_name ||
      enquiryResponse?.data?.account_name ||
      enquiryResponse?.account_name ||
      enquiryResponse?.accountName ||
      null;

    if (!accountName) {
      return res.status(400).json({
        success: false,
        error: 'Could not resolve account name. Please double-check the account number.',
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        accountName,
        accountNumber,
        bankCode,
      },
    });

  } catch (err) {
    next(err);
  }
};

module.exports = { getBankList, accountNameEnquiry };
