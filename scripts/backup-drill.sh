#!/usr/bin/env bash
# Weekly restore drill against the LIVE cluster, into a throwaway *_verify database.
# scripts/verify-backup.js enforces every safety gate (production refusal,
# ALLOW_RESTORE=1, _verify suffix, target != source, guaranteed DROP in finally).
# Cron-friendly: NODE_ENV is forced to "test" only for the drill process so the
# script's production guard does not fire; nothing else about the cluster changes.
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/ovlink}"
cd "$APP_DIR"

if [ -f .env ]; then
  # Same as backup-daily.sh: grep-extract instead of sourcing, so literal `$`
  # characters in the DB password are never expanded by the shell.
  if [ -z "${DATABASE_URL:-}" ]; then
    DATABASE_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- | sed -E 's/^"//; s/"$//')"
  fi
  if [ -z "${SUPABASE_DB_URL:-}" ]; then
    SUPABASE_DB_URL="$(grep -E '^SUPABASE_DB_URL=' .env | head -1 | cut -d= -f2- | sed -E 's/^"//; s/"$//')"
  fi
  export DATABASE_URL SUPABASE_DB_URL
fi

STAMP="$(date +%Y%m%d%H%M%S)"
export NODE_ENV=test
export ALLOW_RESTORE=1
export RESTORE_VERIFY_DB="ovlink_drill_${STAMP}_verify"

echo "$(date -Is) restore drill starting (target: $RESTORE_VERIFY_DB)"
node scripts/verify-backup.js
echo "$(date -Is) restore drill finished ok"
