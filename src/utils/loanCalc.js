/**
 * Sasa Loan uses a flat interest rate on a fixed term (default 30 days).
 * interestRate is a percentage applied once over the whole term (not annualized).
 */
function calculateLoan(amount, interestRatePct) {
  const principal = Number(amount);
  const rate = Number(interestRatePct) / 100;

  const interest = principal * rate;
  const totalRepayable = principal + interest;

  return {
    interest: round2(interest),
    totalRepayable: round2(totalRepayable),
  };
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { calculateLoan, addDays };
