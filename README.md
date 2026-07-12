# Sasa Loan — Loan Management System

A mobile-first micro-lending platform for up to ~500 borrowers: KYC-verified
registration, guarantor-backed loans, 2-level maker-checker approval,
30-day fixed-term loans, WhatsApp notifications, and self-service
extension requests.

Built with Node.js + Express + SQLite (one file, no database server to
manage) and a plain HTML/CSS/JS frontend (no build step).

## How it works

**Registration & KYC**
- Borrower registers with name, WhatsApp phone number, email, password
- Captures a live photo of their ID and a live selfie using their device
  camera (not gallery upload) — requires HTTPS or localhost + camera
  permission
- Account sits as `pending` until staff review the documents
- Staff approve or reject from the **Verifications** tab in the staff
  dashboard; the applicant gets a WhatsApp message either way

**Applying for a loan** (once verified)
- Pick an amount (admin-configurable min/max, default KES 2,000–15,000)
- Pick a **guarantor** from a dropdown of other verified users — the
  guarantor must log in and actively approve before the loan proceeds
- Pick a disbursement date; the due date is fixed at 30 days later
  (admin-configurable) and isn't user-selectable
- Interest is a flat rate applied once over the term (default 12%,
  admin-configurable)

**Approval — enforced 2-level maker-checker, then disbursement**
1. **Level 1** review by any staff member
2. **Level 2** approval — must be a *different* staff member than Level 1
   (the system blocks the same person from doing both)
3. **Disbursement**, marked by staff once money has actually gone out

**Reminders**
- Borrowers see a live countdown pill on their loan (color-coded: green →
  amber at 7 days → red at 3 days/overdue)
- A background job checks every hour and sends WhatsApp reminders daily
  from 3 days before the due date through the due date itself (deduped
  so it only sends once per day per loan)
- Loans past their due date are automatically marked `defaulted`

**Extensions**
- Once disbursed (including if overdue), a borrower can submit a written
  extension request
- Staff approve or reject it
- On approval: the current outstanding total becomes the new principal,
  fresh interest is applied for another full term, and the due date
  moves forward — no separate penalty, exactly one more 30-day cycle.
  Can be requested again afterward if needed, each time requiring staff
  approval.

**Admin settings**
- Admins can change minimum/maximum loan amount, interest rate, and loan
  term length at `/settings.html` — takes effect for new applications
  immediately; existing loans keep their original terms.

## Requirements

- Node.js 18 or later
- HTTPS in production (required for camera access on phones) — Render,
  Railway, etc. provide this automatically

## 1. Install

```bash
cd loan-system
npm install
```

## 2. Configure

```bash
cp .env.example .env
```

Set a long random `JWT_SECRET`. See the WhatsApp section below for the
optional messaging setup.

## 3. First login

The app automatically creates a default admin account the first time it
starts, if no staff/admin account exists yet:

```
Email:    admin@example.com
Password: ChangeMe123!
```

Sign in, then go to **Account → Change password** immediately.

**Adding more staff:** borrowers can't grant themselves staff access —
only via this CLI script (run on the server):

```bash
node create-staff.js "Jane Doe" jane@example.com 0712345678 "a-strong-password" staff
```

You'll want **at least 2 staff accounts** in practice, since Level 1 and
Level 2 loan approval must be done by different people.

## 4. Run it

```bash
npm start
```

Visit **http://localhost:3000**

## WhatsApp messaging (optional but recommended)

Without setup, the app still works fully — WhatsApp messages are just
logged to the console and to a `whatsapp_log` table instead of actually
sending. To enable real sending, at **zero cost** (Meta's direct API has
a free tier, no Twilio markup):

1. Create a free Meta Business account at https://business.facebook.com
2. Go to https://developers.facebook.com, create an app, add the
   **WhatsApp** product
3. Under WhatsApp → API Setup, note your **Phone Number ID** and generate
   a permanent **Access Token**
4. Add both to your `.env`:
   ```
   WHATSAPP_PHONE_NUMBER_ID=your-id-here
   WHATSAPP_ACCESS_TOKEN=your-token-here
   ```
5. Restart the app — messages will now actually send

The phone-number normalization in `src/utils/whatsapp.js` defaults to
Kenya's country code (254) for numbers starting with `0`. Adjust that if
your borrowers are in a different country.

## Data storage

Everything — including uploaded ID photos and selfies (stored as
compressed base64 images) — lives in one SQLite file at `data/loans.db`.
Back up by copying that file.

## Deploying

See the earlier deployment notes for Render/Railway — same process,
no code changes needed. Two things specific to this version:

- **HTTPS is required** for the camera capture on registration to work
  on phones (browsers block camera access on plain HTTP except
  localhost). Render/Railway give you HTTPS automatically.
- **Persistent disk matters even more now** — the database holds real ID
  documents, not just loan records. Recommend the paid tier with a
  persistent disk for anything beyond testing.

## Project structure

```
loan-system/
  server.js                Express app entry point + reminder scheduler startup
  create-staff.js           CLI to create staff/admin accounts
  src/
    db.js                   SQLite connection + schema (users, loans, extensions, settings, whatsapp_log)
    seed.js                 Creates default admin account on first run
    middleware/auth.js       JWT auth + role + verification checks
    routes/auth.js           register, login, KYC verification queue, guarantor list
    routes/loans.js          apply, guarantor response, level1/level2, disburse, repay, extensions
    routes/settings.js       admin-editable loan parameters
    utils/loanCalc.js        flat-rate repayment calculation
    utils/settings.js        settings read/write helpers
    utils/whatsapp.js        Meta Cloud API integration (stubbed until configured)
    utils/reminders.js       hourly sweep: due-date WhatsApp reminders + auto-default
  public/                  Frontend (plain HTML/CSS/JS, mobile-first, no build step)
    index.html               Sign in
    register.html            Borrower sign up with live camera capture
    pending.html             Shown to borrowers awaiting KYC approval
    dashboard.html           Borrower: my loans + guarantor requests
    apply.html               Borrower: loan application with guarantor + date picker
    staff.html               Staff: verification queue, loan queues, extension requests
    settings.html            Admin: editable loan amount/rate/term settings
    loan.html                Shared loan detail + all staff/guarantor/borrower actions
    account.html             Change password
    js/camera.js             Reusable live camera capture helper
  data/loans.db             SQLite database (created on first run)
```

## Security notes before going live

- Set a real, random `JWT_SECRET` in `.env`
- Serve over HTTPS in production (required for camera access anyway)
- Consider rate limiting `/api/auth/login` and `/api/auth/register`
- Back up `data/loans.db` regularly — it now contains ID documents, so
  treat it as sensitive data
