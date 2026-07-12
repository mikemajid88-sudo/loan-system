const express = require('express');
const db = require('../db');
const { requireAuth, requireRole, requireVerified } = require('../middleware/auth');
const { calculateLoan, addDays } = require('../utils/loanCalc');
const { getNumberSetting } = require('../utils/settings');
const { sendWhatsApp } = require('../utils/whatsapp');

const router = express.Router();

function logEvent(loanId, actorId, action, note) {
  db.prepare(`INSERT INTO loan_events (loan_id, actor_id, action, note) VALUES (?, ?, ?, ?)`)
    .run(loanId, actorId || null, action, note || null);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Borrower: apply for a loan (must be verified, must not have another active loan)
router.post('/apply', requireAuth, requireRole('borrower'), requireVerified, (req, res) => {
  const { amount, purpose, guarantor_id, disbursement_date } = req.body;

  const amt = Number(amount);
  const minAmt = getNumberSetting('min_loan_amount', 2000);
  const maxAmt = getNumberSetting('max_loan_amount', 15000);
  const interestRate = getNumberSetting('interest_rate', 12);
  const termDays = getNumberSetting('loan_term_days', 30);

  if (!amt || amt < minAmt || amt > maxAmt) {
    return res.status(400).json({ error: `Amount must be between ${minAmt} and ${maxAmt}` });
  }
  if (!disbursement_date || disbursement_date < today()) {
    return res.status(400).json({ error: 'Disbursement date must be today or a future date' });
  }
  if (!guarantor_id) {
    return res.status(400).json({ error: 'A guarantor is required' });
  }
  if (Number(guarantor_id) === req.user.id) {
    return res.status(400).json({ error: 'You cannot be your own guarantor' });
  }

  const guarantor = db.prepare(`SELECT * FROM users WHERE id = ?`).get(guarantor_id);
  if (!guarantor || guarantor.role !== 'borrower' || guarantor.verification_status !== 'approved') {
    return res.status(400).json({ error: 'Guarantor must be a verified borrower' });
  }

  const openLoan = db
    .prepare(
      `SELECT id FROM loans WHERE user_id = ? AND status NOT IN ('rejected','repaid') LIMIT 1`
    )
    .get(req.user.id);
  if (openLoan) {
    return res.status(409).json({ error: 'You already have an active loan in progress' });
  }

  const calc = calculateLoan(amt, interestRate);
  const dueDate = addDays(disbursement_date, termDays);

  const info = db
    .prepare(
      `INSERT INTO loans (user_id, amount, purpose, interest_rate, term_days, total_repayable,
         disbursement_date, due_date, guarantor_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_guarantor')`
    )
    .run(req.user.id, amt, purpose || null, interestRate, termDays, calc.totalRepayable,
         disbursement_date, dueDate, guarantor_id);

  logEvent(info.lastInsertRowid, req.user.id, 'applied', null);

  sendWhatsApp(
    guarantor.phone,
    `Hi ${guarantor.full_name}, ${req.user.full_name} has listed you as their guarantor for a Sasa Loan of KES ${amt}. Please log in to Sasa Loan to approve or decline.`
  );

  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ loan });
});

// Preview calculation before submitting (uses current settings)
router.get('/calculate', requireAuth, (req, res) => {
  const amount = Number(req.query.amount);
  if (!amount) return res.status(400).json({ error: 'amount is required' });
  const interestRate = getNumberSetting('interest_rate', 12);
  const termDays = getNumberSetting('loan_term_days', 30);
  const calc = calculateLoan(amount, interestRate);
  res.json({ ...calc, interest_rate: interestRate, term_days: termDays });
});

