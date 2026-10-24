const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino   = require('pino');
const QRCode = require('qrcode');
const jsQR   = require('jsqr');
const { Jimp } = require('jimp');
const path   = require('path');
const fs     = require('fs');
const { getDb, persist } = require('./database');
const googleTTS = require('google-tts-api');
const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('child_process');

function convertMp3ToOpusOgg(mp3Buffer) {
    return new Promise((resolve, reject) => {
        try {
            const proc = spawn(ffmpegPath, [
                '-i', 'pipe:0',
                '-c:a', 'libopus',
                '-b:a', '32k',
                '-vbr', 'on',
                '-compression_level', '10',
                '-f', 'ogg',
                'pipe:1'
            ]);

            const chunks = [];
            proc.stdout.on('data', chunk => chunks.push(chunk));
            proc.on('close', code => {
                if (code === 0) resolve(Buffer.concat(chunks));
                else reject(new Error(`ffmpeg exited with code ${code}`));
            });
            proc.on('error', err => reject(err));

            proc.stdin.write(mp3Buffer);
            proc.stdin.end();
        } catch (e) {
            reject(e);
        }
    });
}

// Generates warm, human-like neural voice audio (Microsoft Edge Neural Voice)
function generateNeuralVoiceNote(text, voice = 'hi-IN-MadhurNeural') {
    return new Promise((resolve, reject) => {
        try {
            const pyScript = path.join(__dirname, 'edge_tts_helper.py');
            const pyProc = spawn('python3', [pyScript, text, voice, '+0%']);
            const ffmpegProc = spawn(ffmpegPath, [
                '-i', 'pipe:0',
                '-c:a', 'libopus',
                '-b:a', '32k',
                '-vbr', 'on',
                '-compression_level', '10',
                '-f', 'ogg',
                'pipe:1'
            ]);

            pyProc.stdout.pipe(ffmpegProc.stdin);

            const chunks = [];
            ffmpegProc.stdout.on('data', chunk => chunks.push(chunk));
            ffmpegProc.on('close', code => {
                if (code === 0 && chunks.length > 0) resolve(Buffer.concat(chunks));
                else reject(new Error('Neural voice generation failed with code ' + code));
            });

            pyProc.on('error', err => reject(err));
            ffmpegProc.on('error', err => reject(err));
        } catch (e) {
            reject(e);
        }
    });
}

let sock = null;
let qrCodeDataUrl = null;
let isReady = false;
const pendingVerifications = {};
const activeDispatches = {}; // Keyed by requestId (e.g. 'REQ-1234')

async function decodeQRFromImageBuffer(buffer) {
    if (!buffer || buffer.length === 0) return null;
    try {
        const image = await Jimp.read(buffer);
        const { data, width, height } = image.bitmap;
        const code = jsQR(new Uint8ClampedArray(data), width, height);
        if (code && code.data) {
            let decoded = decodeURIComponent(code.data);
            if (decoded.includes('text=')) {
                decoded = decoded.split('text=')[1].split('&')[0];
            }
            return decoded.trim();
        }
    } catch (err) {
        console.warn('QR image decoding error:', err.message);
    }
    return null;
}

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

// ─────────────────────────────────────────────────────────────
// 40% SCRAP PAYOUT FORMULA (40% of money received from recycling unit)
// Rule 3: No payout for mixed waste (₹0)
// Rule 4: No payout for normal domestic waste (₹0)
// Rule 6: Segregated recyclables receive 40% of wholesale factory rate
// ─────────────────────────────────────────────────────────────
function calculateMaterialPayout(material, weight) {
    const mat = (material || '').toLowerCase();
    
    // Check for mixed or non-segregated or wet waste (₹0 payout)
    if (mat.includes('mixed') || mat.includes('unsegregated') || mat.includes('wet') || mat.includes('biodegradable') || mat.includes('trash') || mat.includes('kachra')) {
        return 0; // ₹0 payout
    }
    
    let factoryWholesale = 0;
    if (mat.includes('cardboard') || mat.includes('gatta') || mat.includes('carton') || mat.includes('dabba')) {
        factoryWholesale = 19.0; // 40% = ₹7.60/kg
    } else if (mat.includes('paper') || mat.includes('raddi') || mat.includes('akhbar') || mat.includes('newspaper') || mat.includes('books')) {
        factoryWholesale = 20.0; // 40% = ₹8.00/kg
    } else if (mat.includes('plastic') || mat.includes('panni') || mat.includes('bottle')) {
        factoryWholesale = 25.0; // 40% = ₹10.00/kg
    } else if (mat.includes('copper') || mat.includes('tamba')) {
        factoryWholesale = 400.0; // 40% = ₹160.00/kg
    } else if (mat.includes('aluminium') || mat.includes('aluminum')) {
        factoryWholesale = 110.0; // 40% = ₹44.00/kg
    } else if (mat.includes('brass') || mat.includes('peetal')) {
        factoryWholesale = 280.0; // 40% = ₹112.00/kg
    } else if (mat.includes('metal') || mat.includes('iron') || mat.includes('loha') || mat.includes('steel') || mat.includes('tin')) {
        factoryWholesale = 35.0; // 40% = ₹14.00/kg
    } else if (mat.includes('e waste') || mat.includes('ewaste') || mat.includes('electronic') || mat.includes('wire') || mat.includes('cable')) {
        factoryWholesale = 40.0; // 40% = ₹16.00/kg
    } else if (mat.includes('glass') || mat.includes('sheesha') || mat.includes('kaanch')) {
        factoryWholesale = 2.5; // 40% = ₹1.00/kg
    } else {
        factoryWholesale = 20.0; // default average dry recyclable
    }

    // 40% of money received from recycling unit
    return Math.round(weight * (factoryWholesale * 0.40));
}

// ─────────────────────────────────────────────────────────────
// AI-POWERED FUZZY WEIGHT PARSER (Groq LLM)
// Corrects typos (plastoc, gata, lohaa) and parses spoken Hindi/Hinglish
// ─────────────────────────────────────────────────────────────
async function parseMaterialWeightsSmart(inputStr) {
    if (!inputStr) return { items: [], totalWeight: 0 };

    // 1. First run fast local regex
    const local = parseMaterialWeights(inputStr);

    // If local regex found specific materials, return immediately
    const hasSpecificMaterials = local.items.some(it => it.material !== "Recyclables (Total)" && it.material !== "Others");
    if (hasSpecificMaterials) {
        return local;
    }

    // 2. Otherwise invoke Groq AI to handle typos (e.g. plastoc, gata, lohaa, Hindi words)
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey && groqKey.startsWith('gsk_')) {
        try {
            const prompt = `You are an AI scrap & waste weight extractor for Circular by Terra in India.
Extract all materials and their weights in kg from this message sent by a local Kabadiwala/collector: "${inputStr}"
Rules:
- Correct typos, slang, or Hindi/Hinglish terms:
  • "plastoc", "plasstic", "panni", "bottles", "botle" -> "Plastic"
  • "gatta", "gata", "dabba" -> "Gatta (Cardboard)"
  • "cardboard", "cardbard", "carton", "box" -> "Cardboard"
  • "loha", "lohaa", "steel", "iron", "aluminium", "tin", "tamba" -> "Metals (Loha)"
  • "raddi", "paper", "akhbar", "akbar", "books", "kitab" -> "Paper (Raddi)"
  • "kaanch", "glass", "sheesha" -> "Glass"
  • "kapda", "clothes", "fabric" -> "Cloth"
  • "wet", "gila", "sabzi", "food" -> "Wet Waste"
  • "dry", "sukha" -> "Dry Waste"
- Convert spoken Hindi numbers if any: "ek"=1, "do"=2, "teen"=3, "chaar"=4, "paanch"=5, "chheh"=6, "saat"=7, "aath"=8, "nau"=9, "das"=10, "gyaarah"=11, "baarah"=12, "terah"=13, "chaudah"=14, "pandrah"=15, "bees"=20.
- Keep each distinct material entered by the collector separate so they see all their inputs in the breakdown.
- Respond ONLY with valid JSON in this exact structure, nothing else:
{"items":[{"material":"Gatta (Cardboard)","weight":8},{"material":"Plastic","weight":7}],"totalWeight":15}
If only a single total weight is given without material name, use material "Recyclables (Total)".
If no weight is found, return {"items":[],"totalWeight":0}`;

            const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: { "Authorization": `Bearer ${groqKey}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: "openai/gpt-oss-120b",
                    messages: [{ role: "user", content: prompt }],
                    temperature: 0.1,
                    response_format: { type: "json_object" }
                })
            });
            const data = await res.json();
            if (data.choices && data.choices[0]?.message?.content) {
                const aiResult = JSON.parse(data.choices[0].message.content);
                if (aiResult.items && Array.isArray(aiResult.items) && aiResult.items.length > 0) {
                    const totalW = aiResult.totalWeight || aiResult.items.reduce((s, it) => s + (Number(it.weight) || 0), 0);
                    return {
                        items: aiResult.items.map(it => ({ material: it.material, weight: Number(it.weight) || 0 })),
                        totalWeight: Math.round(totalW * 10) / 10
                    };
                }
            }
        } catch (e) {
            console.warn('AI weight parsing fallback to local:', e.message);
        }
    }

    return local;
}

// ─────────────────────────────────────────────────────────────
// AI INTENT CLASSIFIER FOR DISPATCH OFFERS (Groq LLM + Smart Fuzzy)
// Handles "मैं इस आफर को सेप्ट करता हूँ", "meh yeh order accept krta hu", "हा मैं ले लूँगा", "1", "yes", "reject", etc.
// ─────────────────────────────────────────────────────────────
async function classifyAcceptRejectIntent(rawText) {
    if (!rawText) return null;
    const clean = rawText.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"'“”]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

    // 1. Fast local checks for Hindi, Hinglish, English patterns
    const acceptWords = [
        'accept', 'accepting', 'accepted', 'sept', '1', 'yes', 'haan', 'ha', 'haa', 'hn', 'haanji', 'haji',
        'ok', 'okay', 'done', 'manzoor', 'sweekar', 'le lunga', 'lelunga', 'leloonga', 'le raha hu', 'le rha hu',
        'le rha', 'le raha', 'mujhe de do', 'de do', 'main lunga', 'mai lunga', 'krunga', 'karunga',
        'accept karta hu', 'accept krta hu', 'accept kar lo', 'accept krlo', 'accept karo', 'accept kar liya',
        'i will accept', 'take order', 'assign to me'
    ];
    const devanagariAccept = ['सेप्ट', 'स्वीकार', 'मंजूर', 'हाँ', 'हां', 'ले लूंगा', 'लेलूंगा', 'लेलूँगा', 'हामेल', 'करूंगा', 'लेता', 'लूंगा', 'लूँगा'];

    const rejectWords = [
        'reject', 'rejecting', 'rejected', '2', 'no', 'nahi', 'nahin', 'na', 'nah', 'cancel',
        'busy', 'nahi chahiye', 'nahi kar sakta', 'nahi kr skta', 'nahi lunga', 'reject kar do', 'reject krdo',
        'cannot accept', 'decline'
    ];
    const devanagariReject = ['रिजेक्ट', 'अस्वीकार', 'नहीं', 'रद्द'];

    if (acceptWords.some(w => clean === w || clean.includes(w)) || devanagariAccept.some(w => rawText.includes(w))) {
        if (!clean.includes('not accept') && !clean.includes('nahi accept') && !clean.includes('mat accept') && !clean.includes('nahi lunga')) {
            return 'ACCEPT';
        }
    }

    if (rejectWords.some(w => clean === w || clean.includes(w)) || devanagariReject.some(w => rawText.includes(w))) {
        return 'REJECT';
    }

    // 2. Groq LLM fallback for conversational/complex sentences (Multi-lingual: Hindi/Hinglish/English)
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey && groqKey.startsWith('gsk_')) {
        try {
            const prompt = `A scrap pickup partner received a dispatch job offer on WhatsApp.
Classify their response into strictly one of three words: ACCEPT, REJECT, or OTHER.
Response: "${rawText}"
Rules:
- If they are agreeing to take or accept the order (in ANY language: Hindi, Hinglish, English, e.g. "मैं इस आफर को सेप्ट करता हूँ", "हामेल लेलूंगा", "order de do", "I will do it", "accept karunga"), reply ACCEPT.
- If they are declining, saying no, busy, or rejecting, reply REJECT.
- Otherwise reply OTHER.
Reply with ONLY the word ACCEPT, REJECT, or OTHER:`;

            const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: { "Authorization": `Bearer ${groqKey}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: "openai/gpt-oss-20b",
                    messages: [{ role: "user", content: prompt }],
                    temperature: 0.0,
                    max_tokens: 150
                })
            });
            const data = await res.json();
            const result = (data.choices?.[0]?.message?.content || '').trim().toUpperCase();
            if (result.includes('ACCEPT')) return 'ACCEPT';
            if (result.includes('REJECT')) return 'REJECT';
        } catch (e) {
            console.warn('Groq accept/reject classification error:', e.message);
        }
    }

    return null;
}

