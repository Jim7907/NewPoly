#!/usr/bin/env bash
# One-command deploy of the Lighter trading frontend. Run this ON the VPS:
#
#   curl -fsSL https://raw.githubusercontent.com/Jim7907/NewPoly/ccr-02956898-1rlsfk/lighter-dex/deploy.sh | bash
#
# Re-run any time to pull the latest code and rebuild.
#
# Options (env vars):
#   NETWORK=testnet|mainnet   Lighter network (default: testnet = fake money)
#   DOMAIN=trade.example.com  your own domain (default: <vps-ip>.sslip.io, works with no DNS setup)
#   HTTPS=0                   skip the HTTPS proxy, serve plain http on port 3003 only
#   TELEGRAM_BOT_TOKEN=...    enable Telegram alerts (token from @BotFather)
set -euo pipefail

REPO="${REPO:-https://github.com/Jim7907/NewPoly.git}"
BRANCH="${BRANCH:-ccr-02956898-1rlsfk}"
DIR="${DIR:-$HOME/NewPoly}"
HTTPS="${HTTPS:-1}"

echo "==> Deploying lighter-dex (branch: $BRANCH) to $DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "==> Docker not found, installing it (get.docker.com)"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || { echo "!! 'docker compose' plugin missing — install docker-compose-plugin"; exit 1; }
command -v git >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq git; }

if [ ! -d "$DIR/.git" ]; then
  git clone "$REPO" "$DIR"
fi
cd "$DIR"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"
cd "$DIR/lighter-dex"

# Config: create .env on first run, then apply NETWORK if given.
[ -f .env ] || cp .env.example .env
set_env() { # set_env KEY VALUE  (adds the line if missing)
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi
}
[ -n "${NETWORK:-}" ] && set_env VITE_LIGHTER_NETWORK "$NETWORK"
[ -n "${TELEGRAM_BOT_TOKEN:-}" ] && set_env TELEGRAM_BOT_TOKEN "$TELEGRAM_BOT_TOKEN"
if grep -q '^TELEGRAM_BOT_TOKEN=.\+' .env; then
  echo "==> Telegram alerts: enabled"
else
  echo "==> Telegram alerts: off (re-run with TELEGRAM_BOT_TOKEN=<token from @BotFather> to enable)"
fi
echo "==> Network: $(grep '^VITE_LIGHTER_NETWORK=' .env | cut -d= -f2)  (edit $DIR/lighter-dex/.env to change)"

IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
export DOMAIN="${DOMAIN:-${IP//./-}.sslip.io}"

port_busy() {
  # true if something other than our own caddy container holds the port
  ss -ltnH "( sport = :$1 )" 2>/dev/null | grep -q . && ! docker ps --format '{{.Names}}' | grep -qx lighter-dex-caddy
}

open_port() {
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow "$1"/tcp >/dev/null && echo "    firewall: opened $1/tcp"
  fi
}

open_port 3003
if [ "$HTTPS" = "1" ] && ! port_busy 80 && ! port_busy 443; then
  open_port 80
  open_port 443
  echo "==> Building + starting (with HTTPS for $DOMAIN)"
  docker compose --profile https up --build -d
  URL="https://$DOMAIN"
else
  [ "$HTTPS" = "1" ] && echo "!! Ports 80/443 are already in use on this VPS — skipping automatic HTTPS."
  echo "==> Building + starting (http only)"
  docker compose up --build -d web alerts
  URL="http://$IP:3003"
fi
docker compose ps

echo
echo "==> Done:  $URL"
if [ "${URL#https}" != "$URL" ]; then
  echo "    (first visit may take ~30s while the HTTPS certificate is issued; also http://$IP:3003)"
fi
echo
echo "    On your phone: open the URL inside your wallet app's built-in browser"
echo "    (MetaMask / Rabby / Coinbase Wallet -> Browser tab), tap 'Connect wallet'."
