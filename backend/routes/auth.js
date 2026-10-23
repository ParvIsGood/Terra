const express = require('express');
const router  = express.Router();
const { getDb } = require('../database');
const { sendWhatsAppAlert, getStatus } = require('../whatsappWeb');

// In-memory OTP storage: phone -> { otp: string, expiresAt: number, attempts: number }
const otpStore = new Map();

function normalizePhone(raw) {
    if (!raw) return null;
    let digits = String(raw).replace(/\D/g, '');
    if (digits.length === 10) {
        digits = '91' + digits;
    } else if (digits.length === 11 && digits.startsWith('0')) {
        digits = '91' + digits.slice(1);
    } else if (digits.length === 12 && digits.startsWith('91')) {
        // already has 91 prefix
    } else if (digits.length < 10) {
        return null;
    }
    return digits;
}

// ─────────────────────────────────────────────
// POST /api/auth/send-otp
// Body: { phone }
// ─────────────────────────────────────────────
router.post('/send-otp', async (req, res) => {
    const { phone } = req.body;
    const normalized = normalizePhone(phone);

    if (!normalized) {
        return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number.' });
    }

    // Rate limiting: check if OTP requested less than 30 seconds ago
    const existing = otpStore.get(normalized);
    if (existing && (existing.expiresAt - Date.now()) > (4.5 * 60 * 1000)) {
        return res.status(429).json({ error: 'Please wait 30 seconds before requesting another code.' });
    }

    // Generate random 4-digit numeric OTP
    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

    otpStore.set(normalized, { otp, expiresAt, attempts: 0 });

    console.log(`\n🔑 [WhatsApp OTP] Generated for +${normalized}: ${otp}`);

    const message = `🌿 *TERRA Verification Code*\n\nYour OTP is: *${otp}*\n\nValid for 5 minutes. Enter this code on the screen to verify your WhatsApp number.`;

    const status = getStatus();
    if (!status.isReady) {
        console.warn('⚠️ WhatsApp client not yet linked. Returning devOtp for testing.');
        return res.json({
            success: true,
            warning: 'WhatsApp bot is offline or scanning QR. Code logged in console.',
            message: 'OTP generated (WhatsApp bot currently offline)',
            devOtp: otp,
            phone: normalized
        });
    }

    const alertResult = await sendWhatsAppAlert(`+${normalized}`, message);

    if (!alertResult.success) {
        console.error('Failed to send OTP via WhatsApp:', alertResult);
        return res.status(500).json({
            error: 'Failed to deliver OTP to WhatsApp. Please verify the number is active on WhatsApp.',
            details: alertResult.error || alertResult.reason
        });
    }

    return res.json({
        success: true,
        message: 'OTP sent directly to your WhatsApp!',
        phone: normalized
    });
});

// ─────────────────────────────────────────────
// POST /api/auth/verify-otp
// Body: { phone, otp }
// ─────────────────────────────────────────────
router.post('/verify-otp', async (req, res) => {
    const { phone, otp } = req.body;
    const normalized = normalizePhone(phone);

    if (!normalized || !otp) {
        return res.status(400).json({ error: 'Phone number and OTP code are required.' });
    }

    const record = otpStore.get(normalized);

    if (!record) {
        return res.status(400).json({ error: 'No OTP requested for this number or it has expired. Please request a new OTP.' });
    }

    if (Date.now() > record.expiresAt) {
        otpStore.delete(normalized);
        return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
    }

    record.attempts = (record.attempts || 0) + 1;
    if (record.attempts > 5) {
        otpStore.delete(normalized);
        return res.status(429).json({ error: 'Too many incorrect attempts. Please request a new OTP.' });
    }

    if (record.otp !== String(otp).trim()) {
        return res.status(400).json({ error: 'Incorrect OTP. Please check your WhatsApp and try again.' });
    }

    // OTP Verified! Clear it
    otpStore.delete(normalized);

    try {
        const db = await getDb();
        // Check if an existing registered user matches this phone
        const last10 = normalized.slice(-10);
        const stmt = db.prepare(`SELECT id, name, email, dob, address, pincode, role, hh_code, phone, created_at FROM users WHERE phone LIKE ?`);
        stmt.bind([`%${last10}`]);

        let user = null;
        if (stmt.step()) {
            user = stmt.getAsObject();
        }
        stmt.free();

        return res.json({
            success: true,
            verified: true,
            phone: normalized,
            isRegistered: !!user,
            user: user || null,
            message: user ? `Welcome back, ${user.name}!` : 'Phone verified successfully.'
        });

    } catch (err) {
        return res.status(500).json({ error: 'Database check failed.', details: err.message });
    }
});

module.exports = router;
