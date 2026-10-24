require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const { getDb }  = require('./database');

const app  = express();
const PORT = 3001;

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' })); // Twilio webhook sends URL-encoded form data
app.use(express.static(path.join(__dirname, '../frontend')));

// ── Direct Portal Routes for Cloudflare & Browsers ───
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '../frontend/admin.html')));
app.get('/hub', (req, res) => res.sendFile(path.join(__dirname, '../frontend/hub.html')));

// ── Routes ──────────────────────────────────
app.use('/api/auth',     require('./routes/auth'));
app.use('/api/users',    require('./routes/users'));
app.use('/api/pickups',  require('./routes/pickups'));
app.use('/api/admin',    require('./routes/admin'));
app.use('/api/whatsapp', require('./routes/whatsapp'));
app.use('/api/ai',       require('./routes/aiChat'));
app.use('/api/wallet',   require('./routes/wallet'));
app.use('/api/hub',      require('./routes/hub'));

// ── WhatsApp Web Client & Status ─────────────────────
const { getStatus } = require('./whatsappWeb');
app.get('/api/whatsapp/status', (req, res) => {
    res.json(getStatus());
});

// ── Health check ────────────────────────────
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'circular. backend is running 🟢' });
});

// ── Catch-all: serve frontend ────────────────
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ── Boot ─────────────────────────────────────
(async () => {
    await getDb();
    app.listen(PORT, '0.0.0.0', () => {
        console.log('');
        console.log('  🌿 circular. backend');
        console.log(`  ➜  App:      http://localhost:${PORT}`);
        console.log(`  ➜  Admin:    http://localhost:${PORT}/admin.html`);
        console.log(`  ➜  API:      http://localhost:${PORT}/api`);
        console.log(`  ➜  Health:   http://localhost:${PORT}/api/health`);
        console.log('');
    });
})();
