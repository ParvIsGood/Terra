const express = require('express');
const router  = express.Router();
const { getDb, persist } = require('../database');

// ─────────────────────────────────────────────────────────────
// GET /api/hub/summary — Hub KPI metrics
// ─────────────────────────────────────────────────────────────
router.get('/summary', async (req, res) => {
    try {
        const db = await getDb();

        // 1. Total storage kg & capacities
        const binStmt = db.prepare(`SELECT SUM(current_kg) as total_stock, SUM(capacity) as total_capacity FROM hub_bins`);
        binStmt.step();
        const binRes = binStmt.getAsObject();
        binStmt.free();

        // 2. Today's drop-offs & weight
        const tripStmt = db.prepare(`
            SELECT count(*) as today_count, COALESCE(SUM(hub_weight), 0) as today_kg
            FROM hub_trips 
            WHERE date(created_at) = date('now', 'localtime')
        `);
        tripStmt.step();
        const tripRes = tripStmt.getAsObject();
        tripStmt.free();

        // 3. Planned dispatches count
        const dStmt = db.prepare(`SELECT count(*) as planned_count FROM hub_dispatches WHERE status = 'Planned'`);
        dStmt.step();
        const dRes = dStmt.getAsObject();
        dStmt.free();

        // 4. Weight gaps (flagged trips)
        const gStmt = db.prepare(`SELECT count(*) as gap_count FROM hub_trips WHERE is_flagged = 1 AND is_approved = 0`);
        gStmt.step();
        const gRes = gStmt.getAsObject();
        gStmt.free();

        return res.json({
            today_dropoffs: tripRes.today_count || 0,
            today_kg: Math.round((tripRes.today_kg || 0) * 10) / 10,
            storage_stock_kg: Math.round((binRes.total_stock || 0) * 10) / 10,
            storage_capacity_kg: Math.round((binRes.total_capacity || 0) * 10) / 10,
            planned_dispatches: dRes.planned_count || 0,
            weight_gaps: gRes.gap_count || 0
        });
    } catch (err) {
        console.error('Hub summary error:', err);
        return res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
// GET /api/hub/bins — All storage silos
// ─────────────────────────────────────────────────────────────
router.get('/bins', async (req, res) => {
    try {
        const db = await getDb();
        const stmt = db.prepare(`SELECT * FROM hub_bins ORDER BY id ASC`);
        const bins = [];
        while (stmt.step()) {
            const b = stmt.getAsObject();
            b.fill_pct = Math.min(100, Math.round((b.current_kg / b.capacity) * 100));
            bins.push(b);
        }
        stmt.free();
        return res.json({ bins });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
// GET /api/hub/collector/:query — Look up collector & their trip collections
// ─────────────────────────────────────────────────────────────
router.get('/collector/:query', async (req, res) => {
    try {
        const q = String(req.params.query).trim();
        const cleanDg = q.replace(/\D/g, '');
        const db = await getDb();

        const cStmt = db.prepare(`
            SELECT * FROM collectors 
            WHERE employee_id = ? 
               OR employee_id = ?
               OR id = ?
               OR phone_number LIKE ?
               OR REPLACE(phone_number, '+', '') = ?
        `);
        cStmt.bind([
            q.toUpperCase(), 
            `KW-${q}`, 
            parseInt(q, 10) || -1, 
            `%${cleanDg}%`, 
            cleanDg
        ]);

        if (!cStmt.step()) {
            cStmt.free();
            return res.status(404).json({ error: 'No Kabadiwala found with that ID or Phone.' });
        }
        const collector = cStmt.getAsObject();
        cStmt.free();

        // Fetch completed pickups for this collector that have measured weights (Weight 1 - Doorstep declared)
        const pStmt = db.prepare(`
            SELECT p.*, u.name as customer_name, u.address as customer_address, u.city as customer_city, u.pincode as customer_pincode
            FROM pickups p
            JOIN users u ON p.user_id = u.id
            WHERE p.collector_id = ?
            ORDER BY p.id DESC
            LIMIT 10
        `);
        pStmt.bind([collector.id]);
        const pickups = [];
        let declaredTotal = 0;

        while (pStmt.step()) {
            const pu = pStmt.getAsObject();
            const w = parseFloat(pu.actual_weight) || 0;
            declaredTotal += w;

            // Parse materials if stored as breakdown
            let matBreakdown = {};
            if (pu.material_weights) {
                // e.g. "Cardboard: 10 kg, Paper: 5 kg, Metals: 15 kg"
                pu.material_weights.split(',').forEach(part => {
                    const [m, val] = part.split(':');
                    if (m && val) {
                        matBreakdown[m.trim()] = parseFloat(val) || 0;
                    }
                });
            } else if (w > 0) {
                matBreakdown['Recyclables (Total)'] = w;
            }

            pu.materials_breakdown = matBreakdown;
            pickups.push(pu);
        }
        pStmt.free();

        return res.json({
            collector,
            pickups,
            declared_total: Math.round(declaredTotal * 10) / 10
        });
    } catch (err) {
        console.error('Hub collector lookup error:', err);
        return res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
// POST /api/hub/dropoff — Record and store a physical drop-off
// ─────────────────────────────────────────────────────────────
router.post('/dropoff', async (req, res) => {
    try {
        const {
            collector_id,
            collector_name,
            collector_phone,
            declared_weight,
            hub_weight,
            is_segregated,
            materials, // e.g. { "Paper": 12, "Cardboard": 25, "Plastic": 8 }
            address_count
        } = req.body;

        const declW = parseFloat(declared_weight) || 0;
        const hubW  = parseFloat(hub_weight) || 0;
        if (hubW <= 0) {
            return res.status(400).json({ error: 'Valid measured hub weight required.' });
        }

        const gapPct = declW > 0 ? (Math.abs(declW - hubW) / declW) * 100 : 0;
        const isFlagged = gapPct > 10 ? 1 : 0;

        // Payout formula: Base ₹150 + ₹10 per address + ₹50 segregated bonus
        const nAddresses = parseInt(address_count, 10) || 1;
        const payout = 150 + (10 * nAddresses) + (is_segregated ? 50 : 0);

        const tripId = `T-${1000 + Math.floor(Math.random() * 9000)}`;
        const db = await getDb();

        // Insert into hub_trips
        const stmt = db.prepare(`
            INSERT INTO hub_trips (
                id, collector_id, collector_name, collector_phone,
                declared_weight, hub_weight, gap_pct, is_flagged,
                is_segregated, payout_amount, is_approved, details_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, datetime('now', 'localtime'))
        `);
        stmt.run([
            tripId,
            collector_id || null,
            collector_name || 'Partner',
            collector_phone || '',
            Math.round(declW * 10) / 10,
            Math.round(hubW * 10) / 10,
            Math.round(gapPct * 10) / 10,
            isFlagged,
            is_segregated ? 1 : 0,
            payout,
            JSON.stringify(materials || {})
        ]);
        stmt.free();

        // Increment hub_bins storage for each material
        if (materials && typeof materials === 'object') {
            for (const [mat, kg] of Object.entries(materials)) {
                const addKg = parseFloat(kg) || 0;
                if (addKg > 0) {
                    db.run(`
                        UPDATE hub_bins 
                        SET current_kg = current_kg + ? 
                        WHERE material = ? OR material LIKE ?
                    `, [addKg, mat, `%${mat}%`]);
                }
            }
        }

        persist();

        return res.json({
            success: true,
            trip_id: tripId,
            payout,
            gap_pct: Math.round(gapPct * 10) / 10,
            is_flagged: isFlagged,
            hub_weight: Math.round(hubW * 10) / 10,
            declared_weight: Math.round(declW * 10) / 10
        });
    } catch (err) {
        console.error('Dropoff record error:', err);
        return res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
// GET /api/hub/trips — All drop-off audit records
// ─────────────────────────────────────────────────────────────
router.get('/trips', async (req, res) => {
    try {
        const db = await getDb();
        const stmt = db.prepare(`SELECT * FROM hub_trips ORDER BY rowid DESC LIMIT 50`);
        const trips = [];
        while (stmt.step()) {
            const t = stmt.getAsObject();
            try { t.details = JSON.parse(t.details_json || '{}'); } catch(e) { t.details = {}; }
            trips.push(t);
        }
        stmt.free();
        return res.json({ trips });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/hub/trips/:id/approve — Approve trip payout
// ─────────────────────────────────────────────────────────────
router.patch('/trips/:id/approve', async (req, res) => {
    try {
        const db = await getDb();
        db.run(`UPDATE hub_trips SET is_approved = 1 WHERE id = ?`, [req.params.id]);
        persist();
        return res.json({ success: true, message: `Trip ${req.params.id} payout approved.` });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
// GET /api/hub/dispatches — Batched lots to recycling plants
// ─────────────────────────────────────────────────────────────
router.get('/dispatches', async (req, res) => {
    try {
        const db = await getDb();
        const stmt = db.prepare(`SELECT * FROM hub_dispatches ORDER BY rowid DESC`);
        const dispatches = [];
        while (stmt.step()) dispatches.push(stmt.getAsObject());
        stmt.free();
        return res.json({ dispatches });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
// POST /api/hub/dispatches — Create new dispatch lot
// ─────────────────────────────────────────────────────────────
router.post('/dispatches', async (req, res) => {
    try {
        const { material, weight_kg } = req.body;
        const w = parseFloat(weight_kg) || 0;
        if (!material || w <= 0) {
            return res.status(400).json({ error: 'Material and valid weight required.' });
        }

        const db = await getDb();
        // Look up unit from hub_bins
        const bStmt = db.prepare(`SELECT recycling_unit FROM hub_bins WHERE material = ?`);
        bStmt.bind([material]);
        let unit = 'Certified Recycler';
        if (bStmt.step()) unit = bStmt.getAsObject().recycling_unit;
        bStmt.free();

        const dispatchId = `D-${100 + Math.floor(Math.random() * 900)}`;
        db.run(`
            INSERT INTO hub_dispatches (id, material, weight_kg, recycling_unit, status)
            VALUES (?, ?, ?, ?, 'Planned')
        `, [dispatchId, material, w, unit]);

        // Subtract from hub_bins current_kg
        db.run(`
            UPDATE hub_bins 
            SET current_kg = MAX(0, current_kg - ?) 
            WHERE material = ?
        `, [w, material]);

        persist();

        return res.json({ success: true, dispatch_id: dispatchId, recycling_unit: unit });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/hub/dispatches/:id/status
// ─────────────────────────────────────────────────────────────
router.patch('/dispatches/:id/status', async (req, res) => {
    try {
        const { status } = req.body;
        const db = await getDb();
        db.run(`UPDATE hub_dispatches SET status = ? WHERE id = ?`, [status || 'In transit', req.params.id]);
        persist();
        return res.json({ success: true, message: `Dispatch ${req.params.id} marked as ${status}.` });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
// GET /api/hub/employees
// ─────────────────────────────────────────────────────────────
router.get('/employees', async (req, res) => {
    try {
        const db = await getDb();
        const stmt = db.prepare(`SELECT * FROM hub_employees ORDER BY id ASC`);
        const employees = [];
        while (stmt.step()) employees.push(stmt.getAsObject());
        stmt.free();
        return res.json({ employees });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
// POST /api/hub/employees
// ─────────────────────────────────────────────────────────────
router.post('/employees', async (req, res) => {
    try {
        const { name, role } = req.body;
        if (!name) return res.status(400).json({ error: 'Name is required.' });

        const db = await getDb();
        const empId = `E-${200 + Math.floor(Math.random() * 800)}`;
        db.run(`INSERT INTO hub_employees (id, name, role, status) VALUES (?, ?, ?, 'Active')`, [
            empId, name.trim(), role || 'Floor staff'
        ]);
        persist();
        return res.json({ success: true, employee_id: empId });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

module.exports = router;
