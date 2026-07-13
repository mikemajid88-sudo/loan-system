const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { JWT_SECRET, requireAuth, requireAnyRole, blockIfMustChangePassword } = require('../middleware/auth');
const { ALL_STAFF_ROLES, parseRoles } = require('../utils/roles');

const router = express.Router();

function signToken(user) {
  return jwt.sign(
    { id: user.id, roles: user.roles, email: user.email, full_name: user.full_name },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function publicUser(user) {
  return {
    id: user.id,
    full_name: user.full_name,
    email: user.email,
    phone: user.phone,
    roles: parseRoles(user.roles),
    status: user.status,
    verification_status: user.verification_status,
    must_change_password: !!user.must_change_password,
  };
}

// Member self-registration with KYC documents
router.post('/register', (req, res) => {
  const {
    full_name, email, phone, national_id, date_of_birth, gender, residential_address,
    occupation, monthly_income_range, next_of_kin_name, next_of_kin_phone,
    consent, password, id_photo, selfie_photo,
  } = req.body;

  if (!full_name || !email || !phone || !national_id || !date_of_birth || !residential_address || !next_of_kin_name || !next_of_kin_phone || !password) {
    return res.status(400).json({ error: 'Please complete all required personal, contact and next-of-kin details' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (!consent) {
    return res.status(400).json({ error: 'You must accept the privacy and credit assessment consent' });
  }
  if (!id_photo || !selfie_photo) {
    return res.status(400).json({ error: 'ID photo and a live selfie are both required' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'Email already registered' });
  const existingId = db.prepare('SELECT id FROM users WHERE national_id = ?').get(national_id.trim());
  if (existingId) return res.status(409).json({ error: 'This National ID is already registered' });

  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare(
      `INSERT INTO users (full_name, email, phone, national_id, date_of_birth, gender, residential_address,
         occupation, monthly_income_range, next_of_kin_name, next_of_kin_phone, consent_at, password_hash,
         roles, verification_status, id_photo, selfie_photo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, 'member', 'pending', ?, ?)`
    )
    .run(full_name.trim(), email.toLowerCase(), phone.trim(), national_id.trim(), date_of_birth,
      gender || null, residential_address.trim(), occupation || null, monthly_income_range || null,
      next_of_kin_name.trim(), next_of_kin_phone.trim(), hash, id_photo, selfie_photo);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  const token = signToken(user);
  res.status(201).json({ token, user: publicUser(user) });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (user.status === 'suspended') return res.status(403).json({ error: 'This account has been suspended' });

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: publicUser(user) });
});

router.post('/change-password', requireAuth, (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'current_password and new_password are required' });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user || !bcrypt.compareSync(current_password, user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hash, user.id);
  res.json({ ok: true });
});

// List of other verified Members, for the guarantor dropdown when applying
router.get('/verified-members', requireAuth, requireAnyRole('member'), (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, full_name, phone FROM users
       WHERE roles = 'member' AND verification_status = 'approved' AND id != ?
       ORDER BY full_name ASC`
    )
    .all(req.user.id);
  res.json({ users: rows });
});

// --- KYC verification: any staff-side role can review ---

router.get('/pending-verifications', requireAuth, requireAnyRole(...ALL_STAFF_ROLES), blockIfMustChangePassword, (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, full_name, email, phone, national_id, date_of_birth, gender, residential_address,
              occupation, monthly_income_range, next_of_kin_name, next_of_kin_phone, id_photo, selfie_photo, created_at
       FROM users WHERE verification_status = 'pending' AND roles = 'member'
       ORDER BY created_at ASC`
    )
    .all();
  res.json({ users: rows });
});

router.get('/users/:id', requireAuth, requireAnyRole(...ALL_STAFF_ROLES), blockIfMustChangePassword, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { password_hash, ...safe } = user;
  res.json({ user: safe });
});

router.post('/users/:id/verify', requireAuth, requireAnyRole(...ALL_STAFF_ROLES), blockIfMustChangePassword, (req, res) => {
  const { decision, note } = req.body;
  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: "decision must be 'approved' or 'rejected'" });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.verification_status !== 'pending') {
    return res.status(400).json({ error: 'This user has already been reviewed' });
  }

  db.prepare(
    `UPDATE users SET verification_status = ?, verification_note = ?, verified_by = ?, verified_at = datetime('now') WHERE id = ?`
  ).run(decision, note || null, req.user.id, user.id);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  const { password_hash, ...safe } = updated;
  res.json({ user: safe });
});

// Staff-side: create an already-verified Member directly (e.g. for walk-ins).
// Still requires the same ID photo + live selfie capture, just performed by staff.
router.post('/members', requireAuth, requireAnyRole(...ALL_STAFF_ROLES), blockIfMustChangePassword, (req, res) => {
  const { full_name, email, phone, national_id, password, id_photo, selfie_photo } = req.body;

  if (!full_name || !email || !phone || !password) {
    return res.status(400).json({ error: 'full_name, email, phone and password are required' });
  }
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (!id_photo || !selfie_photo) return res.status(400).json({ error: 'ID photo and a live selfie are both required' });

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare(
      `INSERT INTO users (full_name, email, phone, national_id, password_hash, roles, verification_status,
         id_photo, selfie_photo, verified_by, verified_at, created_by)
       VALUES (?, ?, ?, ?, ?, 'member', 'approved', ?, ?, ?, datetime('now'), ?)`
    )
    .run(full_name, email.toLowerCase(), phone, national_id || null, hash, id_photo, selfie_photo, req.user.id, req.user.id);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  const { password_hash: _, ...safe } = user;
  res.status(201).json({ user: safe });
});

module.exports = router;
