require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const authRoutes = require('./src/routes/auth');
const loanRoutes = require('./src/routes/loans');
const settingsRoutes = require('./src/routes/settings');
const usersRoutes = require('./src/routes/users');
const whatsappRoutes = require('./src/routes/whatsapp');
const { ensureDefaultAdmin } = require('./src/seed');
const { startReminderScheduler } = require('./src/utils/reminders');

ensureDefaultAdmin();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
// Higher limit than default, to allow base64-encoded ID photo + selfie uploads
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', authRoutes);
app.use('/api/loans', loanRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/whatsapp', whatsappRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Sasa Loan running at http://localhost:${PORT}`);
  startReminderScheduler();
});
