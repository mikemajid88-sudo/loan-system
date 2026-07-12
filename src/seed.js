const bcrypt = require('bcryptjs');
const db = require('./db');

/**
 * If no staff/admin account exists yet, create one with default
 * credentials so the app is usable immediately after first deploy,
 * without needing shell/CLI access.
 *
 * Default login (CHANGE THIS after first sign-in):
 *   email:    admin@example.com
 *   password: ChangeMe123!
 *
 * Override the defaults by setting DEFAULT_ADMIN_EMAIL and
 * DEFAULT_ADMIN_PASSWORD in your environment variables.
 */
function ensureDefaultAdmin() {
  const existingStaff = db
    .prepare(`SELECT id FROM users WHERE role IN ('staff','admin') LIMIT 1`)
    .get();

  if (existingStaff) return;

  const email = (process.env.DEFAULT_ADMIN_EMAIL || 'admin@example.com').toLowerCase();
  const password = process.env.DEFAULT_ADMIN_PASSWORD || 'ChangeMe123!';
  const hash = bcrypt.hashSync(password, 10);

  db.prepare(
    `INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, 'admin')`
  ).run('Default Admin', email, hash);

  console.log('============================================================');
  console.log('No staff/admin account existed, so a default one was created:');
  console.log(`  Email:    ${email}`);
  console.log(`  Password: ${password}`);
  console.log('Sign in and change this password immediately (see /staff.html');
  console.log('once signed in, or create a proper account and stop using this one).');
  console.log('============================================================');
}

module.exports = { ensureDefaultAdmin };
