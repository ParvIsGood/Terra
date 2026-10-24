const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino   = require('pino');
const QRCode = require('qrcode');
const path   = require('path');
const fs     = require('fs');
const { getDb, persist } = require('./database');

let sock = null;
let qrCodeDataUrl = null;
let isReady = false;
const pendingVerifications = {};
const activeDispatches = {}; // Keyed by requestId (e.g. 'REQ-1234')

function parseMaterialWeights(inputStr) {
    if (!inputStr) return { items: [], totalWeight: 0 };
    let text = inputStr.trim();
    // Normalize space separation between number and next word: e.g. "10 plastic" -> "10, plastic"
    text = text.replace(/(\d+(?:\.\d+)?\s*(?:kg|kgs|kilo|kilos)?)\s+([a-zA-Z\u0900-\u097F])/gi, "$1, $2");

    const categories = [
        { key: "Cardboard", regex: /(?:cardboard|gatta|carton|dabba)/i },
        { key: "Paper", regex: /(?:paper|raddi|newspaper|akhbar|book|books)/i },
        { key: "Plastic", regex: /(?:plastic|bottle|bottles|polythene|panni)/i },
        { key: "Metals", regex: /(?:metal|metals|loha|steel|aluminium|iron|tin|taamba)/i },
        { key: "Glass", regex: /(?:glass|kaanch|kanch|sheesha)/i },
        { key: "Cloth", regex: /(?:cloth|kapda|clothes|fabric)/i },
        { key: "Biodegradable", regex: /(?:bio|biodegradable|wet|gila|organic|food)/i },
        { key: "Dry Waste", regex: /(?:dry|sukha)/i },
        { key: "Others", regex: /(?:other|others|kachra)/i }
    ];

    const segments = text.split(/[,;\n\+]|\band\b|\baur\b|&/i).map(s => s.trim()).filter(Boolean);
    const parsed = [];
    let matchedTotal = 0;

    for (const seg of segments) {
        const numMatch = seg.match(/(\d+(?:\.\d+)?)/);
        if (!numMatch) continue;
        const weight = parseFloat(numMatch[1]);
        if (isNaN(weight) || weight <= 0) continue;

        let matchedCat = null;
        for (const cat of categories) {
            if (cat.regex.test(seg)) {
                matchedCat = cat.key;
                break;
            }
        }

        if (matchedCat) {
            const existing = parsed.find(p => p.material === matchedCat);
            if (existing) {
                existing.weight = Math.round((existing.weight + weight) * 10) / 10;
            } else {
                parsed.push({ material: matchedCat, weight });
            }
            matchedTotal += weight;
        }
    }

    if (parsed.length === 0) {
        const singleNumMatch = text.match(/(\d+(?:\.\d+)?)/);
        if (singleNumMatch) {
            const w = parseFloat(singleNumMatch[1]);
            if (!isNaN(w) && w > 0) {
                parsed.push({ material: "Recyclables (Total)", weight: w });
                matchedTotal = w;
            }
        }
    }

    const totalWeight = Math.round(matchedTotal * 10) / 10;
    return { items: parsed, totalWeight };
}

function resolvePhoneAndLid(rawId) {
    if (!rawId) return { phone: '', lid: '', jid: '' };
    const clean = rawId.replace(/[@a-z\._]/gi, '').trim();

    // 1. Check if clean is an LID that has a reverse mapping to phone
    const reverseFile = path.join(AUTH_FOLDER, `lid-mapping-${clean}_reverse.json`);
    if (fs.existsSync(reverseFile)) {
        try {
            const mappedPhone = JSON.parse(fs.readFileSync(reverseFile, 'utf8'));
            const cleanPhone = mappedPhone.replace(/\D/g, '');
            return { phone: `+${cleanPhone}`, lid: clean, jid: `${clean}@lid` };
        } catch (e) {}
    }

    // 2. Check if clean is a phone that has a direct mapping to LID
    const directFile = path.join(AUTH_FOLDER, `lid-mapping-${clean}.json`);
    if (fs.existsSync(directFile)) {
        try {
            const mappedLid = JSON.parse(fs.readFileSync(directFile, 'utf8'));
            const cleanLid = mappedLid.replace(/\D/g, '');
            return { phone: `+${clean}`, lid: cleanLid, jid: `${clean}@s.whatsapp.net` };
        } catch (e) {}
    }

    // 3. Fallback: if raw was an @lid JID
    if (rawId.includes('@lid')) {
        return { phone: `+${clean}`, lid: clean, jid: rawId };
    }

    return { phone: `+${clean}`, lid: '', jid: `${clean}@s.whatsapp.net` };
}

