const express    = require('express');
const router     = express.Router();
const { getDb, persist } = require('../database');
const { sendWhatsAppAlert } = require('../whatsappWeb');

// ─────────────────────────────────────────────
// POST /api/pickups
// ─────────────────────────────────────────────
router.post('/', async (req, res) => {
    const { user_id, role, items, time_slot, quantity } = req.body;

    if (!user_id || !role || !items || !time_slot) {
        return res.status(400).json({ error: 'user_id, role, items and time_slot are required.' });
    }

    try {
        const db     = await getDb();
        const prefix = role === 'Business' ? 'BIZ' : 'REQ';
        const reqId  = `${prefix}-${Math.floor(1000 + Math.random() * 9000)}`;
        const pin    = String(Math.floor(1000 + Math.random() * 9000));

        // Get user details
        const userStmt = db.prepare('SELECT name, address, pincode FROM users WHERE id = ?');
        userStmt.bind([user_id]);
        let customer = null;
        if (userStmt.step()) customer = userStmt.getAsObject();
        userStmt.free();

        // Find an active collector (kabadiwala) in the area
        let collectorId = null;
        let collectorPhone = null;
        let collectorName = null;

        const collectorStmt = db.prepare('SELECT id, name, phone_number FROM collectors WHERE is_available = 1 ORDER BY id DESC LIMIT 1');
        if (collectorStmt.step()) {
            const assignedCollector = collectorStmt.getAsObject();
            collectorId = assignedCollector.id;
            collectorPhone = assignedCollector.phone_number;
            collectorName = assignedCollector.name;
            console.log(`📦 Auto-assigning pickup ${reqId} to collector: ${assignedCollector.name} (${assignedCollector.phone_number})`);
        }
        collectorStmt.free();

        db.run(
            `INSERT INTO pickups (request_id, user_id, role, items, time_slot, quantity, collector_id, pin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [reqId, user_id, role, items, time_slot, quantity || null, collectorId, pin]
        );
        persist();

        const stmt = db.prepare(`SELECT * FROM pickups ORDER BY id DESC LIMIT 1`);
        stmt.step();
        const pickup = stmt.getAsObject();
        stmt.free();

        // 🚀 AUTOMATIC INSTANT WHATSAPP ALERT TO KABADIWALA
        if (collectorPhone) {
            const alertMessage = 
                `🔔 *NAYA PICKUP ALERT! (New Request)*\n\n` +
                `Namaste ${collectorName || 'Partner'} ji! Aapke area me naya waste pickup book hua hai:\n\n` +
                `📋 *Details:*\n` +
                `• Request ID: *#${reqId}*\n` +
                `• Items: *${items}* (${quantity || 'Standard'})\n` +
                `• Customer: *${customer?.name || 'Household'}*\n` +
                `• Address: *${customer?.address || 'Local'}* (PIN: ${customer?.pincode || '—'})\n` +
                `• Time Slot: *${time_slot}*\n\n` +
                `📱 *Doorstep verification:* Doorstep par customer ke phone se QR code scan karein ya reply karein:\n` +
                `*VERIFY ${reqId} ${pin}*\n\n` +
                `Kripya time par pahunch kar waste collect karein! 🙏`;

            sendWhatsAppAlert(collectorPhone, alertMessage)
                .catch(err => console.error('Background alert error:', err));
        }

        return res.status(201).json({ message: 'Pickup scheduled.', pickup });
    } catch (err) {
        return res.status(500).json({ error: 'Database error.', details: err.message });
    }
});

// ─────────────────────────────────────────────
// GET /api/pickups?user_id=X
// ─────────────────────────────────────────────
router.get('/', async (req, res) => {
    try {
        const db      = await getDb();
        const { user_id } = req.query;
        const sql     = user_id
            ? `SELECT * FROM pickups WHERE user_id = ${Number(user_id)} ORDER BY id DESC`
            : `SELECT * FROM pickups ORDER BY id DESC`;
        const stmt    = db.prepare(sql);
        const pickups = [];
        while (stmt.step()) pickups.push(stmt.getAsObject());
        stmt.free();
        return res.json({ count: pickups.length, pickups });
    } catch (err) {
        return res.status(500).json({ error: 'Database error.', details: err.message });
    }
});

