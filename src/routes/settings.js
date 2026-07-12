const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getAllSettings, setSetting } = require('../utils/settings');

const router = express.Router();

// Anyone signed in can read current limits (needed for the apply form)
router.get('/', requireAuth, (req, res) => {
  res.json({ settings: getAllSettings() });
});

// Only admins can change loan parameters
router.put('/', requireAuth, requireRole('admin'), (req, res) => {
  const allowedKeys = ['min_loan_amount', 'max_loan_amount', 'interest_rate', 'loan_term_days'];
  const updates = req.body || {};

  for (const key of Object.keys(updates)) {
    if (!allowedKeys.includes(key)) continue;
    const num = Number(updates[key]);
    if (isNaN(num) || num <= 0) {
      return res.status(400).json({ error: `${key} must be a positive number` });
    }
    setSetting(key, num);
  }

  res.json({ settings: getAllSettings() });
});

module.exports = router;
