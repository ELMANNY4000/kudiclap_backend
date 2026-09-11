# KudiClap Backend

> Tip African Creators. Instantly. No Fees. No Apps.

Backend API for KudiClap — a zero-fee tipping platform built for African creators.
Creators get a **custom link** (e.g. `kudiclap.com/ulodo`) and a **USSD code** (e.g. `*388*12345#`).
Fans tip via card, bank transfer, mobile money, or USSD.
Creators withdraw straight to their bank account.

Built for **The Fusion Hack** hackathon (Sept 12–19, 2026).

---

## 🚀 Live API

```
https://web-production-d2a8f.up.railway.app
```

Health check:
```
GET https://web-production-d2a8f.up.railway.app/health
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 18+ |
| Framework | Express 4 |
| Database | Firebase Firestore |
| Auth | Firebase Auth |
| Payments | Payaza (card, bank transfer, mobile money) |
| Email | Nodemailer (Gmail) |
| Hosting | Railway |

---

## Core Flow — How a Tip Works

```
Fan visits kudiclap.com/ulodo
  → GET /api/creators/u/ulodo          (load creator public profile)
  → Fan clicks "Tip ₦500"
  → POST /api/payments/tip             (get Payaza checkout params)
  → Fan completes payment in Payaza modal
  → Payaza fires POST /api/payments/webhook
  → Backend verifies with payaza.account.getTransactionStatus()
  → Creator wallet credited (atomic Firestore transaction)
  → Email notification sent to creator
```

## Core Flow — How a Withdrawal Works

```
Creator on dashboard
  → POST /api/withdrawals              (body: { creatorId, amount, pin })
  → Backend verifies 4-digit PIN (bcrypt)
  → Calculates commission (Firestore commissions collection)
  → Deducts totalDeduction from wallet (atomic)
  → Calls payaza.transfers.initiate() with creator's bank account
  → Payaza fires POST /api/payments/webhook (transfer.success/failed)
  → Withdrawal status updated, email sent
  → If failed: wallet balance automatically restored
```

---

## Prerequisites

- **Node.js 18+** — [nodejs.org](https://nodejs.org)
- **Firebase project** — [console.firebase.google.com](https://console.firebase.google.com)
- **Payaza business account** — [business.payaza.africa](https://business.payaza.africa)
- **Gmail account** (for OTP emails)

---

## Local Setup

### 1. Clone and install

```bash
git clone https://github.com/ELMANNY4000/kudiclap_backend.git
cd kudiclap_backend
npm install
```

### 2. Configure environment variables

Create a `.env` file in the root and fill in:

```env
# Server
PORT=3000
NODE_ENV=development
BACKEND_URL=http://localhost:3000
FRONTEND_URL=http://localhost:3001
ALLOWED_ORIGIN=http://localhost:3001

# Payaza — business.payaza.africa → Settings → Developers
PAYAZA_PUBLIC_KEY=your_payaza_public_key
PAYAZA_SECRET_KEY=your_payaza_secret_key
PAYAZA_ENV=test
PAYAZA_TRANSACTION_PIN=your_6_digit_pin
PAYAZA_WEBHOOK_SECRET=your_webhook_secret

# Firebase — Firebase Console → Project Settings → Service Accounts
FIREBASE_PROJECT_ID=your_project_id
FIREBASE_CLIENT_EMAIL=your_client_email
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
FIREBASE_WEB_API_KEY=your_web_api_key

# Email — Gmail App Password
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_SECURE=false
EMAIL_USER=your@gmail.com
EMAIL_PASS=your_app_password
EMAIL_FROM="KudiClap <noreply@kudiclap.com>"

# Dev only — returns OTP in API response for testing
RETURN_OTP_IN_RESPONSE=true

# Admin
ADMIN_EMAILS=your@gmail.com
KUDICLAP_PHONE=08000000000
```

### 3. Start the server

```bash
npm run dev
```

Server starts on `http://localhost:3000`. Visit `http://localhost:3000/health` to confirm.

On first start, the server automatically seeds default commission rules into Firestore.

---

## Firestore Composite Indexes

Create these in **Firebase Console → Firestore → Indexes → Composite**:

| Collection | Fields | Order |
|-----------|--------|-------|
| `transactions` | `creatorId` ▲, `timestamp` ▼ | ASC, DESC |
| `transactions` | `creatorId` ▲, `paymentMethod` ▲, `timestamp` ▼ | ASC, ASC, DESC |
| `transactions` | `creatorId` ▲, `status` ▲, `timestamp` ▼ | ASC, ASC, DESC |
| `withdrawals` | `creatorId` ▲, `timestamp` ▼ | ASC, DESC |
| `otps` | `email` ▲, `purpose` ▲, `used` ▲ | ASC, ASC, ASC |
| `otps` | `email` ▲, `purpose` ▲, `used` ▲, `createdAt` ▼ | ASC, ASC, ASC, DESC |

> Firestore will throw an error with a direct auto-create link the first time each query runs — click the link to create the index instantly.

