const express    = require('express');
const router     = express.Router();
const { getDb }  = require('../database');
const { terminateUserSessions } = require('../sessionManager');

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
            SELECT id, name, email, phone, dob, address, pincode, city, state, role, hh_code, points, wallet_balance, created_at
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
// GET /api/admin/users/:id  — full user details, wallet & activity
// ─────────────────────────────────────────────
router.get('/users/:id', requireAdmin, async (req, res) => {
    try {
        const userId = parseInt(req.params.id, 10);
        if (!userId) return res.status(400).json({ error: 'Valid user ID required.' });

        const db = await getDb();

        // 1. Fetch user profile
        const uStmt = db.prepare(`
            SELECT id, name, email, phone, dob, address, pincode, city, state, role, hh_code, bio, saved_materials, points, wallet_balance, created_at
            FROM users WHERE id = ?
        `);
        uStmt.bind([userId]);
        if (!uStmt.step()) {
            uStmt.free();
            return res.status(404).json({ error: 'User not found.' });
        }
        const user = uStmt.getAsObject();
        uStmt.free();

        // 2. Fetch all pickups for this user
        const pStmt = db.prepare(`
            SELECT p.*, c.name as collector_name, c.phone_number as collector_phone, c.employee_id as collector_employee_id
            FROM pickups p
            LEFT JOIN collectors c ON p.collector_id = c.id
            WHERE p.user_id = ?
            ORDER BY p.id DESC
        `);
        pStmt.bind([userId]);
        const pickups = [];
        while (pStmt.step()) pickups.push(pStmt.getAsObject());
        pStmt.free();

        // 3. Fetch all wallet transactions
        const tStmt = db.prepare(`
            SELECT * FROM transactions
            WHERE user_id = ?
            ORDER BY id DESC
        `);
        tStmt.bind([userId]);
        const transactions = [];
        while (tStmt.step()) transactions.push(tStmt.getAsObject());
        tStmt.free();

        // 4. Compute financial & environmental summary
        let totalEarned = 0;
        let totalWithdrawn = 0;
        transactions.forEach(t => {
            if (t.direction === 'credit' && t.status === 'Completed') {
                totalEarned += (t.amount || 0);
            } else if (t.direction === 'debit' && t.status === 'Completed') {
                totalWithdrawn += (t.amount || 0);
            }
        });

        const completedPickups = pickups.filter(p => (p.status || '').toLowerCase() === 'completed');
        const totalWeightCollected = completedPickups.reduce((sum, p) => sum + (parseFloat(p.actual_weight) || 0), 0);

        return res.json({
            success: true,
            user,
            pickups,
            transactions,
            summary: {
                wallet_balance: Math.round((user.wallet_balance || 0) * 100) / 100,
                points: user.points || 0,
                total_earned: Math.round(totalEarned * 100) / 100,
                total_withdrawn: Math.round(totalWithdrawn * 100) / 100,
                total_pickups: pickups.length,
                completed_pickups: completedPickups.length,
                total_weight_kg: Math.round(totalWeightCollected * 10) / 10
            }
        });
    } catch (err) {
        console.error('Admin user detail fetch error:', err);
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
            SELECT p.*, u.name as user_name, u.email as user_email, c.name as collector_name, c.employee_id as collector_employee_id
            FROM pickups p
            LEFT JOIN users u ON p.user_id = u.id
            LEFT JOIN collectors c ON p.collector_id = c.id
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

        // Instantly force logout any active browser sessions on the website
        terminateUserSessions(req.params.id, 'Your account has been deleted by an administrator.');

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
