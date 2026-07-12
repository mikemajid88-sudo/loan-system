const express = require('express');
const db = require('../db');
const { requireAuth, requireAnyRole, blockIfMustChangePassword } = require('../middleware/auth');
const { sendWhatsApp } = require('../utils/whatsapp');
const { ALL_STAFF_ROLES } = require('../utils/roles');

const router = express.Router();

// Any staff-side role can push a WhatsApp message. Staff compose/edit the
// message client-side (pre-filled templates) and this just sends it + logs it.
router.post('/push', requireAuth, requireAnyRole(...ALL_STAFF_ROLES), blockIfMustChangePassword, async (req, res) => {
  const { to_phone, message, loan_id } = req.body;
  if (!to_phone || !message || !message.trim()) {
    return res.status(400).json({ error: 'to_phone and message are required' });
  }

  const result = await sendWhatsApp(to_phone, message.trim());

  if (loan_id) {
    db.prepare(`INSERT INTO loan_events (loan_id, actor_id, action, note) VALUES (?, ?, 'whatsapp_sent', ?)`)
      .run(loan_id, req.user.id, message.trim());
  }

  res.json({ sent: result.sent, reason: result.reason || null });
});

module.exports = router;
