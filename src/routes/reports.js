const express = require('express');
const db = require('../db');
const { requireAuth, requireAnyRole } = require('../middleware/auth');

const router = express.Router();

function today() { return new Date().toISOString().slice(0, 10); }
function daysOverdue(dueDate) {
  return Math.round((new Date(today() + 'T00:00:00Z') - new Date(dueDate + 'T00:00:00Z')) / 86400000);
}

// Portfolio at risk: how much of the active book is overdue, broken into aging buckets
router.get('/portfolio-at-risk', requireAuth, requireAnyRole('admin', 'super_admin'), (req, res) => {
  const active = db.prepare(`SELECT * FROM loans WHERE status IN ('disbursed','defaulted')`).all();

  const buckets = { current: 0, days1to7: 0, days8to30: 0, days30plus: 0 };
  let totalOutstanding = 0;

  for (const loan of active) {
    const paid = db.prepare('SELECT COALESCE(SUM(amount),0) as total FROM repayments WHERE loan_id = ?').get(loan.id).total;
    const balance = Math.max(0, loan.total_repayable - paid);
    totalOutstanding += balance;
    const overdueDays = daysOverdue(loan.due_date);
    if (overdueDays <= 0) buckets.current += balance;
    else if (overdueDays <= 7) buckets.days1to7 += balance;
    else if (overdueDays <= 30) buckets.days8to30 += balance;
    else buckets.days30plus += balance;
  }

  const atRisk = buckets.days1to7 + buckets.days8to30 + buckets.days30plus;
  const parRatio = totalOutstanding > 0 ? Math.round((atRisk / totalOutstanding) * 1000) / 10 : 0;

  res.json({ totalOutstanding: round2(totalOutstanding), buckets: mapRound(buckets), parRatio, activeLoanCount: active.length });
});

router.get('/summary', requireAuth, requireAnyRole('admin', 'super_admin'), (req, res) => {
  const totalMembers = db.prepare(`SELECT COUNT(*) as c FROM users WHERE roles='member'`).get().c;
  const activeMembers = db.prepare(`SELECT COUNT(*) as c FROM users WHERE roles='member' AND verification_status='approved'`).get().c;
  const totalLoans = db.prepare(`SELECT COUNT(*) as c FROM loans`).get().c;
  const repaidOnTime = db.prepare(
    `SELECT COUNT(*) as c FROM loans WHERE status = 'repaid' AND id NOT IN (SELECT loan_id FROM loan_events WHERE action = 'defaulted')`
  ).get().c;
  const defaultedCount = db.prepare(`SELECT COUNT(DISTINCT loan_id) as c FROM loan_events WHERE action = 'defaulted'`).get().c;

  res.json({ totalMembers, activeMembers, totalLoans, repaidOnTime, defaultedCount });
});

// CSV export: all loans
router.get('/loans.csv', requireAuth, requireAnyRole('admin', 'super_admin'), (req, res) => {
  const rows = db.prepare(
    `SELECT loans.id, users.full_name, users.phone, loans.amount, loans.total_repayable, loans.status,
            loans.disbursement_date, loans.due_date, g.full_name as guarantor_name
     FROM loans JOIN users ON users.id = loans.user_id
     LEFT JOIN users g ON g.id = loans.guarantor_id
     ORDER BY loans.created_at DESC`
  ).all();

  const header = 'Loan ID,Member,Phone,Amount,Total Repayable,Status,Disbursement Date,Due Date,Guarantor\n';
  const csv = header + rows.map(r =>
    [r.id, csvEscape(r.full_name), r.phone, r.amount, r.total_repayable, r.status, r.disbursement_date || '', r.due_date || '', csvEscape(r.guarantor_name || '')].join(',')
  ).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="loans.csv"');
  res.send(csv);
});

// CSV export: all members
router.get('/members.csv', requireAuth, requireAnyRole('admin', 'super_admin'), (req, res) => {
  const rows = db.prepare(
    `SELECT id, full_name, email, phone, national_id, verification_status, created_at FROM users WHERE roles = 'member' ORDER BY created_at DESC`
  ).all();

  const header = 'Member ID,Full Name,Email,Phone,National ID,Verification Status,Registered\n';
  const csv = header + rows.map(r =>
    [r.id, csvEscape(r.full_name), r.email, r.phone, r.national_id || '', r.verification_status, r.created_at].join(',')
  ).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="members.csv"');
  res.send(csv);
});

function csvEscape(str) {
  if (!str) return '';
  const s = String(str);
  return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
}
function round2(n) { return Math.round(n * 100) / 100; }
function mapRound(obj) { return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, round2(v)])); }

module.exports = router;
