#!/usr/bin/env bash
# One-command VPS deploy for the Decision Engine (paper trading only). Idempotent: re-run to update.
#
#   curl -fsSL https://raw.githubusercontent.com/Jim7907/NewPoly/claude/ai-trading-decision-engine-kksxds/decision-engine/deploy.sh | bash
#
# Optional (first run or any time):
#   ANTHROPIC_API_KEY=sk-ant-...   enables the Claude news/fundamentals analyst
#   DASHBOARD_USER / DASHBOARD_PASSWORD   dashboard login (a random password is generated if unset)
#   IMPORT_STATE=1   restore the state exported from the Claude cloud session (branch engine-state)
#   PORT=3003   BRANCH=...   DIR=$HOME/NewPoly
set -euo pipefail

REPO="${REPO:-https://github.com/Jim7907/NewPoly.git}"
BRANCH="${BRANCH:-claude/ai-trading-decision-engine-kksxds}"
DIR="${DIR:-$HOME/NewPoly}"
PORT="${PORT:-3003}"
SUDO=""; [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null && SUDO="sudo"

echo "==> Decision Engine deploy (branch: $BRANCH) → $DIR"

command -v git >/dev/null || { echo "==> Installing git"; $SUDO apt-get update -qq && $SUDO apt-get install -y -qq git; }
if ! docker compose version >/dev/null 2>&1; then
  echo "==> Installing Docker (get.docker.com)"
  curl -fsSL https://get.docker.com | $SUDO sh
fi
DOCKER="docker"; docker ps >/dev/null 2>&1 || DOCKER="$SUDO docker"

if [ ! -d "$DIR/.git" ]; then git clone "$REPO" "$DIR"; fi
cd "$DIR"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"
cd "$DIR/decision-engine"

# ── .env: created once, then only updated with values you pass in ──
if [ ! -f .env ]; then
  cp .env.example .env
  echo "==> Created .env"
fi
setenv() { # setenv KEY VALUE → replace or append in .env
  if grep -qE "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi
}
[ -n "${ANTHROPIC_API_KEY:-}" ] && setenv ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY"
[ -n "${DASHBOARD_USER:-}" ] && setenv DASHBOARD_USER "$DASHBOARD_USER"
if [ -n "${DASHBOARD_PASSWORD:-}" ]; then setenv DASHBOARD_PASSWORD "$DASHBOARD_PASSWORD"
elif ! grep -qE "^DASHBOARD_PASSWORD=.+" .env; then
  setenv DASHBOARD_PASSWORD "$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)"
  echo "==> Generated a dashboard password"
fi
grep -qE "^DASHBOARD_USER=" .env || setenv DASHBOARD_USER admin
setenv NODE_ENV production
setenv DB_PATH /app/data
chmod 600 .env

echo "==> Building + starting (Docker Compose)"
$DOCKER compose up --build -d

# ── Optional: restore the engine state exported from the Claude cloud session ──
# IMPORT_STATE=1 pulls the `engine-state` branch (DB: positions, decisions, backtests, calibrators,
# learned weights, model registry; research datasets) into the data volume. Runs once; set
# IMPORT_STATE=force to overwrite again. The current volume contents are backed up first.
if [ -n "${IMPORT_STATE:-}" ] && { [ ! -f .state-imported ] || [ "${IMPORT_STATE}" = "force" ]; }; then
  echo "==> Importing engine state from branch ${STATE_BRANCH:-engine-state}"
  TMP="$(mktemp -d)"
  git -C "$DIR" fetch -q origin "${STATE_BRANCH:-engine-state}"
  git -C "$DIR" archive "origin/${STATE_BRANCH:-engine-state}" data | tar -x -C "$TMP"
  [ -f "$TMP/data/decision-engine.db" ] || { echo "!! no decision-engine.db in state branch"; exit 1; }
  $DOCKER compose stop
  mkdir -p backups && $DOCKER compose cp decision-engine:/app/data "backups/data-$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
  $DOCKER compose cp "$TMP/data/." decision-engine:/app/data/
  $DOCKER compose start
  rm -rf "$TMP"; date -u +%FT%TZ > .state-imported
  echo "==> State imported (previous volume contents backed up under decision-engine/backups/)"
fi
$DOCKER compose ps

# Open the port if ufw is active.
if command -v ufw >/dev/null && $SUDO ufw status 2>/dev/null | grep -q "Status: active"; then
  $SUDO ufw allow "$PORT"/tcp >/dev/null && echo "==> ufw: opened $PORT/tcp"
fi

IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
USERNAME="$(grep -E '^DASHBOARD_USER=' .env | cut -d= -f2-)"
PASSWORD="$(grep -E '^DASHBOARD_PASSWORD=' .env | cut -d= -f2-)"
LLM="off"; grep -qE '^ANTHROPIC_API_KEY=.+' .env && LLM="on"
cat <<MSG

==> Done.
    Dashboard : http://${IP}:${PORT}
    Login     : ${USERNAME} / ${PASSWORD}      (stored in $DIR/decision-engine/.env)
    Claude analyst: ${LLM}   (to enable: ANTHROPIC_API_KEY=sk-ant-... bash deploy.sh)
    Logs      : cd $DIR/decision-engine && docker compose logs -f
    Update    : re-run this script

    First boot: warm-start backtests (~5–10 min) calibrate probabilities, then the self-learning
    loop builds its research datasets and runs its first cycles. Paper trading only.
    If your provider has a cloud firewall/security group, allow inbound TCP ${PORT}.
MSG
