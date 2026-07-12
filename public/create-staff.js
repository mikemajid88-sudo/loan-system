/**
 * One-off CLI helper to create a staff or admin account.
 * Staff accounts are NOT created through the public /register endpoint
 * (only borrowers can self-register), so use this script instead.
 *
 * Usage:
 *   node create-staff.js "Jane Doe" jane@example.com mypassword123 admin
 *   node create-staff.js "John Staff" john@example.com mypassword123 staff
 */
const bcrypt = require('bcryptjs');
const db = require('./src/db');

const [, , fullName, email, password, role = 'staff'] = process.argv;

if (!fullName || !email || !password) {
  console.log('Usage: node create-staff.js "Full Name" email@example.com password [staff|admin]');
  process.exit(1);
}
if (!['staff', 'admin'].includes(role)) {
  console.log('Role must be "staff" or "admin"');
  process.exit(1);
}

const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
if (existing) {
  console.log(`A user with email ${email} already exists (id=${existing.id}).`);
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 10);
const info = db
  .prepare(`INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)`)
  .run(fullName, email.toLowerCase(), hash, role);

console.log(`Created ${role} account: ${email} (id=${info.lastInsertRowid})`);