// ─────────────────────────────────────────────────────────────
// SEQUENTIAL 60-SECOND KABADIWALA DISPATCH SYSTEM
// ─────────────────────────────────────────────────────────────
async function dispatchPickup(pickup, customer) {
    const reqId = pickup.request_id;
    console.log(`[Dispatch] Starting 60s sequential dispatch for #${reqId}...`);

    try {
        const db = await getDb();
        const stmt = db.prepare(`
            SELECT id, name, phone_number 
            FROM collectors 
            WHERE is_available = 1 AND onboarding_step = 'COMPLETED'
            ORDER BY id ASC
        `);
        const candidates = [];
        while (stmt.step()) candidates.push(stmt.getAsObject());
        stmt.free();

        if (candidates.length === 0) {
            console.log(`[Dispatch] No available active collectors found for #${reqId}`);
            if (customer?.phone) {
                sendWhatsAppAlert(customer.phone,
                    `⏳ *circular. Order Scheduled (#${reqId})*\n\n` +
                    `Hi *${customer.name || 'there'}*,\n` +
                    `Aapka pickup request receive ho gaya hai! Hamare partners abhi busy hain, jaise hi partner free hoga, hum assign kar denge.`
                ).catch(e => console.error(e));
            }
            return;
        }

        // Clear existing timer if any
        if (activeDispatches[reqId] && activeDispatches[reqId].timer) {
            clearTimeout(activeDispatches[reqId].timer);
        }

        activeDispatches[reqId] = {
            pickupId: pickup.id,
            requestId: reqId,
            customer: customer,
            items: pickup.items,
            time_slot: pickup.time_slot,
            quantity: pickup.quantity,
            pin: pickup.pin,
            candidates: candidates,
            currentIndex: 0,
            timer: null
        };

        await offerPickupToCurrentCandidate(reqId);
    } catch (err) {
        console.error('[Dispatch] Error starting dispatch:', err);
    }
}