// ─────────────────────────────────────────────────────────────
// AI INTENT CLASSIFIER FOR WEIGHT CONFIRMATION (Groq LLM + Smart Fuzzy)
// Handles "Yes.", "Haan", "sahi hai", "theek hai", "confirm kar do", "nahi galat hai", etc.
// ─────────────────────────────────────────────────────────────
async function classifyConfirmationIntent(rawText) {
    if (!rawText) return null;
    const clean = rawText.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?"'“”]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

    // 1. Fast local checks
    const confirmPhrases = [
        '1', 'yes', 'haan', 'ha', 'haa', 'hn', 'haanji', 'haji', 'ok', 'okay', 'done', 'yup', 'yeah',
        'sahi', 'sahi hai', 'sahi h', 'theek', 'theek hai', 'theek h', 'thik', 'thik hai', 'confirm',
        'confirmed', 'confirm hai', 'kar do', 'krdo', 'kar dijiye', 'complete', 'bilkul', 'bilkul sahi',
        'all good', 'correct', 'right'
    ];
    const devanagariConfirm = ['हाँ', 'हां', 'हाँजी', 'सही', 'सही है', 'ठीक है', 'कन्फर्म', 'कर दो'];

    const rejectPhrases = [
        '2', 'no', 'nahi', 'nahin', 'na', 'nah', 'galat', 'galat hai', 'wrong', 'change', 'badalna',
        'cancel', 'dobara', 'reenter', 'not correct', 'incorrect'
    ];
    const devanagariReject = ['नहीं', 'गलत', 'गलत है', 'बदलो', 'रद्द'];

    if (confirmPhrases.some(w => clean === w || clean.startsWith(w + ' ') || clean.endsWith(' ' + w) || clean.includes(w)) || devanagariConfirm.some(w => rawText.includes(w))) {
        if (!clean.includes('not correct') && !clean.includes('nahi hai') && !clean.includes('sahi nahi')) {
            return 'CONFIRM';
        }
    }

    if (rejectPhrases.some(w => clean === w || clean.includes(w)) || devanagariReject.some(w => rawText.includes(w))) {
        return 'REJECT';
    }

    // 2. Groq LLM fallback for conversational Hindi/Hinglish/English
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey && groqKey.startsWith('gsk_')) {
        try {
            const prompt = `A user was asked: "Should I confirm this scrap weight breakdown?".
Classify their response into strictly one of three words: CONFIRM, REJECT, or OTHER.
Response: "${rawText}"
Rules:
- If they are agreeing, confirming, or saying it is correct (in ANY language: Hindi, Hinglish, English, e.g. "Yes.", "sahi hai ji", "haan bhai kar do", "हाँ", "it is fine"), reply CONFIRM.
- If they are disagreeing, saying it is wrong or want to change, reply REJECT.
- Otherwise reply OTHER.
Reply with ONLY the word CONFIRM, REJECT, or OTHER:`;

            const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: { "Authorization": `Bearer ${groqKey}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: "openai/gpt-oss-20b",
                    messages: [{ role: "user", content: prompt }],
                    temperature: 0.0,
                    max_tokens: 150
                })
            });
            const data = await res.json();
            const result = (data.choices?.[0]?.message?.content || '').trim().toUpperCase();
            if (result.includes('CONFIRM')) return 'CONFIRM';
            if (result.includes('REJECT')) return 'REJECT';
        } catch (e) {
            console.warn('Groq confirmation classification error:', e.message);
        }
    }

    return null;
}

// ─────────────────────────────────────────────────────────────
// CONVERSATIONAL AI ASSISTANT FOR WHATSAPP (Groq LLM)
// Answers inquiries from Kabadiwalas or residents in chosen language (Hindi/Hinglish/English)
// ─────────────────────────────────────────────────────────────
async function getWhatsAppAIReply(userQuery, userName = 'Partner', lang = 'hinglish', contextData = {}) {
    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey || !groqKey.startsWith('gsk_')) return null;

    let langInstruction = 'Respond STRICTLY in polite Hinglish (Hindi written in Roman/English alphabet, mixed with simple English words). DO NOT write in Devanagari script or pure English.';
    if (lang === 'hindi') {
        langInstruction = 'Respond STRICTLY in polite, respectful Hindi written entirely in Devanagari script (हिंदी लिपि). DO NOT reply in English or Roman Hinglish.';
    } else if (lang === 'english') {
        langInstruction = 'Respond STRICTLY in clear, polite, simple English. DO NOT use any Hindi or Hinglish words.';
    }

    try {
        let orderContextStr = "No active assigned orders right now.";
        if (contextData.activePickups && contextData.activePickups.length > 0) {
            orderContextStr = contextData.activePickups.map((p, idx) => {
                return `Order #${p.request_id}:
• Customer Name: ${p.customer_name || 'Resident'}
• Address: ${p.customer_address || 'Local'} (PIN: ${p.customer_pincode || '—'})
• Customer Phone: ${p.customer_phone || '—'}
• Waste Items: ${p.items || 'Standard recyclables'}
• Time Slot: ${p.time_slot || 'Today'}`;
            }).join('\n\n');
        }

        const prompt = `You are "Terra AI", the intelligent, warm, respectful WhatsApp copilot for Circular waste collection partners (Kabadiwalas) in India.
Partner Name: ${userName}

CURRENT LIVE CONTEXT:
[Active Assigned Pickups for this Partner]:
${orderContextStr}

[Official Circular Scrap Rates (40% Household Payout)]:
• Cardboard / Gatta (गत्ता): ₹12/kg
• Plastic Bottles & Containers (प्लास्टिक): ₹14/kg
• Iron & Scrap Metals (लोहा): ₹28/kg
• Brass / Peetal (पीतल): ₹320/kg
• Copper / Taamba (तांबा): ₹430/kg
• Newspaper / Raddi (रद्दी / अखबार): ₹10/kg

[Partner Operating Status]:
• Duty Status: ${contextData.dutyStatus ? 'ON DUTY 🟢' : 'OFF DUTY 🔴'}
• Area: ${contextData.area || 'City Area'}

[Doorstep Verification Guidelines]:
• When reaching customer address: Ask customer to show QR code on their Circular web app.
• Take photo of customer's QR code and send on WhatsApp, OR enter the 4-digit PIN displayed on customer's phone screen.
• Weigh scrap items and send the weights (e.g. 'Gatta 8 kg, Plastic 4 kg' or send voice note).

CRITICAL LANGUAGE REQUIREMENT:
${langInstruction}

INSTRUCTIONS:
1. Answer the partner directly, respectfully, and concisely (2 to 3 sentences max).
2. If the partner asks how to reach the customer, where the customer is, or for their address/phone, provide their active assigned order address and customer details from above!
3. If they ask about rates or prices, quote the official rates above.
4. Keep the tone friendly, practical, and helpful (like a respectful supervisor or partner). Use appropriate emojis.
5. If they ask something completely unrelated, gently guide them back to their scrap collection work.

Partner's Question: "${userQuery}"`;

        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: { "Authorization": `Bearer ${groqKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "qwen/qwen3.8-27b",
                messages: [
                    { role: "system", content: "You are Terra AI, the WhatsApp copilot for Circular scrap collection partners. Answer concisely and accurately based on provided live context." },
                    { role: "user", content: prompt }
                ],
                max_tokens: 220,
                temperature: 0.3
            })
        });

        const data = await res.json();
        return data.choices?.[0]?.message?.content?.trim() || null;
    } catch (e) {
        console.warn('WhatsApp AI reply failed:', e.message);
        return null;
    }
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
            SELECT id, name, phone_number, language 
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
    const lang = currentCollector.language || 'hinglish';

    console.log(`[Dispatch] Offering #${reqId} to collector #${currentCollector.id} (${currentCollector.name}) [Lang: ${lang}] with 60s timeout...`);

    let offerMsg = '';
    if (lang === 'hindi') {
        offerMsg = 
            `🔔 *नया पिकअप ऑफर! (New Request)* 🔔\n\n` +
            `नमस्ते *${currentCollector.name || 'पार्टनर'}* जी!\n` +
            `आपके एरिया में नया पिकअप बुक हुआ है:\n\n` +
            `• ऑर्डर आईडी: *#${dispatch.requestId}*\n` +
            `• कस्टमर: *${dispatch.customer?.name || 'नागरिक'}*\n` +
            `• पता: *${dispatch.customer?.address || 'लोकल'}* (पिन: ${dispatch.customer?.pincode || '—'})\n` +
            `• सामग्री: *${dispatch.items}* (${dispatch.quantity || 'Standard'})\n` +
            `• समय: *${dispatch.time_slot}*\n\n` +
            `⏱️ *स्वीकार करने के लिए आपके पास 60 सेकंड हैं!*\n\n` +
            `स्वीकार करने के लिए लिखें:\n` +
            `👉 *ACCEPT*\n\n` +
            `अस्वीकार करने के लिए लिखें:\n` +
            `👉 *REJECT*`;
    } else if (lang === 'english') {
        offerMsg = 
            `🔔 *NEW PICKUP OFFER!* 🔔\n\n` +
            `Hello *${currentCollector.name || 'Partner'}*!\n` +
            `A new pickup has been requested in your area:\n\n` +
            `• Order ID: *#${dispatch.requestId}*\n` +
            `• Customer: *${dispatch.customer?.name || 'Resident'}*\n` +
            `• Address: *${dispatch.customer?.address || 'Local'}* (PIN: ${dispatch.customer?.pincode || '—'})\n` +
            `• Items: *${dispatch.items}* (${dispatch.quantity || 'Standard'})\n` +
            `• Time Slot: *${dispatch.time_slot}*\n\n` +
            `⏱️ *You have 60 SECONDS to accept this pickup!*\n\n` +
            `To accept, reply:\n` +
            `👉 *ACCEPT*\n\n` +
            `To reject, reply:\n` +
            `👉 *REJECT*`;
    } else {
        offerMsg = 
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
    }

    await sendWhatsAppAlert(collectorPhone, offerMsg);

    // Voice Note Addon for Kabadiwala
    const spokenOffer = (lang === 'hindi')
        ? `नमस्ते ${currentCollector.name || 'पार्टनर'} भाई! नया पिकअप ऑर्डर आया है। अगर आप यह ऑर्डर लेना चाहते हैं, तो माइक दबाकर 'हाँ ले लूँगा' बोलिए।`
        : `Namaste ${currentCollector.name || 'Partner'} bhai! Naya pickup order aaya hai. Agar aap lena chahte hain, toh mic daba kar 'Haan' ya 'Accept' boliye.`;
    await sendWhatsAppVoiceNote(collectorPhone, spokenOffer, 'hi').catch(e => {});

    // 60-second countdown timer
    dispatch.timer = setTimeout(async () => {
        console.log(`[Dispatch] 60s timeout elapsed for collector ${currentCollector.name} on #${reqId}`);
        
        const timeoutMsg = (lang === 'hindi')
            ? `⏱️ *समय समाप्त!* #${dispatch.requestId} का 60-सेकंड समय पूरा हो गया। यह ऑफर अगले पार्टनर को भेज दिया गया है।`
            : (lang === 'english')
            ? `⏱️ *Time Expired!* The 60-second window for #${dispatch.requestId} has expired. Offer forwarded to next partner.`
            : `⏱️ *Time Expired!* #${dispatch.requestId} ka 60-second samay pura ho gaya. Yeh offer agle partner ko forward kar di gayi hai.`;

        sendWhatsAppAlert(collectorPhone, timeoutMsg).catch(e => console.error(e));

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
        const userProcessingQueue = {};

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

                // Strict sequential FIFO per phone (prevents message race conditions)
                const prevTask = userProcessingQueue[phone] || Promise.resolve();
                let notifyDone;
                userProcessingQueue[phone] = new Promise(res => { notifyDone = res; });
                await prevTask;

                try {

                // Extract message body text
                let text = (
                    msg.message.conversation ||
                    msg.message.extendedTextMessage?.text ||
                    ''
                ).trim();

                // 🎙️ WHATSAPP VOICE NOTE HANDLER (Groq Whisper AI)
                let isIncomingVoiceNote = false;
                if (!text && msg.message.audioMessage) {
                    isIncomingVoiceNote = true;
                    try {
                        console.log(`🎙️ [WhatsApp Voice Note] Audio received from ${phone}. Transcribing with Groq Whisper...`);
                        const audioBuffer = await downloadMediaMessage(
                            msg,
                            'buffer',
                            {},
                            {
                                logger: pino({ level: 'silent' }),
                                reuploadRequest: sock.updateMediaMessage
                            }
                        );

                        if (audioBuffer && audioBuffer.length > 0) {
                            const form = new FormData();
                            const mime = msg.message.audioMessage.mimetype || 'audio/ogg';
                            const blob = new Blob([audioBuffer], { type: mime });
                            form.append('file', blob, 'voice.ogg');
                            form.append('model', 'whisper-large-v3-turbo');
                            form.append('prompt', 'Hindi, Hinglish, and English scrap collection speech: हाँ मैं ले लूँगा, ha main le lunga, accept, I will accept this order, reject, nahi, cancel, haan, yes, confirm, sahi hai, theek hai, plastic, gatta, raddi, loha, cardboard, kgs, kilo.');

                            const whisperRes = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
                                method: 'POST',
                                headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
                                body: form
                            });

                            const whisperData = await whisperRes.json();
                            if (whisperData.text) {
                                text = whisperData.text.trim();
                                console.log(`🎙️ [Groq Whisper] Transcribed text: "${text}"`);
                                await sock.sendMessage(remoteJid, {
                                    text: `🎙️ *Voice Note:* _"${text}"_\n⏳ Processing...`
                                });
                            } else {
                                console.warn('Whisper transcription returned no text:', whisperData);
                            }
                        }
                    } catch (voiceErr) {
                        console.error('Error downloading or transcribing WhatsApp voice note:', voiceErr);
                    }
                }

                // 📸 WHATSAPP QR PHOTO HANDLER (Auto-decode QR code from camera snapshot)
                if (!text && msg.message.imageMessage) {
                    try {
                        console.log(`📸 [WhatsApp Image] Photo received from ${phone}. Scanning for customer QR Code...`);
                        const imageBuffer = await downloadMediaMessage(
                            msg,
                            'buffer',
                            {},
                            {
                                logger: pino({ level: 'silent' }),
                                reuploadRequest: sock.updateMediaMessage
                            }
                        );

                        if (imageBuffer && imageBuffer.length > 0) {
                            const qrText = await decodeQRFromImageBuffer(imageBuffer);
                            if (qrText) {
                                text = qrText;
                                console.log(`📸 [QR Photo Scanned]: "${text}"`);
                                await sock.sendMessage(remoteJid, {
                                    text: `📸 *QR Code Photo Scanned!* ⚡\n⏳ Verifying pickup with customer...`
                                });
                            } else {
                                console.log('No QR code detected in image.');
                                await sock.sendMessage(remoteJid, {
                                    text: `⚠️ *QR Code Detect Nahi Hua!*\nKripya customer ke phone screen ka QR code thoda saaf aur paas se kheench kar bhejein, ya Security PIN likh kar bhejein.`
                                });
                            }
                        }
                    } catch (imgErr) {
                        console.error('Error downloading or decoding WhatsApp image:', imgErr);
                    }
                }

                if (!text && !msg.message.locationMessage) continue;

                const lowerBody = text.toLowerCase();
                const db = await getDb();

                // Look up in database (check by clean digits, +phone, or LID if available)
                const stmt = db.prepare('SELECT * FROM collectors WHERE REPLACE(phone_number, "+", "") = ? OR phone_number = ? OR phone_number = ?');
                stmt.bind([cleanDigits, phone, `+${resolved.lid || ''}`]);
                let collector = null;
                if (stmt.step()) collector = stmt.getAsObject();
                stmt.free();

                const reply = async (replyText, spokenAddon = null) => {
                    await sock.sendMessage(remoteJid, { text: replyText });
                    // Always send companion voice note to Kabadiwala (regardless of text, photo, or voice input) in strict sequential order
                    const toSpeak = spokenAddon || replyText;
                    await sendWhatsAppVoiceNote(remoteJid, toSpeak, 'hi').catch(e => {
                        console.warn('Voice send error:', e.message);
                    });
                };

                // ── 0. PICKUP ACCEPT / REJECT HANDLER (60s Dispatch System) ─────
                // First check if this collector is currently offered an active dispatch
                const targetDispatchForCollector = Object.values(activeDispatches).find(d => {
                    const cur = d.candidates[d.currentIndex];
                    if (!cur) return false;
                    const curDigits = cur.phone_number.replace(/\D/g, '');
                    return (
                        curDigits === cleanDigits ||
                        cur.phone_number === phone ||
                        (resolved.lid && curDigits === resolved.lid)
                    );
                });

                const explicitAccept = text.match(/^\s*ACCEPT(?:[_\s]+([A-Za-z0-9\-_]+))?\s*$/i);
                const explicitReject = text.match(/^\s*REJECT(?:[_\s]+([A-Za-z0-9\-_]+))?\s*$/i);

                // AI-driven intent classification for voice notes and conversational messages ("मैं इस आफर को सेप्ट करता हूँ", "meh yeh order accept krta hu", etc.)
                const dispatchIntent = targetDispatchForCollector ? await classifyAcceptRejectIntent(text) : null;
                const quickAccept = dispatchIntent === 'ACCEPT';
                const quickReject = dispatchIntent === 'REJECT';

                const acceptMatch = explicitAccept || quickAccept;
                const rejectMatch = explicitReject || quickReject;

                if (acceptMatch || rejectMatch) {
                    const specifiedReqId = (explicitAccept ? explicitAccept[1] : (explicitReject ? explicitReject[1] : null))?.trim().toUpperCase();
                    let targetDispatch = null;

                    if (specifiedReqId && activeDispatches[specifiedReqId]) {
                        targetDispatch = activeDispatches[specifiedReqId];
                    } else {
                        targetDispatch = targetDispatchForCollector;
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

                    const collLang = currentCandidate?.language || collector?.language || 'hinglish';

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

                        // Confirmation to Collector in their chosen language
                        let acceptConfirmation = '';
                        if (collLang === 'hindi') {
                            acceptConfirmation = 
                                `🎉 *पिकअप स्वीकार कर लिया गया!* 🎉\n\n` +
                                `ऑर्डर *#${reqId}* आपको सफलतापूर्वक असाइन कर दिया गया है।\n\n` +
                                `• कस्टमर: *${targetDispatch.customer?.name || 'नागरिक'}*\n` +
                                `• पता: *${targetDispatch.customer?.address || 'लोकल'}* (पिन: ${targetDispatch.customer?.pincode || '—'})\n` +
                                `• सामग्री: *${targetDispatch.items}*\n` +
                                `• समय: *${targetDispatch.time_slot}*\n\n` +
                                `📍 कस्टमर के घर पहुँचकर उनके ऐप से QR कोड स्कैन करें।\n\n` +
                                `कृपया समय पर पहुँचकर कचरा कलेक्ट करें! धन्यवाद 🙏`;
                        } else if (collLang === 'english') {
                            acceptConfirmation = 
                                `🎉 *Pickup Accepted!* 🎉\n\n` +
                                `Order *#${reqId}* has been successfully assigned to you.\n\n` +
                                `• Customer: *${targetDispatch.customer?.name || 'Resident'}*\n` +
                                `• Address: *${targetDispatch.customer?.address || 'Local'}* (PIN: ${targetDispatch.customer?.pincode || '—'})\n` +
                                `• Items: *${targetDispatch.items}*\n` +
                                `• Time Slot: *${targetDispatch.time_slot}*\n\n` +
                                `📍 Upon arrival at the doorstep, scan the QR code from the customer's phone.\n\n` +
                                `Please collect the waste on time! Thank you 🙏`;
                        } else {
                            acceptConfirmation = 
                                `🎉 *Pickup Accepted!* 🎉\n\n` +
                                `Order *#${reqId}* aapko successfully assign kar diya gaya hai.\n\n` +
                                `• Customer: *${targetDispatch.customer?.name || 'Resident'}*\n` +
                                `• Address: *${targetDispatch.customer?.address || 'Local'}* (PIN: ${targetDispatch.customer?.pincode || '—'})\n` +
                                `• Items: *${targetDispatch.items}*\n` +
                                `• Time Slot: *${targetDispatch.time_slot}*\n\n` +
                                `📍 Doorstep par pahunch kar customer ke app se QR code scan karein.\n\n` +
                                `Kripya time par pahunch kar waste collect karein! Dhanyawad 🙏`;
                        }
                        const spokenAccept = (collLang === 'hindi')
                            ? `बधाई हो भाई जी! यह ऑर्डर आपके नाम कन्फर्म हो गया है। कस्टमर का पता स्क्रीन पर भेज दिया है।`
                            : `Badhaai ho bhai ji! Yeh order aapke naam confirm ho gaya hai. Customer ka address chat mein bhej diya hai.`;
                        await reply(acceptConfirmation, spokenAccept);

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

                        const declineMsg = (collLang === 'hindi')
                            ? `आपने #${targetDispatch.requestId} अस्वीकार कर दिया है। धन्यवाद।`
                            : (collLang === 'english')
                            ? `You have declined order #${targetDispatch.requestId}. Thank you.`
                            : `Aapne #${targetDispatch.requestId} decline kar diya hai. Dhanyawad.`;
                        await reply(declineMsg);

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
                    const collLang = collector.language || 'hinglish';
                    pendingVerifications[phone] = {
                        pickupId: pickup.id,
                        requestId: pickup.request_id,
                        userId: pickup.user_id,
                        customerName: pickup.customer_name || 'Resident',
                        customerPhone: pickup.customer_phone,
                        items: pickup.items,
                        role: pickup.role,
                        ptsEarned: ptsEarned,
                        lang: collLang,
                        timestamp: Date.now()
                    };

                    let verifyPrompt = '';
                    if (collLang === 'hindi') {
                        verifyPrompt = 
                            `🔍 *डोरस्टेप वेरिफिकेशन जारी है!* ⚖️\n\n` +
                            `• ऑर्डर आईडी: *#${pickup.request_id}*\n` +
                            `• कस्टमर: *${pickup.customer_name || 'नागरिक'}*\n` +
                            `• पता: ${pickup.customer_address || ''} (${pickup.customer_pincode || ''})\n\n` +
                            `📋 *इस पिकअप में बुक किया गया कचरा:*\n` +
                            `👉 *${pickup.items}*\n\n` +
                            `⚖️ *कृपया इनका वजन (kg) नापकर रिप्लाई करें:*\n` +
                            `• जैसे: *Cardboard 10, Plastic 4, Paper 5*\n` +
                            `• या: *गत्ता 8 kg, लोहा 2 kg*\n` +
                            `• या कुल वजन: *15 kg*\n\n` +
                            `⚠️ *नोट:* वजन दर्ज करने के बाद ही पिकअप *सफलतापूर्वक पूर्ण (Completed)* होगा।`;
                    } else if (collLang === 'english') {
                        verifyPrompt = 
                            `🔍 *Doorstep Verification In-Progress!* ⚖️\n\n` +
                            `• Order ID: *#${pickup.request_id}*\n` +
                            `• Customer: *${pickup.customer_name || 'Resident'}*\n` +
                            `• Address: ${pickup.customer_address || ''} (${pickup.customer_pincode || ''})\n\n` +
                            `📋 *Booked Waste Items:*\n` +
                            `👉 *${pickup.items}*\n\n` +
                            `⚖️ *Please weigh the scrap and reply with the weight in kg:*\n` +
                            `• e.g.: *Cardboard 10, Plastic 4, Paper 5*\n` +
                            `• or total: *15 kg*\n\n` +
                            `⚠️ *Note:* Pickup will only be officially completed after weight entry.`;
                    } else {
                        verifyPrompt = 
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
                            `⚠️ *Note:* Weight enter karne ke baad hi pickup *Officially Complete* hoga.`;
                    }

                    const spokenPrompt = (collLang === 'hindi')
                        ? `शाबाश भाई जी! क्यूआर कोड वेरीफाई हो गया है। अब कचरे का वजन नापकर, बोलकर या लिखकर भेज दीजिए।`
                        : `Shabaash bhai ji! QR code verify ho gaya hai. Ab kachre ka weight naap kar bolkar ya type karke bhej dijiye.`;
                    await reply(verifyPrompt, spokenPrompt);
                    continue;
                }

                // ── B. MATERIAL-WISE WEIGHT VERIFICATION & OFFICIAL COMPLETION ────────────
                if (pendingVerifications[phone]) {
                    const session = pendingVerifications[phone];
                    const collLang = session.lang || collector?.language || 'hinglish';

                    // 1. If we are currently awaiting confirmation for parsed weights:
                    if (session.pendingParsed) {
                        // AI-powered confirmation classification (handles "Yes.", "Haan", "sahi hai", etc.)
                        const confIntent = await classifyConfirmationIntent(text);
                        const isConfirm = confIntent === 'CONFIRM';
                        const isReject  = confIntent === 'REJECT';

                        if (isConfirm) {
                            const { items: weightItems, totalWeight, payout, weightSummaryStr, breakdownLines } = session.pendingParsed;
                            const ptsEarned = session.ptsEarned || 50;

                            // NOW officially complete the pickup in SQLite & record verified weights & payout
                            db.run(`
                                UPDATE pickups 
                                SET status = 'Completed',
                                    actual_weight = ?, 
                                    material_weights = ?,
                                    payout_amount = ?,
                                    completed_at = datetime('now', 'localtime')
                                WHERE id = ?
                            `, [totalWeight, weightSummaryStr, payout, session.pickupId]);

                            // NOW award Green Points and wallet cash to user
                            db.run(`
                                UPDATE users 
                                SET points = COALESCE(points, 0) + ?,
                                    wallet_balance = COALESCE(wallet_balance, 0) + ?
                                WHERE id = ?
                            `, [ptsEarned, payout, session.userId]);

                            // Record credit transaction into wallet history
                            db.run(`
                                INSERT INTO transactions (user_id, type, title, description, amount, points, direction, status, reference_id, created_at)
                                VALUES (?, 'scrap_payout', ?, ?, ?, ?, 'credit', 'Completed', ?, datetime('now', 'localtime'))
                            `, [
                                session.userId,
                                `Scrap Payout • #${session.requestId}`,
                                `Doorstep weigh-in verified (${totalWeight} kg recyclables)`,
                                payout,
                                ptsEarned,
                                session.requestId
                            ]);

                            persist();
                            delete pendingVerifications[phone];

                            // Confirmation celebration to Collector in their language
                            let compMsg = '';
                            if (collLang === 'hindi') {
                                compMsg = 
                                    `✅ *पिकअप सफलतापूर्वक वेरीफाई और पूर्ण हो गया!* 🎉\n\n` +
                                    `• ऑर्डर आईडी: *#${session.requestId}*\n` +
                                    `• कस्टमर: *${session.customerName}*\n\n` +
                                    `*दर्ज किया गया वजन विवरण:*\n` +
                                    `${breakdownLines}\n` +
                                    `──────────────────\n` +
                                    `📦 *कुल वजन (Total Weight):* *${totalWeight} kg*\n` +
                                    `💵 *कस्टमर भुगतान:* *₹${payout}*\n\n` +
                                    `पिकअप स्टेटस *Completed* मार्क हो गया है और Hub रिकॉर्ड में दर्ज हो चुका है। धन्यवाद! 👍`;
                            } else if (collLang === 'english') {
                                compMsg = 
                                    `✅ *Pickup Officially Verified & Completed!* 🎉\n\n` +
                                    `• Order ID: *#${session.requestId}*\n` +
                                    `• Customer: *${session.customerName}*\n\n` +
                                    `*Segregated Weight Breakdown:*\n` +
                                    `${breakdownLines}\n` +
                                    `──────────────────\n` +
                                    `📦 *Total Weight:* *${totalWeight} kg*\n` +
                                    `💵 *Customer Payout:* *₹${payout}*\n\n` +
                                    `Pickup status marked *Completed* and logged to Hub floor records. Thank you! 👍`;
                            } else {
                                compMsg = 
                                    `✅ *Pickup Officially Verified & Completed!* 🎉\n\n` +
                                    `• Order ID: *#${session.requestId}*\n` +
                                    `• Customer: *${session.customerName}*\n\n` +
                                    `*Segregated Weight Breakdown:*\n` +
                                    `${breakdownLines}\n` +
                                    `──────────────────\n` +
                                    `📦 *Total Weight:* *${totalWeight} kg*\n` +
                                    `💵 *Customer Payout:* *₹${payout}*\n\n` +
                                    `Pickup status *Completed* mark ho gaya hai aur Hub records me save ho chuka hai. Dhanyawad! 👍`;
                            }
                            const spokenComp = (collLang === 'hindi')
                                ? `शाबाश भाई जी! यह पिकअप पूरा हो गया है। कुल ${totalWeight} किलो का वजन नोट कर लिया है, और कस्टमर को पेमेंट भी भेज दिया गया है। बहुत बढ़िया काम!`
                                : `Shabaash bhai ji! Yeh pickup poora ho gaya hai. Kul ${totalWeight} kilo ka weight note kar liya hai, aur customer ko payout bhej diya gaya hai. Bahut badhiya!`;
                            await reply(compMsg, spokenComp);

                            // Official completion & weight alert to Customer on WhatsApp
                            if (session.customerPhone) {
                                sendWhatsAppAlert(session.customerPhone,
                                    `🌿 *circular. Pickup Completed!* 🌿\n\n` +
                                    `Hi *${session.customerName}*,\n` +
                                    `Aapka pickup *#${session.requestId}* collection partner dwara successfully collect kar liya gaya hai!\n\n` +
                                    `*Verified Waste Collected:*\n` +
                                    `${breakdownLines}\n` +
                                    `──────────────────\n` +
                                    `📦 *Total Weight:* *${totalWeight} kg*\n` +
                                    `💵 *Scrap Amount:* *₹${payout}* (Wallet me add ho chuke hain)\n` +
                                    `⭐ Green Points: *+${ptsEarned} pts* (Impact Score - not cash)\n\n` +
                                    `Thank you for contributing to a cleaner, zero-waste environment! 🌍`
                                ).catch(e => console.error('Error notifying customer of completion:', e));
                            }
                            continue;
                        } else if (isReject) {
                            delete session.pendingParsed;
                            const retryMsg = (collLang === 'hindi')
                                ? `🔄 *कोई बात नहीं!* कृपया सही वजन दोबारा बोलकर (Voice Note 🎙️) या लिखकर भेजें:`
                                : (collLang === 'english')
                                ? `🔄 *No problem!* Please re-send the correct weight via Voice Note 🎙️ or text:`
                                : `🔄 *Koi baat nahi!* Kripya sahi weight dobara bolkar (Voice Note 🎙️) ya likh kar bhejein:`;
                            await reply(retryMsg);
                            continue;
                        }
                    }

                    // 2. Parse weights from text or voice transcription
                    const parsedWeight = await parseMaterialWeightsSmart(text);

                    if (parsedWeight.items.length > 0 && parsedWeight.totalWeight > 0) {
                        const { items: weightItems, totalWeight } = parsedWeight;
                        const weightSummaryStr = weightItems.map(it => `${it.material}: ${it.weight} kg`).join(', ');
                        
                        // Rule 6: 40% payout to household based on material and weight
                        let calculatedPayout = 0;
                        const breakdownLines = weightItems
                            .map(it => {
                                const itmPayout = calculateMaterialPayout(it.material, it.weight);
                                calculatedPayout += itmPayout;
                                return `• ${it.material}: *${it.weight} kg* (₹${itmPayout})`;
                            })
                            .join('\n');
                        const payout = calculatedPayout;

                        // Save parsed data in session and ask confirmation
                        session.pendingParsed = {
                            items: weightItems,
                            totalWeight,
                            payout,
                            weightSummaryStr,
                            breakdownLines
                        };

                        let confirmPrompt = '';
                        if (collLang === 'hindi') {
                            confirmPrompt = 
                                `📋 *नापा गया वजन विवरण (Weight Breakdown):*\n\n` +
                                `• ऑर्डर आईडी: *#${session.requestId}*\n` +
                                `• कस्टमर: *${session.customerName}*\n\n` +
                                `${breakdownLines}\n` +
                                `──────────────────\n` +
                                `📦 *कुल वजन (Total Weight):* *${totalWeight} kg*\n` +
                                `💵 *Scrap Payout:* *₹${payout}*\n\n` +
                                `❓ *क्या मैं इसे कन्फर्म कर दूँ? (Should I confirm this?)*\n\n` +
                                `1️⃣ *हाँ / YES* - कन्फर्म और कम्पलीट करने के लिए\n` +
                                `2️⃣ *नहीं / NO* - दोबारा वजन बोलने/बदलने के लिए\n\n` +
                                `_जवाब में *हाँ* / *1* या *नहीं* / *2* भेजें:_`;
                        } else if (collLang === 'english') {
                            confirmPrompt = 
                                `📋 *Recorded Weight Breakdown:*\n\n` +
                                `• Order ID: *#${session.requestId}*\n` +
                                `• Customer: *${session.customerName}*\n\n` +
                                `${breakdownLines}\n` +
                                `──────────────────\n` +
                                `📦 *Total Weight:* *${totalWeight} kg*\n` +
                                `💵 *Scrap Payout:* *₹${payout}*\n\n` +
                                `❓ *Should I confirm and complete this pickup?*\n\n` +
                                `1️⃣ Reply *YES* or *1* to Confirm & Complete\n` +
                                `2️⃣ Reply *NO* or *2* to re-enter weight\n\n` +
                                `_Reply with *YES* or *NO*:_`;
                        } else {
                            confirmPrompt = 
                                `📋 *Dikhaya gaya Weight Breakdown:*\n\n` +
                                `• Order ID: *#${session.requestId}*\n` +
                                `• Customer: *${session.customerName}*\n\n` +
                                `${breakdownLines}\n` +
                                `──────────────────\n` +
                                `📦 *Kul Weight (Total):* *${totalWeight} kg*\n` +
                                `💵 *Scrap Payout:* *₹${payout}*\n\n` +
                                `❓ *Kya main isse confirm kar doon? (Should I confirm this?)*\n\n` +
                                `1️⃣ Reply *HAAN*, *YES* ya *1* - Confirm & Complete karne ke liye\n` +
                                `2️⃣ Reply *NAHI*, *NO* ya *2* - Dobara bolne/likhne ke liye\n\n` +
                                `_Reply karein *HAAN* ya *NAHI*:_`;
                        }
                        const spokenConfirm = (collLang === 'hindi')
                            ? `भाई जी, कुल ${totalWeight} किलो का वजन नोट हुआ है। क्या मैं इसे कन्फर्म कर दूँ? हाँ या ना बोलिए।`
                            : `Bhai ji, kul ${totalWeight} kilo ka weight note hua hai. Kya main isse confirm kar doon? Haan ya na boliye.`;
                        await reply(confirmPrompt, spokenConfirm);
                        continue;
                    } else if (session.pendingParsed) {
                        const askAgain = (collLang === 'hindi')
                            ? `❓ *कृपया पुष्टि करें:*\nक्या ऊपर दिया गया वजन सही है?\n\n• *हाँ* / *1* - कन्फर्म करने के लिए\n• *नहीं* / *2* - बदलने के लिए`
                            : (collLang === 'english')
                            ? `❓ *Please confirm:*\nIs the weight breakdown above correct?\n\n• *YES* / *1* - To Confirm\n• *NO* / *2* - To change`
                            : `❓ *Kripya confirm karein:*\nKya upar diya gaya weight sahi hai?\n\n• *HAAN* / *1* - Confirm karne ke liye\n• *NAHI* / *2* - Change karne ke liye`;
                        const spokenAskAgain = (collLang === 'hindi')
                            ? `भाई जी, क्या ऊपर दिया गया वजन सही है? हाँ या ना बोलिए।`
                            : `Bhai ji, kya upar diya gaya weight sahi hai? Haan ya na boliye.`;
                        await reply(askAgain, spokenAskAgain);
                        continue;
                    } else if (text && !text.startsWith('#') && text.toLowerCase() !== 'duty' && text.toLowerCase() !== 'status') {
                        // Gentle reminder if message is received during active weighing
                        const remMsg = (collLang === 'hindi')
                            ? `⚖️ *ऑर्डर #${session.requestId} के लिए वजन पेंडिंग है!*\n\nकस्टमर का कचरा: *${session.items}*\n\nकृपया नापा हुआ वजन (kg) बोलकर या लिखकर भेजें:\n• जैसे: *Cardboard 8, Plastic 3*\n• या कुल: *12 kg*`
                            : (collLang === 'english')
                            ? `⚖️ *Weight entry pending for #${session.requestId}!*\n\nBooked items: *${session.items}*\n\nPlease reply with measured weight (kg):\n• e.g. *Cardboard 8, Plastic 3*\n• or total: *12 kg*`
                            : `⚖️ *Order #${session.requestId} ke liye weight pending hai!*\n\nCustomer ka booked waste: *${session.items}*\n\nKripya measured weight (kg) bolkar ya likh kar bhejein:\n• Jaise: *Cardboard 8, Plastic 3*\n• ya total: *12 kg*`;
                        await reply(remMsg);
                        continue;
                    }
                }

                // Location message check
                const loc = msg.message.locationMessage;
                const latitude = loc ? loc.degreesLatitude : null;
                const longitude = loc ? loc.degreesLongitude : null;

                // 2. BRAND NEW NUMBER (First-time onboarding: Choose Language first)
                if (!collector) {
                    db.run(
                        `INSERT INTO collectors (phone_number, onboarding_step, language) VALUES (?, 'AWAITING_LANGUAGE', 'hinglish')`,
                        [phone]
                    );
                    db.run(
                        `UPDATE collectors SET employee_id = 'KW-' || (1000 + id) WHERE phone_number = ? AND (employee_id IS NULL OR employee_id = '')`,
                        [phone]
                    );
                    persist();

                    await reply(
                        `🌿 *Namaste! Welcome to Circular Partner!* 🌿\n\n` +
                        `Kripya apni pasandeeda bhasha chunein:\n` +
                        `Please select your preferred language:\n\n` +
                        `1️⃣ *हिंदी* (Hindi)\n` +
                        `2️⃣ *Hinglish* (Hindi in English letters)\n` +
                        `3️⃣ *English*\n\n` +
                        `_Reply with *1*, *2*, or *3*:_`
                    );
                    continue;
                }

                // 3. EXPLICIT RESET COMMAND (Protected with #RESET to avoid accidental trigger)
                if (lowerBody === '#reset' || lowerBody === 'reset profile') {
                    db.run(`UPDATE collectors SET onboarding_step = 'AWAITING_LANGUAGE' WHERE id = ?`, [collector.id]);
                    persist();
                    await reply(
                        `🔄 *Profile Reset!*\n\n` +
                        `Kripya apni pasandeeda bhasha chunein:\n` +
                        `Please select your preferred language:\n\n` +
                        `1️⃣ *हिंदी* (Hindi)\n` +
                        `2️⃣ *Hinglish* (Hindi in English letters)\n` +
                        `3️⃣ *English*\n\n` +
                        `_Reply with *1*, *2*, or *3*:_`
                    );
                    continue;
                }

                // 4. LANGUAGE SWITCH COMMAND ANYTIME
                if (lowerBody === 'lang' || lowerBody === 'language' || lowerBody === 'bhasha') {
                    db.run(`UPDATE collectors SET onboarding_step = 'AWAITING_LANGUAGE' WHERE id = ?`, [collector.id]);
                    persist();
                    await reply(
                        `🌐 *Change Language / भाषा बदलें:*\n\n` +
                        `1️⃣ *हिंदी* (Hindi)\n` +
                        `2️⃣ *Hinglish* (Hindi in English letters)\n` +
                        `3️⃣ *English*\n\n` +
                        `_Reply with *1*, *2*, or *3*:_`
                    );
                    continue;
                }

                // 5. ON / OFF DUTY TOGGLE
                if (lowerBody === 'duty' || lowerBody === 'status') {
                    const newStatus = collector.is_available ? 0 : 1;
                    db.run(`UPDATE collectors SET is_available = ? WHERE id = ?`, [newStatus, collector.id]);
                    persist();
                    const lang = collector.language || 'hinglish';
                    let dutyMsg = '';
                    if (lang === 'hindi') {
                        const statusText = newStatus ? '🟢 ON DUTY (पिकअप के लिए उपलब्ध)' : '🔴 OFF DUTY (अनुपलब्ध)';
                        dutyMsg = `आपका करंट स्टेटस बदल दिया गया है:\n\n*${statusText}*\n\n_ड्यूटी बदलने के लिए *DUTY* लिखें।_`;
                    } else if (lang === 'english') {
                        const statusText = newStatus ? '🟢 ON DUTY (Available for pickups)' : '🔴 OFF DUTY (Inactive)';
                        dutyMsg = `Your duty status has been updated:\n\n*${statusText}*\n\n_Type *DUTY* anytime to toggle._`;
                    } else {
                        const statusText = newStatus ? '🟢 ON DUTY (Available for pickups)' : '🔴 OFF DUTY (Inactive)';
                        dutyMsg = `Aapka current status badal diya gaya hai:\n\n*${statusText}*\n\n_Duty on/off karne ke liye *DUTY* likhein._`;
                    }
                    await reply(dutyMsg);
                    continue;
                }

                // Common greetings filter
                const isGreeting = ['hi', 'hello', 'hey', 'namaste', 'pranam', 'hii', 'hlo'].includes(lowerBody);

                // 6. CONVERSATION STATE MACHINE
                switch (collector.onboarding_step) {

                    case 'AWAITING_LANGUAGE': {
                        let chosenLang = null;
                        const cleanChoice = lowerBody.trim();

                        if (cleanChoice === '1' || cleanChoice.includes('hindi') || cleanChoice.includes('हिन्दी') || cleanChoice.includes('हिंदी')) {
                            chosenLang = 'hindi';
                        } else if (cleanChoice === '2' || cleanChoice.includes('hinglish')) {
                            chosenLang = 'hinglish';
                        } else if (cleanChoice === '3' || cleanChoice.includes('english') || cleanChoice.includes('angrezi')) {
                            chosenLang = 'english';
                        }

                        if (!chosenLang) {
                            await reply(
                                `Kripya 1, 2, ya 3 bhej kar chunein:\n` +
                                `Please select a valid option (1, 2, or 3):\n\n` +
                                `1️⃣ हिंदी (Hindi)\n` +
                                `2️⃣ Hinglish\n` +
                                `3️⃣ English`
                            );
                            break;
                        }

                        const nextStep = (collector.name && collector.operating_area && collector.pincode && collector.materials) 
                            ? 'COMPLETED' 
                            : 'AWAITING_NAME';

                        db.run(`UPDATE collectors SET language = ?, onboarding_step = ? WHERE id = ?`, [chosenLang, nextStep, collector.id]);
                        persist();
                        collector.language = chosenLang;
                        collector.onboarding_step = nextStep;

                        if (nextStep === 'COMPLETED') {
                            if (chosenLang === 'hindi') {
                                await reply(`✅ भाषा बदलकर *हिंदी* कर दी गई है।\n\nऑर्डर्स देखने के लिए *PICKUPS* या ड्यूटी के लिए *DUTY* लिखें।`);
                            } else if (chosenLang === 'english') {
                                await reply(`✅ Preferred language updated to *English*.\n\nType *PICKUPS* to view orders or *DUTY* to toggle duty.`);
                            } else {
                                await reply(`✅ Bhasha badalkar *Hinglish* kar di gayi hai.\n\nOrders dekhne ke liye *PICKUPS* ya duty ke liye *DUTY* bhejein.`);
                            }
                            break;
                        }

                        if (chosenLang === 'hindi') {
                            await reply(
                                `धन्यवाद! 🙏\n\n` +
                                `वेस्ट कलेक्शन पार्टनर बनने के लिए कृपया अपना *पूरा नाम (Full Name)* लिखकर भेजें:`
                            );
                        } else if (chosenLang === 'english') {
                            await reply(
                                `Thank you! 🙏\n\n` +
                                `To register as a Waste Collection Partner, please reply with your *Full Name*:`
                            );
                        } else {
                            await reply(
                                `Dhanyawad! 🙏\n\n` +
                                `Waste collection partner banne ke liye kripya apna *Poora Naam (Full Name)* likh kar bhejein:`
                            );
                        }
                        break;
                    }

                    case 'AWAITING_NAME': {
                        const lang = collector.language || 'hinglish';
                        // Prevent greetings or 1-letter garbage as name
                        if (isGreeting || text.length < 2 || !/^[a-zA-Z\s\u0900-\u097F]+$/.test(text)) {
                            if (lang === 'hindi') {
                                await reply(`कृपया अपना असली नाम लिखकर भेजें (जैसे: *रमेश कुमार*):`);
                            } else if (lang === 'english') {
                                await reply(`Please reply with your real name (e.g. *Ramesh Kumar*):`);
                            } else {
                                await reply(`Kripya apna asali naam likh kar bhejein (jaise: *Ramesh Kumar*):`);
                            }
                            break;
                        }

                        db.run(
                            `UPDATE collectors SET name = ?, onboarding_step = 'AWAITING_AREA' WHERE id = ?`,
                            [text, collector.id]
                        );
                        persist();
                        collector.name = text;

                        if (lang === 'hindi') {
                            await reply(
                                `धन्यवाद *${text}* जी! 🙏\n\n` +
                                `आप किस एरिया / मोहल्ले में कलेक्शन करते हैं? (अपने क्षेत्र या लोकलिटी का नाम लिखें):`
                            );
                        } else if (lang === 'english') {
                            await reply(
                                `Thank you *${text}*! 🙏\n\n` +
                                `Which locality / area do you operate in? (Please reply with your operating area name):`
                            );
                        } else {
                            await reply(
                                `Dhanyawad *${text}* ji! 🙏\n\n` +
                                `Aap kis area / locality me collection karte hain? (Complete area name ya locality likhein):`
                            );
                        }
                        break;
                    }

                    case 'AWAITING_AREA': {
                        const lang = collector.language || 'hinglish';
                        if (isGreeting || text.length < 3) {
                            if (lang === 'hindi') {
                                await reply(`कृपया अपने सही एरिया / मोहल्ले का नाम लिखें (जैसे: *मॉडल टाउन* या *सेक्टर 14*):`);
                            } else if (lang === 'english') {
                                await reply(`Please enter your operating area or locality (e.g. *Model Town* or *Sector 14*):`);
                            } else {
                                await reply(`Kripya apni sahi locality / area ka naam likhein (jaise: *Model Town* ya *Sector 14*):`);
                            }
                            break;
                        }

                        db.run(
                            `UPDATE collectors SET operating_area = ?, onboarding_step = 'AWAITING_PINCODE' WHERE id = ?`,
                            [text, collector.id]
                        );
                        persist();
                        collector.operating_area = text;

                        if (lang === 'hindi') {
                            await reply(`बहुत बढ़िया! अब अपने एरिया का *6-अंकों का पिनकोड* भेजें (जैसे: 110020):`);
                        } else if (lang === 'english') {
                            await reply(`Great! Now please send your area's *6-digit Pincode* (e.g. 110020):`);
                        } else {
                            await reply(`Badhiya! Ab apne area ka *6-digit Pincode* bhejein (jaise: 110020):`);
                        }
                        break;
                    }

                    case 'AWAITING_PINCODE': {
                        const lang = collector.language || 'hinglish';
                        const pincode = text.replace(/\D/g, '');
                        if (pincode.length !== 6) {
                            if (lang === 'hindi') {
                                await reply(`कृपया 6-अंकों का सही पिनकोड भेजें (जैसे: 110020):`);
                            } else if (lang === 'english') {
                                await reply(`Please enter a valid 6-digit pincode (e.g. 110020):`);
                            } else {
                                await reply(`Kripya 6-digit ka sahi pincode bhejein (jaise: 110020):`);
                            }
                            break;
                        }

                        db.run(
                            `UPDATE collectors SET pincode = ?, onboarding_step = 'AWAITING_MATERIALS' WHERE id = ?`,
                            [pincode, collector.id]
                        );
                        persist();
                        collector.pincode = pincode;

                        if (lang === 'hindi') {
                            await reply(
                                `आप किस प्रकार का कबाड़ / वेस्ट कलेक्ट करते हैं? नंबर लिखकर रिप्लाई करें:\n\n` +
                                `1️⃣ रद्दी / कागज़ / गत्ता (Paper & Cardboard)\n` +
                                `2️⃣ प्लास्टिक और बोतलें (Plastic & Bottles)\n` +
                                `3️⃣ लोहा / कबाड़ मेटल (Scrap Metal)\n` +
                                `4️⃣ सभी प्रकार का कबाड़ (All Items)\n\n` +
                                `_(1, 2, 3 या 4 लिखकर चुनें)_`
                            );
                        } else if (lang === 'english') {
                            await reply(
                                `What types of scrap waste do you collect? Reply with a number:\n\n` +
                                `1️⃣ Paper, Books & Cardboard\n` +
                                `2️⃣ Plastic & Bottles\n` +
                                `3️⃣ Scrap Metal\n` +
                                `4️⃣ All Categories (Paper, Plastic, Metal)\n\n` +
                                `_(Reply with 1, 2, 3 or 4)_`
                            );
                        } else {
                            await reply(
                                `Aap kis type ka waste collect karte hain? Number likh kar reply karein:\n\n` +
                                `1️⃣ Raddi / Paper / Cardboard\n` +
                                `2️⃣ Plastic & Bottles\n` +
                                `3️⃣ Scrap Metal / Loha\n` +
                                `4️⃣ Sabhi Tarah Ka (All Items)\n\n` +
                                `_(1, 2, 3 ya 4 bhej kar chunein)_`
                            );
                        }
                        break;
                    }

                    case 'AWAITING_MATERIALS': {
                        const lang = collector.language || 'hinglish';
                        let mats = '';
                        if (text === '1') mats = 'Paper, Books, Cardboard';
                        else if (text === '2') mats = 'Plastic, Bottles';
                        else if (text === '3') mats = 'Scrap Metal';
                        else if (text === '4') mats = 'All Categories (Paper, Plastic, Metal)';
                        else {
                            if (isGreeting) {
                                if (lang === 'hindi') await reply(`कृपया 1, 2, 3 या 4 नंबर लिखकर चुनें:`);
                                else if (lang === 'english') await reply(`Please choose 1, 2, 3, or 4:`);
                                else await reply(`Kripya 1, 2, 3 ya 4 number likh kar chunein:`);
                                break;
                            }
                            mats = text;
                        }

                        const empId = collector.employee_id || ('KW-' + (1000 + collector.id));
                        db.run(
                            `UPDATE collectors SET materials = ?, onboarding_step = 'COMPLETED', is_available = 1, employee_id = ? WHERE id = ?`,
                            [mats, empId, collector.id]
                        );
                        if (latitude && longitude) {
                            db.run(`UPDATE collectors SET latitude = ?, longitude = ? WHERE id = ?`, [latitude, longitude, collector.id]);
                        }
                        persist();

                        if (lang === 'hindi') {
                            await reply(
                                `🎉 *बधाई हो! आप Circular Partner बन चुके हैं!* 🎉\n\n` +
                                `📋 *आपकी डिटेल्स:*\n` +
                                `• पार्टनर ID (Employee ID): *${empId}*\n` +
                                `• नाम: *${collector.name}*\n` +
                                `• एरिया: *${collector.operating_area}* (${collector.pincode})\n` +
                                `• सामग्री: *${mats}*\n` +
                                `• भाषा: *हिंदी*\n` +
                                `• स्टेटस: 🟢 *एक्टिव / On Duty*\n\n` +
                                `आपके एरिया में जब भी नया पिकअप आएगा, हम आपको WhatsApp पर तुरंत सूचित करेंगे।\n\n` +
                                `_ड्यूटी बदलने के लिए *DUTY*, भाषा बदलने के लिए *LANG* लिखें।_`
                            );
                        } else if (lang === 'english') {
                            await reply(
                                `🎉 *Congratulations! You are now an official Circular Partner!* 🎉\n\n` +
                                `📋 *Your Profile:*\n` +
                                `• Partner ID (Employee ID): *${empId}*\n` +
                                `• Name: *${collector.name}*\n` +
                                `• Area: *${collector.operating_area}* (${collector.pincode})\n` +
                                `• Materials: *${mats}*\n` +
                                `• Language: *English*\n` +
                                `• Status: 🟢 *Active / On Duty*\n\n` +
                                `Whenever a new pickup is booked in your area, you will be notified on WhatsApp.\n\n` +
                                `_Type *DUTY* to toggle duty, or *LANG* to switch language anytime._`
                            );
                        } else {
                            await reply(
                                `🎉 *Badhaai ho! Aap Circular Partner ban chuke hain!* 🎉\n\n` +
                                `📋 *Aapki Details:*\n` +
                                `• Partner ID (Employee ID): *${empId}*\n` +
                                `• Naam: *${collector.name}*\n` +
                                `• Area: *${collector.operating_area}* (${collector.pincode})\n` +
                                `• Material: *${mats}*\n` +
                                `• Language: *Hinglish*\n` +
                                `• Status: 🟢 *Active / On Duty*\n\n` +
                                `Aapke area me jab bhi naya pickup aayega, hum aapko WhatsApp par notify karenge.\n\n` +
                                `_Duty on/off karne ke liye *DUTY*, bhasha badalne ke liye *LANG* likhein._`
                            );
                        }
                        break;
                    }

                    case 'COMPLETED': {
                        const lang = collector.language || 'hinglish';

                        // 1. Live location sharing
                        if (latitude && longitude) {
                            db.run(`UPDATE collectors SET latitude = ?, longitude = ? WHERE id = ?`, [latitude, longitude, collector.id]);
                            persist();
                            const locAck = (lang === 'hindi')
                                ? `📍 लोकेशन अपडेट हो गई है!`
                                : (lang === 'english')
                                ? `📍 Live location updated successfully!`
                                : `📍 Location update ho gayi hai!`;
                            await reply(locAck);
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
                                const emptyMsg = (lang === 'hindi')
                                    ? `📦 *अभी कोई नया पिकअप पेंडिंग नहीं है।*\n\nजैसे ही नया अनुरोध आएगा, यहाँ दिखाई देगा।`
                                    : (lang === 'english')
                                    ? `📦 *No pending pickups in your area right now.*\n\nNew requests will appear here as soon as booked.`
                                    : `📦 *Abhi koi naya pickup pending nahi hai.*\n\nJaise hi naya request aayega, yahan show hoga.`;
                                await reply(emptyMsg);
                                break;
                            }

                            let replyText = (lang === 'hindi')
                                ? `📦 *वर्तमान पेंडिंग पिकअप्स (${activeList.length}):*\n\n`
                                : (lang === 'english')
                                ? `📦 *Current Pending Pickups (${activeList.length}):*\n\n`
                                : `📦 *Current Pending Pickups (${activeList.length}):*\n\n`;

                            activeList.forEach((p, idx) => {
                                replyText += `*${idx + 1}. #${p.request_id}*\n`;
                                replyText += `• Items: *${p.items}* (${p.quantity || 'Standard'})\n`;
                                replyText += `• Customer: ${p.customer_name || 'Household'}\n`;
                                replyText += `• Address: ${p.customer_address || 'Local'} (PIN: ${p.customer_pincode || '—'})\n`;
                                replyText += `• Time: ${p.time_slot}\n\n`;
                            });
                            replyText += (lang === 'hindi')
                                ? `_पिकअप पूरा होने पर वेबसाइट पैनल पर स्टेटस Collected मार्क हो जाएगा।_`
                                : (lang === 'english')
                                ? `_Status will automatically update upon doorstep verification._`
                                : `_Pickup complete hone par website admin panel par status Collected mark ho jayega._`;
                            await reply(replyText);
                            break;
                        }

                        // 3. Conversational AI Assistant with Live Order Context & Rates
                        if (!isGreeting && text.length > 2) {
                            // Query active assigned pickups for this collector to provide live customer & address context
                            const activePickupsStmt = db.prepare(`
                                SELECT p.request_id, p.items, p.time_slot, u.name as customer_name, u.address as customer_address, u.phone as customer_phone, u.pincode as customer_pincode
                                FROM pickups p
                                LEFT JOIN users u ON p.user_id = u.id
                                WHERE p.status = 'Assigned' AND (p.collector_phone = ? OR p.collector_id = ?)
                            `);
                            activePickupsStmt.bind([phone, collector.id]);
                            const activeAssignedPickups = [];
                            while (activePickupsStmt.step()) activeAssignedPickups.push(activePickupsStmt.getAsObject());
                            activePickupsStmt.free();

                            const contextData = {
                                activePickups: activeAssignedPickups,
                                dutyStatus: !!collector.is_on_duty,
                                area: collector.area || ''
                            };

                            const aiReply = await getWhatsAppAIReply(text, collector.name, collector.language || 'hinglish', contextData);
                            if (aiReply) {
                                const tipText = (lang === 'hindi')
                                    ? `_सलाह: ऑर्डर्स देखने के लिए *PICKUPS*, ड्यूटी के लिए *DUTY*, भाषा के लिए *LANG* लिखें।_`
                                    : (lang === 'english')
                                    ? `_Tip: Type *PICKUPS* to view orders, *DUTY* to toggle status, or *LANG* for language._`
                                    : `_Tip: Orders dekhne ke liye *PICKUPS*, duty ke liye *DUTY*, bhasha ke liye *LANG* bhejein._`;

                                await reply(
                                    `🤖 *Terra AI:*\n${aiReply}\n\n` +
                                    `─────────────\n` +
                                    tipText,
                                    aiReply // Spoken voice note companion speaks the AI answer directly in Edge Neural Voice!
                                );
                                break;
                            }
                        }

                        // For greetings or fallback, display the command menu in user's language
                        const cEmpId = collector.employee_id || ('KW-' + (1000 + collector.id));
                        if (lang === 'hindi') {
                            await reply(
                                `नमस्ते *${collector.name || 'पार्टनर'}* जी (ID: *${cEmpId}*)! 🙏\n\n` +
                                `कमांड्स:\n` +
                                `• *PICKUPS* - एरिया के पेंडिंग पिकअप्स देखें 📦\n` +
                                `• *DUTY* - ड्यूटी ऑन/ऑफ करें 🟢/🔴\n` +
                                `• *LANG* - भाषा बदलें (Hindi / Hinglish / English) 🌐\n` +
                                `• लाइव लोकेशन भेजकर लोकेशन अपडेट करें 📍\n` +
                                `• *#RESET* - प्रोफाइल दोबारा भरें 🔄`
                            );
                        } else if (lang === 'english') {
                            await reply(
                                `Welcome *${collector.name || 'Partner'}* (ID: *${cEmpId}*)! 🙏\n\n` +
                                `Commands:\n` +
                                `• *PICKUPS* - Check pending pickups in your area 📦\n` +
                                `• *DUTY* - Toggle On/Off duty status 🟢/🔴\n` +
                                `• *LANG* - Change preferred language 🌐\n` +
                                `• Send live location to update coordinates 📍\n` +
                                `• *#RESET* - Reset your profile 🔄`
                            );
                        } else {
                            await reply(
                                `Namaste *${collector.name || 'Partner'}* ji (ID: *${cEmpId}*)! 🙏\n\n` +
                                `Commands:\n` +
                                `• *PICKUPS* - Area ke pending pickups check karein 📦\n` +
                                `• *DUTY* - On/Off duty toggle karein 🟢/🔴\n` +
                                `• *LANG* - Bhasha badlein (Hindi / Hinglish / English) 🌐\n` +
                                `• Live location bhej kar apni location update karein 📍\n` +
                                `• *#RESET* - Details dobara bharein (agar zaroorat ho) 🔄`
                            );
                        }
                        break;
                    }

                    default:
                        await reply(`Namaste! Status update karne ke liye *DUTY* ya *PICKUPS* likhein.`);
                }
            } catch (procErr) {
                console.error(`Error processing message from ${phone}:`, procErr);
            } finally {
                notifyDone();
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

// ─────────────────────────────────────────────────────────────
// VOICE NOTE ADDON: Sends spoken Hindi voice note to Kabadiwala (Serialized FIFO per target)
// ─────────────────────────────────────────────────────────────
const voiceQueues = {};

async function _sendWhatsAppVoiceNoteDirect(target, spokenText, lang = 'hi') {
    if (!isReady || !sock || !spokenText) return { success: false };

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

        // Clean any markdown symbols, asterisks, bullet points, order IDs, and phonetic quirks from spoken text
        const cleanSpeech = spokenText
            .replace(/#?REQ[-_\s]?\d+/gi, '') // Strip order IDs completely from speech
            .replace(/\bise\b/gi, 'isse')     // Phonetic fix: prevents English TTS 'ice' pronunciation, forces authentic 'इस-से'
            .replace(/\*\*(.*?)\*\*/g, '$1')
            .replace(/\*(.*?)\*/g, '$1')
            .replace(/#{1,6}\s+/g, '')
            .replace(/`{1,3}[^`]*`{1,3}/g, '')
            .replace(/https?:\/\/[^\s]+/g, '')
            .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
            .replace(/\s+/g, ' ')
            .trim();

        if (!cleanSpeech) return { success: false };

        const truncatedSpeech = cleanSpeech.length > 220 ? cleanSpeech.substring(0, 215) + '...' : cleanSpeech;

        let oggOpusBuffer = null;

        // 1. Primary: Microsoft Edge Neural Voice (Warm natural conversational voice - MadhurNeural)
        try {
            const chosenVoice = lang === 'en' ? 'en-IN-PrabhatNeural' : 'hi-IN-MadhurNeural';
            oggOpusBuffer = await generateNeuralVoiceNote(truncatedSpeech, chosenVoice);
        } catch (neuralErr) {
            console.warn('Edge Neural TTS notice, falling back to Google TTS:', neuralErr.message);
        }

        // 2. Secondary fallback: Google TTS if needed
        if (!oggOpusBuffer) {
            try {
                const base64Audio = await googleTTS.getAudioBase64(truncatedSpeech, {
                    lang: lang === 'en' ? 'en' : 'hi',
                    slow: false,
                    host: 'https://translate.google.com',
                    timeout: 10000,
                });
                if (base64Audio) {
                    const mp3Buffer = Buffer.from(base64Audio, 'base64');
                    oggOpusBuffer = await convertMp3ToOpusOgg(mp3Buffer);
                }
            } catch (fallbackErr) {
                console.warn('Google TTS fallback error:', fallbackErr.message);
            }
        }

        if (oggOpusBuffer) {
            await sock.sendMessage(jid, {
                audio: oggOpusBuffer,
                mimetype: 'audio/ogg; codecs=opus',
                ptt: true
            });
            console.log(`🎙️ [WhatsApp Neural Voice Note] Successfully sent native OGG Opus to ${jid}`);
            return { success: true };
        }
    } catch (err) {
        console.warn('Could not send WhatsApp voice note addon:', err.message);
        return { success: false, error: err.message };
    }
}

async function sendWhatsAppVoiceNote(target, spokenText, lang = 'hi') {
    const queueKey = (target || '').replace(/[^a-zA-Z0-9]/g, '');
    const prevQueue = voiceQueues[queueKey] || Promise.resolve();
    let advanceQueue;
    voiceQueues[queueKey] = new Promise(res => { advanceQueue = res; });
    await prevQueue;

    try {
        return await _sendWhatsAppVoiceNoteDirect(target, spokenText, lang);
    } finally {
        advanceQueue();
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
