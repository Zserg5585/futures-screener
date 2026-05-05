#!/bin/bash
# First-time setup script for futures-screener
# Usage: ./scripts/setup.sh

set -euo pipefail

APP_DIR="/home/app/futures-screener"
cd "$APP_DIR"

echo "=== Futures Screener Setup ==="
echo ""

# --- Check Node.js ---
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js not found. Install Node.js 18+ first."
  exit 1
fi

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  echo "WARNING: Node.js v$NODE_VER detected. v18+ recommended."
fi
echo "[OK] Node.js $(node -v)"

# --- Check PM2 ---
if ! command -v pm2 &>/dev/null; then
  echo "[INSTALL] PM2 not found, installing globally..."
  npm install -g pm2
fi
echo "[OK] PM2 $(pm2 -v)"

# --- Install dependencies ---
echo ""
echo "Installing dependencies..."
npm install
echo "[OK] Dependencies installed"

# --- Create .env if missing ---
if [ ! -f "$APP_DIR/.env" ]; then
  if [ -f "$APP_DIR/.env.example" ]; then
    cp "$APP_DIR/.env.example" "$APP_DIR/.env"
    echo ""
    echo "[ACTION REQUIRED] .env created from .env.example"
    echo "  Edit $APP_DIR/.env and fill in your secrets:"
    echo "  - JWT_SECRET (generate: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\")"
    echo "  - VAPID keys (generate: npx web-push generate-vapid-keys)"
    echo ""
  fi
else
  echo "[OK] .env already exists"
fi

# --- Create data directories ---
mkdir -p "$APP_DIR/data"
mkdir -p "$APP_DIR/server/data"
mkdir -p "$APP_DIR/backups"
echo "[OK] Data directories created"

# --- Setup PM2 ---
echo ""
echo "Setting up PM2..."
if pm2 describe futures-screener &>/dev/null; then
  echo "[OK] PM2 app already registered"
else
  pm2 start ecosystem.config.js
  pm2 save
  echo "[OK] PM2 app registered and saved"
fi

# --- Setup PM2 startup (optional) ---
echo ""
echo "To enable auto-start on reboot, run:"
echo "  pm2 startup"
echo "  pm2 save"

echo ""
echo "=== Setup complete ==="
echo "  Start:  pm2 start futures-screener"
echo "  Logs:   pm2 logs futures-screener --lines 30"
echo "  Test:   npm test"
echo "  Deploy: ./scripts/deploy.sh"
