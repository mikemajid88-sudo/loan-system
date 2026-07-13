const express = require('express');
const db = require('../db');
const { requireAuth, requireAnyRole, requireVerified, blockIfMustChangePassword } = require('../middleware/auth');
const { calculateLoan, addDays } = require('../utils/loanCalc');
const { getNumberSetting } = require('../utils/settings');
const { ALL_STAFF_ROLES } = require('../utils/roles');

const router = express.Router();

function logEvent(loanId, actorId, action, note) {
  db.prepare(`INSERT INTO loan_events (loan_id, actor_id, action, note) VALUES (?, ?, ?, ?)`)
    .run(loanId, actorId || null, action, note || null);
}
function today() { return new Date().toISOString().slice(0, 10); }
function daysRemaining(dueDate) {
  if (!dueDate) return null;
  const diffMs = new Date(dueDate + 'T00:00:00Z') - new Date(today() + 'T00:00:00Z');
  return Math.round(diffMs / 86400000);
}

// Member: apply for a loan
router.post('/apply', requireAuth, requireAnyRole('member'), requireVerified, (req, res) => {
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
  if (!guarantor_id) return res.status(400).json({ error: 'A guarantor is required' });
  if (Number(guarantor_id) === req.user.id) {
    return res.status(400).json({ error: 'You cannot be your own guarantor' });
  }

  const guarantor = db.prepare(`SELECT * FROM users WHERE id = ?`).get(guarantor_id);
  if (!guarantor || guarantor.roles !== 'member' || guarantor.verification_status !== 'approved') {
    return res.status(400).json({ error: 'Guarantor must be a verified member' });
  }

  const openLoan = db
    .prepare(`SELECT id FROM loans WHERE user_id = ? AND status NOT IN ('rejected','repaid') LIMIT 1`)
    .get(req.user.id);
  if (openLoan) return res.status(409).json({ error: 'You already have an active loan in progress' });

  const calc = calculateLoan(amt, interestRate);
  const dueDate = addDays(disbursement_date, termDays);
  const liabilityAmount = Math.round(amt * 0.5 * 100) / 100;

  const info = db
    .prepare(
      `INSERT INTO loans (user_id, amount, purpose, interest_rate, term_days, total_repayable,
         disbursement_date, due_date, guarantor_id, guarantor_liability_amount, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_guarantor')`
    )
    .run(req.user.id, amt, purpose || null, interestRate, termDays, calc.totalRepayable,
         disbursement_date, dueDate, guarantor_id, liabilityAmount);

  logEvent(info.lastInsertRowid, req.user.id, 'applied', null);
  res.status(201).json({ loan: db.prepare('SELECT * FROM loans WHERE id = ?').get(info.lastInsertRowid) });
});

router.get('/calculate', requireAuth, (req, res) => {
  const amount = Number(req.query.amount);
  if (!amount) return res.status(400).json({ error: 'amount is required' });
  const interestRate = getNumberSetting('interest_rate', 12);
  const termDays = getNumberSetting('loan_term_days', 30);
  const calc = calculateLoan(amount, interestRate);
  res.json({ ...calc, interest_rate: interestRate, term_days: termDays });
});

