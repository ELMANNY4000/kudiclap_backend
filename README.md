# KudiClap Backend

> Tip African Creators. Instantly. No Fees. No Apps.

Backend API for KudiClap — a zero-fee tipping platform built for African creators. Creators get a custom link and USSD code. Fans tip via card, bank transfer, or mobile money. Creators withdraw straight to their bank account.

Built for **The Fusion Hack** hackathon (Sept 12–19, 2026).

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 18+ |
| Framework | Express 4 |
| Database | Firebase Firestore |
| Auth | Firebase Auth |
| Payments | Payaza (card, bank transfer, mobile money) |
| Email | Nodemailer (Gmail / SMTP) |
| Hosting | Railway |

---

## Prerequisites

Before you set up the project, make sure you have:

- **Node.js 18+** — [nodejs.org](https://nodejs.org)
- **A Firebase project** — [console.firebase.google.com](https://console.firebase.google.com)
- **A Payaza business account** — [business.payaza.africa](https://business.payaza.africa)
- **A Gmail account** (for OTP emails in development)

---

## Local Setup

### 1. Clone and install

```bash
git clone https://github.com/ELMANNY4000/kudiclap_backend.git
cd kudiclap_backend
npm install
```

### 2. Configure environment variables

Copy the `.env` file and fill in your values:

```bash
# The .env file is already in the repo (it is in .gitignore — never commit it)
# Open it and fill in the keys below
```

| Variable | Where to get it | Required |
|----------|----------------|----------|
| `PORT` | Leave as `3000` | ✅ |
| `NODE_ENV` | `development` locally, `production` on Railway | ✅ |
| `BACKEND_URL` | `http://localhost:3000` locally | ✅ |
| `FRONTEND_URL` | `http://localhost:3001` locally | ✅ |
| `ALLOWED_ORIGIN` | `http://localhost:3001` locally | ✅ |
| `PAYAZA_PUBLIC_KEY` | Payaza dashboard → Settings → Developers → API Keys | ✅ |
| `PAYAZA_ENV` | `test` for sandbox, `live` for production | ✅ |
| `PAYAZA_TRANSACTION_PIN` | Payaza dashboard → Settings → Security → set 6-digit PIN | ✅ |
| `PAYAZA_WEBHOOK_SECRET` | Payaza dashboard → Settings → Developers → Webhooks | ✅ |
| `FIREBASE_PROJECT_ID` | Firebase Console → Project Settings → General | ✅ |
| `FIREBASE_CLIENT_EMAIL` | Firebase Console → Project Settings → Service Accounts → Generate key | ✅ |
| `FIREBASE_PRIVATE_KEY` | Same JSON file as above — copy the `private_key` field | ✅ |
| `FIREBASE_WEB_API_KEY` | Firebase Console → Project Settings → General → Web API Key | ✅ |
| `EMAIL_HOST` | `smtp.gmail.com` for Gmail | ✅ |
| `EMAIL_PORT` | `587` | ✅ |
| `EMAIL_SECURE` | `false` for port 587 | ✅ |
| `EMAIL_USER` | Your Gmail address | ✅ |
| `EMAIL_PASS` | Gmail App Password (not your real password) | ✅ |
| `EMAIL_FROM` | `"KudiClap <noreply@kudiclap.com>"` | ✅ |
| `RETURN_OTP_IN_RESPONSE` | `true` in dev (returns OTP in API response for testing) | dev only |
| `ADMIN_EMAILS` | Your email — comma-separated for multiple admins | ✅ |
| `KUDICLAP_PHONE` | Your registered Nigerian business phone number | ✅ |

#### Getting Firebase credentials

1. Go to [Firebase Console](https://console.firebase.google.com) → your project
2. Click the gear icon → **Project Settings**
3. Go to **Service Accounts** tab → click **Generate new private key**
4. Download the JSON file — copy the values into `.env`:
   - `project_id` → `FIREBASE_PROJECT_ID`
   - `client_email` → `FIREBASE_CLIENT_EMAIL`
   - `private_key` → `FIREBASE_PRIVATE_KEY` (paste the full string including `\n` characters, wrapped in double quotes)
5. Go to **General** tab → scroll to **Your apps** → copy the **Web API Key** → `FIREBASE_WEB_API_KEY`

#### Setting up Gmail App Password

1. Enable 2-Factor Authentication on your Google account
2. Go to [myaccount.google.com](https://myaccount.google.com) → **Security** → **App Passwords**
3. Generate a password for **Mail**
4. Paste the 16-character password as `EMAIL_PASS`

### 3. Set up Firebase

In your Firebase project:

1. Go to **Firestore Database** → **Create database** → choose **Start in test mode**
2. Go to **Authentication** → **Sign-in method** → enable **Email/Password**
3. Create the required **composite indexes** (see section below)

### 4. Start the development server

```bash
npm run dev
```

The server starts on `http://localhost:3000`. Visit `http://localhost:3000/health` to confirm it's running.

On first start, the server automatically seeds default commission rules (0% on all transaction types) into Firestore.

---

## Firestore Composite Indexes

Firestore requires composite indexes for queries that combine multiple fields. Create these in **Firebase Console → Firestore → Indexes → Composite**.

Alternatively, add a `firestore.indexes.json` file and run `firebase deploy --only firestore:indexes`.

| Collection | Fields | Order |
|-----------|--------|-------|
| `transactions` | `creatorId` ▲, `timestamp` ▼ | ASC, DESC |
| `transactions` | `creatorId` ▲, `paymentMethod` ▲, `timestamp` ▼ | ASC, ASC, DESC |
| `transactions` | `creatorId` ▲, `status` ▲, `timestamp` ▼ | ASC, ASC, DESC |
| `withdrawals` | `creatorId` ▲, `timestamp` ▼ | ASC, DESC |
| `otps` | `email` ▲, `purpose` ▲, `used` ▲ | ASC, ASC, ASC |
| `otps` | `email` ▲, `purpose` ▲, `used` ▲, `createdAt` ▼ | ASC, ASC, ASC, DESC |

> **Tip:** If you skip this step, Firestore will throw an error the first time each query runs and include a direct link to auto-create the missing index. Click the link.

---

## API Reference

Base URL: `http://localhost:3000` (dev) · `https://your-app.railway.app` (production)

### Auth — `/api/auth`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/signup` | Public | Create creator account |
| POST | `/api/auth/login` | Public | Login → returns `idToken` + `refreshToken` |
| POST | `/api/auth/logout` | 🔒 | Revoke all sessions |
| GET | `/api/auth/me` | 🔒 | Get current creator profile |
| POST | `/api/auth/change-password` | 🔒 | Change login password |
| POST | `/api/auth/set-pin` | 🔒 | Set 4-digit withdrawal PIN (first time) |
| POST | `/api/auth/change-pin` | 🔒 | Update existing withdrawal PIN |
| POST | `/api/auth/request-otp` | Public | Request OTP for password/PIN reset |
| POST | `/api/auth/verify-otp` | Public | Verify OTP → returns `verificationToken` |
| POST | `/api/auth/reset-pin` | Public | Reset PIN using `verificationToken` |

### Creators — `/api/creators`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/creators/u/:username` | Public | Fan tip page by username |
| GET | `/api/creators/:id` | Public | Public profile by Firestore ID |
| GET | `/api/creators/dashboard/:id` | 🔒 | Private dashboard + wallet + recent tips |
| PUT | `/api/creators/:id` | 🔒 | Update name, bio, profile picture |
| PUT | `/api/creators/:id/bank` | 🔒 | Save bank account for withdrawals |

### Payments — `/api/payments`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/payments/banks` | Public | List Nigerian banks + codes |
| GET | `/api/payments/enquire` | 🔒 | Resolve account number to account name |
| POST | `/api/payments/tip` | Public | Initiate a fan tip |
| POST | `/api/payments/verify/:txRef` | Public | Verify payment + credit creator |
| POST | `/api/payments/card-callback` | Public | Payaza card 3DS result callback |
| POST | `/api/payments/webhook` | Public | Payaza webhook notifications |

### USSD — `/api/ussd`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/ussd/tip` | Public | Fan tips via USSD shortcode |
| POST | `/api/ussd/withdraw/initiate` | 🔒 | Creator initiates USSD withdrawal (PIN required) |
| POST | `/api/ussd/withdraw/verify` | 🔒 | Confirm USSD withdrawal with code |
| POST | `/api/ussd/withdraw/cancel` | 🔒 | Cancel pending USSD withdrawal |

### Withdrawals — `/api/withdrawals`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/withdrawals` | 🔒 | Request a bank transfer payout (PIN required) |
| GET | `/api/withdrawals/:creatorId` | 🔒 | Withdrawal history |
| GET | `/api/withdrawals/status/:withdrawalId` | 🔒 | Status of a specific withdrawal |

### Transactions — `/api/transactions`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/transactions/:creatorId` | 🔒 | Tip history (paginated, filterable) |
| GET | `/api/transactions/:creatorId/summary` | 🔒 | Aggregated stats (total, by method) |
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

## Core Flow — How a Tip Works

```
Fan visits kudiclap.com/ulodo
  → GET /api/creators/u/ulodo          (load creator profile)
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
  → Backend verifies PIN (bcrypt)
  → Calculates commission (Firestore commissions collection)
  → Deducts totalDeduction from wallet (atomic)
  → Calls payaza.transfers.initiate() with creator's bank account
  → Payaza fires POST /api/payments/webhook (transfer.success/failed)
  → Withdrawal status updated, email sent
  → If failed: wallet balance automatically restored
```

---

## Postman Testing — Core Loop

Import and run these requests in order:

### Step 1 — Sign up
```
POST /api/auth/signup
{
  "name": "Test Creator",
  "email": "test@example.com",
  "password": "Test1234",
  "username": "testcreator",
  "mobileMoneyNumber": "08012345678"
}
```
→ Copy the `uid` and `customToken` from the response.

### Step 2 — Login
```
POST /api/auth/login
{
  "email": "test@example.com",
  "password": "Test1234"
}
```
→ Copy the `idToken`. Use this as `Authorization: Bearer <idToken>` on all protected requests.

### Step 3 — Set withdrawal PIN
```
POST /api/auth/set-pin
Authorization: Bearer <idToken>
{
  "pin": "1234"
}
```

### Step 4 — Add bank account
```
PUT /api/creators/<uid>/bank
Authorization: Bearer <idToken>
{
  "bankAccountNumber": "0123456789",
  "bankCode": "044",
  "bankName": "Access Bank",
  "bankAccountName": "Test Creator"
}
```

### Step 5 — Get the public tip page
```
GET /api/creators/u/testcreator
```
→ Should return the creator's public profile including their USSD code.

### Step 6 — Initiate a tip (Payaza checkout)
```
POST /api/payments/tip
{
  "creatorId": "<uid>",
  "amount": 500,
  "paymentMethod": "checkout",
  "fanName": "Test Fan",
  "fanEmail": "fan@example.com"
}
```
→ Returns `checkoutParams`. Use these with the Payaza Checkout SDK on the frontend.  
→ In test mode, use Payaza's sandbox to simulate a successful payment.

### Step 7 — Verify the payment manually (if webhook not set up yet)
```
POST /api/payments/verify/<txRef>
```
→ Should credit the creator's wallet and return success.

### Step 8 — Check the dashboard
```
GET /api/creators/dashboard/<uid>
Authorization: Bearer <idToken>
```
→ Should show updated `walletBalance` and the tip in `recentTransactions`.

### Step 9 — Request a withdrawal
```
POST /api/withdrawals
Authorization: Bearer <idToken>
{
  "creatorId": "<uid>",
  "amount": 500,
  "pin": "1234"
}
```
→ Should deduct the wallet and initiate a Payaza transfer.

### Step 10 — Check withdrawal status
```
GET /api/withdrawals/status/<withdrawalId>
Authorization: Bearer <idToken>
```

---

## Deployment to Railway

### 1. Push your code to GitHub

```bash
git push origin main
```

### 2. Create a Railway project

1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
2. Select `ELMANNY4000/kudiclap_backend`
3. Railway auto-detects Node.js and runs `npm start`

### 3. Set environment variables on Railway

Go to your Railway project → **Variables** tab → add every key from your `.env` file.

> **Important:** Do NOT commit your `.env` file. Set all secrets as Railway environment variables.

### 4. Configure Payaza webhook

Once Railway gives you a live URL (e.g. `https://kudiclap-backend.up.railway.app`):

1. Go to Payaza dashboard → **Settings → Developers → Webhooks**
2. Add webhook URL: `https://your-app.up.railway.app/api/payments/webhook`
3. Copy the generated **Secret Hash** → paste as `PAYAZA_WEBHOOK_SECRET` in Railway variables

### 5. Update Railway environment variables

```
BACKEND_URL=https://your-app.up.railway.app
FRONTEND_URL=https://your-frontend.vercel.app
ALLOWED_ORIGIN=https://your-frontend.vercel.app
NODE_ENV=production
PAYAZA_ENV=live   (only when you're ready to go live with real money)
```

### 6. Verify deployment

```
GET https://your-app.up.railway.app/health
```
Should return: `{ "status": "ok", "message": "KudiClap backend is running." }`

---

## Project Structure

```
kudiclap_backend/
├── config/
│   ├── firebase.js          # Firebase Admin SDK singleton
│   └── payaza.js            # Payaza SDK client singleton
├── controllers/
│   ├── authController.js    # signup, login, logout, PIN, password
│   ├── creatorController.js # profiles, dashboard, bank account
│   ├── paymentController.js # tips, webhook, card callback, verification
│   ├── paymentHelperController.js # bank list, account name enquiry
│   ├── ussdController.js    # USSD tip + USSD withdrawal flow
│   ├── withdrawalController.js    # Payaza bank transfer payouts
│   ├── transactionController.js   # tip history, summary, pagination
│   ├── otpController.js     # OTP request, verify, PIN reset
│   └── adminController.js   # commission management, platform stats
├── routes/
│   ├── authRoutes.js
│   ├── creatorRoutes.js
│   ├── paymentRoutes.js
│   ├── ussdRoutes.js
│   ├── withdrawalRoutes.js
│   ├── transactionRoutes.js
│   └── adminRoutes.js
├── services/
│   ├── emailService.js      # nodemailer OTP + notification emails
│   └── commissionService.js # fee calculation + Firestore seeding
├── middlewares/
│   ├── authMiddleware.js    # Firebase token verification
│   └── errorMiddleware.js   # global error handler
├── utils/
│   ├── validation.js        # all Joi schemas
│   └── generateUssdCode.js  # *388*XXXXX# code generator
├── app.js                   # Express setup, routes, middleware
├── server.js                # HTTP server entry point
└── .env                     # environment variables (never commit)
```

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
