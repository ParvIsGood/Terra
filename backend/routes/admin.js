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

// ─────────────────────────────────────────────
// GET /api/admin/volunteers — all biodegradable volunteer drop-off hubs
// ─────────────────────────────────────────────
router.get('/volunteers', requireAdmin, async (req, res) => {
    try {
        const db = await getDb();
        const stmt = db.prepare(`
            SELECT id, name, email, phone, address, pincode, city, state, role, hh_code, 
                   COALESCE(volunteer_status, 'Active') as status,
                   COALESCE(is_verified, 1) as is_verified,
                   points, created_at
            FROM users 
            WHERE role = 'Recycler'
            ORDER BY id DESC
        `);
        const volunteers = [];
        while (stmt.step()) {
            volunteers.push(stmt.getAsObject());
        }
        stmt.free();

        // Get organic wet waste silo stats from hub_bins
        const binStmt = db.prepare(`SELECT current_kg, capacity FROM hub_bins WHERE material LIKE '%Organic%' LIMIT 1`);
        let organicStock = 427;
        if (binStmt.step()) {
            organicStock = binStmt.getAsObject().current_kg || 427;
        }
        binStmt.free();

        return res.json({ 
            count: volunteers.length, 
            volunteers,
            organic_silo_kg: organicStock
        });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────
// POST /api/admin/volunteers — register new drop-off station
// ─────────────────────────────────────────────
router.post('/volunteers', requireAdmin, async (req, res) => {
    try {
        const { name, phone, address, pincode, city, state, volunteer_status } = req.body;
        if (!name || !phone || !address || !pincode) {
            return res.status(400).json({ error: 'Name, phone, address and pincode are required.' });
        }
        const db = await getDb();
        const { persist } = require('../database');
        const cleanPhone = String(phone).replace(/\D/g, '');
        const generatedEmail = `${cleanPhone}@volunteer.terra`;
        const genCode = `HH-${Math.floor(1000 + Math.random() * 9000)}`;

        db.run(`
            INSERT INTO users (name, email, password_hash, dob, address, pincode, city, state, role, hh_code, original_hh_code, active_hh_type, phone, volunteer_status, is_verified)
            VALUES (?, ?, 'VOLUNTEER_STATION', '2000-01-01', ?, ?, ?, ?, 'Recycler', ?, ?, 'personal', ?, ?, 1)
        `, [name.trim(), generatedEmail, address.trim(), String(pincode).trim(), (city || 'Local Area').trim(), (state || 'Punjab').trim(), genCode, genCode, cleanPhone, volunteer_status || 'Active']);
        persist();

        return res.status(201).json({ success: true, message: `Volunteer drop-off point "${name}" registered successfully.` });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────
// PATCH /api/admin/volunteers/:id — update status or details
// ─────────────────────────────────────────────
router.patch('/volunteers/:id', requireAdmin, async (req, res) => {
    try {
        const { name, address, pincode, city, state, volunteer_status, is_verified, phone } = req.body;
        const db = await getDb();
        const { persist } = require('../database');

        db.run(`
            UPDATE users 
            SET name = COALESCE(?, name),
                phone = COALESCE(?, phone),
                address = COALESCE(?, address),
                pincode = COALESCE(?, pincode),
                city = COALESCE(?, city),
                state = COALESCE(?, state),
                volunteer_status = COALESCE(?, volunteer_status),
                is_verified = COALESCE(?, is_verified)
            WHERE id = ? AND role = 'Recycler'
        `, [
            name ? name.trim() : null,
            phone ? String(phone).trim() : null,
            address ? address.trim() : null,
            pincode ? String(pincode).trim() : null,
            city ? city.trim() : null,
            state ? state.trim() : null,
            volunteer_status ? volunteer_status.trim() : null,
            is_verified !== undefined ? (is_verified ? 1 : 0) : null,
            req.params.id
        ]);
        persist();

        return res.json({ success: true, message: `Volunteer station #${req.params.id} updated.` });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────
// DELETE /api/admin/volunteers/:id — delete volunteer station
// ─────────────────────────────────────────────
router.delete('/volunteers/:id', requireAdmin, async (req, res) => {
    try {
        const db = await getDb();
        const { persist } = require('../database');
        db.run(`DELETE FROM users WHERE id = ? AND role = 'Recycler'`, [req.params.id]);
        persist();
        return res.json({ success: true, message: `Volunteer station #${req.params.id} removed.` });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

module.exports = router;
