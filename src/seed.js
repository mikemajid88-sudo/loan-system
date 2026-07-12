const bcrypt = require('bcryptjs');
const db = require('./db');

/**
 * If no staff-side account exists yet, create a default Super Admin so the
 * app is usable immediately after first deploy, without needing shell/CLI access.
 *
 * Default login (CHANGE THIS after first sign-in):
 *   email:    admin@example.com
 *   password: ChangeMe123!
 *
 * Override via DEFAULT_ADMIN_EMAIL / DEFAULT_ADMIN_PASSWORD env vars.
 */
function ensureDefaultAdmin() {
  const existingStaff = db.prepare(`SELECT id FROM users WHERE roles != 'member' LIMIT 1`).get();
  if (existingStaff) return;

  const email = (process.env.DEFAULT_ADMIN_EMAIL || 'admin@example.com').toLowerCase();
  const password = process.env.DEFAULT_ADMIN_PASSWORD || 'ChangeMe123!';
  const hash = bcrypt.hashSync(password, 10);

  db.prepare(
    `INSERT INTO users (full_name, email, phone, password_hash, roles, verification_status)
     VALUES (?, ?, ?, ?, 'super_admin', 'approved')`
  ).run('Default Super Admin', email, '0700000000', hash);

  console.log('============================================================');
  console.log('No staff account existed, so a default Super Admin was created:');
  console.log(`  Email:    ${email}`);
  console.log(`  Password: ${password}`);
  console.log('Sign in and change this password immediately.');
  console.log('============================================================');
}

module.exports = { ensureDefaultAdmin };
