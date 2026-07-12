# Sasa Loan — Loan Management System

A mobile-first micro-lending platform for up to ~500 members: KYC-verified
registration, guarantor-backed loans, role-based 2-level approval
(Loan Officer → Credit Manager), 30-day fixed-term loans, manually-pushed
WhatsApp notifications, and self-service extension requests.

## Roles

| Role | Can do |
|---|---|
| **Super Admin** | Everything — manage all staff accounts (create/edit/suspend/change roles), settings, cash flow analytics, KYC, disburse/repay, extensions, push WhatsApp |
| **Admin** | Settings, cash flow analytics, KYC, extensions, push WhatsApp (never personally does Level 1/2 review) |
| **Loan Officer** | Level 1 loan review, KYC, extensions, push WhatsApp |
| **Credit Manager** | Level 2 loan review, disburse, mark repaid, KYC, extensions, push WhatsApp |
| **Member** | Register, apply for loans, act as guarantor |

A single person **can** hold both Loan Officer and Credit Manager (or any
combination) — the system still blocks the *same person* from doing both
Level 1 and Level 2 on the same loan, regardless of which roles they hold.

Only a **Super Admin** can create/edit/suspend other accounts, from
**Manage users** (`/users.html`) in the app — no command line needed once
the first Super Admin exists. New accounts get a temporary password and
are **forced to change it** before doing anything else.

## How it works

**Registration & KYC** — Member registers with a live camera capture of
their ID and a selfie, account sits `pending` until any staff-side role
approves/rejects it from the dashboard.

**Applying for a loan** — amount (admin-configurable min/max), pick a
guarantor from a dropdown of other verified Members (guarantor must log
in and actively approve), pick a disbursement date (due date is fixed at
30 days later, admin-configurable).

**Approval — Level 1 (Loan Officer) → Level 2 (Credit Manager) → Disbursement (Credit Manager)**

**WhatsApp — all messages are manual "push" buttons**, appearing
contextually on the dashboard/loan page: KYC approval/rejection,
guarantor notice, loan approval, disbursement notice, extension
confirmation. Staff review the pre-filled message, edit if needed, and
click send. **Due-date reminders (3 days out through due date) remain
fully automatic**, since no one's watching at 2am.

**Extensions** — Member submits a written request once disbursed (or
overdue); any staff-side role approves/rejects. On approval: outstanding
total + fresh interest becomes a new 30-day cycle — no penalty, can be
requested again afterward, always requiring approval.

**Dashboard** — sequential sections: pending registrations → pending loan
applications → pending extensions → active loans → overdue loans, plus a
**cash flow trend chart** (disbursed vs repaid by week) visible to
Admin/Super Admin only.

## Requirements

- Node.js 18+, HTTPS in production (required for camera access on phones)

## 1. Install & configure

```bash
cd loan-system
npm install
cp .env.example .env   # then set a random JWT_SECRET
```

## 2. First login

```
Email:    admin@example.com
Password: ChangeMe123!
```

This is a **Super Admin** account, auto-created on first run. Sign in,
you'll be forced to set a new password immediately, then go to
**Manage users** to create your Loan Officer(s) and Credit Manager(s) —
you need **at least one of each** for the approval flow to work, and they
should ideally be different people (though the system allows one person
to hold both roles if you assign it that way).

## 3. Run it

```bash
npm start
```
Visit **http://localhost:3000**

## WhatsApp messaging (optional, free)

Without setup, push buttons still work — messages are logged to the
console/database but not actually sent. To enable real sending at zero
cost via Meta's direct Cloud API (no Twilio markup):

1. Create a free Meta Business account, add the WhatsApp product to a
   developer app at https://developers.facebook.com
2. Get your **Phone Number ID** and a permanent **Access Token**
3. Add to `.env`:
   ```
   WHATSAPP_PHONE_NUMBER_ID=your-id-here
   WHATSAPP_ACCESS_TOKEN=your-token-here
   ```
4. Restart the app

Default country code normalization is Kenya (254) for numbers starting
with `0` — adjust in `src/utils/whatsapp.js` if needed.

## Data storage

Everything (including ID photos/selfies as base64) lives in one SQLite
file at `data/loans.db`. Back up by copying that file — treat it as
sensitive since it holds real ID documents.

## Deploying

Same as before (Render/Railway, no code changes needed) — see earlier
notes. HTTPS is required for camera capture to work on phones, and a
persistent disk matters more than ever now that real KYC documents and
loan records are involved.

## Project structure

```
loan-system/
  server.js                Express entry point + reminder scheduler
  create-staff.js            CLI fallback to create the very first account
  src/
    db.js                     SQLite schema (users w/ multi-role, loans, extensions, settings, whatsapp_log)
    seed.js                   Creates default Super Admin on first run
    middleware/auth.js         JWT auth, multi-role check, forced-password-change guard
    routes/auth.js              register, login, KYC queue, verified-members list
    routes/users.js             Super Admin: create/list/edit-roles/suspend staff accounts
    routes/loans.js              apply, guarantor response, level1/level2, disburse, repay, extensions, cash flow
    routes/settings.js           admin-editable loan parameters
    routes/whatsapp.js           manual "push" send endpoint
    utils/roles.js               multi-role parsing/checking helpers
    utils/loanCalc.js            flat-rate repayment calculation
    utils/settings.js            settings read/write helpers
    utils/whatsapp.js            Meta Cloud API integration (stubbed until configured)
    utils/reminders.js           hourly sweep: automatic due-date WhatsApp reminders + auto-default
  public/                   Frontend (plain HTML/CSS/JS, mobile-first, no build step)
    index.html, register.html, pending.html   Sign in / sign up / KYC-pending screen
    dashboard.html, apply.html                 Member: my loans, guarantor requests, apply
    staff.html                                 Sequential ops dashboard + cash flow chart (Chart.js via CDN)
    users.html                                 Super Admin: manage staff accounts
    settings.html                              Admin/Super Admin: loan parameters
    loan.html                                  Shared detail page + all role-specific actions + WhatsApp push buttons
    account.html                               Change password (handles forced first-login change)
  data/loans.db             SQLite database (created on first run)
```

## Security notes before going live

- Set a real, random `JWT_SECRET`
- Serve over HTTPS (required for camera access anyway)
- Back up `data/loans.db` regularly — it contains ID documents