// Borrower: my loans
router.get('/my', requireAuth, requireRole('borrower'), (req, res) => {
  const loans = db.prepare('SELECT * FROM loans WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  const withCountdown = loans.map(l => ({ ...l, days_remaining: daysRemaining(l.due_date) }));
  res.json({ loans: withCountdown });
});

// Borrower: guarantor requests awaiting my decision
router.get('/guarantor-requests', requireAuth, requireRole('borrower'), (req, res) => {
  const rows = db
    .prepare(
      `SELECT loans.*, users.full_name as applicant_name, users.phone as applicant_phone
       FROM loans JOIN users ON users.id = loans.user_id
       WHERE loans.guarantor_id = ? AND loans.guarantor_status = 'pending'
       ORDER BY loans.created_at ASC`
    )
    .all(req.user.id);
  res.json({ requests: rows });
});

router.post('/:id/guarantor-respond', requireAuth, requireRole('borrower'), (req, res) => {
  const { decision } = req.body; // 'approved' | 'declined'
  if (!['approved', 'declined'].includes(decision)) {
    return res.status(400).json({ error: "decision must be 'approved' or 'declined'" });
  }
  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id);
  if (!loan) return res.status(404).json({ error: 'Loan not found' });
  if (loan.guarantor_id !== req.user.id) return res.status(403).json({ error: 'You are not the guarantor for this loan' });
  if (loan.guarantor_status !== 'pending') return res.status(400).json({ error: 'This request has already been answered' });

  const newStatus = decision === 'approved' ? 'pending_level1' : 'rejected';
  db.prepare(
    `UPDATE loans SET guarantor_status = ?, guarantor_responded_at = datetime('now'), status = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(decision, newStatus, loan.id);

  logEvent(loan.id, req.user.id, `guarantor_${decision}`, null);
  const updated = db.prepare('SELECT * FROM loans WHERE id = ?').get(loan.id);
  res.json({ loan: updated });
});

// Staff: list loans, optional ?status=
router.get('/', requireAuth, requireRole('staff', 'admin'), (req, res) => {
  const { status } = req.query;
  const base = `SELECT loans.*, users.full_name, users.email, users.phone, users.national_id,
                       g.full_name as guarantor_name
                FROM loans JOIN users ON users.id = loans.user_id
                LEFT JOIN users g ON g.id = loans.guarantor_id`;
  const rows = status
    ? db.prepare(`${base} WHERE loans.status = ? ORDER BY loans.created_at ASC`).all(status)
    : db.prepare(`${base} ORDER BY loans.created_at DESC`).all();
  res.json({ loans: rows.map(l => ({ ...l, days_remaining: daysRemaining(l.due_date) })) });
});

router.get('/stats/summary', requireAuth, requireRole('staff', 'admin'), (req, res) => {
  const counts = db.prepare(`SELECT status, COUNT(*) as count FROM loans GROUP BY status`).all();
  const totalBorrowers = db.prepare(`SELECT COUNT(*) as count FROM users WHERE role='borrower'`).get();
  const pendingVerification = db.prepare(`SELECT COUNT(*) as count FROM users WHERE verification_status='pending'`).get();
  const disbursedSum = db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM loans WHERE status IN ('disbursed','defaulted','repaid')`).get();
  res.json({ counts, totalBorrowers: totalBorrowers.count, pendingVerification: pendingVerification.count, disbursedTotal: disbursedSum.total });
});

// Get single loan (owner, guarantor, or staff)
router.get('/:id', requireAuth, (req, res) => {
  const loan = db
    .prepare(
      `SELECT loans.*, users.full_name, users.email, users.phone, users.national_id,
              g.full_name as guarantor_name, g.phone as guarantor_phone
       FROM loans JOIN users ON users.id = loans.user_id
       LEFT JOIN users g ON g.id = loans.guarantor_id
       WHERE loans.id = ?`
    )
    .get(req.params.id);
  if (!loan) return res.status(404).json({ error: 'Loan not found' });

  const isOwner = loan.user_id === req.user.id;
  const isGuarantor = loan.guarantor_id === req.user.id;
  const isStaff = ['staff', 'admin'].includes(req.user.role);
  if (!isOwner && !isGuarantor && !isStaff) return res.status(403).json({ error: 'Not authorized' });

  const events = db.prepare('SELECT * FROM loan_events WHERE loan_id = ? ORDER BY created_at ASC').all(loan.id);
  const extensions = db.prepare('SELECT * FROM loan_extensions WHERE loan_id = ? ORDER BY created_at DESC').all(loan.id);
  res.json({ loan: { ...loan, days_remaining: daysRemaining(loan.due_date) }, events, extensions });
});

