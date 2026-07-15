# Sasa Loan

Micro-lending management system. See the full functional specification
(22 sections, all design decisions confirmed) for complete business rules.

## Status: Clean rebuild — Phase 0 + Phase 1 only

This is a **from-scratch rebuild**, replacing the earlier v4 codebase entirely.
Nothing from v4 was ported over — the schema below was built directly from
the finalized spec, so it doesn't carry forward any of v4's unverified
assumptions or half-applied migrations.

**What's built:**
- Full database schema (`src/db.js`) — every table the spec describes, created
  up front. Includes the `loans.status` CHECK constraint with the complete
  status list (including `written_off` / `pending_clarification`, which
  required an awkward table-rebuild workaround in v4 — not an issue here
  since this is a fresh table).
- Loan math (`src/utils/loanMath.js`) — flat-rate interest, installment
  schedule generation, payment application with overpayment rollforward,
  PAR aging buckets. Pure functions, fully unit tested.
- Encryption helper (`src/utils/encryption.js`) — AES-256-GCM for ID numbers
  and KYC photos at rest.
- Minimal server bootstrap (`server.js`) — initializes the DB and exposes a
  health check. **No business route logic yet — intentional.**

**What's NOT built yet (by design — stopping here for review):**
- Auth routes (login, lockout, password reset)
- Registration/KYC wizard + review queue
- Loan application, approval, disbursement, repayment routes
- Member portal
- Reporting
- Notifications (WhatsApp, in-app)
- Backups cron job
- Frontend (public/)

## Setup

```bash
npm install
cp .env.example .env
# generate an encryption key and paste it into .env:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npm run test    # runs loan math unit tests
npm start        # boots the server, initializes the DB, seeds a Super Admin
```

On first boot, if no `super_admin` user exists, one is seeded using the
`SEED_SUPERADMIN_*` env vars. If `SEED_SUPERADMIN_PASSWORD` is left blank, a
random temp password is generated and printed to the console once — not
stored anywhere else. The account is forced to change its password on first
login (once auth routes exist).

## Database

SQLite via `better-sqlite3`, file path set by `DB_PATH` (defaults to
`./data/sasa-loan.db`). On Render's free tier this has no persistent disk —
acceptable for testing only, per the spec's known infrastructure risk.

## Tests

```bash
npm test
```

Runs `tests/loanMath.test.js` (21 tests) covering flat-rate interest,
installment schedule generation (including the exact worked examples from
the spec), overpayment rollforward, and PAR aging bucket logic — the areas
flagged in the spec as most likely to contain subtle bugs given real money
is involved.

## Next step

Review the schema and test results against the spec. Once confirmed, proceed
to Phase 2 (Registration/KYC) per the build roadmap.
