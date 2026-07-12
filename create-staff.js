/**
 * One-off CLI helper to create a staff or admin account.
 * Staff accounts are NOT created through the public /register endpoint
 * (only borrowers can self-register), so use this script instead.
 *
 * Usage:
 *   node create-staff.js "Jane Doe" jane@example.com 0712345678 mypassword123 admin
 */
const bcrypt = require('bcryptjs');
const db = require('./src/db');

const [, , fullName, email, phone, password, role = 'staff'] = process.argv;

if (!fullName || !email || !phone || !password) {
  console.log('Usage: node create-staff.js "Full Name" email@example.com phone password [staff|admin]');
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
  .prepare(
    `INSERT INTO users (full_name, email, phone, password_hash, role, verification_status)
     VALUES (?, ?, ?, ?, ?, 'approved')`
  )
  .run(fullName, email.toLowerCase(), phone, hash, role);

console.log(`Created ${role} account: ${email} (id=${info.lastInsertRowid})`);
