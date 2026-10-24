const express = require('express');
const router = express.Router();
const { getDb } = require('../database');
const { GoogleGenAI } = require('@google/genai');

const SYSTEM_INSTRUCTION = `
You are "Terra AI", the official waste segregation, sustainability, and pickup assistant for "Circular by Terra".
Your mission:
1. Guide users with precise waste segregation (Wet/Biodegradable, Dry Recyclables, E-Waste, Harmful/Hazardous).
2. Answer questions about Circular by Terra's doorstep pickup service, scrap payouts, Green Points, and Recycling Units.
3. Be friendly, polite, encouraging, and structured (use bold text, bullet points, and clean formatting).
4. Multilingual: Understand and respond in English, Hindi, or Hinglish depending on what the user asks.

Official Circular by Terra Knowledge:
• Wet / Biodegradable Waste: Food leftovers, kitchen scraps, vegetable & fruit peels, eggshells, tea/coffee grounds, meat/bones, flowers, puja offerings, garden leaves. (Goes to composting / green bin).
• Dry Recyclables: Clean paper, raddi, newspapers, cardboard boxes, clean plastic bottles, containers, rigid plastics, scrap metals (iron, steel, copper, aluminium, brass), glass bottles. Must be relatively clean and dry.
• Oily / Soiled Pizza Boxes: The clean top lid can be torn off and recycled in Dry Recyclables. The oily, cheesy bottom goes to Wet/Compost waste as oil contaminates paper recycling.
• Thermocol (Polystyrene): Keep in a separate bag; hard to recycle curbside, but Circular batches it for specialized recycling.
• Milk Pouches / Soft Plastics: Rinse lightly with water, let dry, and bundle with Dry Recyclables.
• E-Waste: Old phones, chargers, cables, appliances, remotes, gadgets, circuit boards.
• Harmful / Hazardous Waste: Expired medicines, syringes/sharps, chemical cleaners, paint, pesticides, car oil, aerosol cans. Must never be mixed with regular waste. Sharps should be in a puncture-proof container.
• Scrap Payouts: Doorstep weigh-in by authorized collector gives instant verified cash credited to wallet (Cardboard ₹7.60/kg, Paper ₹8/kg, Plastic ₹10/kg, Iron ₹14/kg, Aluminium ₹44/kg, Copper ₹160/kg). Withdrawable to UPI.
• Pickup Fees: Segregated scheduled collection is 100% FREE (₹0). Non-segregated mixed waste incurs a ₹15 sorting fee (₹0 payout). Instant pickup within 45 mins has a ₹30 convenience fee.
• Green Points: Non-monetary environmental impact score (+10 pts/kg of recyclables diverted). Points cannot be converted to wallet cash.
• Segregation Reference: When relevant, share the official link: "For more information refer https://share.google/ek9B3BloMvGMxW7UR".
`;