---

## API Reference

**Base URL:** `https://web-production-d2a8f.up.railway.app`

### Auth — `/api/auth`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/signup` | Public | Create creator account → returns `customLink`, `ussdCode`, `customToken` |
| POST | `/api/auth/login` | Public | Login → returns `idToken` + `refreshToken` |
| POST | `/api/auth/logout` | 🔒 | Revoke all sessions server-side |
| GET | `/api/auth/me` | 🔒 | Get current creator profile + `customLink` |
| POST | `/api/auth/change-password` | 🔒 | Change login password |
| POST | `/api/auth/set-pin` | 🔒 | Set 4-digit withdrawal PIN (first time) |
| POST | `/api/auth/change-pin` | 🔒 | Update existing withdrawal PIN |
| POST | `/api/auth/request-otp` | Public | Request OTP for password/PIN reset |
| POST | `/api/auth/verify-otp` | Public | Verify OTP → returns `verificationToken` |
| POST | `/api/auth/reset-pin` | Public | Reset PIN using `verificationToken` |

### Creators — `/api/creators`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/creators/u/:username` | Public | **Fan tip page** — returns `customLink`, `ussdCode`, public profile |
| GET | `/api/creators/:id` | Public | Public profile by Firestore ID |
| GET | `/api/creators/dashboard/:id` | 🔒 | Private dashboard — wallet, bank, recent tips |
| PUT | `/api/creators/:id` | 🔒 | Update name, bio, profile picture |
| PUT | `/api/creators/:id/bank` | 🔒 | Save bank account for withdrawals |

### Payments — `/api/payments`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/payments/banks` | Public | List Nigerian banks + codes |
| GET | `/api/payments/enquire` | 🔒 | Resolve account number to account name |
| POST | `/api/payments/tip` | Public | **Initiate a fan tip** (returns Payaza checkout params) |
| POST | `/api/payments/verify/:txRef` | Public | Verify payment + credit creator wallet |
| POST | `/api/payments/card-callback` | Public | Payaza card 3DS result callback |
| POST | `/api/payments/webhook` | Public | Payaza webhook (HMAC-SHA512 verified) |

### USSD — `/api/ussd`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/ussd/tip` | Public | Fan tips via USSD shortcode (e.g. `*388*12345#`) |
| POST | `/api/ussd/withdraw/initiate` | 🔒 | Creator initiates USSD withdrawal (PIN required) |
| POST | `/api/ussd/withdraw/verify` | 🔒 | Confirm USSD withdrawal with code |
| POST | `/api/ussd/withdraw/cancel` | 🔒 | Cancel pending USSD withdrawal |

### Withdrawals — `/api/withdrawals`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/withdrawals` | 🔒 | Request bank transfer payout (PIN required) |
| GET | `/api/withdrawals/:creatorId` | 🔒 | Withdrawal history |
| GET | `/api/withdrawals/status/:withdrawalId` | 🔒 | Status of a specific withdrawal |

### Transactions — `/api/transactions`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/transactions/:creatorId` | 🔒 | Tip history (paginated, filterable by method) |
| GET | `/api/transactions/:creatorId/summary` | 🔒 | Aggregated stats (total, average, by method) |
| GET | `/api/transactions/single/:id` | 🔒 | Single transaction by ID |

### Admin — `/api/admin`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/admin/stats` | 🔒 Admin | Platform-wide statistics |
| GET | `/api/admin/commissions` | 🔒 Admin | List all commission rules |
| GET | `/api/admin/commissions/:type` | 🔒 Admin | Get one rule (withdraw/deposit/payment) |
| PUT | `/api/admin/commissions/:type` | 🔒 Admin | Update commission rate |

> 🔒 = requires `Authorization: Bearer <idToken>` header  
> 🔒 Admin = also requires email in `ADMIN_EMAILS` env var

---

## Postman Testing — Core Loop

### Step 1 — Sign up
```json
POST /api/auth/signup
{
  "name": "Test Creator",
  "email": "test@example.com",
  "password": "Test1234",
  "username": "testcreator",
  "mobileMoneyNumber": "08012345678"
}
```
Response includes `customLink: "kudiclap.com/testcreator"` and `ussdCode`.

### Step 2 — Login
```json
POST /api/auth/login
{
  "email": "test@example.com",
  "password": "Test1234"
}
```
Copy the `idToken` — use as `Authorization: Bearer <idToken>` on all protected requests.

### Step 3 — Set withdrawal PIN
```json
POST /api/auth/set-pin
{ "pin": "1234" }
```

### Step 4 — Add bank account
```json
PUT /api/creators/:id/bank
{
  "bankAccountNumber": "0123456789",
  "bankCode": "044",
  "bankName": "Access Bank",
  "bankAccountName": "Test Creator"
}
```

### Step 5 — View fan tip page
```
GET /api/creators/u/testcreator
```
Returns public profile with `customLink`, `ussdCode`, `totalEarnings`.

