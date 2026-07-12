const jwt = require('jsonwebtoken');
const { parseRoles, hasAnyRole } = require('../utils/roles');

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-env-file';

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload; // { id, roles (comma string, informational only), email, full_name }
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Fetches current roles fresh from the DB (not the JWT) so role changes take
// effect immediately without waiting for the token to expire.
function requireAnyRole(...allowedRoles) {
  return (req, res, next) => {
    const db = require('../db');
    const row = db.prepare('SELECT roles FROM users WHERE id = ?').get(req.user.id);
    if (!row || !hasAnyRole(row.roles, allowedRoles)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    req.userRoles = parseRoles(row.roles);
    next();
  };
}

function requireVerified(req, res, next) {
  const db = require('../db');
  const user = db.prepare('SELECT roles, verification_status FROM users WHERE id = ?').get(req.user.id);
  if (!hasAnyRole(user.roles, ['member'])) return next(); // staff bypass
  if (!user || user.verification_status !== 'approved') {
    return res.status(403).json({ error: 'Your account is not yet verified. Please wait for staff approval.' });
  }
  next();
}

// Blocks any action until a forced password change (set when Super Admin
// creates a Loan Officer/Credit Manager/Admin/Super Admin account) has been completed.
function blockIfMustChangePassword(req, res, next) {
  const db = require('../db');
  const row = db.prepare('SELECT must_change_password FROM users WHERE id = ?').get(req.user.id);
  if (row && row.must_change_password) {
    return res.status(403).json({ error: 'You must change your password before continuing.', code: 'MUST_CHANGE_PASSWORD' });
  }
  next();
}

module.exports = { requireAuth, requireAnyRole, requireVerified, blockIfMustChangePassword, JWT_SECRET };
