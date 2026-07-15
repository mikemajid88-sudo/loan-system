require('dotenv').config();
const express = require('express');
const { init } = require('./src/db');

// Initializes schema + seeds (loan products, settings, super admin) on boot.
// Safe to run every startup: uses CREATE TABLE IF NOT EXISTS / INSERT OR IGNORE.
init();

const app = express();
app.use(express.json({ limit: '10mb' })); // KYC images arrive as base64 JSON payloads

app.use(express.static('public'));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// --- Route modules will be mounted here in Phase 2+ (Registration/KYC,
// Loan Lifecycle, Member Portal, Reporting) once the schema is reviewed
// and confirmed. Intentionally not built yet. ---

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sasa Loan server listening on port ${PORT}`);
});
