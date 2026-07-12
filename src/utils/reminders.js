const db = require('../db');
const { sendWhatsApp } = require('./whatsapp');

function today() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((new Date(a + 'T00:00:00Z') - new Date(b + 'T00:00:00Z')) / 86400000);
}

/**
 * Runs once per invocation:
 * - Sends a WhatsApp reminder to borrowers whose loan is due in 3, 2, 1, or 0 days
 *   (max once per day per loan, tracked via last_whatsapp_reminder_date).
 * - Marks any disbursed loan whose due date has passed as 'defaulted'.
 */
async function runReminderSweep() {
  const t = today();

  const dueSoon = db
    .prepare(
      `SELECT loans.*, users.full_name, users.phone FROM loans
       JOIN users ON users.id = loans.user_id
       WHERE loans.status = 'disbursed'
         AND (loans.last_whatsapp_reminder_date IS NULL OR loans.last_whatsapp_reminder_date != ?)`
    )
    .all(t);

  for (const loan of dueSoon) {
    const diff = daysBetween(loan.due_date, t); // days until due (negative = overdue)
    if (diff >= 0 && diff <= 3) {
      const dayWord = diff === 0 ? 'today' : `in ${diff} day${diff === 1 ? '' : 's'}`;
      await sendWhatsApp(
        loan.phone,
        `Hi ${loan.full_name}, reminder: your Sasa Loan repayment of KES ${loan.total_repayable} is due ${dayWord} (${loan.due_date}).`
      );
      db.prepare(`UPDATE loans SET last_whatsapp_reminder_date = ? WHERE id = ?`).run(t, loan.id);
    }
  }

  const overdue = db
    .prepare(`SELECT * FROM loans WHERE status = 'disbursed' AND due_date < ?`)
    .all(t);
  for (const loan of overdue) {
    db.prepare(`UPDATE loans SET status = 'defaulted', updated_at = datetime('now') WHERE id = ?`).run(loan.id);
    db.prepare(`INSERT INTO loan_events (loan_id, actor_id, action, note) VALUES (?, NULL, 'defaulted', NULL)`).run(loan.id);
  }
}

function startReminderScheduler() {
  runReminderSweep().catch(err => console.error('Reminder sweep failed:', err));
  // Check hourly; sending itself is deduped per-day via last_whatsapp_reminder_date
  setInterval(() => {
    runReminderSweep().catch(err => console.error('Reminder sweep failed:', err));
  }, 60 * 60 * 1000);
}

module.exports = { startReminderScheduler, runReminderSweep };
