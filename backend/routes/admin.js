const express    = require('express');
const router     = express.Router();
const { getDb }  = require('../database');

// Simple admin key auth middleware
const ADMIN_KEY = 'circular-admin-2024';

function requireAdmin(req, res, next) {
    const key = req.headers['x-admin-key'] || req.query.key;
    if (key !== ADMIN_KEY) {
        return res.status(403).json({ error: 'Forbidden. Invalid admin key.' });
    }
    next();
}

// ─────────────────────────────────────────────
// GET /api/admin/users  — all users
// ─────────────────────────────────────────────
router.get('/users', requireAdmin, async (req, res) => {
    try {
        const db   = await getDb();
        const stmt = db.prepare(`
            SELECT id, name, email, dob, address, pincode, role, hh_code, created_at
            FROM users ORDER BY id DESC
        `);
        const users = [];
        while (stmt.step()) users.push(stmt.getAsObject());
        stmt.free();
        return res.json({ count: users.length, users });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────
// GET /api/admin/pickups  — all pickups with user info
// ─────────────────────────────────────────────
router.get('/pickups', requireAdmin, async (req, res) => {
    try {
        const db   = await getDb();
        const stmt = db.prepare(`
            SELECT p.*, u.name as user_name, u.email as user_email
            FROM pickups p
            LEFT JOIN users u ON p.user_id = u.id
            ORDER BY p.id DESC
        `);
        const pickups = [];
        while (stmt.step()) pickups.push(stmt.getAsObject());
        stmt.free();
        return res.json({ count: pickups.length, pickups });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────
// GET /api/admin/collectors — all WhatsApp collectors
// ─────────────────────────────────────────────
router.get('/collectors', requireAdmin, async (req, res) => {
    try {
        const db   = await getDb();
        const stmt = db.prepare(`SELECT * FROM collectors ORDER BY id DESC`);
        const collectors = [];
        while (stmt.step()) collectors.push(stmt.getAsObject());
        stmt.free();
        return res.json({ count: collectors.length, collectors });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────
// DELETE /api/admin/collectors/:id
// ─────────────────────────────────────────────
router.delete('/collectors/:id', requireAdmin, async (req, res) => {
    try {
        const db = await getDb();
        const { persist } = require('../database');
        db.run(`DELETE FROM collectors WHERE id = ?`, [req.params.id]);
        persist();
        return res.json({ message: `Collector ${req.params.id} deleted.` });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────
// DELETE /api/admin/users/:id  — delete a user
// ─────────────────────────────────────────────
router.delete('/users/:id', requireAdmin, async (req, res) => {
    try {
        const db = await getDb();
        const { persist } = require('../database');
        db.run(`DELETE FROM users WHERE id = ?`, [req.params.id]);
        db.run(`DELETE FROM pickups WHERE user_id = ?`, [req.params.id]);
        persist();
        return res.json({ message: `User ${req.params.id} and their pickups deleted.` });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────
// PATCH /api/admin/pickups/:id/status
// ─────────────────────────────────────────────
router.patch('/pickups/:id/status', requireAdmin, async (req, res) => {
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: 'status required.' });
    try {
        const db = await getDb();
        const { persist } = require('../database');
        db.run(`UPDATE pickups SET status = ? WHERE id = ?`, [status, req.params.id]);
        persist();
        return res.json({ message: `Pickup ${req.params.id} status updated to ${status}.` });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

module.exports = router;
