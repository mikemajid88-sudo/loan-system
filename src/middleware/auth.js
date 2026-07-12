const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-env-file';

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload; // { id, role, email, full_name }
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    next();
  };
}

function requireVerified(req, res, next) {
  if (req.user.role !== 'borrower') return next(); // staff/admin bypass
  const db = require('../db');
  const user = db.prepare('SELECT verification_status FROM users WHERE id = ?').get(req.user.id);
  if (!user || user.verification_status !== 'approved') {
    return res.status(403).json({ error: 'Your account is not yet verified. Please wait for staff approval.' });
  }
  next();
}

module.exports = { requireAuth, requireRole, requireVerified, JWT_SECRET };
