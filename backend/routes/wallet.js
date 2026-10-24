const express = require('express');
const router = express.Router();
const { getDb, persist } = require('../database');

// ─────────────────────────────────────────────
// GET /api/wallet?user_id=123
// Returns wallet balance, green points, and full transaction history
// Auto-reconciles transactions from completed pickups if not already present
// ─────────────────────────────────────────────
router.get('/', async (req, res) => {
    try {
        const userId = parseInt(req.query.user_id, 10);
        if (!userId) {
            return res.status(400).json({ error: 'user_id query parameter is required.' });
        }

        const db = await getDb();

        // 1. Fetch user
        const uStmt = db.prepare('SELECT id, name, email, points, wallet_balance, created_at FROM users WHERE id = ?');
        uStmt.bind([userId]);
        if (!uStmt.step()) {
            uStmt.free();
            return res.status(404).json({ error: 'User not found.' });
        }
        const user = uStmt.getAsObject();
        uStmt.free();

        // 2. Check existing transactions for this user
        const tStmt = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC');
        tStmt.bind([userId]);
        const existingTxns = [];
        while (tStmt.step()) existingTxns.push(tStmt.getAsObject());
        tStmt.free();

        const existingRefIds = new Set(existingTxns.map(t => t.reference_id).filter(Boolean));

        // 3. Reconcile with completed pickups if any are missing
        const pStmt = db.prepare(`
            SELECT id, request_id, actual_weight, payout_amount, items, created_at, completed_at, status 
            FROM pickups 
            WHERE user_id = ? AND status = 'Completed'
            ORDER BY id ASC
        `);
        pStmt.bind([userId]);
        const completedPickups = [];
        while (pStmt.step()) completedPickups.push(pStmt.getAsObject());
        pStmt.free();

        let addedNewTxn = false;

        // If user has zero transactions at all, give them a welcome community eco-bonus
        if (existingTxns.length === 0) {
            db.run(`
                INSERT INTO transactions (user_id, type, title, description, amount, points, direction, status, reference_id, created_at)
                VALUES (?, 'bonus', 'Terra Green Welcome Bonus', 'Account activation & community eco-reward', 50.0, 0, 'credit', 'Completed', 'BONUS-WELCOME', ?)
            `, [userId, user.created_at || new Date().toISOString()]);
            addedNewTxn = true;
        }

        for (const p of completedPickups) {
            if (!existingRefIds.has(p.request_id)) {
                const weight = parseFloat(p.actual_weight) || 10;
                const payout = parseFloat(p.payout_amount) || Math.round(weight * 10);
                const pts = 50;
                const txDate = p.completed_at || p.created_at || new Date().toISOString();

                db.run(`
                    INSERT INTO transactions (user_id, type, title, description, amount, points, direction, status, reference_id, created_at)
                    VALUES (?, 'scrap_payout', ?, ?, ?, ?, 'credit', 'Completed', ?, ?)
                `, [
                    userId,
                    `Scrap Payout • #${p.request_id}`,
                    `Doorstep weigh-in verified (${weight} kg recyclables collected)`,
                    payout,
                    pts,
                    p.request_id,
                    txDate
                ]);

                // Also update pickup payout_amount if it was null
                if (!p.payout_amount) {
                    db.run(`UPDATE pickups SET payout_amount = ? WHERE id = ?`, [payout, p.id]);
                }

                addedNewTxn = true;
            }
        }

        if (addedNewTxn) {
            // Recalculate true wallet balance
            const sumStmt = db.prepare(`
                SELECT 
                    COALESCE(SUM(CASE WHEN direction = 'credit' AND status = 'Completed' THEN amount ELSE 0 END), 0) as total_credits,
                    COALESCE(SUM(CASE WHEN direction = 'debit' AND status = 'Completed' THEN amount ELSE 0 END), 0) as total_debits
                FROM transactions 
                WHERE user_id = ?
            `);
            sumStmt.bind([userId]);
            let totalCredits = 0;
            let totalDebits = 0;
            if (sumStmt.step()) {
                const sums = sumStmt.getAsObject();
                totalCredits = sums.total_credits;
                totalDebits = sums.total_debits;
            }
            sumStmt.free();

            const netBalance = Math.max(0, totalCredits - totalDebits);
            db.run(`UPDATE users SET wallet_balance = ? WHERE id = ?`, [netBalance, userId]);
            persist();
        }

        // 4. Fetch final updated list of transactions
        const finalTxStmt = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC');
        finalTxStmt.bind([userId]);
        const transactions = [];
        while (finalTxStmt.step()) transactions.push(finalTxStmt.getAsObject());
        finalTxStmt.free();

        // 5. Fetch fresh user balance & points
        const freshUStmt = db.prepare('SELECT points, wallet_balance FROM users WHERE id = ?');
        freshUStmt.bind([userId]);
        let freshPoints = user.points || 0;
        let freshBalance = user.wallet_balance || 0.0;
        if (freshUStmt.step()) {
            const fresh = freshUStmt.getAsObject();
            freshPoints = fresh.points || 0;
            freshBalance = fresh.wallet_balance || 0.0;
        }
        freshUStmt.free();

        let totalEarned = 0;
        let totalWithdrawn = 0;
        transactions.forEach(t => {
            if (t.direction === 'credit' && t.status === 'Completed') {
                totalEarned += (t.amount || 0);
            } else if (t.direction === 'debit' && t.status === 'Completed') {
                totalWithdrawn += (t.amount || 0);
            }
        });

        return res.json({
            success: true,
            balance: Math.round(freshBalance * 100) / 100,
            points: freshPoints,
            total_earned: Math.round(totalEarned * 100) / 100,
            total_withdrawn: Math.round(totalWithdrawn * 100) / 100,
            transactions
        });
    } catch (err) {
        console.error('Wallet fetch error:', err);
        return res.status(500).json({ error: 'Database error.', details: err.message });
    }
});