router.get('/my', requireAuth, requireAnyRole('member'), (req, res) => {
  const loans = db.prepare('SELECT * FROM loans WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ loans: loans.map(l => ({ ...l, days_remaining: daysRemaining(l.due_date) })) });
});

router.get('/guarantor-requests', requireAuth, requireAnyRole('member'), (req, res) => {
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

router.post('/:id/guarantor-respond', requireAuth, requireAnyRole('member'), (req, res) => {
  const { decision } = req.body;
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
  res.json({ loan: db.prepare('SELECT * FROM loans WHERE id = ?').get(loan.id) });
});

// Any staff-side role: list loans
router.get('/', requireAuth, requireAnyRole(...ALL_STAFF_ROLES), blockIfMustChangePassword, (req, res) => {
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

router.get('/stats/summary', requireAuth, requireAnyRole(...ALL_STAFF_ROLES), blockIfMustChangePassword, (req, res) => {
  const counts = db.prepare(`SELECT status, COUNT(*) as count FROM loans GROUP BY status`).all();
  const totalMembers = db.prepare(`SELECT COUNT(*) as count FROM users WHERE roles='member'`).get();
  const pendingVerification = db.prepare(`SELECT COUNT(*) as count FROM users WHERE verification_status='pending'`).get();
  const disbursedSum = db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM loans WHERE status IN ('disbursed','defaulted','repaid')`).get();
  res.json({ counts, totalMembers: totalMembers.count, pendingVerification: pendingVerification.count, disbursedTotal: disbursedSum.total });
});

// Admin/Super Admin only: cash flow trend
router.get('/stats/cashflow', requireAuth, requireAnyRole('admin', 'super_admin'), blockIfMustChangePassword, (req, res) => {
  const disbursedByWeek = db.prepare(
    `SELECT strftime('%Y-W%W', loan_events.created_at) as period, SUM(loans.amount) as total
     FROM loan_events JOIN loans ON loans.id = loan_events.loan_id
     WHERE loan_events.action = 'disbursed' GROUP BY period ORDER BY period ASC`
  ).all();
  const repaidByWeek = db.prepare(
    `SELECT strftime('%Y-W%W', loan_events.created_at) as period, SUM(loans.total_repayable) as total
     FROM loan_events JOIN loans ON loans.id = loan_events.loan_id
     WHERE loan_events.action = 'repaid' GROUP BY period ORDER BY period ASC`
  ).all();
  const outstanding = db.prepare(`SELECT COALESCE(SUM(total_repayable),0) as total FROM loans WHERE status IN ('disbursed','defaulted')`).get();
  const overdueAmount = db.prepare(`SELECT COALESCE(SUM(total_repayable),0) as total FROM loans WHERE status = 'defaulted'`).get();
  const totalRepaidAllTime = db.prepare(`SELECT COALESCE(SUM(total_repayable),0) as total FROM loans WHERE status = 'repaid'`).get();

  const periods = Array.from(new Set([...disbursedByWeek.map(r => r.period), ...repaidByWeek.map(r => r.period)])).sort();
  const disbursedMap = Object.fromEntries(disbursedByWeek.map(r => [r.period, r.total]));
  const repaidMap = Object.fromEntries(repaidByWeek.map(r => [r.period, r.total]));

  res.json({
    trend: periods.map(p => ({ period: p, disbursed: disbursedMap[p] || 0, repaid: repaidMap[p] || 0 })),
    outstanding: outstanding.total, overdueAmount: overdueAmount.total, totalRepaidAllTime: totalRepaidAllTime.total,
  });
});

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
  const requesterRow = db.prepare('SELECT roles FROM users WHERE id = ?').get(req.user.id);
  const isStaff = requesterRow && requesterRow.roles !== 'member';
  if (!isOwner && !isGuarantor && !isStaff) return res.status(403).json({ error: 'Not authorized' });

  const events = db.prepare('SELECT * FROM loan_events WHERE loan_id = ? ORDER BY created_at ASC').all(loan.id);
  const extensions = db.prepare('SELECT * FROM loan_extensions WHERE loan_id = ? ORDER BY created_at DESC').all(loan.id);
  const repayments = db.prepare('SELECT repayments.*, users.full_name as recorded_by_name FROM repayments LEFT JOIN users ON users.id = repayments.recorded_by WHERE loan_id = ? ORDER BY created_at ASC').all(loan.id);
  const amountPaid = repayments.reduce((sum, r) => sum + r.amount, 0);
  const balance = Math.max(0, Math.round((loan.total_repayable - amountPaid) * 100) / 100);
  res.json({ loan: { ...loan, days_remaining: daysRemaining(loan.due_date), amount_paid: amountPaid, balance }, events, extensions, repayments });
});

// Loan Officer only: Level 1 review
router.post('/:id/level1', requireAuth, requireAnyRole('loan_officer'), blockIfMustChangePassword, (req, res) => {
  const { decision, note } = req.body;
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
  res.json({ loan: db.prepare('SELECT * FROM loans WHERE id = ?').get(loan.id) });
});

// Credit Manager only: Level 2 - must ALSO be a different person than level 1
// (in case one person holds both Loan Officer and Credit Manager roles)
router.post('/:id/level2', requireAuth, requireAnyRole('credit_manager'), blockIfMustChangePassword, (req, res) => {
  const { decision, note } = req.body;
  if (!['passed', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: "decision must be 'passed' or 'rejected'" });
  }
  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id);
  if (!loan) return res.status(404).json({ error: 'Loan not found' });
  if (loan.status !== 'pending_level2') return res.status(400).json({ error: 'Loan is not awaiting level 2 review' });
  if (loan.level1_reviewer_id === req.user.id) {
    return res.status(403).json({ error: 'Level 2 approval must be done by a different person than Level 1, even if you hold both roles' });
  }

  const newStatus = decision === 'passed' ? 'approved' : 'rejected';
  db.prepare(
    `UPDATE loans SET level2_status = ?, level2_reviewer_id = ?, level2_note = ?, level2_at = datetime('now'),
       status = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(decision, req.user.id, note || null, newStatus, loan.id);
  logEvent(loan.id, req.user.id, `level2_${decision}`, note);
  res.json({ loan: db.prepare('SELECT * FROM loans WHERE id = ?').get(loan.id) });
});

// Credit Manager only: disburse (they did the final approval)
router.post('/:id/disburse', requireAuth, requireAnyRole('credit_manager'), blockIfMustChangePassword, (req, res) => {
  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id);
  if (!loan) return res.status(404).json({ error: 'Loan not found' });
  if (loan.status !== 'approved') return res.status(400).json({ error: 'Only approved loans can be disbursed' });

  db.prepare(`UPDATE loans SET status='disbursed', updated_at=datetime('now') WHERE id=?`).run(loan.id);
  logEvent(loan.id, req.user.id, 'disbursed', null);
  res.json({ loan: db.prepare('SELECT * FROM loans WHERE id = ?').get(loan.id) });
});

// Credit Manager only: record a repayment (partial or full)
router.post('/:id/repayments', requireAuth, requireAnyRole('credit_manager'), blockIfMustChangePassword, (req, res) => {
  const { amount, note } = req.body;
  const amt = Number(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'A positive repayment amount is required' });

  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id);
  if (!loan) return res.status(404).json({ error: 'Loan not found' });
  if (!['disbursed', 'defaulted'].includes(loan.status)) {
    return res.status(400).json({ error: 'Repayments can only be recorded on disbursed or overdue loans' });
  }

  const existingPaid = db.prepare('SELECT COALESCE(SUM(amount),0) as total FROM repayments WHERE loan_id = ?').get(loan.id).total;
  const balance = loan.total_repayable - existingPaid;
  if (amt > balance + 0.01) {
    return res.status(400).json({ error: `Amount exceeds outstanding balance of KES ${balance.toFixed(2)}` });
  }

  db.prepare(`INSERT INTO repayments (loan_id, amount, note, recorded_by) VALUES (?, ?, ?, ?)`)
    .run(loan.id, amt, note || null, req.user.id);
  logEvent(loan.id, req.user.id, 'repayment_recorded', `KES ${amt}${note ? ' — ' + note : ''}`);

  const newPaid = existingPaid + amt;
  const fullyPaid = newPaid >= loan.total_repayable - 0.01;
  if (fullyPaid) {
    db.prepare(`UPDATE loans SET status='repaid', updated_at=datetime('now') WHERE id=?`).run(loan.id);
    logEvent(loan.id, req.user.id, 'repaid', null);
  }

  res.json({
    loan: db.prepare('SELECT * FROM loans WHERE id = ?').get(loan.id),
    amount_paid: newPaid,
    balance: Math.max(0, Math.round((loan.total_repayable - newPaid) * 100) / 100),
    fully_paid: fullyPaid,
  });
});

// Member: request an extension
router.post('/:id/request-extension', requireAuth, requireAnyRole('member'), (req, res) => {
  const { reason } = req.body;
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'A written reason is required' });

  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id);
  if (!loan) return res.status(404).json({ error: 'Loan not found' });
  if (loan.user_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
  if (!['disbursed', 'defaulted'].includes(loan.status)) {
    return res.status(400).json({ error: 'Extensions can only be requested on disbursed loans' });
  }
  const existingPending = db.prepare(`SELECT id FROM loan_extensions WHERE loan_id = ? AND status = 'pending'`).get(loan.id);
  if (existingPending) return res.status(409).json({ error: 'You already have a pending extension request for this loan' });

  const info = db.prepare(`INSERT INTO loan_extensions (loan_id, reason, status) VALUES (?, ?, 'pending')`).run(loan.id, reason.trim());
  logEvent(loan.id, req.user.id, 'extension_requested', reason.trim());
  res.status(201).json({ extension: db.prepare('SELECT * FROM loan_extensions WHERE id = ?').get(info.lastInsertRowid) });
});

