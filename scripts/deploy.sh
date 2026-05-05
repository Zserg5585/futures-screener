#!/bin/bash
# Deploy script for futures-screener
# Usage: ./scripts/deploy.sh [--skip-tests] [--restart-only]

set -euo pipefail

APP_DIR="/home/app/futures-screener"
APP_NAME="futures-screener"
LOG_PREFIX="[DEPLOY $(date -Iseconds)]"

cd "$APP_DIR"

# Parse flags
SKIP_TESTS=false
RESTART_ONLY=false
for arg in "$@"; do
  case $arg in
    --skip-tests) SKIP_TESTS=true ;;
    --restart-only) RESTART_ONLY=true ;;
  esac
done

echo "$LOG_PREFIX Starting deployment..."

# --- Restart-only mode ---
if [ "$RESTART_ONLY" = true ]; then
  echo "$LOG_PREFIX Restart-only mode"
  pm2 restart "$APP_NAME" --update-env
  pm2 save
  echo "$LOG_PREFIX Done (restart only)"
  exit 0
fi

# --- Pull latest code ---
echo "$LOG_PREFIX Pulling latest changes..."
git pull --ff-only || {
  echo "$LOG_PREFIX ERROR: git pull failed (conflicts?). Aborting."
  exit 1
}

# --- Install dependencies ---
echo "$LOG_PREFIX Installing dependencies..."
npm install --omit=dev --prefer-offline

# --- Run tests ---
if [ "$SKIP_TESTS" = false ]; then
  echo "$LOG_PREFIX Running tests..."
  npm test || {
    echo "$LOG_PREFIX ERROR: Tests failed. Aborting deployment."
    exit 1
  }
  echo "$LOG_PREFIX Tests passed."
else
  echo "$LOG_PREFIX Skipping tests (--skip-tests flag)"
fi

# --- Restart app ---
echo "$LOG_PREFIX Restarting $APP_NAME..."
pm2 restart "$APP_NAME" --update-env
pm2 save

# --- Health check ---
echo "$LOG_PREFIX Waiting 3s for startup..."
sleep 3
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3200/api/health 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ]; then
  echo "$LOG_PREFIX Health check passed (HTTP $HTTP_CODE)"
else
  echo "$LOG_PREFIX WARNING: Health check returned HTTP $HTTP_CODE"
  echo "$LOG_PREFIX Check logs: pm2 logs $APP_NAME --lines 30"
fi

echo "$LOG_PREFIX Deployment complete."
