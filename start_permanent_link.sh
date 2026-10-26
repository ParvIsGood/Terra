#!/bin/bash
# =========================================================
# Terra: Launch Backend & Permanent Static Domain
# Domain: https://rippling-scoring-doodle.ngrok-free.dev
# =========================================================

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "🌿 Starting Terra Backend on Port 3001..."
lsof -ti :3001 | xargs kill -9 2>/dev/null
(cd backend && node server.js) &
sleep 2

echo "🌐 Launching Permanent Static Tunnel..."
echo "👉 Your permanent link is: https://rippling-scoring-doodle.ngrok-free.dev"
ngrok http 3001 --domain=rippling-scoring-doodle.ngrok-free.dev
