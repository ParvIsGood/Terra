const express  = require('express');
const bcrypt   = require('bcryptjs');
const router   = express.Router();
const { getDb, persist } = require('../database');

// ─────────────────────────────────────────────
// POST /api/users/register
// Body: { name, email, password, dob, address, pincode, role, hh_code? }
// ─────────────────────────────────────────────
router.post('/register', async (req, res) => {
    const { name, phone, dob, address, pincode, role, hh_code } = req.body;

    if (!name || !phone || !dob || !address || !pincode || !role) {
        return res.status(400).json({ error: 'All fields are required.' });
    }

    const validRoles = ['Household', 'Business', 'Recycler'];
    if (!validRoles.includes(role)) {
        return res.status(400).json({ error: 'Invalid role.' });
    }

    // Normalize phone
    let cleanPhone = String(phone).replace(/\D/g, '');
    if (cleanPhone.length === 10) cleanPhone = '91' + cleanPhone;
    if (cleanPhone.length < 10) {
        return res.status(400).json({ error: 'Please enter a valid 10-digit WhatsApp number.' });
    }

    const last10 = cleanPhone.slice(-10);

    try {
        const db = await getDb();

        // Check if phone already exists
        const checkStmt = db.prepare(`SELECT id FROM users WHERE phone LIKE ?`);
        checkStmt.bind([`%${last10}`]);
        const exists = checkStmt.step();
        checkStmt.free();

        if (exists) {
            return res.status(409).json({ error: 'An account with this WhatsApp number already exists. Please log in.' });
        }

        const generatedEmail = `${cleanPhone}@whatsapp.terra`;
        const defaultPasswordHash = 'WHATSAPP_OTP_AUTH';

        db.run(
            `INSERT INTO users (name, email, password_hash, dob, address, pincode, role, hh_code, phone)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [name.trim(), generatedEmail, defaultPasswordHash, dob, address.trim(), pincode.trim(), role, hh_code || null, cleanPhone]
        );
        persist();

        // Fetch the newly created user (without password)
        const stmt = db.prepare(`SELECT id, name, email, dob, address, pincode, role, hh_code, phone, created_at FROM users ORDER BY id DESC LIMIT 1`);
        stmt.step();
        const user = stmt.getAsObject();
        stmt.free();

        // Seed default Primary address
        try {
            db.run(
                `INSERT INTO addresses (user_id, label, address, pincode, is_primary) VALUES (?, 'Primary', ?, ?, 1)`,
                [user.id, address.trim(), pincode.trim()]
            );
            persist();
        } catch (e) {}

        return res.status(201).json({ message: 'Registered successfully.', user });
    } catch (err) {
        return res.status(500).json({ error: 'Database error.', details: err.message });
    }
});

// ─────────────────────────────────────────────
// POST /api/users/login
// Body: { email, password }
// ─────────────────────────────────────────────
router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
    }

    try {
        const db   = await getDb();
        const stmt = db.prepare(`SELECT * FROM users WHERE email = ?`);
        stmt.bind([email.toLowerCase()]);

        if (!stmt.step()) {
            stmt.free();
            return res.status(401).json({ error: 'No account found with this email.' });
        }

        const row = stmt.getAsObject();
        stmt.free();

        const valid = await bcrypt.compare(password, row.password_hash);
        if (!valid) {
            return res.status(401).json({ error: 'Incorrect password.' });
        }

        // Return user without the password hash
        const { password_hash, ...user } = row;
        return res.json({ message: 'Login successful.', user });

    } catch (err) {
        return res.status(500).json({ error: 'Database error.', details: err.message });
    }
});

// ─────────────────────────────────────────────
// PATCH /api/users/:id/address
// ─────────────────────────────────────────────
router.patch('/:id/address', async (req, res) => {
    const { address, pincode } = req.body;
    if (!address || !pincode) {
        return res.status(400).json({ error: 'Address and pincode are required.' });
    }

    try {
        const db = await getDb();
        db.run(`UPDATE users SET address = ?, pincode = ? WHERE id = ?`, [address.trim(), pincode.trim(), req.params.id]);
        persist();

        const stmt = db.prepare(`SELECT id, name, email, dob, address, pincode, role, hh_code, phone FROM users WHERE id = ?`);
        stmt.bind([req.params.id]);
        if (!stmt.step()) { stmt.free(); return res.status(404).json({ error: 'User not found.' }); }
        const user = stmt.getAsObject();
        stmt.free();

        return res.json({ message: 'Address updated successfully.', user });
    } catch (err) {
        return res.status(500).json({ error: 'Database error.', details: err.message });
    }
});

// ─────────────────────────────────────────────
// PATCH /api/users/:id/hh-code
// ─────────────────────────────────────────────
router.patch('/:id/hh-code', async (req, res) => {
    const { hh_code } = req.body;
    if (!hh_code) return res.status(400).json({ error: 'hh_code is required.' });

    try {
        const db = await getDb();
        db.run(`UPDATE users SET hh_code = ? WHERE id = ?`, [hh_code, req.params.id]);
        persist();

        const stmt = db.prepare(`SELECT id, name, email, dob, address, pincode, role, hh_code, phone FROM users WHERE id = ?`);
        stmt.bind([req.params.id]);
        if (!stmt.step()) { stmt.free(); return res.status(404).json({ error: 'User not found.' }); }
        const user = stmt.getAsObject();
        stmt.free();

        return res.json({ message: 'Household code updated.', user });
    } catch (err) {
        return res.status(500).json({ error: 'Database error.', details: err.message });
    }
});

// ─────────────────────────────────────────────
// GET /api/users/:id/addresses
// ─────────────────────────────────────────────
router.get('/:id/addresses', async (req, res) => {
    try {
        const db = await getDb();
        const stmt = db.prepare(`SELECT * FROM addresses WHERE user_id = ? ORDER BY is_primary DESC, id ASC`);
        stmt.bind([req.params.id]);
        const addresses = [];
        while (stmt.step()) {
            addresses.push(stmt.getAsObject());
        }
        stmt.free();

        // If no addresses saved yet, seed from user table
        if (addresses.length === 0) {
            const uStmt = db.prepare(`SELECT address, pincode FROM users WHERE id = ?`);
            uStmt.bind([req.params.id]);
            if (uStmt.step()) {
                const u = uStmt.getAsObject();
                uStmt.free();
                if (u.address) {
                    db.run(
                        `INSERT INTO addresses (user_id, label, address, pincode, is_primary) VALUES (?, 'Primary', ?, ?, 1)`,
                        [req.params.id, u.address, u.pincode || '']
                    );
                    persist();
                    const nStmt = db.prepare(`SELECT * FROM addresses WHERE user_id = ?`);
                    nStmt.bind([req.params.id]);
                    while (nStmt.step()) addresses.push(nStmt.getAsObject());
                    nStmt.free();
                }
            } else {
                uStmt.free();
            }
        }

        return res.json({ addresses });
    } catch (err) {
        return res.status(500).json({ error: 'Database error.', details: err.message });
    }
});

// ─────────────────────────────────────────────
// POST /api/users/:id/addresses
// Body: { label, address, pincode, is_primary }
// ─────────────────────────────────────────────
router.post('/:id/addresses', async (req, res) => {
    const { label, address, pincode, is_primary } = req.body;
    if (!address) {
        return res.status(400).json({ error: 'Address is required.' });
    }

    try {
        const db = await getDb();
        const primaryFlag = is_primary ? 1 : 0;
        if (primaryFlag === 1) {
            db.run(`UPDATE addresses SET is_primary = 0 WHERE user_id = ?`, [req.params.id]);
            db.run(`UPDATE users SET address = ?, pincode = ? WHERE id = ?`, [address.trim(), (pincode || '').trim(), req.params.id]);
        }

        db.run(
            `INSERT INTO addresses (user_id, label, address, pincode, is_primary) VALUES (?, ?, ?, ?, ?)`,
            [req.params.id, (label || 'Other').trim(), address.trim(), (pincode || '').trim(), primaryFlag]
        );
        persist();

        const stmt = db.prepare(`SELECT * FROM addresses WHERE user_id = ? ORDER BY id DESC LIMIT 1`);
        stmt.step();
        const newAddress = stmt.getAsObject();
        stmt.free();

        return res.status(201).json({ message: 'Address added.', address: newAddress });
    } catch (err) {
        return res.status(500).json({ error: 'Database error.', details: err.message });
    }
});

// ─────────────────────────────────────────────
// PUT /api/users/:id/addresses/:addressId
// Body: { label, address, pincode, is_primary }
// ─────────────────────────────────────────────
router.put('/:id/addresses/:addressId', async (req, res) => {
    const { label, address, pincode, is_primary } = req.body;
    try {
        const db = await getDb();
        const primaryFlag = is_primary ? 1 : 0;
        if (primaryFlag === 1) {
            db.run(`UPDATE addresses SET is_primary = 0 WHERE user_id = ?`, [req.params.id]);
            if (address) {
                db.run(`UPDATE users SET address = ?, pincode = ? WHERE id = ?`, [address.trim(), (pincode || '').trim(), req.params.id]);
            }
        }

        db.run(
            `UPDATE addresses SET label = COALESCE(?, label), address = COALESCE(?, address), pincode = COALESCE(?, pincode), is_primary = ? WHERE id = ? AND user_id = ?`,
            [label ? label.trim() : null, address ? address.trim() : null, pincode ? pincode.trim() : null, primaryFlag, req.params.addressId, req.params.id]
        );
        persist();

        return res.json({ message: 'Address updated.' });
    } catch (err) {
        return res.status(500).json({ error: 'Database error.', details: err.message });
    }
});

// ─────────────────────────────────────────────
// PATCH /api/users/:id/profile
// Body: { name, dob, pincode }
// ─────────────────────────────────────────────
router.patch('/:id/profile', async (req, res) => {
    const { name, dob, pincode } = req.body;
    try {
        const db = await getDb();
        db.run(
            `UPDATE users SET name = COALESCE(?, name), dob = COALESCE(?, dob), pincode = COALESCE(?, pincode) WHERE id = ?`,
            [name ? name.trim() : null, dob ? dob.trim() : null, pincode ? pincode.trim() : null, req.params.id]
        );
        persist();

        const stmt = db.prepare(`SELECT id, name, email, dob, address, pincode, role, hh_code, phone FROM users WHERE id = ?`);
        stmt.bind([req.params.id]);
        stmt.step();
        const user = stmt.getAsObject();
        stmt.free();

        return res.json({ message: 'Profile updated.', user });
    } catch (err) {
        return res.status(500).json({ error: 'Database error.', details: err.message });
    }
});

module.exports = router;
