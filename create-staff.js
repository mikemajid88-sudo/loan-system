/**
 * One-off CLI helper to create a staff-side account (Loan Officer, Credit
 * Manager, Admin, or Super Admin). Once at least one Super Admin exists,
 * prefer using the "Manage users" screen in the app instead of this script.
 *
 * Usage:
 *   node create-staff.js "Jane Doe" jane@example.com 0712345678 mypassword123 super_admin
 *   node create-staff.js "John Officer" john@example.com 0712345679 mypassword123 loan_officer,credit_manager
 */
const bcrypt = require('bcryptjs');
const db = require('./src/db');

const VALID_ROLES = ['super_admin', 'admin', 'loan_officer', 'credit_manager'];
const [, , fullName, email, phone, password, rolesArg] = process.argv;

if (!fullName || !email || !phone || !password || !rolesArg) {
  console.log('Usage: node create-staff.js "Full Name" email@example.com phone password role1[,role2]');
  console.log(`Valid roles: ${VALID_ROLES.join(', ')}`);
  process.exit(1);
}

const roles = rolesArg.split(',').map(r => r.trim());
const invalid = roles.filter(r => !VALID_ROLES.includes(r));
if (invalid.length > 0) {
  console.log(`Invalid role(s): ${invalid.join(', ')}. Valid roles: ${VALID_ROLES.join(', ')}`);
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
    `INSERT INTO users (full_name, email, phone, password_hash, roles, verification_status)
     VALUES (?, ?, ?, ?, ?, 'approved')`
  )
  .run(fullName, email.toLowerCase(), phone, hash, roles.join(','));

console.log(`Created account with roles [${roles.join(', ')}]: ${email} (id=${info.lastInsertRowid})`);