// Smart local fallback knowledge base when GEMINI_API_KEY is not yet added
function getSmartFallbackReply(userMsg, context = {}) {
    const q = (userMsg || '').toLowerCase();

    if (q.includes('pizza') || q.includes('box')) {
        return `🍕 **Pizza Box Segregation Tip:**\n\n• **Clean Top Lid:** Tear it off and put it in **Dry Recyclables** (Cardboard).\n• **Greasy / Oily Bottom:** Put it in **Wet / Biodegradable Waste** (or compost) because grease prevents paper pulp from binding during recycling.\n\n📖 *For more information refer:* https://share.google/ek9B3BloMvGMxW7UR`;
    }

    if (q.includes('thermocol') || q.includes('polystyrene')) {
        return `📦 **Thermocol (Polystyrene):**\n\nThermocol is brittle and non-biodegradable. Please **do not mix** it with food waste or wet garbage. Keep it separately in a dry bag so our collection partner can batch it for industrial compaction.\n\n📖 *For more information refer:* https://share.google/ek9B3BloMvGMxW7UR`;
    }

    if (q.includes('medicine') || q.includes('tablet') || q.includes('syringe') || q.includes('hazard') || q.includes('paint') || q.includes('chemical')) {
        return `⚠️ **Harmful (Hazardous) Waste:**\n\nMedicines, paint cans, and sharps must **never** be mixed with regular trash.\n• Keep expired medicines in their blister packs in a separate red/hazardous pouch.\n• Place sharps (syringes) in a hard plastic bottle to protect collection workers.\n\n📖 *For more information refer:* https://share.google/ek9B3BloMvGMxW7UR`;
    }

    if (q.includes('milk') || q.includes('pouch') || q.includes('packet')) {
        return `🥛 **Milk Pouches / Soft Plastics:**\n\nRinse the pouch with a small splash of water, let it dry, and fold it into your **Dry Recyclables** bag. Clean low-density polyethylene (LDPE) is easily recycled into composite lumber and plastic pellets!`;
    }

    if (q.includes('payout') || q.includes('money') || q.includes('cash') || q.includes('payment') || q.includes('20%')) {
        return `💵 **Scrap Payout Schedule:**\n\n• **Doorstep:** When weight is confirmed at the doorstep by the authorized kabadiwala, the household is paid **20%** of the actual amount.\n• **Recycling Unit:** The remaining **20%** balance is disbursed after the load is weighed and confirmed in the authorized Recycling Unit.`;
    }

    if (q.includes('point') || q.includes('green point') || q.includes('co2') || q.includes('emission') || q.includes('tree')) {
        const pts = context.userPoints !== undefined ? context.userPoints : 0;
        const co2 = Math.round(pts * 0.25 * 10) / 10;
        return `⭐ **Green Points & Environmental Impact:**\n\n${context.userPoints !== undefined ? `You currently have **${pts} Green Points** (~${co2} kg CO₂ emissions prevented)!` : `Every 50 Green Points you earn prevents ~12.5 kg of CO₂ emissions.`}\n\nKeep segregating clean recyclables to increase your lifetime carbon offset! 🌿`;
    }

    if (q.includes('pickup') || q.includes('status') || q.includes('req-') || q.includes('order')) {
        if (context.recentPickup) {
            const p = context.recentPickup;
            return `📦 **Your Recent Pickup (#${p.request_id}):**\n\n• **Status:** 🟢 ${p.status}\n• **Items:** ${p.items}\n• **Time Slot:** ${p.time_slot}\n• **Verified Weight:** ${p.actual_weight ? `${p.actual_weight} kg` : 'Pending doorstep weigh-in'}\n\nYou can track this live in your Activity tab anytime.`;
        }
        return `📦 **Doorstep Pickups:**\n\nYou can schedule a pickup directly from the Home screen ("Schedule a Pickup"). Our 60-second dispatch system immediately connects you to an active Kabariwala in your area!`;
    }

    return `🌿 **Hello from Terra AI!**\n\nI am your eco-assistant for Circular by Terra. You can ask me:\n• How to segregate any item (*"Where does a pizza box go?"*, *"Can I recycle plastic bottles?"*)\n• Check your pickup status or Green Points\n• Understand scrap payout milestones\n\n*💡 Tip: You can also upload a photo of any item, and I'll analyze and classify it for you!*`;
}

