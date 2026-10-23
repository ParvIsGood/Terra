const express = require('express');
const router  = express.Router();
const twilio  = require('twilio');
const { getDb, persist } = require('../database');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken  = process.env.TWILIO_AUTH_TOKEN;
const client     = (accountSid && authToken) ? twilio(accountSid, authToken) : null;

// Helper to send WhatsApp reply back using Twilio TwiML
function sendReply(res, message) {
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(message);
    res.type('text/xml');
    res.send(twiml.toString());
}

// ─────────────────────────────────────────────
// POST /api/whatsapp/webhook
// Receives inbound messages from Twilio WhatsApp
// ─────────────────────────────────────────────
router.post('/webhook', async (req, res) => {
    try {
        const db = await getDb();

        // Twilio sends fields like: From, To, Body, Latitude, Longitude
        const rawFrom   = req.body.From || ''; // e.g. "whatsapp:+919876543210"
        const phone     = rawFrom.replace('whatsapp:', '').trim();
        const body      = (req.body.Body || '').trim();
        const latitude  = req.body.Latitude ? parseFloat(req.body.Latitude) : null;
        const longitude = req.body.Longitude ? parseFloat(req.body.Longitude) : null;

        if (!phone) {
            return res.status(400).send('No phone number provided');
        }

        // Look up collector in circular.db
        const stmt = db.prepare('SELECT * FROM collectors WHERE phone_number = ?');
        stmt.bind([phone]);
        let collector = null;
        if (stmt.step()) {
            collector = stmt.getAsObject();
        }
        stmt.free();

        // If new user or texts "reset" or "hi" from completed
        if (!collector) {
            db.run(
                `INSERT INTO collectors (phone_number, onboarding_step) VALUES (?, 'AWAITING_NAME')`,
                [phone]
            );
            persist();

            return sendReply(
                res,
                `🌿 *Namaste! Welcome to Circular Partner!*\n\n` +
                `Aapka swagat hai. Waste collection partner banne ke liye kripya apna *Poora Naam (Full Name)* likh kar bhejein:`
            );
        }

        const lowerBody = body.toLowerCase();

        // Global commands
        if (lowerBody === 'reset' || lowerBody === 'restart') {
            db.run(`UPDATE collectors SET onboarding_step = 'AWAITING_NAME' WHERE id = ?`, [collector.id]);
            persist();
            return sendReply(res, `🔄 Process reset.\n\nKripya apna *Poora Naam (Full Name)* bhejein:`);
        }

        if (lowerBody === 'status' || lowerBody === 'duty') {
            const newStatus = collector.is_available ? 0 : 1;
            db.run(`UPDATE collectors SET is_available = ? WHERE id = ?`, [newStatus, collector.id]);
            persist();
            const statusText = newStatus ? '🟢 ON DUTY (Available for pickups)' : '🔴 OFF DUTY (Inactive)';
            return sendReply(res, `Aapka current status badal diya gaya hai:\n\n*${statusText}*`);
        }

        // ── State Machine ──────────────────────────────────────
        switch (collector.onboarding_step) {

            case 'AWAITING_NAME': {
                const name = body;
                if (name.length < 2) {
                    return sendReply(res, `Kripya apna sahi naam likh kar bhejein:`);
                }

                db.run(
                    `UPDATE collectors SET name = ?, onboarding_step = 'AWAITING_AREA' WHERE id = ?`,
                    [name, collector.id]
                );
                persist();

                return sendReply(
                    res,
                    `Dhanyawad *${name}* ji! 🙏\n\n` +
                    `Aap kis area / locality me collection karte hain? (Complete area name ya locality likhein):`
                );
            }

            case 'AWAITING_AREA': {
                const area = body;
                db.run(
                    `UPDATE collectors SET operating_area = ?, onboarding_step = 'AWAITING_PINCODE' WHERE id = ?`,
                    [area, collector.id]
                );
                persist();

                return sendReply(
                    res,
                    `Badhiya! Ab apne area ka *6-digit Pincode* bhejein (jaise: 110020):`
                );
            }

            case 'AWAITING_PINCODE': {
                const pincode = body.replace(/\D/g, '');
                if (pincode.length !== 6) {
                    return sendReply(res, `Kripya 6-digit ka sahi pincode bhejein (jaise: 110020):`);
                }

                db.run(
                    `UPDATE collectors SET pincode = ?, onboarding_step = 'AWAITING_MATERIALS' WHERE id = ?`,
                    [pincode, collector.id]
                );
                persist();

                return sendReply(
                    res,
                    `Aap kis type ka waste collect karte hain? Number likh kar reply karein:\n\n` +
                    `1️⃣ Raddi / Paper / Cardboard\n` +
                    `2️⃣ Plastic & Bottles\n` +
                    `3️⃣ Scrap Metal / Loha\n` +
                    `4️⃣ Sabhi Tarah Ka (All Items)\n\n` +
                    `_(1, 2, 3 ya 4 bhej kar chunein)_`
                );
            }

            case 'AWAITING_MATERIALS': {
                let mats = '';
                if (body === '1') mats = 'Paper, Books, Cardboard';
                else if (body === '2') mats = 'Plastic, Bottles';
                else if (body === '3') mats = 'Scrap Metal';
                else if (body === '4') mats = 'All Categories (Paper, Plastic, Metal)';
                else mats = body; // fallback to text typed

                db.run(
                    `UPDATE collectors SET materials = ?, onboarding_step = 'COMPLETED', is_available = 1 WHERE id = ?`,
                    [mats, collector.id]
                );
                if (latitude && longitude) {
                    db.run(`UPDATE collectors SET latitude = ?, longitude = ? WHERE id = ?`, [latitude, longitude, collector.id]);
                }
                persist();

                return sendReply(
                    res,
                    `🎉 *Badhaai ho! Aap Circular Partner ban chuke hain!* 🎉\n\n` +
                    `📋 *Aapki Details:*\n` +
                    `• Naam: *${collector.name}*\n` +
                    `• Area: *${collector.operating_area}* (${collector.pincode})\n` +
                    `• Material: *${mats}*\n` +
                    `• Status: 🟢 *Active / On Duty*\n\n` +
                    `Aapke area me jab bhi naya pickup aayega, hum aapko WhatsApp par notify karenge.\n\n` +
                    `_Duty on/off karne ke liye kisi bhi time *DUTY* likh kar bhejein._`
                );
            }

            case 'COMPLETED': {
                // If they send location anytime after completion, update their GPS coordinates
                if (latitude && longitude) {
                    db.run(`UPDATE collectors SET latitude = ?, longitude = ? WHERE id = ?`, [latitude, longitude, collector.id]);
                    persist();
                    return sendReply(res, `📍 Location update ho gayi hai!`);
                }

                // Check pending pickups
                if (lowerBody === 'pickups' || lowerBody === 'pickup' || lowerBody === 'orders' || lowerBody === 'kaam') {
                    const pickupStmt = db.prepare(`
                        SELECT p.*, u.name as customer_name, u.address as customer_address, u.pincode as customer_pincode
                        FROM pickups p
                        LEFT JOIN users u ON p.user_id = u.id
                        WHERE p.status = 'Pending'
                        ORDER BY p.id DESC
                        LIMIT 5
                    `);
                    const activeList = [];
                    while (pickupStmt.step()) activeList.push(pickupStmt.getAsObject());
                    pickupStmt.free();

                    if (activeList.length === 0) {
                        return sendReply(res, `📦 *Abhi koi naya pickup pending nahi hai.*\n\nJaise hi naya request aayega, yahan show hoga.`);
                    }

                    let replyText = `📦 *Current Pending Pickups (${activeList.length}):*\n\n`;
                    activeList.forEach((p, idx) => {
                        replyText += `*${idx + 1}. #${p.request_id}*\n`;
                        replyText += `• Items: *${p.items}* (${p.quantity || 'Standard'})\n`;
                        replyText += `• Customer: ${p.customer_name || 'Household'}\n`;
                        replyText += `• Address: ${p.customer_address || 'Local'} (PIN: ${p.customer_pincode || '—'})\n`;
                        replyText += `• Time: ${p.time_slot}\n\n`;
                    });
                    replyText += `_Pickup complete hone par website admin panel par status Collected mark ho jayega._`;
                    return sendReply(res, replyText);
                }

                return sendReply(
                    res,
                    `Namaste *${collector.name}* ji! Aap Circular par active partner hain.\n\n` +
                    `Commands:\n` +
                    `• *PICKUPS* - Area ke pending pickups check karein 📦\n` +
                    `• *DUTY* - On/Off duty toggle karein 🟢/🔴\n` +
                    `• *RESET* - Details dobara bharein 🔄\n` +
                    `• Live location bhej kar apni location update karein 📍`
                );
            }

            default:
                return sendReply(res, `Namaste! Apna status update karne ke liye *DUTY* ya *RESET* likhein.`);
        }

    } catch (err) {
        console.error('WhatsApp Webhook Error:', err);
        return res.status(500).send('Internal Error');
    }
});

// ─────────────────────────────────────────────
// GET /api/whatsapp/collectors
// List all collectors for website / admin
// ─────────────────────────────────────────────
router.get('/collectors', async (req, res) => {
    try {
        const db = await getDb();
        const stmt = db.prepare('SELECT * FROM collectors ORDER BY id DESC');
        const list = [];
        while (stmt.step()) list.push(stmt.getAsObject());
        stmt.free();
        res.json({ count: list.length, collectors: list });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
