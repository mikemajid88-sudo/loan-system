# Northgate Loans — Loan Management System

A simple, fast loan management system for up to ~500 borrowers. Borrowers
register and apply for loans; staff review (vet), approve, or reject
applications; approved loans can be marked as disbursed.

Built with Node.js + Express + SQLite (one file, no database server to
install or manage) and a plain HTML/CSS/JS frontend (no build step).

## Features

- Borrower self-registration and login
- Loan application with live repayment calculation (flat annual interest)
- One open application per borrower at a time (configurable)
- Staff queue: pending → under review → approved/rejected → disbursed
- Full audit trail (loan_events table) for every action taken on a loan
- Staff dashboard with summary stats
- Role-based access (borrower / staff / admin) enforced on every API route

## Requirements

- Node.js 18 or later

## 1. Install

```bash
cd loan-system
npm install
```

## 2. Configure

```bash
cp .env.example .env
```

Open `.env` and set a long random `JWT_SECRET` (used to sign login
tokens). Adjust `DEFAULT_INTEREST_RATE`, `MIN_LOAN_AMOUNT`, and
`MAX_LOAN_AMOUNT` if needed.

## 3. First login

The app automatically creates a default admin account the very first time
it starts, if no staff/admin account exists yet:

```
Email:    admin@example.com
Password: ChangeMe123!
```

Sign in with these, then **immediately go to Account → Change password**
in the top menu to set your own password. This default account is only
ever created once — after that first login it behaves like any other
admin account.

Want a different default instead of typing your own password every time?
Set `DEFAULT_ADMIN_EMAIL` and `DEFAULT_ADMIN_PASSWORD` in your `.env`
before first startup and those will be used instead.

**Adding more staff later:** once you're signed in as admin, create
additional staff accounts from the command line (borrowers can't grant
themselves staff access — only admins can create staff/admin accounts,
deliberately kept out of the public website):

```bash
node create-staff.js "Jane Doe" jane@example.com "a-strong-password" staff
```

## 4. Run it

```bash
npm start
```

Visit **http://localhost:3000**

- Borrowers sign up at `/register.html`
- Everyone signs in at `/` (the login page)
- Staff/admin land on the staff dashboard; borrowers land on their own
  loan list

For local development with auto-restart on file changes: `npm run dev`

## How the loan workflow works

1. **Apply** — a borrower submits amount, term, and purpose. The system
   calculates a monthly payment automatically. Status: `pending`.
2. **Vet** — staff review the application and can add a note and move it
   to `under_review` (optional step — staff can also approve/reject
   directly from `pending`).
3. **Approve / Reject** — staff make the decision, with a required reason
   when rejecting.
4. **Disburse** — once approved, staff mark the loan `disbursed` when the
   money has actually gone out.

Every transition is recorded in `loan_events` with who did it and when, so
you always have a full history per loan.

## Data storage

All data lives in a single SQLite file at `data/loans.db`, created
automatically the first time you run the server. To back up your data,
just copy that file. There is nothing else to configure — no separate
database server.

## Deploying so multiple staff can access it online

Since this is a single Node process with a SQLite file, the simplest
deployment path is a small always-on server:

- **Railway / Render / Fly.io** — connect your git repo, set the
  `JWT_SECRET` env var, and deploy. Attach a persistent volume mounted at
  `data/` so the SQLite file survives restarts/redeploys (all three
  platforms support this).
- **A cheap VPS (DigitalOcean, Linode, etc.)** — install Node, copy the
  project over, run `npm install --production`, then run it under a
  process manager like `pm2` so it restarts automatically:
  ```bash
  npm install -g pm2
  pm2 start server.js --name loan-system
  pm2 save
  ```
  Put it behind Nginx with a free Let's Encrypt SSL certificate for HTTPS.

At 500 users this app will comfortably run on the smallest tier of any of
the above (512MB RAM is plenty).

## Growing beyond this

If you eventually outgrow SQLite (many concurrent staff, very high
volume, need for automated backups/replication), the `better-sqlite3`
calls are isolated in `src/db.js` and the route files — swapping to
Postgres later means rewriting those queries, not the rest of the app.

## Project structure

```
loan-system/
  server.js              Express app entry point
  create-staff.js         CLI to create staff/admin accounts
  src/
    db.js                 SQLite connection + schema
    middleware/auth.js     JWT auth + role checks
    routes/auth.js         register, login, /me
    routes/loans.js        apply, list, vet, approve, reject, disburse, stats
    utils/loanCalc.js      flat-rate repayment calculation
  public/                 Frontend (plain HTML/CSS/JS, no build step)
    index.html             Sign in
    register.html          Borrower sign up
    dashboard.html          Borrower: my loans
    apply.html              Borrower: loan application form
    staff.html              Staff: queue + stats
    loan.html               Shared loan detail + staff actions
  data/loans.db           SQLite database (created on first run)
```

## Security notes before going live

- Set a real, random `JWT_SECRET` in `.env` — don't use the example value.
- Serve over HTTPS in production (see deployment section).
- Consider adding rate limiting on `/api/auth/login` and
  `/api/auth/register` if this will be public on the internet.
- Back up `data/loans.db` regularly (it's a single file, so this is easy —
  even a nightly `cp` to another location is a good start).
