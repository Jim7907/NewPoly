#!/usr/bin/env bash
# Idempotent deploy for Barometer. Run this ON the VPS. Re-run any time to pull the latest and rebuild.
#
#   curl -fsSL https://raw.githubusercontent.com/Jim7907/NewPoly/claude/vesync-marketing-platform-research-97dyo1/barometer/deploy.sh | bash
#
# or: git clone the repo, then `cd barometer && ./deploy.sh`
set -euo pipefail

REPO="${REPO:-https://github.com/Jim7907/NewPoly.git}"
BRANCH="${BRANCH:-claude/vesync-marketing-platform-research-97dyo1}"
DIR="${DIR:-$HOME/NewPoly}"
PORT="${PORT:-3004}"   # host port; change with PORT=xxxx ./deploy.sh

echo "==> Deploying barometer (branch: $BRANCH) to $DIR"

if [ ! -d "$DIR/.git" ]; then
  git clone "$REPO" "$DIR"
fi
cd "$DIR"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"
cd "$DIR/barometer"

# Keep a .env across deploys; create it from the example on first run so keys can be added later.
if [ ! -f .env ]; then
  cp .env.example .env
  echo "==> Created barometer/.env from .env.example — add API keys there and re-run to pick them up."
fi

if docker compose version >/dev/null 2>&1; then
  echo "==> Building + starting with Docker Compose"
  PORT="$PORT" docker compose up --build -d
  docker compose ps
else
  echo "==> Docker Compose not found; falling back to Node"
  command -v node >/dev/null || { echo "Install Node 20+ first"; exit 1; }
  npm install
  npm run build
  echo "==> Starting (foreground). For a service, use systemd/barometer.service."
  NODE_ENV=production PORT="$PORT" node server/index.js
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}' || echo '<vps-ip>')"
echo
echo "==> Done. Barometer:  http://${IP}:${PORT}"
echo "    Feeds start polling immediately (Open-Meteo, NWS, CDC, BLS need no keys)."
echo "    Ad-platform writes stay in dry-run until LIVE_WRITES=true and channel credentials are set in .env."
