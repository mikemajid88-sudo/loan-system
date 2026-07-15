// Sasa Loan - database bootstrap.
// Clean-start schema: every table the finalized spec describes is created
// up front, so there is no legacy data to migrate around (unlike v4).
//
// IMPORTANT: the `loans.status` CHECK constraint is defined completely here
// on table creation, including written_off/pending_clarification, which
// required an awkward table-rebuild workaround in v4. Not needed here.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'sasa-loan.db');

// Ensure the data directory exists (Render free tier: ephemeral, but still
// needs to exist within the current process lifetime).
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function createSchema() {
  db.exec(`
    -- ==========================================================
    -- USERS (staff + members share one table; role is comma-
    -- separated to support dual roles, e.g. "loan_officer,credit_manager")
    -- ==========================================================
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL, -- comma-separated: super_admin, admin, credit_manager, loan_officer, member
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT, -- normalized to +254 format
      password_hash TEXT NOT NULL,
      must_change_password INTEGER NOT NULL DEFAULT 1,
      token_version INTEGER NOT NULL DEFAULT 0, -- bumped on password change to invalidate existing JWTs

      -- Personal info (Section 5, step 1)
      date_of_birth TEXT,
      address TEXT,
      next_of_kin TEXT,
      referred_by INTEGER REFERENCES users(id), -- optional, informational only

      -- ID verification (Section 5, step 2) - encrypted at rest (Section 18)
      id_type TEXT CHECK (id_type IN ('national_id', 'passport', 'alien_id')),
      id_number_encrypted TEXT,
      id_photo_front_encrypted TEXT, -- passports only populate this field
      id_photo_back_encrypted TEXT,  -- null for passports

      -- Selfie (Section 5, step 3) - encrypted at rest
      selfie_photo_encrypted TEXT,

      -- KYC review status (Section 6)
      verification_status TEXT NOT NULL DEFAULT 'pending' CHECK (
        verification_status IN ('pending', 'approved', 'rejected', 'more_info_requested', 'pre_verified')
      ),
      verification_reviewed_by INTEGER REFERENCES users(id),
      verification_reviewed_at TEXT,
      verification_reject_reason TEXT,
      verification_info_requested_note TEXT,

      -- Account lockout (Section 4)
      failed_login_count INTEGER NOT NULL DEFAULT 0,
      lockout_until TEXT,
      lockout_cycle_minutes INTEGER NOT NULL DEFAULT 3,

      -- Account status
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),

      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
    CREATE INDEX IF NOT EXISTS idx_users_verification_status ON users(verification_status);

    -- ==========================================================
    -- PASSWORD RESET TOKENS (Section 2)
    -- ==========================================================
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id);

    -- ==========================================================
    -- CHANGE OF DETAILS REQUESTS (Section 15)
    -- ==========================================================
    CREATE TABLE IF NOT EXISTS change_of_details_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      field_name TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      reviewed_by INTEGER REFERENCES users(id),
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_cod_requests_status ON change_of_details_requests(status);

    -- ==========================================================
    -- LOAN PRODUCTS (Section 8) - fully configurable, defaults seeded below
    -- ==========================================================
    CREATE TABLE IF NOT EXISTS loan_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      min_amount REAL NOT NULL,
      max_amount REAL NOT NULL,
      term_days INTEGER NOT NULL,
      installment_count INTEGER NOT NULL,
      interest_rate REAL NOT NULL, -- percent, flat rate on original principal
      guarantors_required INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ==========================================================
    -- LOANS (Section 7, 9, 10, 19)
    -- ==========================================================
    CREATE TABLE IF NOT EXISTS loans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER NOT NULL REFERENCES users(id),
      loan_product_id INTEGER NOT NULL REFERENCES loan_products(id),

      requested_amount REAL NOT NULL,

      -- Snapshot of product terms at application time, so later edits to
      -- loan_products don't retroactively change an in-flight loan's terms.
      interest_rate REAL NOT NULL,
      term_days INTEGER NOT NULL,
      installment_count INTEGER NOT NULL,
      total_repayable REAL, -- computed at disbursement, once disbursed_amount is final

      status TEXT NOT NULL DEFAULT 'pending_guarantor_approval' CHECK (status IN (
        'pending_guarantor_approval',
        'pending_loan_officer_review',
        'pending_credit_manager_approval',
        'pending_clarification',
        'approved',
        'disbursed',
        'active',
        'closed',
        'rejected',
        'written_off'
      )),

      -- Origination (Section 7)
      origin TEXT NOT NULL CHECK (origin IN ('staff', 'member')),
      originated_by INTEGER NOT NULL REFERENCES users(id),

      -- Loan Officer review (member-submitted applications only - Section 7)
      loan_officer_id INTEGER REFERENCES users(id), -- assigned officer; also who may record repayments
      loan_officer_reviewed_by INTEGER REFERENCES users(id),
      loan_officer_reviewed_at TEXT,
      loan_officer_notes TEXT,

      -- Credit Manager approval (Level 2 - maker-checker)
      credit_manager_id INTEGER REFERENCES users(id),
      credit_manager_decision_at TEXT,
      credit_manager_notes TEXT,

      rejection_reason TEXT,
      clarification_note TEXT,

      -- Guarantor (Section 7) - exactly 1 required, across all tiers
      guarantor_id INTEGER REFERENCES users(id),
      guarantor_status TEXT NOT NULL DEFAULT 'pending' CHECK (guarantor_status IN ('pending', 'confirmed', 'declined')),
      guarantor_confirmed_at TEXT,
      guarantor_liability_amount REAL, -- 50% of disbursed amount, set at disbursement

      -- Disbursement (Section 10)
      mpesa_disbursement_ref TEXT,
      disbursed_amount REAL,
      disbursed_by INTEGER REFERENCES users(id),
      disbursed_at TEXT,
      disbursement_edited_at TEXT,
      disbursement_edit_reason TEXT,

      -- Write-off (Section 19) - Super Admin only
      written_off_by INTEGER REFERENCES users(id),
      written_off_at TEXT,
      written_off_reason TEXT,

      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_loans_member ON loans(member_id);
    CREATE INDEX IF NOT EXISTS idx_loans_status ON loans(status);
    CREATE INDEX IF NOT EXISTS idx_loans_guarantor ON loans(guarantor_id);
    CREATE INDEX IF NOT EXISTS idx_loans_loan_officer ON loans(loan_officer_id);

    -- ==========================================================
    -- LOAN INSTALLMENTS (Section 11) - one row per scheduled payment,
    -- even Tier 1 single-payment loans get exactly one row.
    -- ==========================================================
    CREATE TABLE IF NOT EXISTS loan_installments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      loan_id INTEGER NOT NULL REFERENCES loans(id),
      installment_number INTEGER NOT NULL,
      due_date TEXT NOT NULL,
      amount_due REAL NOT NULL,
      amount_paid REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN (
        'upcoming', 'due', 'overdue', 'partially_paid', 'paid'
      )),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(loan_id, installment_number)
    );

    CREATE INDEX IF NOT EXISTS idx_installments_loan ON loan_installments(loan_id);
    CREATE INDEX IF NOT EXISTS idx_installments_status ON loan_installments(status);

    -- ==========================================================
    -- REPAYMENTS (Section 11)
    -- ==========================================================
    CREATE TABLE IF NOT EXISTS repayments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      loan_id INTEGER NOT NULL REFERENCES loans(id),
      installment_id INTEGER REFERENCES loan_installments(id),
      mpesa_ref TEXT,
      amount REAL NOT NULL,
      payment_date TEXT NOT NULL,
      recorded_by INTEGER NOT NULL REFERENCES users(id),

      -- 24hr edit window (Section 11)
      edited_at TEXT,
      edit_reason TEXT,

      -- Post-window corrections reference the original, never overwrite it
      adjustment_of_repayment_id INTEGER REFERENCES repayments(id),

      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_repayments_loan ON repayments(loan_id);

    -- ==========================================================
    -- LOAN EVENTS (audit trail - every status change / decision)
    -- ==========================================================
    CREATE TABLE IF NOT EXISTS loan_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      loan_id INTEGER NOT NULL REFERENCES loans(id),
      event_type TEXT NOT NULL,
      actor_id INTEGER REFERENCES users(id),
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_loan_events_loan ON loan_events(loan_id);

    -- ==========================================================
    -- WHATSAPP LOG (Section 16)
    -- ==========================================================
    CREATE TABLE IF NOT EXISTS whatsapp_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      loan_id INTEGER REFERENCES loans(id),
      message_type TEXT NOT NULL,
      phone TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
      sent_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ==========================================================
    -- IN-APP NOTIFICATIONS (Section 16, staff notification center)
    -- ==========================================================
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      related_loan_id INTEGER REFERENCES loans(id),
      related_user_id INTEGER REFERENCES users(id),
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);

    -- ==========================================================
    -- SETTINGS (key-value store for global config)
    -- e.g. disbursement_permission, guarantor_exposure_limit
    -- ==========================================================
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function seedLoanProducts() {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM loan_products').get();
  if (existing.n > 0) return;

  const insert = db.prepare(`
    INSERT INTO loan_products (name, min_amount, max_amount, term_days, installment_count, interest_rate, guarantors_required, active)
    VALUES (@name, @min_amount, @max_amount, @term_days, @installment_count, @interest_rate, @guarantors_required, 1)
  `);

  const insertMany = db.transaction((products) => {
    for (const p of products) insert.run(p);
  });

  insertMany([
    { name: 'Tier 1', min_amount: 0, max_amount: 15000, term_days: 30, installment_count: 1, interest_rate: 10, guarantors_required: 1 },
    { name: 'Tier 2', min_amount: 15001, max_amount: 30000, term_days: 60, installment_count: 2, interest_rate: 10, guarantors_required: 1 },
    { name: 'Tier 3', min_amount: 30001, max_amount: 60000, term_days: 90, installment_count: 3, interest_rate: 10, guarantors_required: 1 },
  ]);
}

function seedSettings() {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)
  `);
  // Options: 'approving_credit_manager', 'any_credit_manager', 'any_admin_plus'
  insert.run('disbursement_permission', 'any_credit_manager');
  insert.run('guarantor_exposure_limit', '100000');
}

