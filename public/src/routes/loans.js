const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { calculateLoan } = require('../utils/loanCalc');

const router = express.Router();

const MAX_ACTIVE_LOANS_PER_USER = 1; // one open (non-final) loan at a time
const DEFAULT_INTEREST_RATE = Number(process.env.DEFAULT_INTEREST_RATE || 12); // annual %
const MIN_AMOUNT = Number(process.env.MIN_LOAN_AMOUNT || 1000);
const MAX_AMOUNT = Number(process.env.MAX_LOAN_AMOUNT || 500000);

function logEvent(loanId, actorId, action, note) {
  db.prepare(
    `INSERT INTO loan_events (loan_id, actor_id, action, note) VALUES (?, ?, ?, ?)`
  ).run(loanId, actorId || null, action, note || null);
}

// Borrower applies for a loan
router.post('/apply', requireAuth, requireRole('borrower'), (req, res) => {
  const { amount, purpose, term_months } = req.body;

  const amt = Number(amount);
  const term = Number(term_months);

  if (!amt || amt < MIN_AMOUNT || amt > MAX_AMOUNT) {
    return res.status(400).json({ error: `Amount must be between ${MIN_AMOUNT} and ${MAX_AMOUNT}` });
  }
  if (!term || term < 1 || term > 60) {
    return res.status(400).json({ error: 'Term must be between 1 and 60 months' });
  }

  const openLoan = db
    .prepare(
      `SELECT id FROM loans WHERE user_id = ? AND status IN ('pending','under_review','approved') LIMIT 1`
    )
    .get(req.user.id);
  if (openLoan) {
    return res.status(409).json({ error: 'You already have an active loan application in progress' });
  }

  const calc = calculateLoan(amt, term, DEFAULT_INTEREST_RATE);

  const info = db
    .prepare(
      `INSERT INTO loans (user_id, amount, purpose, term_months, interest_rate, monthly_payment, total_repayable, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
    )
    .run(req.user.id, amt, purpose || null, term, DEFAULT_INTEREST_RATE, calc.monthlyPayment, calc.totalRepayable);

  logEvent(info.lastInsertRowid, req.user.id, 'applied', null);

  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ loan });
});

// Borrower: preview calculation before submitting
router.post('/calculate', requireAuth, (req, res) => {
  const { amount, term_months } = req.body;
  if (!amount || !term_months) return res.status(400).json({ error: 'amount and term_months required' });
  const calc = calculateLoan(amount, term_months, DEFAULT_INTEREST_RATE);
  res.json({ ...calc, interest_rate: DEFAULT_INTEREST_RATE });
});

// Borrower: my loans
router.get('/my', requireAuth, requireRole('borrower'), (req, res) => {
  const loans = db
    .prepare('SELECT * FROM loans WHERE user_id = ? ORDER BY created_at DESC')
    .all(req.user.id);
  res.json({ loans });
});

// Staff: list loans, optional ?status=pending
router.get('/', requireAuth, requireRole('staff', 'admin'), (req, res) => {
  const { status } = req.query;
  let rows;
  if (status) {
    rows = db
      .prepare(
        `SELECT loans.*, users.full_name, users.email, users.phone, users.national_id
         FROM loans JOIN users ON users.id = loans.user_id
         WHERE loans.status = ? ORDER BY loans.created_at ASC`
      )
      .all(status);
  } else {
    rows = db
      .prepare(
        `SELECT loans.*, users.full_name, users.email, users.phone, users.national_id
         FROM loans JOIN users ON users.id = loans.user_id
         ORDER BY loans.created_at DESC`
      )
      .all();
  }
  res.json({ loans: rows });
});

// Staff dashboard summary
router.get('/stats/summary', requireAuth, requireRole('staff', 'admin'), (req, res) => {
  const counts = db
    .prepare(`SELECT status, COUNT(*) as count FROM loans GROUP BY status`)
    .all();
  const totalBorrowers = db.prepare(`SELECT COUNT(*) as count FROM users WHERE role='borrower'`).get();
  const disbursedSum = db
    .prepare(`SELECT COALESCE(SUM(amount),0) as total FROM loans WHERE status='disbursed'`)
    .get();
  res.json({ counts, totalBorrowers: totalBorrowers.count, disbursedTotal: disbursedSum.total });
});

// Get single loan (owner or staff)
router.get('/:id', requireAuth, (req, res) => {
  const loan = db
    .prepare(
      `SELECT loans.*, users.full_name, users.email, users.phone, users.national_id
       FROM loans JOIN users ON users.id = loans.user_id WHERE loans.id = ?`
    )
    .get(req.params.id);
  if (!loan) return res.status(404).json({ error: 'Loan not found' });
  if (req.user.role === 'borrower' && loan.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  const events = db
    .prepare('SELECT * FROM loan_events WHERE loan_id = ? ORDER BY created_at ASC')
    .all(loan.id);
  res.json({ loan, events });
});

// Staff: move to under_review with a note (vetting step)
router.post('/:id/vet', requireAuth, requireRole('staff', 'admin'), (req, res) => {
  const { note } = req.body;
  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id);
  if (!loan) return res.status(404).json({ error: 'Loan not found' });
  if (loan.status !== 'pending') return res.status(400).json({ error: 'Only pending loans can be sent for vetting' });

  db.prepare(
    `UPDATE loans SET status='under_review', staff_notes=?, reviewed_by=?, updated_at=datetime('now') WHERE id=?`
  ).run(note || null, req.user.id, loan.id);

  logEvent(loan.id, req.user.id, 'under_review', note);
  const updated = db.prepare('SELECT * FROM loans WHERE id = ?').get(loan.id);
  res.json({ loan: updated });
});

// Staff: approve
router.post('/:id/approve', requireAuth, requireRole('staff', 'admin'), (req, res) => {
  const { note } = req.body;
  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id);
  if (!loan) return res.status(404).json({ error: 'Loan not found' });
  if (!['pending', 'under_review'].includes(loan.status)) {
    return res.status(400).json({ error: 'Loan cannot be approved from its current status' });
  }

  db.prepare(
    `UPDATE loans SET status='approved', staff_notes=?, reviewed_by=?, updated_at=datetime('now') WHERE id=?`
  ).run(note || loan.staff_notes, req.user.id, loan.id);

  logEvent(loan.id, req.user.id, 'approved', note);
  const updated = db.prepare('SELECT * FROM loans WHERE id = ?').get(loan.id);
  res.json({ loan: updated });
});

// Staff: reject
router.post('/:id/reject', requireAuth, requireRole('staff', 'admin'), (req, res) => {
  const { note } = req.body;
  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id);
  if (!loan) return res.status(404).json({ error: 'Loan not found' });
  if (!['pending', 'under_review'].includes(loan.status)) {
    return res.status(400).json({ error: 'Loan cannot be rejected from its current status' });
  }
  if (!note) return res.status(400).json({ error: 'A reason is required to reject a loan' });

  db.prepare(
    `UPDATE loans SET status='rejected', staff_notes=?, reviewed_by=?, updated_at=datetime('now') WHERE id=?`
  ).run(note, req.user.id, loan.id);

  logEvent(loan.id, req.user.id, 'rejected', note);
  const updated = db.prepare('SELECT * FROM loans WHERE id = ?').get(loan.id);
  res.json({ loan: updated });
});

// Staff: mark disbursed (after approval)
router.post('/:id/disburse', requireAuth, requireRole('staff', 'admin'), (req, res) => {
  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id);
  if (!loan) return res.status(404).json({ error: 'Loan not found' });
  if (loan.status !== 'approved') return res.status(400).json({ error: 'Only approved loans can be disbursed' });

  db.prepare(`UPDATE loans SET status='disbursed', updated_at=datetime('now') WHERE id=?`).run(loan.id);
  logEvent(loan.id, req.user.id, 'disbursed', null);
  const updated = db.prepare('SELECT * FROM loans WHERE id = ?').get(loan.id);
  res.json({ loan: updated });
});

module.exports = router;