// ─────────────────────────────────────────────
// POST /api/ai/chat
// Body: { message, imageBase64?, mimeType?, userId? }
// ─────────────────────────────────────────────
router.post('/chat', async (req, res) => {
    const { message, imageBase64, mimeType, userId, isVoiceCall } = req.body;

    if (!message && !imageBase64) {
        return res.status(400).json({ error: 'Message or image is required.' });
    }

    try {
        const db = await getDb();
        const contextData = {};
        let dbContextString = '';

        // Fetch live database context if user is logged in
        if (userId) {
            try {
                const uStmt = db.prepare('SELECT id, name, points, role, address, pincode, wallet_balance FROM users WHERE id = ?');
                uStmt.bind([userId]);
                if (uStmt.step()) {
                    const u = uStmt.getAsObject();
                    contextData.userName = u.name;
                    contextData.userPoints = u.points || 0;
                    contextData.walletBalance = u.wallet_balance || 0;
                    dbContextString += `User Profile: Name: ${u.name}, Role: ${u.role}, Pincode: ${u.pincode}, Cash Wallet Balance: ₹${u.wallet_balance || 0}, Green Points: ${u.points || 0}.\n`;
                }
                uStmt.free();

                const pStmt = db.prepare('SELECT id, request_id, items, time_slot, status, actual_weight, pin FROM pickups WHERE user_id = ? ORDER BY id DESC LIMIT 1');
                pStmt.bind([userId]);
                if (pStmt.step()) {
                    const p = pStmt.getAsObject();
                    contextData.recentPickup = p;
                    dbContextString += `Recent Pickup: ID: #${p.request_id}, Items: ${p.items}, Status: ${p.status}, Time: ${p.time_slot}, Weight: ${p.actual_weight || 'Pending'}.\n`;
                }
                pStmt.free();
            } catch (dbErr) {
                console.error('Error reading context for AI:', dbErr.message);
            }
        }

        const groqKey = process.env.GROQ_API_KEY;
        const geminiKey = process.env.GEMINI_API_KEY;

        let systemWithContext = `${SYSTEM_INSTRUCTION}\n\n`;
        if (dbContextString) {
            systemWithContext += `[Live Database Context for current user]:\n${dbContextString}\n\n`;
        }
        if (isVoiceCall) {
            systemWithContext += `\n[CRITICAL TELEPHONE VOICE CALL OVERRIDE]:
You are on a live voice phone call right now with the customer.
1. Answer in natural, friendly spoken Hindi/Hinglish (or English if addressed in English).
2. Keep your response strictly under 2 short conversational sentences (under 25 words).
3. ABSOLUTELY NEVER use markdown symbols, asterisks (**), bullet points, emojis, or website links. Your text is directly fed into browser speech synthesis.
4. If asked about scrap rates, quote: Cardboard ₹7.60 per kg, Paper ₹8 per kg, Plastic ₹10 per kg, Iron ₹14 per kg.
5. Scheduled segregated pickups are 100% free.\n`;
        }

        // 1. Try Groq (Ultra-fast, Llama 3 / Qwen)
        if (groqKey && groqKey.startsWith('gsk_')) {
            try {
                const userContent = [];
                if (imageBase64) {
                    let cleanUrl = imageBase64;
                    if (!cleanUrl.startsWith('data:')) {
                        cleanUrl = `data:${mimeType || 'image/jpeg'};base64,${cleanUrl.trim()}`;
                    }
                    userContent.push({ type: 'text', text: message || 'Please classify the waste shown in this photo and specify its category (Wet, Dry, E-Waste, Harmful) and proper disposal instructions.' });
                    userContent.push({
                        type: 'image_url',
                        image_url: { url: cleanUrl }
                    });
                } else {
                    userContent.push({ type: 'text', text: message });
                }

                const chosenModel = 'qwen/qwen3.8-27b';
                const maxTokens = isVoiceCall ? 120 : (imageBase64 ? 350 : 500);

                const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${groqKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: chosenModel,
                        messages: [
                            { role: 'system', content: systemWithContext },
                            { role: 'user', content: imageBase64 ? userContent : (message || '') }
                        ],
                        max_tokens: maxTokens,
                        temperature: 0.6
                    })
                });

                const groqData = await groqRes.json();
                if (groqData.choices && groqData.choices[0]?.message?.content) {
                    return res.json({
                        reply: groqData.choices[0].message.content,
                        source: 'groq-live'
                    });
                } else if (groqData.error) {
                    console.warn('Groq API error:', groqData.error);
                }
            } catch (groqErr) {
                console.warn('Groq fetch error:', groqErr.message);
            }
        }

        // 2. Try Gemini (if configured)
        if (geminiKey && geminiKey !== 'YOUR_GEMINI_API_KEY') {
            try {
                const ai = new GoogleGenAI({ apiKey: geminiKey });
                const promptParts = [];

                let fullPrompt = `${systemWithContext}\nUser Query: ${message || 'Please classify the waste in this image.'}`;
                promptParts.push({ text: fullPrompt });

                if (imageBase64) {
                    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
                    promptParts.push({
                        inlineData: {
                            data: cleanBase64,
                            mimeType: mimeType || 'image/jpeg'
                        }
                    });
                }

                const response = await ai.models.generateContent({
                    model: 'gemini-2.0-flash',
                    contents: [{ parts: promptParts }]
                });

                return res.json({
                    reply: response.text,
                    source: 'gemini-live'
                });
            } catch (geminiErr) {
                console.warn('Gemini API call failed, falling back to local knowledge base:', geminiErr.message);
            }
        }

        // 3. Offline / Local Knowledge Base Fallback
        const fallbackReply = getSmartFallbackReply(message, contextData);
        return res.json({
            reply: fallbackReply,
            source: 'local-knowledge-base'
        });

    } catch (err) {
        console.error('AI chat route error:', err);
        return res.status(500).json({ error: 'AI Assistant error.', details: err.message });
    }
});

// ─────────────────────────────────────────────

module.exports = router;