async function offerPickupToCurrentCandidate(reqId) {
    const dispatch = activeDispatches[reqId];
    if (!dispatch) return;

    if (dispatch.currentIndex >= dispatch.candidates.length) {
        console.log(`[Dispatch] All candidate collectors declined or timed out for #${reqId}`);
        if (dispatch.customer?.phone) {
            sendWhatsAppAlert(dispatch.customer.phone,
                `⏳ *circular. Update for #${reqId}*\n\n` +
                `Hi *${dispatch.customer.name || 'there'}*,\n` +
                `Nearby partners abhi dusre orders me vyast hain. Aapka pickup priority queue me hai, agle available partner ko assign kiya jayega.`
            ).catch(e => console.error(e));
        }
        delete activeDispatches[reqId];
        return;
    }

    const currentCollector = dispatch.candidates[dispatch.currentIndex];
    const collectorPhone = currentCollector.phone_number;

    console.log(`[Dispatch] Offering #${reqId} to collector #${currentCollector.id} (${currentCollector.name}) with 60s timeout...`);

    const offerMsg = 
        `🔔 *NAYA PICKUP OFFER! (New Request)* 🔔\n\n` +
        `Namaste *${currentCollector.name || 'Partner'}* ji!\n` +
        `Aapke area me naya pickup book hua hai:\n\n` +
        `• Order ID: *#${dispatch.requestId}*\n` +
        `• Customer: *${dispatch.customer?.name || 'Resident'}*\n` +
        `• Address: *${dispatch.customer?.address || 'Local'}* (PIN: ${dispatch.customer?.pincode || '—'})\n` +
        `• Items: *${dispatch.items}* (${dispatch.quantity || 'Standard'})\n` +
        `• Time Slot: *${dispatch.time_slot}*\n\n` +
        `⏱️ *Aapke paas accept karne ke liye 60 SECONDS hain!*\n\n` +
        `Accept karne ke liye reply karein:\n` +
        `👉 *ACCEPT*\n\n` +
        `Reject karne ke liye reply karein:\n` +
        `👉 *REJECT*`;

    await sendWhatsAppAlert(collectorPhone, offerMsg);

    // 60-second countdown timer
    dispatch.timer = setTimeout(async () => {
        console.log(`[Dispatch] 60s timeout elapsed for collector ${currentCollector.name} on #${reqId}`);
        
        sendWhatsAppAlert(collectorPhone,
            `⏱️ *Time Expired!* #${dispatch.requestId} ka 60-second samay pura ho gaya. Yeh offer agle partner ko forward kar di gayi hai.`
        ).catch(e => console.error(e));

        dispatch.currentIndex++;
        offerPickupToCurrentCandidate(reqId);
    }, 60000);
}

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

                // Extract sender phone with LID support
                const resolved = resolvePhoneAndLid(remoteJid);
                const phone = resolved.phone || `+${remoteJid.replace(/\D/g, '')}`;
                const cleanDigits = phone.replace(/\D/g, '');
                if (!cleanDigits || cleanDigits.length < 8) continue;

                // Extract message body text
                const text = (
                    msg.message.conversation ||
                    msg.message.extendedTextMessage?.text ||
                    ''
                ).trim();

                const lowerBody = text.toLowerCase();
                const db = await getDb();

                // Look up in database (check by clean digits, +phone, or LID if available)
                const stmt = db.prepare('SELECT * FROM collectors WHERE REPLACE(phone_number, "+", "") = ? OR phone_number = ? OR phone_number = ?');
                stmt.bind([cleanDigits, phone, `+${resolved.lid || ''}`]);
                let collector = null;
                if (stmt.step()) collector = stmt.getAsObject();
                stmt.free();

                const reply = async (replyText) => {
                    await sock.sendMessage(remoteJid, { text: replyText });
                };

                // ── 0. PICKUP ACCEPT / REJECT HANDLER (60s Dispatch System) ─────
                const acceptMatch = text.match(/^\s*(?:ACCEPT(?:[_\s]+([A-Za-z0-9\-_]+))?|1|YES|HAAN?)\s*$/i);
                const rejectMatch = text.match(/^\s*(?:REJECT(?:[_\s]+([A-Za-z0-9\-_]+))?|2|NO|NAHI?)\s*$/i);

                if (acceptMatch || rejectMatch) {
                    const specifiedReqId = (acceptMatch ? acceptMatch[1] : rejectMatch[1])?.trim().toUpperCase();
                    let targetDispatch = null;

                    if (specifiedReqId && activeDispatches[specifiedReqId]) {
                        targetDispatch = activeDispatches[specifiedReqId];
                    } else {
                        // Find active dispatch where this collector is the candidate
                        targetDispatch = Object.values(activeDispatches).find(d => {
                            const cur = d.candidates[d.currentIndex];
                            if (!cur) return false;
                            const curDigits = cur.phone_number.replace(/\D/g, '');
                            return (
                                curDigits === cleanDigits ||
                                cur.phone_number === phone ||
                                (resolved.lid && curDigits === resolved.lid)
                            );
                        });
                    }

                    if (!targetDispatch) {
                        await reply(`⚠️ Yeh pickup offer expire ho chuki hai ya kisi aur partner ko assign ho chuki hai.`);
                        continue;
                    }

                    const currentCandidate = targetDispatch.candidates[targetDispatch.currentIndex];
                    const candDigits = currentCandidate ? currentCandidate.phone_number.replace(/\D/g, '') : '';
                    const isCandidate = currentCandidate && (
                        candDigits === cleanDigits ||
                        currentCandidate.phone_number === phone ||
                        (resolved.lid && candDigits === resolved.lid)
                    );

                    if (!isCandidate) {
                        await reply(`⚠️ Yeh offer abhi aapke number ke liye active nahi hai.`);
                        continue;
                    }

                    if (acceptMatch) {
                        // Clear 60-second timer
                        if (targetDispatch.timer) clearTimeout(targetDispatch.timer);

                        const assignedCollector = currentCandidate;
                        const pickupId = targetDispatch.pickupId;
                        const reqId = targetDispatch.requestId;

                        // Assign collector in SQLite database
                        db.run(`
                            UPDATE pickups 
                            SET collector_id = ?, 
                                collector_phone = ?, 
                                status = 'Assigned',
                                assigned_at = datetime('now', 'localtime')
                            WHERE id = ?
                        `, [assignedCollector.id, assignedCollector.phone_number, pickupId]);
                        persist();

                        // Confirmation to Collector
                        await reply(
                            `🎉 *Pickup Accepted!* 🎉\n\n` +
                            `Order *#${reqId}* aapko successfully assign kar diya gaya hai.\n\n` +
                            `• Customer: *${targetDispatch.customer?.name || 'Resident'}*\n` +
                            `• Address: *${targetDispatch.customer?.address || 'Local'}* (PIN: ${targetDispatch.customer?.pincode || '—'})\n` +
                            `• Items: *${targetDispatch.items}*\n` +
                            `• Time Slot: *${targetDispatch.time_slot}*\n\n` +
                            `📍 Doorstep par pahunch kar customer ke app se QR code scan karein.\n\n` +
                            `Kripya time par pahunch kar waste collect karein! Dhanyawad 🙏`
                        );

                        // Alert to Customer on WhatsApp
                        if (targetDispatch.customer?.phone) {
                            sendWhatsAppAlert(targetDispatch.customer.phone,
                                `🌿 *circular. Collection Partner Assigned!* 🌿\n\n` +
                                `Hi *${targetDispatch.customer.name || 'there'}*,\n` +
                                `Aapke pickup *#${reqId}* ke liye verified collection partner (*${assignedCollector.name || 'Authorized Partner'}*) assign ho gaye hain!\n\n` +
                                `Wo aapke address par nikal rahe hain. Pickup status app screen par track kar sakte hain. 🌍`
                            ).catch(e => console.error(e));
                        }

                        delete activeDispatches[reqId];
                        continue;
                    } else if (rejectMatch) {
                        if (targetDispatch.timer) clearTimeout(targetDispatch.timer);

                        await reply(`Aapne #${targetDispatch.requestId} decline kar diya hai. Dhanyawad.`);

                        // Cascade to next collector in queue
                        targetDispatch.currentIndex++;
                        offerPickupToCurrentCandidate(targetDispatch.requestId);
                        continue;
                    }
                }

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

                    // 2. DOORSTEP VERIFICATION INITIATED (Status remains In-Progress / Weight Pending until collector enters kg)
                    const ptsEarned = 50;
                    db.run(`
                        UPDATE pickups 
                        SET collector_phone = ?, 
                            collector_id = COALESCE(collector_id, ?)
                        WHERE id = ?
                    `, [phone, collector.id, pickup.id]);
                    persist();

                    // Save session in pendingVerifications with all details & booked waste items
                    pendingVerifications[phone] = {
                        pickupId: pickup.id,
                        requestId: pickup.request_id,
                        userId: pickup.user_id,
                        customerName: pickup.customer_name || 'Resident',
                        customerPhone: pickup.customer_phone,
                        items: pickup.items,
                        role: pickup.role,
                        ptsEarned: ptsEarned,
                        timestamp: Date.now()
                    };

                    await reply(
                        `🔍 *Doorstep Verification In-Progress!* ⚖️\n\n` +
                        `• Order ID: *#${pickup.request_id}*\n` +
                        `• Customer: *${pickup.customer_name || 'Resident'}*\n` +
                        `• Address: ${pickup.customer_address || ''} (${pickup.customer_pincode || ''})\n\n` +
                        `📋 *Customer Waste in this Pickup:*\n` +
                        `👉 *${pickup.items}*\n\n` +
                        `⚖️ *Kripya inka weight (kg) naapein aur reply karein:*\n` +
                        `• Jaise: *Cardboard 10, Plastic 4, Paper 5*\n` +
                        `• ya: *Gatta 8 kg, Loha 2 kg*\n` +
                        `• ya Kul weight: *15 kg*\n\n` +
                        `⚠️ *Note:* Weight enter karne ke baad hi pickup *Officially Complete* hoga aur customer ko Green Points credit honge.`
                    );

                    continue;
                }

                // ── B. MATERIAL-WISE WEIGHT VERIFICATION & OFFICIAL COMPLETION ────────────
                if (pendingVerifications[phone]) {
                    const session = pendingVerifications[phone];
                    const parsedWeight = parseMaterialWeights(text);

                    if (parsedWeight.items.length > 0 && parsedWeight.totalWeight > 0) {
                        const { items: weightItems, totalWeight } = parsedWeight;
                        const weightSummaryStr = weightItems.map(it => `${it.material}: ${it.weight} kg`).join(', ');
                        const ptsEarned = session.ptsEarned || 50;

                        // NOW officially complete the pickup in SQLite & record verified weights
                        db.run(`
                            UPDATE pickups 
                            SET status = 'Completed',
                                actual_weight = ?, 
                                material_weights = ?,
                                completed_at = datetime('now', 'localtime')
                            WHERE id = ?
                        `, [totalWeight, weightSummaryStr, session.pickupId]);

                        // NOW award Green Points to user
                        db.run(`
                            UPDATE users 
                            SET points = COALESCE(points, 0) + ? 
                            WHERE id = ?
                        `, [ptsEarned, session.userId]);

                        persist();
                        delete pendingVerifications[phone];

                        const breakdownLines = weightItems
                            .map(it => `• ${it.material}: *${it.weight} kg*`)
                            .join('\n');

                        // Confirmation to Collector
                        await reply(
                            `✅ *Pickup Officially Verified & Completed!* 🎉\n\n` +
                            `• Order ID: *#${session.requestId}*\n` +
                            `• Customer: *${session.customerName}*\n\n` +
                            `*Segregated Weight Breakdown:*\n` +
                            `${breakdownLines}\n` +
                            `──────────────────\n` +
                            `📦 *Total Weight:* *${totalWeight} kg*\n\n` +
                            `Pickup status *Completed* mark ho gaya hai aur customer ko *+${ptsEarned} Green Points* credit kar diye gaye hain. Dhanyawad!`
                        );

                        // Official completion & weight alert to Customer on WhatsApp
                        if (session.customerPhone) {
                            sendWhatsAppAlert(session.customerPhone,
                                `🌿 *circular. Pickup Completed!* 🌿\n\n` +
                                `Hi *${session.customerName}*,\n` +
                                `Aapka pickup *#${session.requestId}* collection partner dwara successfully collect kar liya gaya hai!\n\n` +
                                `*Verified Waste Collected:*\n` +
                                `${breakdownLines}\n` +
                                `──────────────────\n` +
                                `📦 *Total Weight:* *${totalWeight} kg*\n\n` +
                                `⭐ Green Points: *+${ptsEarned} pts* (App me add ho chuke hain)\n\n` +
                                `Thank you for contributing to a cleaner, zero-waste environment! 🌍`
                            ).catch(e => console.error('Error notifying customer of completion:', e));
                        }
                        continue;
                    } else if (text && !text.startsWith('#') && text.toLowerCase() !== 'duty' && text.toLowerCase() !== 'status') {
                        // Gentle reminder if message is received during active weighing
                        await reply(
                            `⚖️ *Order #${session.requestId} ke liye weight pending hai!*\n\n` +
                            `Customer ka booked waste: *${session.items}*\n\n` +
                            `Kripya measured weight (kg) likh kar bhejein:\n` +
                            `• Jaise: *Cardboard 8, Plastic 3*\n` +
                            `• ya total: *12 kg*`
                        );
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
async function sendWhatsAppAlert(target, message) {
    if (!isReady || !sock) {
        console.warn('⚠️ WhatsApp client not ready. Cannot send alert.');
        return { success: false, reason: 'Client not ready' };
    }

    try {
        let jid = target;
        if (!target.includes('@')) {
            const resolved = resolvePhoneAndLid(target);
            if (resolved.phone) {
                jid = `${resolved.phone.replace(/\D/g, '')}@s.whatsapp.net`;
            } else {
                jid = `${target.replace(/\D/g, '')}@s.whatsapp.net`;
            }
        }

        await sock.sendMessage(jid, { text: message });
        console.log(`✅ WhatsApp alert successfully sent to ${jid} (target: ${target})!`);
        return { success: true };
    } catch (err) {
        console.error(`❌ Failed to send WhatsApp alert to ${target}:`, err.message);
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
    dispatchPickup,
    getStatus
};
