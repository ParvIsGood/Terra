const express  = require('express');
const bcrypt   = require('bcryptjs');
const router   = express.Router();
const { getDb, persist } = require('../database');

const pincodeLookup = require('india-pincode-lookup');

function toTitleCase(str) {
    if (!str) return '';
    return str.toLowerCase().replace(/(?:^|\s|-|\/)\S/g, c => c.toUpperCase());
}

function isValidIndianPincode(pin) {
    if (!pin) return false;
    return /^[1-9][0-9]{5}$/.test(String(pin).trim());
}

function lookupIndianPincode(pin) {
    const cleanPin = String(pin || '').trim();
    if (!/^[1-9][0-9]{5}$/.test(cleanPin)) {
        return { valid: false, error: 'Indian PIN codes must be exactly 6 digits and cannot start with 0.' };
    }

    try {
        const results = pincodeLookup.lookup(cleanPin);
        if (results && results.length > 0) {
            const first = results[0];
            const district = toTitleCase(first.districtName || first.taluk || '');
            const state = toTitleCase(first.stateName || '');
            const office = toTitleCase(first.officeName || '');

            return {
                valid: true,
                pincode: cleanPin,
                city: district || office,
                state: state,
                office: office
            };
        }
    } catch (e) {
        console.error('Pincode lookup error:', e);
    }

    return { valid: false, error: 'Invalid PIN: Not found in official Indian postal registry.' };
}

// ─────────────────────────────────────────────
// GET /api/users/pincode-lookup/:pin
// ─────────────────────────────────────────────
router.get('/pincode-lookup/:pin', (req, res) => {
    const result = lookupIndianPincode(req.params.pin);
    if (!result.valid) {
        return res.status(404).json(result);
    }
    return res.json(result);
});

// ─────────────────────────────────────────────
// GET /api/users/:id
// ─────────────────────────────────────────────
router.get('/:id', async (req, res) => {
    try {
        const db = await getDb();
        const stmt = db.prepare('SELECT id, name, email, role, address, pincode, city, state, dob, hh_code, phone, bio, saved_materials, points, wallet_balance FROM users WHERE id = ?');
        stmt.bind([req.params.id]);
        if (!stmt.step()) {
            stmt.free();
            return res.status(404).json({ error: 'User not found.' });
        }
        const user = stmt.getAsObject();
        stmt.free();

        // Ensure user has a valid, shareable Household Code
        if (!user.hh_code || user.hh_code.trim() === '' || user.hh_code === '—') {
            const genCode = `HH-${Math.floor(1000 + Math.random() * 9000)}`;
            db.run('UPDATE users SET hh_code = ? WHERE id = ?', [genCode, user.id]);
            persist();
            user.hh_code = genCode;
        }

        return res.json({ user });
    } catch (err) {
        return res.status(500).json({ error: 'Database error.', details: err.message });
    }
});

function calculateAge(dobStr) {
    if (!dobStr) return 0;
    const birthDate = new Date(dobStr);
    if (isNaN(birthDate.getTime())) return 0;
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const m = today.getMonth() - birthDate.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
        age--;
    }
    return age;
}

