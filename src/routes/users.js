const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth, requireAnyRole, blockIfMustChangePassword } = require('../middleware/auth');
const { ALL_STAFF_ROLES, parseRoles, rolesToString } = require('../utils/roles');

const router = express.Router();

function safeUser(row) {
  return {
    id: row.id, full_name: row.full_name, email: row.email, phone: row.phone,
    roles: parseRoles(row.roles), status: row.status,
    must_change_password: !!row.must_change_password, created_at: row.created_at,
  };
}

// List all staff-side accounts (Members are managed via the KYC queue instead)
router.get('/', requireAuth, requireAnyRole('super_admin'), blockIfMustChangePassword, (req, res) => {
  const rows = db.prepare(`SELECT * FROM users WHERE roles != 'member'`).all()
    .filter(r => parseRoles(r.roles).some(x => ALL_STAFF_ROLES.includes(x)));
  res.json({ users: rows.map(safeUser) });
});

// Create a new staff-side account with one or more roles and a temp password
router.post('/', requireAuth, requireAnyRole('super_admin'), blockIfMustChangePassword, (req, res) => {
  const { full_name, email, phone, temp_password, roles } = req.body;

  if (!full_name || !email || !phone || !temp_password || !Array.isArray(roles) || roles.length === 0) {
    return res.status(400).json({ error: 'full_name, email, phone, temp_password and at least one role are required' });
  }
  const invalid = roles.filter(r => !ALL_STAFF_ROLES.includes(r));
  if (invalid.length > 0) {
    return res.status(400).json({ error: `Invalid role(s): ${invalid.join(', ')}` });
  }
  if (temp_password.length < 6) {
    return res.status(400).json({ error: 'Temporary password must be at least 6 characters' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const hash = bcrypt.hashSync(temp_password, 10);
  const info = db
    .prepare(
      `INSERT INTO users (full_name, email, phone, password_hash, roles, verification_status, must_change_password, created_by)
       VALUES (?, ?, ?, ?, ?, 'approved', 1, ?)`
    )
    .run(full_name, email.toLowerCase(), phone, hash, rolesToString(roles), req.user.id);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ user: safeUser(user) });
});

// Replace a staff-side account's roles entirely
router.put('/:id/roles', requireAuth, requireAnyRole('super_admin'), blockIfMustChangePassword, (req, res) => {
  const { roles } = req.body;
  if (!Array.isArray(roles) || roles.length === 0) {
    return res.status(400).json({ error: 'roles must be a non-empty array' });
  }
  const invalid = roles.filter(r => !ALL_STAFF_ROLES.includes(r));
  if (invalid.length > 0) return res.status(400).json({ error: `Invalid role(s): ${invalid.join(', ')}` });

  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target || target.roles === 'member') return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id && !roles.includes('super_admin')) {
    return res.status(400).json({ error: 'You cannot remove your own Super Admin access' });
  }

  db.prepare('UPDATE users SET roles = ? WHERE id = ?').run(rolesToString(roles), target.id);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(target.id);
  res.json({ user: safeUser(updated) });
});

router.put('/:id/status', requireAuth, requireAnyRole('super_admin'), blockIfMustChangePassword, (req, res) => {
  const { status } = req.body;
  if (!['active', 'suspended'].includes(status)) {
    return res.status(400).json({ error: "status must be 'active' or 'suspended'" });
  }
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target || target.roles === 'member') return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id && status === 'suspended') {
    return res.status(400).json({ error: 'You cannot suspend your own account' });
  }

  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, target.id);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(target.id);
  res.json({ user: safeUser(updated) });
});

module.exports = router;
