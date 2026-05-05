#!/bin/bash
# Health check script for futures-screener
# Usage: ./scripts/health-check.sh [--verbose]
# Exit code: 0 = healthy, 1 = unhealthy

set -uo pipefail

APP_NAME="futures-screener"
BASE_URL="http://127.0.0.1:3200"
VERBOSE=false

for arg in "$@"; do
  case $arg in
    --verbose|-v) VERBOSE=true ;;
  esac
done

log() {
  if [ "$VERBOSE" = true ]; then
    echo "[HEALTH $(date -Iseconds)] $1"
  fi
}

ERRORS=0

# --- Check PM2 process ---
log "Checking PM2 process..."
PM2_STATUS=$(pm2 jlist 2>/dev/null | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const app = d.find(a => a.name === '$APP_NAME');
  if (!app) { console.log('not_found'); process.exit(); }
  console.log(app.pm2_env.status);
" 2>/dev/null || echo "error")

if [ "$PM2_STATUS" = "online" ]; then
  log "PM2: online"
else
  echo "FAIL: PM2 process status = $PM2_STATUS"
  ERRORS=$((ERRORS + 1))
fi

# --- Check HTTP endpoint ---
log "Checking HTTP endpoint..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$BASE_URL/api/health" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ]; then
  log "HTTP: 200 OK"
else
  echo "FAIL: HTTP health endpoint returned $HTTP_CODE"
  ERRORS=$((ERRORS + 1))
fi

# --- Check memory usage ---
log "Checking memory..."
MEM_MB=$(pm2 jlist 2>/dev/null | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const app = d.find(a => a.name === '$APP_NAME');
  if (!app) { console.log('0'); process.exit(); }
  console.log(Math.round(app.monit.memory / 1024 / 1024));
" 2>/dev/null || echo "0")

if [ "$MEM_MB" -gt 0 ] && [ "$MEM_MB" -lt 1024 ]; then
  log "Memory: ${MEM_MB}MB (OK)"
elif [ "$MEM_MB" -ge 1024 ]; then
  echo "WARN: Memory usage high: ${MEM_MB}MB"
fi

# --- Check disk space for data/ ---
log "Checking disk space..."
DISK_AVAIL=$(df -m /home/app/futures-screener/data 2>/dev/null | awk 'NR==2{print $4}' || echo "0")
if [ "$DISK_AVAIL" -lt 500 ]; then
  echo "WARN: Low disk space: ${DISK_AVAIL}MB available"
fi

# --- Result ---
if [ $ERRORS -eq 0 ]; then
  if [ "$VERBOSE" = true ]; then
    echo "OK: All checks passed (PM2=online, HTTP=200, Mem=${MEM_MB}MB, Disk=${DISK_AVAIL}MB)"
  fi
  exit 0
else
  echo "UNHEALTHY: $ERRORS check(s) failed"
  exit 1
fi
