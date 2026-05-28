#!/usr/bin/env bash
# Idempotent deploy for the 15m crypto imbalance bot (paper mode).
# Run this ON the VPS. Re-run any time to pull the latest and rebuild.
#
#   curl -fsSL https://raw.githubusercontent.com/Jim7907/NewPoly/claude/crypto-polymarket-imbalance-bot-JoCou/crypto15m/deploy.sh | bash
#
# or: git clone the repo, then `cd crypto15m && ./deploy.sh`
set -euo pipefail

REPO="${REPO:-https://github.com/Jim7907/NewPoly.git}"
BRANCH="${BRANCH:-claude/crypto-polymarket-imbalance-bot-JoCou}"
DIR="${DIR:-$HOME/NewPoly}"
PORT="${PORT:-3002}"

echo "==> Deploying crypto15m (branch: $BRANCH) to $DIR"

if [ ! -d "$DIR/.git" ]; then
  git clone "$REPO" "$DIR"
fi
cd "$DIR"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"
cd "$DIR/crypto15m"

if docker compose version >/dev/null 2>&1; then
  echo "==> Building + starting with Docker Compose"
  docker compose up --build -d
  docker compose ps
else
  echo "==> Docker Compose not found; falling back to Node + systemd-less run"
  command -v node >/dev/null || { echo "Install Node 20+ first"; exit 1; }
  npm install
  npm run build
  echo "==> Starting (foreground). For a service, use systemd/crypto15m.service."
  NODE_ENV=production PORT="$PORT" node server/index.js
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}' || echo '<vps-ip>')"
echo
echo "==> Done. Dashboard:  http://${IP}:${PORT}"
echo "    Paper mode is the only mode — no API keys, no real orders."
echo "    Open the BACKTEST tab and click RUN to auto-tune thresholds."