// ─────────────────────────────────────────────
// PATCH /api/pickups/:id/status
// ─────────────────────────────────────────────
router.patch('/:id/status', async (req, res) => {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'status is required.' });

    try {
        const db = await getDb();
        db.run(`UPDATE pickups SET status = ? WHERE id = ?`, [status, req.params.id]);
        persist();

        const stmt = db.prepare(`SELECT * FROM pickups WHERE id = ?`);
        stmt.bind([req.params.id]);
        if (!stmt.step()) { stmt.free(); return res.status(404).json({ error: 'Pickup not found.' }); }
        const pickup = stmt.getAsObject();
        stmt.free();
        return res.json({ message: 'Status updated.', pickup });
    } catch (err) {
        return res.status(500).json({ error: 'Database error.', details: err.message });
    }
});

// ─────────────────────────────────────────────
// PATCH /api/pickups/:id/reschedule
// ─────────────────────────────────────────────
router.patch('/:id/reschedule', async (req, res) => {
    const { time_slot } = req.body;
    if (!time_slot) return res.status(400).json({ error: 'time_slot is required.' });

    try {
        const db = await getDb();
        db.run(`UPDATE pickups SET time_slot = ? WHERE id = ? OR request_id = ?`, [time_slot, req.params.id, req.params.id]);
        persist();

        const stmt = db.prepare(`SELECT * FROM pickups WHERE id = ? OR request_id = ?`);
        stmt.bind([req.params.id, req.params.id]);
        if (!stmt.step()) { stmt.free(); return res.status(404).json({ error: 'Pickup not found.' }); }
        const pickup = stmt.getAsObject();
        stmt.free();
        return res.json({ message: 'Pickup rescheduled.', pickup });
    } catch (err) {
        return res.status(500).json({ error: 'Database error.', details: err.message });
    }
});

// ─────────────────────────────────────────────
// DELETE /api/pickups/:id
// ─────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
    try {
        const db = await getDb();
        db.run(`DELETE FROM pickups WHERE id = ? OR request_id = ?`, [req.params.id, req.params.id]);
        persist();
        return res.json({ message: `Pickup ${req.params.id} cancelled.` });
    } catch (err) {
        return res.status(500).json({ error: 'Database error.', details: err.message });
    }
});

// ─────────────────────────────────────────────
// GET /api/pickups/:id/status
// ─────────────────────────────────────────────
router.get('/:id/status', async (req, res) => {
    try {
        const db = await getDb();
        const stmt = db.prepare('SELECT id, request_id, status, pin, actual_weight, payout_amount, completed_at FROM pickups WHERE id = ? OR request_id = ?');
        stmt.bind([req.params.id, req.params.id]);
        if (!stmt.step()) {
            stmt.free();
            return res.status(404).json({ error: 'Pickup not found.' });
        }
        const pickup = stmt.getAsObject();
        stmt.free();
        return res.json({ pickup });
    } catch (err) {
        return res.status(500).json({ error: 'Database error.', details: err.message });
    }
});

// ─────────────────────────────────────────────
// PATCH /api/pickups/:id/complete
// ─────────────────────────────────────────────
router.patch('/:id/complete', async (req, res) => {
    const { weight, collector_phone } = req.body;
    try {
        const db = await getDb();
        const pStmt = db.prepare('SELECT p.*, u.phone as customer_phone, u.name as customer_name FROM pickups p LEFT JOIN users u ON p.user_id = u.id WHERE p.id = ? OR p.request_id = ?');
        pStmt.bind([req.params.id, req.params.id]);
        if (!pStmt.step()) {
            pStmt.free();
            return res.status(404).json({ error: 'Pickup not found.' });
        }
        const pickup = pStmt.getAsObject();
        pStmt.free();

        const measuredWeight = parseFloat(weight) || 10;
        const isWetOnly = pickup.items.toLowerCase().includes('biodegradable') && !pickup.items.toLowerCase().includes('dry');
        const payout = isWetOnly ? 0 : Math.round(measuredWeight * 10);
        const ptsEarned = 50;

        db.run(`
            UPDATE pickups 
            SET status = 'Completed', 
                actual_weight = ?, 
                payout_amount = ?, 
                collector_phone = ?, 
                completed_at = datetime('now', 'localtime')
            WHERE id = ?
        `, [measuredWeight, payout, collector_phone || 'WhatsApp Collector', pickup.id]);

        db.run(`UPDATE users SET points = COALESCE(points, 0) + ? WHERE id = ?`, [ptsEarned, pickup.user_id]);
        persist();

        return res.json({ message: 'Pickup completed.', weight: measuredWeight, payout, points_earned: ptsEarned });
    } catch (err) {
        return res.status(500).json({ error: 'Database error.', details: err.message });
    }
});

module.exports = router;
