/**
 * services/emailService.js
 *
 * Handles all outgoing emails for KudiClap using Nodemailer.
 *
 * ── Email types sent by KudiClap ─────────────────────────────────────────────
 *
 *   OTP (forgot_password)        → "Your KudiClap password reset code is 483921"
 *   OTP (reset_pin)              → "Your KudiClap PIN reset code is 739201"
 *   OTP (withdrawal_verification)→ "Confirm your withdrawal with code 112938"
 *   Tip received                 → "You received a ₦500 tip from Anonymous!"
 *   Withdrawal processed         → "Your ₦5,000 withdrawal is on its way"
 *
 * ── SMTP configuration ────────────────────────────────────────────────────────
 *
 *   Set these in your .env file:
 *
 *     EMAIL_HOST=smtp.gmail.com          (or smtp.sendgrid.net, smtp.resend.com)
 *     EMAIL_PORT=587                     (587 for TLS, 465 for SSL, 25 for plain)
 *     EMAIL_SECURE=false                 (true for port 465, false for 587)
 *     EMAIL_USER=your@gmail.com          (SMTP username)
 *     EMAIL_PASS=your-app-password       (Gmail: use App Password, not your real password)
 *     EMAIL_FROM="KudiClap <noreply@kudiclap.com>"
 *
 *   Gmail setup (recommended for hackathon):
 *     1. Enable 2FA on your Google account
 *     2. Go to myaccount.google.com → Security → App Passwords
 *     3. Generate an App Password for "Mail"
 *     4. Use that 16-char password as EMAIL_PASS
 *
 *   Production alternatives (higher deliverability):
 *     - Resend (resend.com) — simple, modern, developer-friendly
 *     - SendGrid — industry standard, generous free tier
 *     - Mailgun — good for Nigeria
 *
 * ── Dev mode ──────────────────────────────────────────────────────────────────
 *
 *   If EMAIL_HOST is not set, emails are logged to the console instead of sent.
 *   This lets OTP flows work in development without any email setup.
 *   Set RETURN_OTP_IN_RESPONSE=true in .env to also return the OTP in the API
 *   response for easier testing.
 *
 * Exported:
 *   - sendOtp(options)             → sends an OTP code email
 *   - sendTipNotification(options) → notifies creator of a received tip
 *   - sendWithdrawalUpdate(options)→ notifies creator of withdrawal status
 */

const nodemailer = require('nodemailer');

// ─────────────────────────────────────────────────────────────────────────────
// Create the transporter (singleton)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates the Nodemailer transporter.
 *
 * Returns null if EMAIL_HOST is not configured — all send functions
 * check for null and fall back to console logging in that case.
 */
const createTransporter = () => {
  if (!process.env.EMAIL_HOST || !process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    return null; // Email not configured — dev mode
  }

  return nodemailer.createTransporter({
    host:   process.env.EMAIL_HOST,
    port:   parseInt(process.env.EMAIL_PORT || '587', 10),
    // true for port 465 (SSL), false for port 587 (STARTTLS)
    secure: process.env.EMAIL_SECURE === 'true',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    // Timeout settings — important for Nigerian network reliability
    connectionTimeout: 10000, // 10 seconds to connect
    greetingTimeout:   5000,  // 5 seconds for SMTP greeting
    socketTimeout:     15000, // 15 seconds for data transfer
  });
};

// Singleton — created once when the module loads
let transporter = null;

/**
 * Gets or creates the transporter.
 * Lazy-initialised so .env is loaded before we try to create it.
 */
const getTransporter = () => {
  if (!transporter) {
    transporter = createTransporter();
  }
  return transporter;
};

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper — send any email
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sends an email. Falls back to console log if EMAIL_HOST is not configured.
 *
 * @param {object} mailOptions - { to, subject, text, html }
 * @returns {Promise<boolean>} - true if sent, false if logged only
 */
