#!/bin/bash
# Deploy futures-screener to Production (Malaysia VPS)
# Usage: ./deploy-prod.sh [--force]

set -e

PROD_HOST="root@72.62.247.119"
PROD_PATH="/home/app/futures-screener"
LOCAL_PATH="/home/app/futures-screener"
DEPLOY_LOG="$LOCAL_PATH/deploys/log.txt"
RSYNC_EXCLUDE=(
  --exclude='node_modules'
  --exclude='server/node_modules'
  --exclude='data/'
  --exclude='logs/'
  --exclude='.git/'
  --exclude='.env'
  --exclude='ecosystem.config.js'
  --exclude='*.png'
  --exclude='*.db-shm'
  --exclude='*.db-wal'
  --exclude='deploys/'
)

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo ""
echo -e "${GREEN}═══════════════════════════════════════${NC}"
echo -e "${GREEN}  Futures Screener → Production Deploy ${NC}"
echo -e "${GREEN}═══════════════════════════════════════${NC}"
echo ""

# 1. Current commit info
COMMIT=$(git -C "$LOCAL_PATH" log --oneline -1)
echo -e "${YELLOW}📦 Current commit:${NC} $COMMIT"
echo ""

# 2. Run tests
echo -e "${YELLOW}🧪 Running tests...${NC}"
cd "$LOCAL_PATH"
if npm test 2>&1 | tail -3; then
  echo -e "${GREEN}✅ Tests passed${NC}"
else
  echo -e "${RED}❌ Tests FAILED — aborting deploy${NC}"
  exit 1
fi
echo ""

# 3. Show what will change
echo -e "${YELLOW}📋 Changes to deploy (dry-run):${NC}"
CHANGES=$(rsync -avz --dry-run "${RSYNC_EXCLUDE[@]}" "$LOCAL_PATH/" "$PROD_HOST:$PROD_PATH/" 2>&1 | grep -E '^\S' | grep -v '^sending\|^total\|^$')
if [ -z "$CHANGES" ]; then
  echo -e "${GREEN}Nothing to deploy — prod is up to date!${NC}"
  exit 0
fi
echo "$CHANGES"
echo ""

# 4. Confirm (skip with --force)
if [ "$1" != "--force" ]; then
  read -p "Deploy to production? (y/N) " -n 1 -r
  echo ""
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# 5. Rsync
echo ""
echo -e "${YELLOW}🚀 Deploying...${NC}"
rsync -avz "${RSYNC_EXCLUDE[@]}" "$LOCAL_PATH/" "$PROD_HOST:$PROD_PATH/"
echo -e "${GREEN}✅ Files synced${NC}"

# 6. PM2 restart on prod
echo ""
echo -e "${YELLOW}♻️  Restarting PM2 on production...${NC}"
ssh "$PROD_HOST" "cd $PROD_PATH && pm2 restart futures-screener" 2>&1 | tail -3
echo -e "${GREEN}✅ PM2 restarted${NC}"

# 7. Health check (wait a bit for server to start)
echo ""
echo -e "${YELLOW}🏥 Health check...${NC}"
sleep 2
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 https://screen.clkway.online/api/vpin/stats)
if [ "$HTTP_CODE" = "200" ]; then
  echo -e "${GREEN}✅ Production is alive (HTTP $HTTP_CODE)${NC}"
else
  echo -e "${RED}⚠️  Health check returned HTTP $HTTP_CODE — check logs!${NC}"
  echo "  ssh $PROD_HOST \"pm2 logs futures-screener --lines 20 --nostream\""
fi

# 8. Log deployment
TIMESTAMP=$(TZ='America/Vancouver' date '+%Y-%m-%d %H:%M %Z')
COMMIT_SHORT=$(git -C "$LOCAL_PATH" rev-parse --short HEAD)
COMMIT_MSG=$(git -C "$LOCAL_PATH" log --format='%s' -1)
echo "$TIMESTAMP | $COMMIT_SHORT | $COMMIT_MSG" >> "$DEPLOY_LOG"
echo ""
echo -e "${GREEN}📝 Logged to deploys/log.txt${NC}"
echo -e "${GREEN}═══════════════════════════════════════${NC}"
echo -e "${GREEN}  Deploy complete! 🎉${NC}"
echo -e "${GREEN}═══════════════════════════════════════${NC}"
