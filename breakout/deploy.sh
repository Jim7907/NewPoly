#!/usr/bin/env bash
# Idempotent deploy for Breakout Lab. Run this ON the VPS.
# Re-run any time to pull the latest and rebuild.
#
#   curl -fsSL https://raw.githubusercontent.com/Jim7907/NewPoly/claude/breakout-strategy-backtesting-kdx75b/breakout/deploy.sh | bash
#
# or: git clone the repo, then `cd breakout && ./deploy.sh`
#
# Backtest only — no API keys, no orders, nothing to secure beyond the port itself.
set -euo pipefail

REPO="${REPO:-https://github.com/Jim7907/NewPoly.git}"
BRANCH="${BRANCH:-claude/breakout-strategy-backtesting-kdx75b}"
DIR="${DIR:-$HOME/NewPoly}"
PORT="${PORT:-3003}"

echo "==> Deploying breakout (branch: $BRANCH) to $DIR"

if [ ! -d "$DIR/.git" ]; then
  git clone "$REPO" "$DIR"
fi
cd "$DIR"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"
cd "$DIR/breakout"

if docker compose version >/dev/null 2>&1; then
  echo "==> Building + starting with Docker Compose"
  docker compose up --build -d
  docker compose ps
else
  echo "==> Docker Compose not found; building with Node instead"
  command -v node >/dev/null || { echo "Install Node 20+ first"; exit 1; }
  npm install
  npm run build
  echo "==> Starting in the foreground. For a managed service use systemd/breakout.service."
  NODE_ENV=production PORT="$PORT" node server/index.js
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}' || echo '<vps-ip>')"
echo
echo "==> Done. Open  http://${IP}:${PORT}"
echo "    Defaults load BTC-USD daily. Try the Trend / GG ladder presets to compare exits,"
echo "    switch symbol to SPY for the equity result, and drop to 1m to see the cost trap."
echo "    Open port ${PORT} in the firewall (ufw allow ${PORT}/tcp) if it is not reachable."