### Step 6 — Initiate a tip
```json
POST /api/payments/tip
{
  "creatorId": "<uid>",
  "amount": 500,
  "paymentMethod": "checkout",
  "fanName": "Test Fan",
  "fanEmail": "fan@example.com"
}
```
Returns `checkoutParams` — pass to Payaza Checkout SDK on frontend.

### Step 7 — Check dashboard
```
GET /api/creators/dashboard/:id
```
Shows `walletBalance`, `totalEarnings`, `recentTransactions`, `customLink`.

### Step 8 — Request a withdrawal
```json
POST /api/withdrawals
{
  "creatorId": "<uid>",
  "amount": 500,
  "pin": "1234"
}
```

---

## Deployment to Railway

### 1. Push to GitHub
```bash
git push origin main
```

### 2. Railway setup
1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub**
2. Select `ELMANNY4000/kudiclap_backend`
3. Go to **Variables** tab → **Raw Editor** → paste all env vars
4. Railway auto-deploys on every push to `main`

### 3. Environment variables on Railway
Set all variables from your `.env` file. Key ones for production:
```
NODE_ENV=production
BACKEND_URL=https://your-app.up.railway.app
PAYAZA_ENV=live  (only when going live with real money)
RETURN_OTP_IN_RESPONSE=false
```

### 4. After deploy — add webhook URL in Payaza
```
https://your-app.up.railway.app/api/payments/webhook
```

### 5. Verify
```
GET https://your-app.up.railway.app/health
→ { "status": "ok", "message": "KudiClap backend is running." }
```

---

## Project Structure

```
kudiclap_backend/
├── config/
│   ├── firebase.js              # Firebase Admin SDK
│   └── payaza.js                # Payaza SDK client
├── controllers/
│   ├── authController.js        # signup, login, PIN, password, logout
│   ├── creatorController.js     # profiles, dashboard, bank account
│   ├── paymentController.js     # tips, webhook, card callback
│   ├── paymentHelperController.js # bank list, account name enquiry
│   ├── ussdController.js        # USSD tip + USSD withdrawal
│   ├── withdrawalController.js  # Payaza bank transfer payouts
│   ├── transactionController.js # tip history, summary, pagination
│   ├── otpController.js         # OTP request, verify, PIN reset
│   └── adminController.js       # commission management, platform stats
├── routes/
│   ├── authRoutes.js
│   ├── creatorRoutes.js
│   ├── paymentRoutes.js
│   ├── ussdRoutes.js
│   ├── withdrawalRoutes.js
│   ├── transactionRoutes.js
│   └── adminRoutes.js
├── services/
│   ├── emailService.js          # Nodemailer — OTP + tip + withdrawal emails
│   └── commissionService.js     # Fee calculation + Firestore seeding
├── middlewares/
│   ├── authMiddleware.js        # Firebase token verification + isSameUser
│   └── errorMiddleware.js       # Global error handler
├── utils/
│   ├── validation.js            # All Joi schemas (17 schemas)
│   └── generateUssdCode.js      # *388*XXXXX# generator
├── firestore.rules              # Firestore security rules
├── firestore.indexes.json       # All 6 composite index definitions
├── firebase.json                # Firebase CLI config
├── Procfile                     # Railway start command
├── app.js                       # Express setup + all routes
└── server.js                    # HTTP server entry point + commission seed
```

---

## Firestore Collections

| Collection | Purpose |
|-----------|---------|
| `creators` | Creator profiles + wallet balances |
| `transactions` | All confirmed tip records |
| `withdrawals` | Payout requests + status |
| `pendingPayments` | Pre-credit payment intents (30-min expiry) |
| `commissions` | Platform fee configuration |
| `otps` | OTP codes (bcrypt-hashed, 10-min expiry) |
| `otpVerifications` | Post-OTP tokens for PIN reset (5-min expiry) |
| `ussdWithdrawals` | Pending USSD withdrawal confirmations (10-min expiry) |

---

## Security

- **Passwords** — managed by Firebase Auth (bcrypt internally), never stored in our database
- **Withdrawal PIN** — 4-digit PIN stored as bcrypt hash in Firestore
- **OTP codes** — generated with `crypto.randomBytes()` (CSPRNG), stored as bcrypt hash
- **USSD confirmation codes** — generated with `crypto.randomBytes()`, stored as bcrypt hash
- **Webhook verification** — HMAC-SHA512 signature checked on every Payaza webhook
- **Rate limiting** — auth: 10 req/15min, payments: 20 req/15min, general: 100 req/15min
- **Firestore rules** — all client writes blocked; Admin SDK bypasses rules server-side
- **Idempotent credits** — `creditCreatorWallet()` checks for duplicate `payazaRef` before writing

---

## Team

| Name | Role |
|------|------|
| Ulodo Emmanuel | Full-Stack Dev + Designer (Lead) |
| Victor | Frontend Developer |
| Israel | Backend Developer |
| Vicent | Graphic Designer |

---

## License

ISC
