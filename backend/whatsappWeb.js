const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino   = require('pino');
const QRCode = require('qrcode');
const path   = require('path');
const { getDb, persist } = require('./database');

let sock = null;
let qrCodeDataUrl = null;
let isReady = false;
const pendingVerifications = {};

const AUTH_FOLDER = path.join(__dirname, '.baileys_auth');

async function startWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['Circular App', 'MacOS', '1.0.0']
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('⚡ New WhatsApp QR generated (Baileys)!');
                try {
                    qrCodeDataUrl = await QRCode.toDataURL(qr);
                } catch (e) {
                    console.error('QR convert error:', e);
                }
            }

            if (connection === 'close') {
                isReady = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`⚠️ WhatsApp connection closed (code: ${statusCode}). Reconnecting: ${shouldReconnect}`);

                if (shouldReconnect) {
                    setTimeout(startWhatsApp, 3000);
                } else {
                    console.log('User logged out from phone. Fresh QR needed.');
                    qrCodeDataUrl = null;
                }
            } else if (connection === 'open') {
                console.log('🟢 WhatsApp is 100% READY & CONNECTED (Direct WebSockets, No Browser)!');
                isReady = true;
                qrCodeDataUrl = null;
            }
        });

        // ─────────────────────────────────────────────────────────────
        // INBOUND MESSAGES: Automatically converses with any Kabadiwala
        // ─────────────────────────────────────────────────────────────
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const msg of messages) {
                // 1. STRICT OPERATOR FILTER: Ignore anything sent from our own phone!
                if (!msg.message || msg.key.fromMe) continue;

                const remoteJid = msg.key.remoteJid;
                // Ignore groups or status broadcasts
                if (remoteJid.includes('@g.us') || remoteJid === 'status@broadcast') continue;

                // Extract sender phone
                const rawSender = remoteJid.replace('@s.whatsapp.net', '');
                const cleanDigits = rawSender.replace(/\D/g, '');
                if (!cleanDigits || cleanDigits.length < 8) continue;
                const phone = `+${cleanDigits}`;

                // Extract message body text
                const text = (
                    msg.message.conversation ||
                    msg.message.extendedTextMessage?.text ||
                    ''
                ).trim();

                const lowerBody = text.toLowerCase();
                const db = await getDb();

                // Look up in database (check with and without + prefix)
                const stmt = db.prepare('SELECT * FROM collectors WHERE REPLACE(phone_number, "+", "") = ? OR phone_number = ?');
                stmt.bind([cleanDigits, phone]);
                let collector = null;
                if (stmt.step()) collector = stmt.getAsObject();
                stmt.free();

                const reply = async (replyText) => {
                    await sock.sendMessage(remoteJid, { text: replyText });
                };

                // ── A. DOORSTEP QR CODE VERIFICATION ─────────────────
                // Check if message is a VERIFY / CONFIRM scan from QR:
                // Format: "VERIFY REQ-1234 4821" or "CONFIRM_PICKUP_REQ-1234_PIN-4821"
                const verifyMatch = text.match(/(?:VERIFY|CONFIRM(?:_PICKUP)?)[_\s]+([A-Za-z0-9\-_]+)(?:[_\s]+(?:PIN[-_:]?)?(\d{4}))?/i);
                if (verifyMatch) {
                    // 1. STRANGER BLOCK: Only registered, active Kabadiwalas can verify pickups
                    if (!collector || collector.onboarding_step !== 'COMPLETED') {
                        await reply(
                            `⛔ *Access Denied!*\n\n` +
                            `Aap Circular ke registered collection partner (Kabadiwala) nahi hain.\n` +
                            `Sirf authorized Kabadiwala hi QR code scan karke pickup complete kar sakte hain.`
                        );
                        continue;
                    }

                    const targetReqId = verifyMatch[1].trim().toUpperCase();
                    const enteredPin = verifyMatch[2] ? verifyMatch[2].trim() : null;

                    const pStmt = db.prepare(`
                        SELECT p.*, u.name as customer_name, u.phone as customer_phone, u.pincode as customer_pincode, u.address as customer_address
                        FROM pickups p
                        LEFT JOIN users u ON p.user_id = u.id
                        WHERE UPPER(p.request_id) = ?
                    `);
                    pStmt.bind([targetReqId]);
                    let pickup = null;
                    if (pStmt.step()) pickup = pStmt.getAsObject();
                    pStmt.free();

                    if (!pickup) {
                        await reply(`❌ Order #${targetReqId} nahi mila. Kripya sahi ID check karein.`);
                        continue;
                    }

                    if (pickup.status === 'Completed') {
                        await reply(`ℹ️ Order #${targetReqId} pehle hi complete ho chuka hai!`);
                        continue;
                    }

                    if (enteredPin && pickup.pin && enteredPin !== pickup.pin) {
                        await reply(`⚠️ Galat Security PIN! Kripya customer ke phone screen par dikhaya gaya 4-digit PIN bhejein.`);
                        continue;
                    }

                    // 2. IMMEDIATE COMPLETION: Mark as Completed in SQLite so Household interface flips to Completed instantly!
                    const ptsEarned = 50;
                    db.run(`
                        UPDATE pickups 
                        SET status = 'Completed', 
                            collector_phone = ?, 
                            collector_id = COALESCE(collector_id, ?),
                            completed_at = datetime('now', 'localtime')
                        WHERE id = ?
                    `, [phone, collector.id, pickup.id]);

                    db.run(`
                        UPDATE users 
                        SET points = COALESCE(points, 0) + ? 
                        WHERE id = ?
                    `, [ptsEarned, pickup.user_id]);

                    persist();

                    // Save session in case collector wants to reply with measured weight for cash payout calculation
                    pendingVerifications[phone] = {
                        pickupId: pickup.id,
                        requestId: pickup.request_id,
                        userId: pickup.user_id,
                        customerName: pickup.customer_name || 'Resident',
                        customerPhone: pickup.customer_phone,
                        items: pickup.items,
                        role: pickup.role,
                        timestamp: Date.now()
                    };

                    await reply(
                        `✅ *Doorstep Verified & Completed!* 🎉\n\n` +
                        `• Order ID: *#${pickup.request_id}*\n` +
                        `• Customer: *${pickup.customer_name || 'Resident'}*\n` +
                        `• Address: ${pickup.customer_address || ''} (${pickup.customer_pincode || ''})\n` +
                        `• Items: *${pickup.items}*\n` +
                        `• Status: 🟢 *Completed*\n\n` +
                        `Customer ke app screen par pickup *Completed* mark ho gaya hai aur *+${ptsEarned} Green Points* credit ho gaye hain!\n\n` +
                        `⚖️ *Optional:* Agar aapne weight naapa hai, toh weight (kg) likh kar bhejein (jaise: *14 kg* ya *12*) taaki cash receipt generate ho sake.`
                    );

                    // Notify customer on WhatsApp right away
                    if (pickup.customer_phone) {
                        const custMsg = 
                            `🌿 *circular. Pickup Completed!* 🌿\n\n` +
                            `Hi *${pickup.customer_name || 'there'}*,\n` +
                            `Aapka pickup *#${pickup.request_id}* collection partner (*${collector.name || 'Authorized Collector'}*) dwara collect kar liya gaya hai!\n\n` +
                            `⭐ Green Points: *+${ptsEarned} pts* (App me add ho chuke hain)\n\n` +
                            `Thank you for contributing to a cleaner environment! 🌍`;

                        sendWhatsAppAlert(pickup.customer_phone, custMsg)
                            .catch(e => console.error('Error notifying customer of completion:', e));
                    }

                    continue;
                }

                // ── B. OPTIONAL WEIGHT RECEIPT UPDATE ────────────
                if (pendingVerifications[phone]) {
                    const session = pendingVerifications[phone];
                    const weightMatch = text.match(/(\d+(?:\.\d+)?)/);

                    if (weightMatch) {
                        const measuredWeight = parseFloat(weightMatch[1]);
                        const isWetOnly = session.items.toLowerCase().includes('biodegradable') && !session.items.toLowerCase().includes('dry');
                        const ratePerKg = isWetOnly ? 0 : 10;
                        const payout = Math.round(measuredWeight * ratePerKg);

                        db.run(`
                            UPDATE pickups 
                            SET actual_weight = ?, 
                                payout_amount = ? 
                            WHERE id = ?
                        `, [measuredWeight, payout, session.pickupId]);
                        persist();
                        delete pendingVerifications[phone];

                        await reply(
                            `💵 *Cash Payout Receipt Generated!*\n\n` +
                            `• Order: *#${session.requestId}*\n` +
                            `• Total Weight: *${measuredWeight} kg*\n` +
                            (payout > 0 ? `• Customer ko Cash Pay karein: *₹${payout}*\n\n` : '\n') +
                            `Receipt customer ko WhatsApp par bhej di gayi hai. Dhanyawad!`
                        );

                        if (session.customerPhone && payout > 0) {
                            sendWhatsAppAlert(session.customerPhone,
                                `💵 *circular. Cash Receipt for #${session.requestId}*\n\n` +
                                `• Weighed Scrap: *${measuredWeight} kg*\n` +
                                `• Total Cash Payout: *₹${payout}*\n\n` +
                                `Cash collector dwara handover kar diya gaya hai.`
                            ).catch(e => console.error(e));
                        }
                        continue;
                    }
                }

                // Location message check
                const loc = msg.message.locationMessage;
                const latitude = loc ? loc.degreesLatitude : null;
                const longitude = loc ? loc.degreesLongitude : null;

                // 2. BRAND NEW NUMBER
                if (!collector) {
                    db.run(
                        `INSERT INTO collectors (phone_number, onboarding_step) VALUES (?, 'AWAITING_NAME')`,
                        [phone]
                    );
                    persist();

                    await reply(
                        `🌿 *Namaste! Welcome to Circular Partner!* 🌿\n\n` +
                        `Aapka swagat hai. Waste collection partner banne ke liye kripya apna *Poora Naam (Full Name)* likh kar bhejein:`
                    );
                    continue;
                }

                // 3. EXPLICIT RESET COMMAND (Protected with #RESET to avoid accidental trigger)
                if (lowerBody === '#reset' || lowerBody === 'reset profile') {
                    db.run(`UPDATE collectors SET onboarding_step = 'AWAITING_NAME' WHERE id = ?`, [collector.id]);
                    persist();
                    await reply(`🔄 Aapka profile reset kar diya gaya hai.\n\nKripya apna *Poora Naam (Full Name)* bhejein:`);
                    continue;
                }

                // 4. ON / OFF DUTY TOGGLE
                if (lowerBody === 'duty' || lowerBody === 'status') {
                    const newStatus = collector.is_available ? 0 : 1;
                    db.run(`UPDATE collectors SET is_available = ? WHERE id = ?`, [newStatus, collector.id]);
                    persist();
                    const statusText = newStatus ? '🟢 ON DUTY (Available for pickups)' : '🔴 OFF DUTY (Inactive)';
                    await reply(`Aapka current status badal diya gaya hai:\n\n*${statusText}*`);
                    continue;
                }

                // Common greetings filter
                const isGreeting = ['hi', 'hello', 'hey', 'namaste', 'pranam', 'hii', 'hlo'].includes(lowerBody);

                // 5. CONVERSATION STATE MACHINE
                switch (collector.onboarding_step) {

                    case 'AWAITING_NAME': {
                        // Prevent greetings or 1-letter garbage as name
                        if (isGreeting || text.length < 2 || !/^[a-zA-Z\s\u0900-\u097F]+$/.test(text)) {
                            await reply(`Kripya apna asali naam likh kar bhejein (jaise: *Ramesh Kumar*):`);
                            break;
                        }

                        db.run(
                            `UPDATE collectors SET name = ?, onboarding_step = 'AWAITING_AREA' WHERE id = ?`,
                            [text, collector.id]
                        );
                        persist();

                        await reply(
                            `Dhanyawad *${text}* ji! 🙏\n\n` +
                            `Aap kis area / locality me collection karte hain? (Complete area name ya locality likhein):`
                        );
                        break;
                    }

                    case 'AWAITING_AREA': {
                        if (isGreeting || text.length < 3) {
                            await reply(`Kripya apni sahi locality / area ka naam likhein (jaise: *Model Town* ya *Sector 14*):`);
                            break;
                        }

                        db.run(
                            `UPDATE collectors SET operating_area = ?, onboarding_step = 'AWAITING_PINCODE' WHERE id = ?`,
                            [text, collector.id]
                        );
                        persist();

                        await reply(`Badhiya! Ab apne area ka *6-digit Pincode* bhejein (jaise: 110020):`);
                        break;
                    }

                    case 'AWAITING_PINCODE': {
                        const pincode = text.replace(/\D/g, '');
                        if (pincode.length !== 6) {
                            await reply(`Kripya 6-digit ka sahi pincode bhejein (jaise: 110020):`);
                            break;
                        }

                        db.run(
                            `UPDATE collectors SET pincode = ?, onboarding_step = 'AWAITING_MATERIALS' WHERE id = ?`,
                            [pincode, collector.id]
                        );
                        persist();

                        await reply(
                            `Aap kis type ka waste collect karte hain? Number likh kar reply karein:\n\n` +
                            `1️⃣ Raddi / Paper / Cardboard\n` +
                            `2️⃣ Plastic & Bottles\n` +
                            `3️⃣ Scrap Metal / Loha\n` +
                            `4️⃣ Sabhi Tarah Ka (All Items)\n\n` +
                            `_(1, 2, 3 ya 4 bhej kar chunein)_`
                        );
                        break;
                    }

                    case 'AWAITING_MATERIALS': {
                        let mats = '';
                        if (text === '1') mats = 'Paper, Books, Cardboard';
                        else if (text === '2') mats = 'Plastic, Bottles';
                        else if (text === '3') mats = 'Scrap Metal';
                        else if (text === '4') mats = 'All Categories (Paper, Plastic, Metal)';
                        else {
                            if (isGreeting) {
                                await reply(`Kripya 1, 2, 3 ya 4 number likh kar chunein:`);
                                break;
                            }
                            mats = text;
                        }

                        db.run(
                            `UPDATE collectors SET materials = ?, onboarding_step = 'COMPLETED', is_available = 1 WHERE id = ?`,
                            [mats, collector.id]
                        );
                        if (latitude && longitude) {
                            db.run(`UPDATE collectors SET latitude = ?, longitude = ? WHERE id = ?`, [latitude, longitude, collector.id]);
                        }
                        persist();

                        await reply(
                            `🎉 *Badhaai ho! Aap Circular Partner ban chuke hain!* 🎉\n\n` +
                            `📋 *Aapki Details:*\n` +
                            `• Naam: *${collector.name}*\n` +
                            `• Area: *${collector.operating_area}* (${collector.pincode})\n` +
                            `• Material: *${mats}*\n` +
                            `• Status: 🟢 *Active / On Duty*\n\n` +
                            `Aapke area me jab bhi naya pickup aayega, hum aapko WhatsApp par notify karenge.\n\n` +
                            `_Duty on/off karne ke liye kisi bhi time *DUTY* likh kar bhejein._`
                        );
                        break;
                    }

                    case 'COMPLETED': {
                        // 1. Live location sharing
                        if (latitude && longitude) {
                            db.run(`UPDATE collectors SET latitude = ?, longitude = ? WHERE id = ?`, [latitude, longitude, collector.id]);
                            persist();
                            await reply(`📍 Location update ho gayi hai!`);
                            break;
                        }

                        // 2. Query pickups
                        if (lowerBody.includes('pickup') || lowerBody === 'orders' || lowerBody === 'kaam') {
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
                                await reply(`📦 *Abhi koi naya pickup pending nahi hai.*\n\nJaise hi naya request aayega, yahan show hoga.`);
                                break;
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
                            await reply(replyText);
                            break;
                        }

                        // 3. For any other regular chat message or greeting, NEVER reset!
                        await reply(
                            `Namaste *${collector.name || 'Partner'}* ji! 🙏\n\n` +
                            `Commands:\n` +
                            `• *PICKUPS* - Area ke pending pickups check karein 📦\n` +
                            `• *DUTY* - On/Off duty toggle karein 🟢/🔴\n` +
                            `• Live location bhej kar apni location update karein 📍\n` +
                            `• *#RESET* - Details dobara bharein (agar zaroorat ho) 🔄`
                        );
                        break;
                    }

                    default:
                        await reply(`Namaste! Status update karne ke liye *DUTY* ya *PICKUPS* likhein.`);
                }
            }
        });
    } catch (err) {
        console.error('Baileys WhatsApp Init Error:', err);
    }
}

// ─────────────────────────────────────────────────────────────
// OUTBOUND NOTIFIER: Sends instant alert when customer schedules
// ─────────────────────────────────────────────────────────────
async function sendWhatsAppAlert(phoneNumber, message) {
    if (!isReady || !sock) {
        console.warn('⚠️ WhatsApp client not ready. Cannot send alert.');
        return { success: false, reason: 'Client not ready' };
    }

    try {
        const cleanDigits = phoneNumber.replace(/\D/g, '');
        const jid = `${cleanDigits}@s.whatsapp.net`;

        await sock.sendMessage(jid, { text: message });
        console.log(`✅ WhatsApp alert successfully sent to ${phoneNumber}!`);
        return { success: true };
    } catch (err) {
        console.error(`❌ Failed to send WhatsApp alert to ${phoneNumber}:`, err.message);
        return { success: false, error: err.message };
    }
}

function getStatus() {
    const botNumber = sock?.user?.id ? sock.user.id.split(':')[0].replace(/\D/g, '') : '917657864774';
    return {
        isReady,
        qrCodeDataUrl,
        botNumber
    };
}

// Start
startWhatsApp();

module.exports = {
    sendWhatsAppAlert,
    getStatus
};
