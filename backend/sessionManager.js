// ─────────────────────────────────────────────────────────────
// Real-time Web Session Manager (Server-Sent Events)
// Tracks open browser tabs and enables instant forced logout
// ─────────────────────────────────────────────────────────────

const activeWebSessions = new Map(); // userId (string) -> Set<Response>

function registerSession(userId, res) {
    if (!userId) return;
    const key = String(userId);
    if (!activeWebSessions.has(key)) {
        activeWebSessions.set(key, new Set());
    }
    activeWebSessions.get(key).add(res);
}

function unregisterSession(userId, res) {
    if (!userId) return;
    const key = String(userId);
    if (activeWebSessions.has(key)) {
        activeWebSessions.get(key).delete(res);
        if (activeWebSessions.get(key).size === 0) {
            activeWebSessions.delete(key);
        }
    }
}

function terminateUserSessions(userId, reason = 'Your account has been deactivated or removed by an administrator.') {
    if (!userId) return false;
    const key = String(userId);
    if (activeWebSessions.has(key)) {
        const clients = activeWebSessions.get(key);
        console.log(`🔌 [Live Session] Forcing immediate logout for user #${key} across ${clients.size} open browser tab(s).`);
        for (const res of clients) {
            try {
                res.write(`event: force_logout\ndata: ${JSON.stringify({ reason })}\n\n`);
                res.end();
            } catch (err) {
                console.warn('Error pushing force_logout to client:', err.message);
            }
        }
        activeWebSessions.delete(key);
        return true;
    }
    return false;
}

module.exports = {
    registerSession,
    unregisterSession,
    terminateUserSessions,
    activeWebSessions
};