// Staff: Level 1 review
router.post('/:id/level1', requireAuth, requireRole('staff', 'admin'), (req, res) => {
  const { decision, note } = req.body; // 'passed' | 'rejected'
  if (!['passed', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: "decision must be 'passed' or 'rejected'" });
  }
  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id);
  if (!loan) return res.status(404).json({ error: 'Loan not found' });
  if (loan.status !== 'pending_level1') return res.status(400).json({ error: 'Loan is not awaiting level 1 review' });

  const newStatus = decision === 'passed' ? 'pending_level2' : 'rejected';
  db.prepare(
    `UPDATE loans SET level1_status = ?, level1_reviewer_id = ?, level1_note = ?, level1_at = datetime('now'),
       status = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(decision, req.user.id, note || null, newStatus, loan.id);

  logEvent(loan.id, req.user.id, `level1_${decision}`, note);
  const updated = db.prepare('SELECT * FROM loans WHERE id = ?').get(loan.id);
  res.json({ loan: updated });
});

// Staff: Level 2 approval - must be a DIFFERENT staff member than level 1
router.post('/:id/level2', requireAuth, requireRole('staff', 'admin'), (req, res) => {
  const { decision, note } = req.body; // 'passed' | 'rejected'
  if (!['passed', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: "decision must be 'passed' or 'rejected'" });
  }
  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id);
  if (!loan) return res.status(404).json({ error: 'Loan not found' });
  if (loan.status !== 'pending_level2') return res.status(400).json({ error: 'Loan is not awaiting level 2 review' });
  if (loan.level1_reviewer_id === req.user.id) {
    return res.status(403).json({ error: 'Level 2 approval must be done by a different staff member than level 1' });
  }

  const newStatus = decision === 'passed' ? 'approved' : 'rejected';
  db.prepare(
    `UPDATE loans SET level2_status = ?, level2_reviewer_id = ?, level2_note = ?, level2_at = datetime('now'),
       status = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(decision, req.user.id, note || null, newStatus, loan.id);

  logEvent(loan.id, req.user.id, `level2_${decision}`, note);
  const updated = db.prepare('SELECT * FROM loans WHERE id = ?').get(loan.id);
  res.json({ loan: updated });
});

// Staff: disburse (level 3)
router.post('/:id/disburse', requireAuth, requireRole('staff', 'admin'), async (req, res) => {
  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id);
  if (!loan) return res.status(404).json({ error: 'Loan not found' });
  if (loan.status !== 'approved') return res.status(400).json({ error: 'Only approved loans can be disbursed' });

  db.prepare(`UPDATE loans SET status='disbursed', updated_at=datetime('now') WHERE id=?`).run(loan.id);
  logEvent(loan.id, req.user.id, 'disbursed', null);

  const borrower = db.prepare('SELECT * FROM users WHERE id = ?').get(loan.user_id);
  await sendWhatsApp(
    borrower.phone,
    `Hi ${borrower.full_name}, your Sasa Loan of KES ${loan.amount} has been disbursed. Repayment of KES ${loan.total_repayable} is due by ${loan.due_date}.`
  );

  const updated = db.prepare('SELECT * FROM loans WHERE id = ?').get(loan.id);
  res.json({ loan: updated });
});

// Staff: mark repaid
router.post('/:id/repay', requireAuth, requireRole('staff', 'admin'), (req, res) => {
  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id);
  if (!loan) return res.status(404).json({ error: 'Loan not found' });
  if (!['disbursed', 'defaulted'].includes(loan.status)) {
    return res.status(400).json({ error: 'Only disbursed or defaulted loans can be marked repaid' });
  }
  db.prepare(`UPDATE loans SET status='repaid', updated_at=datetime('now') WHERE id=?`).run(loan.id);
  logEvent(loan.id, req.user.id, 'repaid', null);
  const updated = db.prepare('SELECT * FROM loans WHERE id = ?').get(loan.id);
  res.json({ loan: updated });
});