const sendEmail = async (mailOptions) => {
  const transport = getTransporter();

  if (!transport) {
    // Dev mode — log the email content to the console
    console.log('\n📧 [Email — DEV MODE — not actually sent]');
    console.log(`   To:      ${mailOptions.to}`);
    console.log(`   Subject: ${mailOptions.subject}`);
    console.log(`   Body:    ${mailOptions.text}`);
    console.log('');
    return false; // false = logged only, not sent
  }

  try {
    const info = await transport.sendMail({
      from: process.env.EMAIL_FROM || `"KudiClap" <noreply@kudiclap.com>`,
      ...mailOptions,
    });
    console.log(`[Email] Sent to ${mailOptions.to} — messageId: ${info.messageId}`);
    return true;
  } catch (err) {
    // Log the error but don't crash the request — email failure is non-fatal
    // The OTP code is still saved in Firestore, so the user can request a new one
    console.error(`[Email] Failed to send to ${mailOptions.to}:`, err.message);
    return false;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// sendOtp
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sends a 6-digit OTP code to the creator's email.
 *
 * @param {object} options
 * @param {string} options.to        - Creator's email address
 * @param {string} options.otpCode   - The 6-digit OTP code (plain text, not hashed)
 * @param {string} options.purpose   - 'forgot_password' | 'reset_pin' | 'withdrawal_verification'
 * @param {string} options.name      - Creator's name (for personalisation)
 * @returns {Promise<boolean>}       - true if sent, false if dev-logged only
 */
const sendOtp = async ({ to, otpCode, purpose, name = 'Creator' }) => {
  // Map purpose to human-readable subject and body text
  const purposeConfig = {
    forgot_password: {
      subject: 'Your KudiClap Password Reset Code',
      action:  'reset your password',
    },
    reset_pin: {
      subject: 'Your KudiClap PIN Reset Code',
      action:  'reset your withdrawal PIN',
    },
    withdrawal_verification: {
      subject: 'KudiClap Withdrawal Verification Code',
      action:  'verify your withdrawal',
    },
  };

  const config = purposeConfig[purpose] || {
    subject: 'Your KudiClap Verification Code',
    action:  'verify your account',
  };

  const text = `
Hi ${name},

Your KudiClap verification code to ${config.action} is:

    ${otpCode}

This code expires in 10 minutes. Do not share it with anyone.

If you did not request this code, please ignore this email.

— The KudiClap Team
`.trim();

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family: Inter, sans-serif; background: #0A0A0A; color: #ffffff; padding: 40px;">
  <div style="max-width: 480px; margin: 0 auto;">
    <h1 style="color: #00FF85; font-size: 28px; margin-bottom: 4px;">KudiClap</h1>
    <p style="color: #888; font-size: 13px; margin-top: 0;">Tip African Creators. Instantly.</p>

    <div style="background: #111; border-radius: 12px; padding: 32px; margin-top: 24px;">
      <p style="margin-top: 0;">Hi <strong>${name}</strong>,</p>
      <p>Use the code below to ${config.action}:</p>

      <div style="
        background: #0A0A0A;
        border: 2px solid #00FF85;
        border-radius: 8px;
        padding: 20px;
        text-align: center;
        margin: 24px 0;
      ">
        <span style="
          font-size: 36px;
          font-weight: 700;
          letter-spacing: 8px;
          color: #00FF85;
          font-family: 'Space Grotesk', monospace;
        ">${otpCode}</span>
      </div>

      <p style="color: #888; font-size: 13px;">
        This code expires in <strong style="color: #fff;">10 minutes</strong>.
        Do not share it with anyone — KudiClap will never ask for your code.
      </p>
    </div>

    <p style="color: #555; font-size: 12px; margin-top: 24px; text-align: center;">
      If you didn't request this, you can safely ignore this email.
    </p>
  </div>
</body>
</html>
  `.trim();

  return sendEmail({ to, subject: config.subject, text, html });
};

// ─────────────────────────────────────────────────────────────────────────────
// sendTipNotification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Notifies a creator that they received a new tip.
 *
 * @param {object} options
 * @param {string} options.to            - Creator's email address
 * @param {string} options.creatorName   - Creator's name
 * @param {number} options.amount        - Tip amount in Naira
 * @param {string} options.fanName       - Fan's name (or 'Anonymous')
 * @param {string} options.paymentMethod - 'card' | 'mobileMoney' | 'ussd' | 'checkout'
 * @param {number} options.newBalance    - Creator's new wallet balance after the tip
 * @returns {Promise<boolean>}
 */
const sendTipNotification = async ({
  to,
  creatorName = 'Creator',
  amount,
  fanName = 'Anonymous',
  paymentMethod = 'checkout',
  newBalance,
}) => {
  const formattedAmount  = `₦${Number(amount).toLocaleString()}`;
  const formattedBalance = newBalance !== undefined ? `₦${Number(newBalance).toLocaleString()}` : null;
  const methodLabel = {
    card:         'Card payment',
    mobileMoney:  'Mobile money',
    bankTransfer: 'Bank transfer',
    ussd:         'USSD',
    checkout:     'Online checkout',
  }[paymentMethod] || paymentMethod;

  const text = `
Hi ${creatorName},

Great news! You just received a ${formattedAmount} tip from ${fanName} via ${methodLabel}.
${formattedBalance ? `\nYour new wallet balance is ${formattedBalance}.` : ''}

Log in to your dashboard to view your earnings and withdraw anytime.

— The KudiClap Team
  `.trim();

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family: Inter, sans-serif; background: #0A0A0A; color: #ffffff; padding: 40px;">
  <div style="max-width: 480px; margin: 0 auto;">
    <h1 style="color: #00FF85; font-size: 28px; margin-bottom: 4px;">KudiClap</h1>
    <p style="color: #888; font-size: 13px; margin-top: 0;">Tip African Creators. Instantly.</p>

    <div style="background: #111; border-radius: 12px; padding: 32px; margin-top: 24px;">
      <p style="margin-top: 0;">Hi <strong>${creatorName}</strong> 🎉</p>
      <p>You just received a new tip!</p>

      <div style="background: #0A0A0A; border-radius: 8px; padding: 20px; margin: 20px 0;">
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="color: #888; padding: 6px 0;">Amount</td>
            <td style="text-align: right; font-weight: 700; color: #00FF85; font-size: 24px;">${formattedAmount}</td>
          </tr>
          <tr>
            <td style="color: #888; padding: 6px 0;">From</td>
            <td style="text-align: right;">${fanName}</td>
          </tr>
          <tr>
            <td style="color: #888; padding: 6px 0;">Method</td>
            <td style="text-align: right;">${methodLabel}</td>
          </tr>
          ${formattedBalance ? `
          <tr>
            <td style="color: #888; padding: 6px 0; border-top: 1px solid #222; padding-top: 12px; margin-top: 8px;">New balance</td>
            <td style="text-align: right; border-top: 1px solid #222; padding-top: 12px;">${formattedBalance}</td>
          </tr>` : ''}
        </table>
      </div>

      <a href="${process.env.FRONTEND_URL || 'https://kudiclap.com'}/dashboard"
         style="display: block; background: #00FF85; color: #0A0A0A; text-align: center;
                padding: 14px; border-radius: 8px; font-weight: 700; text-decoration: none;">
        View Dashboard
      </a>
    </div>
  </div>
</body>
</html>
  `.trim();

  return sendEmail({
    to,
    subject: `💸 You received a ${formattedAmount} tip on KudiClap!`,
    text,
    html,
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// sendWithdrawalUpdate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Notifies a creator about a withdrawal status update (initiated or completed).
 *
 * @param {object} options
 * @param {string} options.to           - Creator's email
 * @param {string} options.creatorName  - Creator's name
 * @param {number} options.amount       - Withdrawal amount
 * @param {string} options.status       - 'pending' | 'completed' | 'failed'
 * @param {string} options.bankName     - Destination bank name
 * @param {string} options.reason       - Failure reason (only for 'failed' status)
 * @returns {Promise<boolean>}
 */
const sendWithdrawalUpdate = async ({
  to,
  creatorName = 'Creator',
  amount,
  status,
  bankName = 'your bank account',
  reason,
}) => {
  const formattedAmount = `₦${Number(amount).toLocaleString()}`;

  const statusConfig = {
    pending: {
      subject: `Your ${formattedAmount} KudiClap withdrawal is being processed`,
      headline: 'Withdrawal initiated 🏦',
      message: `Your withdrawal of ${formattedAmount} to ${bankName} is being processed. This typically takes 1–5 minutes.`,
      color: '#FFD700',
    },
    completed: {
      subject: `Your ${formattedAmount} KudiClap withdrawal is complete ✅`,
      headline: 'Withdrawal successful ✅',
      message: `Your withdrawal of ${formattedAmount} has been sent to ${bankName}. Check your bank account.`,
      color: '#00FF85',
    },
    failed: {
      subject: `Your ${formattedAmount} KudiClap withdrawal failed`,
      headline: 'Withdrawal failed ❌',
      message: `Your withdrawal of ${formattedAmount} could not be processed${reason ? `: ${reason}` : '.'}. Your balance has been restored — please try again.`,
      color: '#FF4444',
    },
  };

  const config = statusConfig[status] || statusConfig.pending;

  const text = `
Hi ${creatorName},

${config.message}

Log in to your dashboard to view your wallet balance.

— The KudiClap Team
  `.trim();

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family: Inter, sans-serif; background: #0A0A0A; color: #ffffff; padding: 40px;">
  <div style="max-width: 480px; margin: 0 auto;">
    <h1 style="color: #00FF85; font-size: 28px; margin-bottom: 4px;">KudiClap</h1>
    <p style="color: #888; font-size: 13px; margin-top: 0;">Tip African Creators. Instantly.</p>

    <div style="background: #111; border-radius: 12px; padding: 32px; margin-top: 24px;">
      <h2 style="color: ${config.color}; margin-top: 0;">${config.headline}</h2>
      <p>${config.message}</p>

      <div style="background: #0A0A0A; border-radius: 8px; padding: 16px; margin: 20px 0;">
        <div style="display: flex; justify-content: space-between;">
          <span style="color: #888;">Amount</span>
          <strong style="color: ${config.color};">${formattedAmount}</strong>
        </div>
        <div style="display: flex; justify-content: space-between; margin-top: 8px;">
          <span style="color: #888;">Destination</span>
          <span>${bankName}</span>
        </div>
      </div>

      <a href="${process.env.FRONTEND_URL || 'https://kudiclap.com'}/dashboard"
         style="display: block; background: #00FF85; color: #0A0A0A; text-align: center;
                padding: 14px; border-radius: 8px; font-weight: 700; text-decoration: none;">
        View Dashboard
      </a>
    </div>
  </div>
</body>
</html>
  `.trim();

  return sendEmail({ to, subject: config.subject, text, html });
};

module.exports = {
  sendOtp,
  sendTipNotification,
  sendWithdrawalUpdate,
};
