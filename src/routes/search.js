const express = require('express');
const db = require('../db');
const { requireAuth, requireAnyRole, blockIfMustChangePassword } = require('../middleware/auth');
const { ALL_STAFF_ROLES } = require('../utils/roles');

const router = express.Router();

// Quick search across members and loans by name or phone - any staff-side role
router.get('/', requireAuth, requireAnyRole(...ALL_STAFF_ROLES), blockIfMustChangePassword, (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json({ members: [], loans: [] });
  const like = `%${q}%`;

  const members = db.prepare(
    `SELECT id, full_name, phone, email, verification_status FROM users
     WHERE roles = 'member' AND (full_name LIKE ? OR phone LIKE ?) LIMIT 10`
  ).all(like, like);

  const loans = db.prepare(
    `SELECT loans.id, loans.amount, loans.status, users.full_name, users.phone
     FROM loans JOIN users ON users.id = loans.user_id
     WHERE users.full_name LIKE ? OR users.phone LIKE ? LIMIT 10`
  ).all(like, like);

  res.json({ members, loans });
});

module.exports = router;