// Borrower: request an extension (any time after disbursement, typically once overdue)
router.post('/:id/request-extension', requireAuth, requireRole('borrower'), (req, res) => {
  const { reason } = req.body;
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'A written reason is required' });

  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id);
  if (!loan) return res.status(404).json({ error: 'Loan not found' });
  if (loan.user_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
  if (!['disbursed', 'defaulted'].includes(loan.status)) {
    return res.status(400).json({ error: 'Extensions can only be requested on disbursed loans' });
  }

  const existingPending = db
    .prepare(`SELECT id FROM loan_extensions WHERE loan_id = ? AND status = 'pending'`)
    .get(loan.id);
  if (existingPending) return res.status(409).json({ error: 'You already have a pending extension request for this loan' });

  const info = db
    .prepare(`INSERT INTO loan_extensions (loan_id, reason, status) VALUES (?, ?, 'pending')`)
    .run(loan.id, reason.trim());

  logEvent(loan.id, req.user.id, 'extension_requested', reason.trim());
  res.status(201).json({ extension: db.prepare('SELECT * FROM loan_extensions WHERE id = ?').get(info.lastInsertRowid) });
});

// Staff: list all pending extension requests
router.get('/extensions/pending', requireAuth, requireRole('staff', 'admin'), (req, res) => {
  const rows = db
    .prepare(
      `SELECT loan_extensions.*, loans.amount, loans.total_repayable, loans.due_date, loans.user_id,
              users.full_name, users.phone
       FROM loan_extensions
       JOIN loans ON loans.id = loan_extensions.loan_id
       JOIN users ON users.id = loans.user_id
       WHERE loan_extensions.status = 'pending'
       ORDER BY loan_extensions.created_at ASC`
    )
    .all();
  res.json({ extensions: rows });
});

// Staff: review an extension request
router.post('/extensions/:id/review', requireAuth, requireRole('staff', 'admin'), async (req, res) => {
  const { decision, note } = req.body; // 'approved' | 'rejected'
  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: "decision must be 'approved' or 'rejected'" });
  }
  const ext = db.prepare('SELECT * FROM loan_extensions WHERE id = ?').get(req.params.id);
  if (!ext) return res.status(404).json({ error: 'Extension request not found' });
  if (ext.status !== 'pending') return res.status(400).json({ error: 'This request has already been reviewed' });

  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(ext.loan_id);
  let newDueDate = null;

  if (decision === 'approved') {
    const interestRate = getNumberSetting('interest_rate', 12);
    const termDays = getNumberSetting('loan_term_days', 30);
    // Outstanding total becomes the new principal; fresh interest applied for another term
    const calc = calculateLoan(loan.total_repayable, interestRate);
    newDueDate = addDays(loan.due_date, termDays);

    db.prepare(
      `UPDATE loans SET total_repayable = ?, due_date = ?, status = 'disbursed', updated_at = datetime('now') WHERE id = ?`
    ).run(calc.totalRepayable, newDueDate, loan.id);

    logEvent(loan.id, req.user.id, 'extension_approved', note);

    const borrower = db.prepare('SELECT * FROM users WHERE id = ?').get(loan.user_id);
    await sendWhatsApp(
      borrower.phone,
      `Hi ${borrower.full_name}, your extension request has been approved. New amount due: KES ${calc.totalRepayable}, new due date: ${newDueDate}.`
    );
  } else {
    logEvent(loan.id, req.user.id, 'extension_rejected', note);
  }

  db.prepare(
    `UPDATE loan_extensions SET status = ?, reviewed_by = ?, review_note = ?, new_due_date = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(decision, req.user.id, note || null, newDueDate, ext.id);

  res.json({ extension: db.prepare('SELECT * FROM loan_extensions WHERE id = ?').get(ext.id) });
});

function daysRemaining(dueDate) {
  if (!dueDate) return null;
  const diffMs = new Date(dueDate + 'T00:00:00Z') - new Date(today() + 'T00:00:00Z');
  return Math.round(diffMs / 86400000);
}

module.exports = router;
