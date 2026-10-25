const initSqlJs = require('sql.js');
const fs        = require('fs');
const path      = require('path');

const DB_PATH = path.join(__dirname, 'circular.db');

let db;

async function getDb() {
    if (db) return db;

    const SQL = await initSqlJs();

    if (fs.existsSync(DB_PATH)) {
        const fileBuffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(fileBuffer);
        console.log(`✅ Database loaded from: ${DB_PATH}`);
    } else {
        db = new SQL.Database();
        console.log(`✅ New database created at: ${DB_PATH}`);
    }

    // Create schema
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            name           TEXT    NOT NULL,
            email          TEXT    NOT NULL UNIQUE,
            password_hash  TEXT    NOT NULL,
            dob            TEXT    NOT NULL,
            address        TEXT    NOT NULL,
            pincode        TEXT    NOT NULL,
            role           TEXT    NOT NULL,
            hh_code        TEXT,
            phone          TEXT,
            created_at     TEXT    DEFAULT (datetime('now', 'localtime'))
        );

        CREATE TABLE IF NOT EXISTS collectors (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            employee_id     TEXT,
            phone_number    TEXT    NOT NULL UNIQUE,
            name            TEXT,
            operating_area  TEXT,
            pincode         TEXT,
            materials       TEXT,
            latitude        REAL,
            longitude       REAL,
            is_available    INTEGER DEFAULT 1,
            onboarding_step TEXT    DEFAULT 'START',
            source          TEXT    DEFAULT 'WhatsApp',
            created_at      TEXT    DEFAULT (datetime('now', 'localtime'))
        );

        CREATE TABLE IF NOT EXISTS pickups (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            request_id   TEXT    NOT NULL UNIQUE,
            user_id      INTEGER NOT NULL,
            collector_id INTEGER,
            role         TEXT    NOT NULL,
            items        TEXT    NOT NULL,
            time_slot    TEXT    NOT NULL,
            quantity     TEXT,
            status       TEXT    DEFAULT 'Pending',
            created_at   TEXT    DEFAULT (datetime('now', 'localtime')),
            FOREIGN KEY (collector_id) REFERENCES collectors(id)
        );

        CREATE TABLE IF NOT EXISTS addresses (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER NOT NULL,
            label       TEXT    NOT NULL,
            address     TEXT    NOT NULL,
            pincode     TEXT,
            is_primary  INTEGER DEFAULT 0,
            created_at  TEXT    DEFAULT (datetime('now', 'localtime')),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS transactions (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id      INTEGER NOT NULL,
            type         TEXT    NOT NULL,
            title        TEXT    NOT NULL,
            description  TEXT,
            amount       REAL    DEFAULT 0.0,
            points       INTEGER DEFAULT 0,
            direction    TEXT    DEFAULT 'credit',
            status       TEXT    DEFAULT 'Completed',
            reference_id TEXT,
            created_at   TEXT    DEFAULT (datetime('now', 'localtime')),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
    `);

    // Check if collector_id column exists in existing pickups table; add if missing
    try {
        db.run(`ALTER TABLE pickups ADD COLUMN collector_id INTEGER REFERENCES collectors(id)`);
    } catch (e) {
        // Column already exists or table was just created
    }

    try {
        db.run(`ALTER TABLE users ADD COLUMN phone TEXT`);
    } catch (e) {
        // Column already exists
    }

    try {
        db.run(`ALTER TABLE users ADD COLUMN bio TEXT`);
    } catch (e) {
        // Column already exists
    }

    try {
        db.run(`ALTER TABLE users ADD COLUMN saved_materials TEXT`);
    } catch (e) {
        // Column already exists
    }

    try {
        db.run(`ALTER TABLE pickups ADD COLUMN pin TEXT`);
    } catch (e) {}

    try {
        db.run(`ALTER TABLE pickups ADD COLUMN actual_weight REAL`);
    } catch (e) {}

    try {
        db.run(`ALTER TABLE pickups ADD COLUMN material_weights TEXT`);
    } catch (e) {}

    try {
        db.run(`ALTER TABLE pickups ADD COLUMN payout_amount REAL`);
    } catch (e) {}

    try {
        db.run(`ALTER TABLE pickups ADD COLUMN collector_phone TEXT`);
    } catch (e) {}

    try {
        db.run(`ALTER TABLE pickups ADD COLUMN completed_at TEXT`);
    } catch (e) {}

    try {
        db.run(`ALTER TABLE pickups ADD COLUMN assigned_at TEXT`);
    } catch (e) {}

    try {
        db.run(`ALTER TABLE collectors ADD COLUMN language TEXT DEFAULT 'hinglish'`);
    } catch (e) {}

    try {
        db.run(`ALTER TABLE collectors ADD COLUMN employee_id TEXT`);
    } catch (e) {}

    try {
        db.run(`UPDATE collectors SET employee_id = 'KW-' || (1000 + id) WHERE employee_id IS NULL OR employee_id = ''`);
    } catch (e) {}

    try {
        db.run(`ALTER TABLE users ADD COLUMN wallet_balance REAL DEFAULT 0.0`);
    } catch (e) {}

    try {
        db.run(`
            CREATE TABLE IF NOT EXISTS transactions (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id      INTEGER NOT NULL,
                type         TEXT    NOT NULL,
                title        TEXT    NOT NULL,
                description  TEXT,
                amount       REAL    DEFAULT 0.0,
                points       INTEGER DEFAULT 0,
                direction    TEXT    DEFAULT 'credit',
                status       TEXT    DEFAULT 'Completed',
                reference_id TEXT,
                created_at   TEXT    DEFAULT (datetime('now', 'localtime')),
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        `);
    } catch (e) {}

    try {
        db.run(`ALTER TABLE users ADD COLUMN city TEXT`);
    } catch (e) {}
    try {
        db.run(`ALTER TABLE users ADD COLUMN state TEXT`);
    } catch (e) {}

    try {
        db.run(`ALTER TABLE addresses ADD COLUMN city TEXT`);
    } catch (e) {}
    try {
        db.run(`ALTER TABLE addresses ADD COLUMN state TEXT`);
    } catch (e) {}
    try {
        db.run(`ALTER TABLE pickups ADD COLUMN hub_trip_id TEXT`);
    } catch (e) {}
    try {
        db.run(`ALTER TABLE pickups ADD COLUMN hub_deposited_at TEXT`);
    } catch (e) {}

    // ── Segregation Hub Tables & Initial State ───────────────────────────────
    try {
        db.run(`
            CREATE TABLE IF NOT EXISTS hub_bins (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                material       TEXT NOT NULL UNIQUE,
                capacity       REAL NOT NULL,
                current_kg     REAL DEFAULT 0,
                recycling_unit TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS hub_trips (
                id              TEXT PRIMARY KEY,
                collector_id    INTEGER,
                collector_name  TEXT,
                collector_phone TEXT,
                declared_weight REAL,
                hub_weight      REAL,
                gap_pct         REAL,
                is_flagged      INTEGER DEFAULT 0,
                is_segregated   INTEGER DEFAULT 1,
                payout_amount   REAL,
                is_approved     INTEGER DEFAULT 0,
                details_json    TEXT,
                created_at      TEXT DEFAULT (datetime('now', 'localtime'))
            );

            CREATE TABLE IF NOT EXISTS hub_dispatches (
                id             TEXT PRIMARY KEY,
                material       TEXT NOT NULL,
                weight_kg      REAL NOT NULL,
                recycling_unit TEXT NOT NULL,
                status         TEXT DEFAULT 'Planned',
                created_at     TEXT DEFAULT (datetime('now', 'localtime'))
            );

            CREATE TABLE IF NOT EXISTS hub_employees (
                id     TEXT PRIMARY KEY,
                name   TEXT NOT NULL,
                role   TEXT NOT NULL,
                status TEXT DEFAULT 'Active'
            );
        `);

        // Check if bins are initialized
        const binStmt = db.prepare(`SELECT count(*) as count FROM hub_bins`);
        binStmt.step();
        const binCount = binStmt.getAsObject().count;
        binStmt.free();

        if (binCount === 0) {
            const initialBins = [
                ['Paper', 800, 310, 'PaperCycle Mills'],
                ['Cardboard', 1000, 640, 'PaperCycle Mills'],
                ['Plastic', 700, 330, 'GreenLoop Plastics'],
                ['Copper', 300, 40, 'MetalWorks Recyclers'],
                ['Steel', 500, 120, 'MetalWorks Recyclers'],
                ['Aluminium', 400, 50, 'MetalWorks Recyclers'],
                ['Glass', 600, 200, 'ClearGlass Unit'],
                ['Organic wet waste', 900, 420, 'BioCompost Plant'],
                ['E-waste', 400, 60, 'SafeE Recyclers'],
                ['Landfill waste', 500, 40, 'Authorised Landfill']
            ];
            const insBin = db.prepare(`INSERT INTO hub_bins (material, capacity, current_kg, recycling_unit) VALUES (?, ?, ?, ?)`);
            for (const b of initialBins) {
                insBin.run(b);
            }
            insBin.free();
        }

        // Check if dispatches are initialized
        const dStmt = db.prepare(`SELECT count(*) as count FROM hub_dispatches`);
        dStmt.step();
        const dCount = dStmt.getAsObject().count;
        dStmt.free();

        if (dCount === 0) {
            db.run(`
                INSERT INTO hub_dispatches (id, material, weight_kg, recycling_unit, status) VALUES 
                ('D-103', 'Steel', 60, 'MetalWorks Recyclers', 'In transit'),
                ('D-104', 'Plastic', 150, 'GreenLoop Plastics', 'Planned'),
                ('D-105', 'Cardboard', 400, 'PaperCycle Mills', 'Planned')
            `);
        }

        // Check if employees are initialized
        const eStmt = db.prepare(`SELECT count(*) as count FROM hub_employees`);
        eStmt.step();
        const eCount = eStmt.getAsObject().count;
        eStmt.free();

        if (eCount === 0) {
            db.run(`
                INSERT INTO hub_employees (id, name, role, status) VALUES 
                ('E-201', 'Anil Sharma', 'Sorting', 'Active'),
                ('E-202', 'Pooja Verma', 'Weighing', 'Active')
            `);
        }

        // Seed initial trips if empty
        const tStmt = db.prepare(`SELECT count(*) as count FROM hub_trips`);
        tStmt.step();
        const tCount = tStmt.getAsObject().count;
        tStmt.free();

        if (tCount === 0) {
            db.run(`
                INSERT INTO hub_trips (id, collector_id, collector_name, collector_phone, declared_weight, hub_weight, gap_pct, is_flagged, is_segregated, payout_amount, is_approved, details_json) VALUES 
                ('T-1041', 10, 'Parv Dua', '+917814776666', 63.5, 62.2, 2.0, 0, 1, 350, 1, '{"Paper": 15, "Cardboard": 26, "Metals (Loha)": 21.2}'),
                ('T-1042', 10, 'Parv Dua', '+917814776666', 30.0, 24.5, 18.3, 1, 1, 220, 0, '{"Cardboard": 10, "Paper": 4.5, "Metals (Loha)": 10}')
            `);
        }
    } catch (e) {
        console.error('Error initializing hub tables:', e);
    }

    persist();
    return db;
}

function persist() {
    if (!db) return;
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
}

module.exports = { getDb, persist };
