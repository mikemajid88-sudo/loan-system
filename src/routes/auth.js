const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { JWT_SECRET, requireAuth, requireRole } = require('../middleware/auth');
const { sendWhatsApp } = require('../utils/whatsapp');

const router = express.Router();

function signToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, email: user.email, full_name: user.full_name },
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
    role: user.role,
    verification_status: user.verification_status,
  };
}

// Borrower self-registration with KYC documents
router.post('/register', (req, res) => {
  const { full_name, email, phone, national_id, password, id_photo, selfie_photo } = req.body;

  if (!full_name || !email || !phone || !password) {
    return res.status(400).json({ error: 'full_name, email, phone and password are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  if (!id_photo || !selfie_photo) {
    return res.status(400).json({ error: 'ID photo and a live selfie are both required' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare(
      `INSERT INTO users (full_name, email, phone, national_id, password_hash, role, verification_status, id_photo, selfie_photo)
       VALUES (?, ?, ?, ?, ?, 'borrower', 'pending', ?, ?)`
    )
    .run(full_name, email.toLowerCase(), phone, national_id || null, hash, id_photo, selfie_photo);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  const token = signToken(user);
  res.status(201).json({ token, user: publicUser(user) });
});

// Login (borrower or staff) - borrowers can log in while pending, but are
// restricted from applying for loans until verified (enforced in loans routes)
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended' });

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

// Current user
router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: publicUser(user) });
});

// Change password (any signed-in user)
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
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
  res.json({ ok: true });
});

// List of other verified borrowers, for the guarantor dropdown when applying
router.get('/verified-borrowers', requireAuth, requireRole('borrower'), (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, full_name, phone FROM users
       WHERE role = 'borrower' AND verification_status = 'approved' AND id != ?
       ORDER BY full_name ASC`
    )
    .all(req.user.id);
  res.json({ users: rows });
});

// --- Staff: KYC verification queue ---

router.get('/pending-verifications', requireAuth, requireRole('staff', 'admin'), (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, full_name, email, phone, national_id, id_photo, selfie_photo, created_at
       FROM users WHERE verification_status = 'pending' AND role = 'borrower'
       ORDER BY created_at ASC`
    )
    .all();
  res.json({ users: rows });
});

router.get('/users/:id', requireAuth, requireRole('staff', 'admin'), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { password_hash, ...safe } = user;
  res.json({ user: safe });
});

router.post('/users/:id/verify', requireAuth, requireRole('staff', 'admin'), async (req, res) => {
  const { decision, note } = req.body; // decision: 'approved' | 'rejected'
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

  if (decision === 'approved') {
    await sendWhatsApp(
      user.phone,
      `Hi ${user.full_name}, your Sasa Loan account has been verified. You can now log in and apply for a loan.`
    );
  } else {
    await sendWhatsApp(
      user.phone,
      `Hi ${user.full_name}, we were unable to verify your Sasa Loan registration. Reason: ${note || 'not specified'}. Please contact support.`
    );
  }

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  const { password_hash, ...safe } = updated;
  res.json({ user: safe });
});

module.exports = router;