function seedSuperAdmin() {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role LIKE '%super_admin%'").get();
  if (existing.n > 0) return;

  const email = process.env.SEED_SUPERADMIN_EMAIL || 'admin@sasaloan.local';
  const phone = process.env.SEED_SUPERADMIN_PHONE || '+254700000000';
  const firstName = process.env.SEED_SUPERADMIN_FIRST_NAME || 'Super';
  const lastName = process.env.SEED_SUPERADMIN_LAST_NAME || 'Admin';
  const tempPassword = process.env.SEED_SUPERADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');

  const passwordHash = bcrypt.hashSync(tempPassword, 10);

  db.prepare(`
    INSERT INTO users (role, first_name, last_name, email, phone, password_hash, must_change_password, verification_status)
    VALUES ('super_admin', ?, ?, ?, ?, ?, 1, 'pre_verified')
  `).run(firstName, lastName, email, phone, passwordHash);

  if (!process.env.SEED_SUPERADMIN_PASSWORD) {
    // Only printed when auto-generated - not logged anywhere persistent.
    console.log('='.repeat(60));
    console.log('SEEDED SUPER ADMIN ACCOUNT');
    console.log(`  Email:    ${email}`);
    console.log(`  Password: ${tempPassword}`);
    console.log('  (forced password change on first login)');
    console.log('='.repeat(60));
  }
}

function init() {
  createSchema();
  seedLoanProducts();
  seedSettings();
  seedSuperAdmin();
  return db;
}

module.exports = { db, init };
