#!/bin/bash
# Backup SQLite databases
# Usage: ./scripts/backup.sh [--dir /path/to/backups]
# Keeps last 7 daily backups by default

set -euo pipefail

APP_DIR="/home/app/futures-screener"
BACKUP_DIR="${APP_DIR}/backups"
KEEP_DAYS=7
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Parse args
for arg in "$@"; do
  case $arg in
    --dir=*) BACKUP_DIR="${arg#*=}" ;;
    --keep=*) KEEP_DAYS="${arg#*=}" ;;
  esac
done

mkdir -p "$BACKUP_DIR"

echo "[BACKUP $TIMESTAMP] Starting backup..."

# --- Backup each .db file ---
DB_COUNT=0
for db_file in "$APP_DIR"/data/*.db "$APP_DIR"/server/data/*.db; do
  [ -f "$db_file" ] || continue

  DB_NAME=$(basename "$db_file" .db)
  DEST="$BACKUP_DIR/${DB_NAME}_${TIMESTAMP}.db"

  # Use sqlite3 .backup for consistency (if available), else cp
  if command -v sqlite3 &>/dev/null; then
    sqlite3 "$db_file" ".backup '$DEST'" 2>/dev/null || cp "$db_file" "$DEST"
  else
    cp "$db_file" "$DEST"
  fi

  # Compress
  gzip "$DEST"
  SIZE=$(du -sh "${DEST}.gz" | cut -f1)
  echo "  Backed up: $DB_NAME ($SIZE)"
  DB_COUNT=$((DB_COUNT + 1))
done

if [ $DB_COUNT -eq 0 ]; then
  echo "  No .db files found to backup"
  exit 0
fi

# --- Cleanup old backups ---
echo "[BACKUP] Cleaning up backups older than $KEEP_DAYS days..."
find "$BACKUP_DIR" -name "*.db.gz" -mtime +$KEEP_DAYS -delete 2>/dev/null || true

REMAINING=$(find "$BACKUP_DIR" -name "*.db.gz" | wc -l)
echo "[BACKUP] Done. $DB_COUNT databases backed up, $REMAINING total backup files."
