/**
 * Simple flat-rate loan calculation.
 * interestRate is an ANNUAL percentage (e.g. 12 means 12%/year).
 */
function calculateLoan(amount, termMonths, interestRatePct) {
  const principal = Number(amount);
  const months = Number(termMonths);
  const annualRate = Number(interestRatePct) / 100;

  const totalInterest = principal * annualRate * (months / 12);
  const totalRepayable = principal + totalInterest;
  const monthlyPayment = totalRepayable / months;

  return {
    totalInterest: round2(totalInterest),
    totalRepayable: round2(totalRepayable),
    monthlyPayment: round2(monthlyPayment),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { calculateLoan };