// ─────────────────────────────────────────────
// POST /api/wallet/withdraw
// Withdraws funds to UPI ID or Bank Account
// ─────────────────────────────────────────────
router.post('/withdraw', async (req, res) => {
    try {
        const { user_id, amount, upi_id, bank_account, ifsc, method } = req.body;
        const userId = parseInt(user_id, 10);
        const withdrawAmount = parseFloat(amount);

        if (!userId || isNaN(withdrawAmount) || withdrawAmount <= 0) {
            return res.status(400).json({ error: 'Valid user_id and positive amount are required.' });
        }

        const db = await getDb();
        const uStmt = db.prepare('SELECT id, name, wallet_balance FROM users WHERE id = ?');
        uStmt.bind([userId]);
        if (!uStmt.step()) {
            uStmt.free();
            return res.status(404).json({ error: 'User not found.' });
        }
        const user = uStmt.getAsObject();
        uStmt.free();

        const curBalance = user.wallet_balance || 0.0;
        if (withdrawAmount > curBalance) {
            return res.status(400).json({ 
                error: `Insufficient balance. Available balance is ₹${curBalance.toFixed(2)}.` 
            });
        }

        const isUpi = method === 'upi' || (!bank_account && upi_id);
        const destination = isUpi 
            ? (upi_id ? upi_id.trim() : 'UPI') 
            : `Bank A/C •••• ${String(bank_account || '').slice(-4)}`;

        const refId = 'WDR-' + Math.floor(100000 + Math.random() * 900000);
        const newBalance = Math.max(0, curBalance - withdrawAmount);

        // Deduct from balance
        db.run('UPDATE users SET wallet_balance = ? WHERE id = ?', [newBalance, userId]);

        // Record debit transaction
        db.run(`
            INSERT INTO transactions (user_id, type, title, description, amount, points, direction, status, reference_id, created_at)
            VALUES (?, 'withdrawal', ?, ?, ?, 0, 'debit', 'Completed', ?, datetime('now', 'localtime'))
        `, [
            userId,
            `Withdrawal via ${isUpi ? 'UPI' : 'Bank'}`,
            `Transferred to ${destination}`,
            withdrawAmount,
            refId
        ]);

        persist();

        return res.json({
            success: true,
            message: `Successfully transferred ₹${withdrawAmount.toFixed(2)} to ${destination}!`,
            balance: Math.round(newBalance * 100) / 100,
            reference_id: refId
        });
    } catch (err) {
        console.error('Wallet withdraw error:', err);
        return res.status(500).json({ error: 'Withdrawal failed.', details: err.message });
    }
});

// ─────────────────────────────────────────────
// POST /api/wallet/redeem-points
// Converts Green Points into instant wallet cash
// 1 Point = ₹1.00 INR
// ─────────────────────────────────────────────
router.post('/redeem-points', async (req, res) => {
    try {
        const { user_id, points } = req.body;
        const userId = parseInt(user_id, 10);
        const ptsToRedeem = parseInt(points, 10);

        if (!userId || isNaN(ptsToRedeem) || ptsToRedeem < 10) {
            return res.status(400).json({ error: 'Minimum 10 Green Points required to redeem.' });
        }

        const db = await getDb();
        const uStmt = db.prepare('SELECT id, name, points, wallet_balance FROM users WHERE id = ?');
        uStmt.bind([userId]);
        if (!uStmt.step()) {
            uStmt.free();
            return res.status(404).json({ error: 'User not found.' });
        }
        const user = uStmt.getAsObject();
        uStmt.free();

        const userPts = user.points || 0;
        if (ptsToRedeem > userPts) {
            return res.status(400).json({ 
                error: `Insufficient Green Points. You have ${userPts} points available.` 
            });
        }

        const cashValue = ptsToRedeem * 1.0; // 1 point = ₹1
        const newPoints = userPts - ptsToRedeem;
        const newBalance = (user.wallet_balance || 0.0) + cashValue;
        const refId = 'RDM-' + Math.floor(100000 + Math.random() * 900000);

        // Update user points & wallet balance
        db.run('UPDATE users SET points = ?, wallet_balance = ? WHERE id = ?', [newPoints, newBalance, userId]);

        // Record credit transaction
        db.run(`
            INSERT INTO transactions (user_id, type, title, description, amount, points, direction, status, reference_id, created_at)
            VALUES (?, 'reward_cashback', 'Green Points Redeemed', ?, ?, ?, 'credit', 'Completed', ?, datetime('now', 'localtime'))
        `, [
            userId,
            `Converted ${ptsToRedeem} Green Points into wallet balance`,
            cashValue,
            -ptsToRedeem,
            refId
        ]);

        persist();

        return res.json({
            success: true,
            message: `🎉 Successfully converted ${ptsToRedeem} points into ₹${cashValue.toFixed(2)} wallet cash!`,
            balance: Math.round(newBalance * 100) / 100,
            points: newPoints,
            reference_id: refId
        });
    } catch (err) {
        console.error('Wallet redeem error:', err);
        return res.status(500).json({ error: 'Points redemption failed.', details: err.message });
    }
});

module.exports = router;
