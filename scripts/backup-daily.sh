#!/usr/bin/env bash
# Daily Postgres backup for Ovlink (W8 companion: verify-backup.js drills these).
# Scope: only writes $BACKUP_DIR and only deletes its OWN ovlink_*.dump artifacts
# older than KEEP_DAYS. Intended for cron; exit code reflects the dump result.
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/ovlink}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"

cd "$APP_DIR"
mkdir -p "$BACKUP_DIR"

if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

DB_URL="${DATABASE_URL:-${SUPABASE_DB_URL:-}}"
if [ -z "$DB_URL" ]; then
  echo "$(date -Is) ERROR: DATABASE_URL not found in environment or .env" >&2
  exit 1
fi

STAMP="$(date +%Y%m%d_%H%M%S)"
OUT="$BACKUP_DIR/ovlink_$STAMP.dump"
PARTIAL="$BACKUP_DIR/.ovlink_$STAMP.partial"
trap 'rm -f "$PARTIAL"' EXIT

pg_dump "$DB_URL" --format=custom --no-owner --file="$PARTIAL"
mv "$PARTIAL" "$OUT"
trap - EXIT

# Rotation: only this script's own artifacts inside BACKUP_DIR.
find "$BACKUP_DIR" -maxdepth 1 -name 'ovlink_*.dump' -mtime "+$KEEP_DAYS" -delete

SIZE="$(stat -c%s "$OUT" 2>/dev/null || stat -f%z "$OUT")"
echo "$(date -Is) backup ok: $OUT ($SIZE bytes), keeping $KEEP_DAYS days"