// Any staff-side role can review extensions
router.get('/extensions/pending', requireAuth, requireAnyRole(...ALL_STAFF_ROLES), blockIfMustChangePassword, (req, res) => {
  const rows = db
    .prepare(
      `SELECT loan_extensions.*, loans.amount, loans.total_repayable, loans.due_date, loans.user_id,
              users.full_name, users.phone
       FROM loan_extensions
       JOIN loans ON loans.id = loan_extensions.loan_id
       JOIN users ON users.id = loans.user_id
       WHERE loan_extensions.status = 'pending' ORDER BY loan_extensions.created_at ASC`
    )
    .all();
  res.json({ extensions: rows });
});

router.post('/extensions/:id/review', requireAuth, requireAnyRole(...ALL_STAFF_ROLES), blockIfMustChangePassword, (req, res) => {
  const { decision, note } = req.body;
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
    const calc = calculateLoan(loan.total_repayable, interestRate);
    newDueDate = addDays(loan.due_date, termDays);
    db.prepare(
      `UPDATE loans SET total_repayable = ?, due_date = ?, status = 'disbursed', updated_at = datetime('now') WHERE id = ?`
    ).run(calc.totalRepayable, newDueDate, loan.id);
    logEvent(loan.id, req.user.id, 'extension_approved', note);
  } else {
    logEvent(loan.id, req.user.id, 'extension_rejected', note);
  }

  db.prepare(
    `UPDATE loan_extensions SET status = ?, reviewed_by = ?, review_note = ?, new_due_date = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(decision, req.user.id, note || null, newDueDate, ext.id);
  res.json({ extension: db.prepare('SELECT * FROM loan_extensions WHERE id = ?').get(ext.id) });
});

module.exports = router;