// ─────────────────────────────────────────────
// POST /api/users/register
// Body: { name, email, password, dob, address, pincode, role, hh_code? }
// ─────────────────────────────────────────────
router.post('/register', async (req, res) => {
    const { name, phone, dob, address, pincode, city, state, role, hh_code } = req.body;

    if (!name || !phone || !dob || !address || !pincode || !role) {
        return res.status(400).json({ error: 'All fields are required.' });
    }

    if (calculateAge(dob) < 13) {
        return res.status(400).json({ error: 'You must be at least 13 years old to register on Circular.' });
    }

    if (!isValidIndianPincode(pincode)) {
        return res.status(400).json({ error: 'Please enter a valid 6-digit Indian PIN code (cannot start with 0 or contain letters).' });
    }

    const pinCheck = await lookupIndianPincode(pincode);
    if (!pinCheck.valid) {
        return res.status(400).json({ error: pinCheck.error || 'Invalid Indian PIN code (Not found in postal directory).' });
    }

    const resolvedCity = city ? city.trim() : (pinCheck.city || null);
    const resolvedState = state ? state.trim() : (pinCheck.state || null);

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
        const finalHhCode = (hh_code && hh_code.trim()) ? hh_code.trim().toUpperCase() : `HH-${Math.floor(1000 + Math.random() * 9000)}`;

        db.run(
            `INSERT INTO users (name, email, password_hash, dob, address, pincode, city, state, role, hh_code, phone)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [name.trim(), generatedEmail, defaultPasswordHash, dob, address.trim(), pincode.trim(), resolvedCity, resolvedState, role, finalHhCode, cleanPhone]
        );
        persist();

        // Fetch the newly created user (without password)
        const stmt = db.prepare(`SELECT id, name, email, dob, address, pincode, city, state, role, hh_code, phone, created_at FROM users ORDER BY id DESC LIMIT 1`);
        stmt.step();
        const user = stmt.getAsObject();
        stmt.free();

        // Seed default Primary address
        try {
            db.run(
                `INSERT INTO addresses (user_id, label, address, pincode, city, state, is_primary) VALUES (?, 'Primary', ?, ?, ?, ?, 1)`,
                [user.id, address.trim(), pincode.trim(), resolvedCity, resolvedState]
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
    const { address, pincode, city, state } = req.body;
    if (!address || !pincode) {
        return res.status(400).json({ error: 'Address and pincode are required.' });
    }
    if (!isValidIndianPincode(pincode)) {
        return res.status(400).json({ error: 'Please enter a valid 6-digit Indian PIN code.' });
    }

    try {
        const db = await getDb();
        db.run(
            `UPDATE users SET address = ?, pincode = ?, city = COALESCE(?, city), state = COALESCE(?, state) WHERE id = ?`,
            [address.trim(), pincode.trim(), city ? city.trim() : null, state ? state.trim() : null, req.params.id]
        );
        persist();

        const stmt = db.prepare(`SELECT id, name, email, dob, address, pincode, city, state, role, hh_code, phone FROM users WHERE id = ?`);
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
// POST /api/users/:id/join-household
// Links user to another household via hh_code
// ─────────────────────────────────────────────
router.post('/:id/join-household', async (req, res) => {
    try {
        const { hh_code } = req.body;
        const targetUserId = parseInt(req.params.id, 10);
        if (!hh_code || !hh_code.trim()) {
            return res.status(400).json({ error: 'Please enter a valid Household Code.' });
        }

        const cleanCode = hh_code.trim().toUpperCase();
        const db = await getDb();

        // Check if household exists (any user currently holding this hh_code)
        const checkStmt = db.prepare('SELECT id, name, address, pincode, city, state, hh_code FROM users WHERE UPPER(hh_code) = ? AND id != ? LIMIT 1');
        checkStmt.bind([cleanCode, targetUserId]);
        let primaryUser = null;
        if (checkStmt.step()) {
            primaryUser = checkStmt.getAsObject();
        }
        checkStmt.free();

        if (!primaryUser) {
            return res.status(404).json({ 
                error: `Household code "${cleanCode}" was not found. Please verify the code with your family member or flatmate.` 
            });
        }

        // Link this user to the household and sync address & pincode
        db.run(`
            UPDATE users 
            SET hh_code = ?,
                address = COALESCE(NULLIF(address, ''), ?),
                pincode = COALESCE(NULLIF(pincode, ''), ?),
                city = COALESCE(NULLIF(city, ''), ?),
                state = COALESCE(NULLIF(state, ''), ?)
            WHERE id = ?
        `, [cleanCode, primaryUser.address, primaryUser.pincode, primaryUser.city, primaryUser.state, targetUserId]);

        persist();

        // Fetch updated user
        const stmt = db.prepare('SELECT id, name, email, role, address, pincode, city, state, dob, hh_code, phone, bio, saved_materials, points, wallet_balance FROM users WHERE id = ?');
        stmt.bind([targetUserId]);
        let updatedUser = null;
        if (stmt.step()) updatedUser = stmt.getAsObject();
        stmt.free();

        return res.json({
            success: true,
            message: `Successfully linked to ${primaryUser.name}'s household (${cleanCode})!`,
            user: updatedUser,
            householdOwner: primaryUser.name
        });
    } catch (err) {
        console.error('Join household error:', err);
        return res.status(500).json({ error: 'Failed to join household.', details: err.message });
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
// Body: { label, address, pincode, city, state, is_primary }
// ─────────────────────────────────────────────
router.post('/:id/addresses', async (req, res) => {
    const { label, address, pincode, city, state, is_primary } = req.body;
    if (!address) {
        return res.status(400).json({ error: 'Address is required.' });
    }
    if (pincode && !isValidIndianPincode(pincode)) {
        return res.status(400).json({ error: 'Please enter a valid 6-digit Indian PIN code.' });
    }

    try {
        const db = await getDb();
        const primaryFlag = is_primary ? 1 : 0;
        if (primaryFlag === 1) {
            db.run(`UPDATE addresses SET is_primary = 0 WHERE user_id = ?`, [req.params.id]);
            db.run(
                `UPDATE users SET address = ?, pincode = ?, city = COALESCE(?, city), state = COALESCE(?, state) WHERE id = ?`,
                [address.trim(), (pincode || '').trim(), city ? city.trim() : null, state ? state.trim() : null, req.params.id]
            );
        }

        db.run(
            `INSERT INTO addresses (user_id, label, address, pincode, city, state, is_primary) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [req.params.id, (label || 'Other').trim(), address.trim(), (pincode || '').trim(), city ? city.trim() : null, state ? state.trim() : null, primaryFlag]
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
// Body: { label, address, pincode, city, state, is_primary }
// ─────────────────────────────────────────────
router.put('/:id/addresses/:addressId', async (req, res) => {
    const { label, address, pincode, city, state, is_primary } = req.body;
    if (pincode && !isValidIndianPincode(pincode)) {
        return res.status(400).json({ error: 'Please enter a valid 6-digit Indian PIN code.' });
    }
    try {
        const db = await getDb();
        const primaryFlag = is_primary ? 1 : 0;
        if (primaryFlag === 1) {
            db.run(`UPDATE addresses SET is_primary = 0 WHERE user_id = ?`, [req.params.id]);
            if (address) {
                db.run(
                    `UPDATE users SET address = ?, pincode = ?, city = COALESCE(?, city), state = COALESCE(?, state) WHERE id = ?`,
                    [address.trim(), (pincode || '').trim(), city ? city.trim() : null, state ? state.trim() : null, req.params.id]
                );
            }
        }

        db.run(
            `UPDATE addresses SET label = COALESCE(?, label), address = COALESCE(?, address), pincode = COALESCE(?, pincode), city = COALESCE(?, city), state = COALESCE(?, state), is_primary = ? WHERE id = ? AND user_id = ?`,
            [label ? label.trim() : null, address ? address.trim() : null, pincode ? pincode.trim() : null, city ? city.trim() : null, state ? state.trim() : null, primaryFlag, req.params.addressId, req.params.id]
        );
        persist();

        return res.json({ message: 'Address updated.' });
    } catch (err) {
        return res.status(500).json({ error: 'Database error.', details: err.message });
    }
});

// ─────────────────────────────────────────────
// PATCH /api/users/:id/profile
// Body: { name, dob, pincode, city, state }
// ─────────────────────────────────────────────
router.patch('/:id/profile', async (req, res) => {
    const { name, dob, pincode, city, state, bio, saved_materials } = req.body;
    if (dob && calculateAge(dob) < 13) {
        return res.status(400).json({ error: 'You must be at least 13 years old.' });
    }
    if (pincode && !isValidIndianPincode(pincode)) {
        return res.status(400).json({ error: 'Please enter a valid 6-digit Indian PIN code.' });
    }
    try {
        const db = await getDb();
        db.run(
            `UPDATE users SET name = COALESCE(?, name), dob = COALESCE(?, dob), pincode = COALESCE(?, pincode), city = COALESCE(?, city), state = COALESCE(?, state), bio = COALESCE(?, bio), saved_materials = COALESCE(?, saved_materials) WHERE id = ?`,
            [name ? name.trim() : null, dob ? dob.trim() : null, pincode ? pincode.trim() : null, city ? city.trim() : null, state ? state.trim() : null, bio ? bio.trim() : null, saved_materials ? saved_materials.trim() : null, req.params.id]
        );
        persist();

        const stmt = db.prepare(`SELECT id, name, email, dob, address, pincode, city, state, role, hh_code, phone FROM users WHERE id = ?`);
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
