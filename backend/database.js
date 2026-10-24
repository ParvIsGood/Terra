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
        db.run(`ALTER TABLE users ADD COLUMN points INTEGER DEFAULT 0`);
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

    persist();
    return db;
}

function persist() {
    if (!db) return;
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
}

module.exports = { getDb, persist };
