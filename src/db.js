const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'loans.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT NOT NULL,
  national_id TEXT,
  password_hash TEXT NOT NULL,
  -- Comma-separated list of roles. A Member is always exactly 'member'.
  -- Staff-side accounts hold one or more of: super_admin, admin, loan_officer, credit_manager
  roles TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
  must_change_password INTEGER NOT NULL DEFAULT 0,
  verification_status TEXT NOT NULL DEFAULT 'pending' CHECK(verification_status IN ('pending','approved','rejected')),
  verification_note TEXT,
  id_photo TEXT,
  selfie_photo TEXT,
  verified_by INTEGER REFERENCES users(id),
  verified_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value) VALUES ('min_loan_amount', '2000');
INSERT OR IGNORE INTO settings (key, value) VALUES ('max_loan_amount', '15000');
INSERT OR IGNORE INTO settings (key, value) VALUES ('interest_rate', '12');
INSERT OR IGNORE INTO settings (key, value) VALUES ('loan_term_days', '30');

CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount REAL NOT NULL,
  purpose TEXT,
  interest_rate REAL NOT NULL DEFAULT 12.0,
  term_days INTEGER NOT NULL DEFAULT 30,
  total_repayable REAL,
  disbursement_date TEXT,
  due_date TEXT,

  guarantor_id INTEGER REFERENCES users(id),
  guarantor_status TEXT NOT NULL DEFAULT 'pending' CHECK(guarantor_status IN ('pending','approved','declined')),
  guarantor_responded_at TEXT,

  level1_status TEXT NOT NULL DEFAULT 'pending' CHECK(level1_status IN ('pending','passed','rejected')),
  level1_reviewer_id INTEGER REFERENCES users(id),
  level1_note TEXT,
  level1_at TEXT,

  level2_status TEXT NOT NULL DEFAULT 'pending' CHECK(level2_status IN ('pending','passed','rejected')),
  level2_reviewer_id INTEGER REFERENCES users(id),
  level2_note TEXT,
  level2_at TEXT,

  status TEXT NOT NULL DEFAULT 'awaiting_guarantor' CHECK(status IN (
    'awaiting_guarantor','pending_level1','pending_level2','approved','rejected','disbursed','repaid','defaulted'
  )),
  parent_loan_id INTEGER REFERENCES loans(id),
  last_whatsapp_reminder_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS loan_extensions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id INTEGER NOT NULL REFERENCES loans(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  reviewed_by INTEGER REFERENCES users(id),
  review_note TEXT,
  new_due_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS loan_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id INTEGER NOT NULL REFERENCES loans(id),
  actor_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS whatsapp_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_phone TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sent','failed')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_loans_user ON loans(user_id);
CREATE INDEX IF NOT EXISTS idx_loans_status ON loans(status);
CREATE INDEX IF NOT EXISTS idx_loans_guarantor ON loans(guarantor_id);
CREATE INDEX IF NOT EXISTS idx_users_verification ON users(verification_status);
`);

module.exports = db;
