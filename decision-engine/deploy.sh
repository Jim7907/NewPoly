#!/usr/bin/env bash
# Idempotent deploy for the decision engine (paper mode).
# Run this ON the VPS. Re-run any time to pull the latest and rebuild.
#
#   curl -fsSL https://raw.githubusercontent.com/Jim7907/NewPoly/claude/ai-trading-decision-engine-kksxds/decision-engine/deploy.sh | bash
#
# or: git clone the repo, then `cd decision-engine && ./deploy.sh`
set -euo pipefail

REPO="${REPO:-https://github.com/Jim7907/NewPoly.git}"
BRANCH="${BRANCH:-claude/ai-trading-decision-engine-kksxds}"
DIR="${DIR:-$HOME/NewPoly}"
PORT="${PORT:-3003}"

echo "==> Deploying decision-engine (branch: $BRANCH) to $DIR"

if [ ! -d "$DIR/.git" ]; then
  git clone "$REPO" "$DIR"
fi
cd "$DIR"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"
cd "$DIR/decision-engine"

if docker compose version >/dev/null 2>&1; then
  echo "==> Building + starting with Docker Compose"
  docker compose up --build -d
  docker compose ps
else
  echo "==> Docker Compose not found; falling back to Node + systemd-less run"
  command -v node >/dev/null || { echo "Install Node 20+ first"; exit 1; }
  npm install
  npm run build
  echo "==> Starting (foreground). For a service, use a systemd unit or pm2."
  NODE_ENV=production PORT="$PORT" node server/index.js
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}' || echo '<vps-ip>')"
echo
echo "==> Done. Dashboard:  http://${IP}:${PORT}"
echo "    Paper mode is the only mode — no broker keys, no real orders. Optional: put ANTHROPIC_API_KEY in decision-engine/.env for the Claude analyst."
echo "    First boot runs walk-forward backtests (~5 min) to calibrate probabilities."
