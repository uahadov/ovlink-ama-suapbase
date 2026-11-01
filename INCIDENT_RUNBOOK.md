# INCIDENT_RUNBOOK.md

## 1) Ownership
- Incident commander: `<name>`
- Backup commander: `<name>`
- Escalation channel: `<slack/telegram/email>`
- Customer status page/contact path: `/contact`

## 2) Severity levels
- `SEV1`: Full outage, auth/API unavailable, data-loss risk.
- `SEV2`: Partial outage, elevated 5xx, webhook/API degradation.
- `SEV3`: Non-critical issue with workaround.

## 3) First 15 minutes
- Confirm impact window and affected endpoints.
- Freeze risky deploys.
- Capture baseline metrics: `5xx`, `p95/p99`, webhook failure ratio, auth failure spikes.
- Open incident timeline document.

## 4) Containment
- If release-related, rollback to previous stable release.
- If credential leakage is suspected, rotate:
  - `SESSION_SECRET`
  - `API_KEY_HASH_SECRET`
  - `WEBHOOK_HASH_SECRET`
  - OAuth/email provider tokens
- If abuse traffic is active, tighten relevant rate limits and block offending sources.

## 5) Recovery checks
- `npm test`
- `npm run check:syntax:working` (working tree, including files not committed yet)
- `node --check server.js routes/admin.js routes/auth.js public/script.js public/lang.js`
- Verify key user flows:
  - login/register
  - link create/redirect
  - pro API (`/api/pro/v1/account`, `/api/pro/v1/shorten`)
  - webhook delivery + replay

## 6) Communication
- Publish internal updates every 15-30 minutes for SEV1/SEV2.
- Share customer-facing status with impact, mitigation, ETA.
- Avoid exposing exploit details before full mitigation.

## 7) Post-incident
- Complete RCA within 48 hours.
- Track action items with owners and due dates.
- Add test/monitoring guardrails to prevent recurrence.

## 8) Restore drill (backup verification)

The nightly dump produced by `scripts/backup-telegram.js` is only worth what its
last successful **restore** is worth. `scripts/verify-backup.js` performs that
restore against a throwaway database and checks invariants, so a truncated or
corrupt upload is found here rather than during a SEV1.

### Automated
- Workflow: `.github/workflows/backup-verify.yml` (`schedule: weekly`, plus
  `workflow_dispatch` for an on-demand run). It is never triggered by a PR and
  never points at production.
- Cron equivalent on the staging host:
  `15 4 * * 1 cd /var/www/ovlink && ALLOW_RESTORE=1 RESTORE_VERIFY_DB=ovlink_verify node scripts/verify-backup.js`

### Production server ops (ovlink.sbs)
- `scripts/backup-daily.sh` — daily `pg_dump --format=custom` of the live database into
  `~/backups/ovlink_<stamp>.dump`, 14-day rotation of its own artifacts only. Cron:
  `15 3 * * * $HOME/ovlink/scripts/backup-daily.sh >> $HOME/backups/backup.log 2>&1`
- `scripts/backup-drill.sh` — weekly restore drill against the live cluster via
  `scripts/verify-backup.js` (throwaway `ovlink_drill_<ts>_verify` database, always dropped
  in `finally`). Cron: `15 4 * * 0 $HOME/ovlink/scripts/backup-drill.sh >> $HOME/backups/drill.log 2>&1`
- A drill failure in `~/backups/drill.log` is a SEV2: the last known-good restore is stale.

### Manual run
```bash
# staging / a host with pg_dump, pg_restore and psql installed
export DATABASE_URL='postgres://user:pass@staging-host:5432/ovlink'   # never production
export RESTORE_VERIFY_DB='ovlink_verify'                              # must end with _verify
export ALLOW_RESTORE=1                                               # explicit destructive opt-in
npm run verify:backup
```

Guards are evaluated **before** any command touches the cluster (`test/backup-verify.test.js`):
- `NODE_ENV=production` → refused.
- `ALLOW_RESTORE` unset → refused.
- `RESTORE_VERIFY_DB` must end with `_verify`, be a bare identifier, and differ
  from the database in `DATABASE_URL`.

Flow: `pg_dump --format=custom` → `CREATE DATABASE <verify>` →
`pg_restore --no-owner` → row-count/table-list invariants over
`users, urls, clicks, link_stats_daily, qr_codes` → `DROP DATABASE IF EXISTS`
in `finally`, followed by a `pg_database` check that the drop actually landed.

### During a real incident
1. Identify the dump: the Telegram backup message carries the date; files are
   `ovlink_backup_YYYY-MM-DD.dump.gz`.
2. Restore into a **new** database on a staging cluster, never over the live one:
   `createdb ovlink_incident && pg_restore --no-owner -d ovlink_incident <dump>`
3. Compare against production before promoting anything:
   `SELECT count(*) FROM users / urls / clicks;` on both sides.
4. Only then decide between repairing forward and promoting the restored copy.
5. Record in the RCA whether the drill last passed and on what date.

If the weekly drill is red, treat it as a SEV2 — the current backup set is not
proven restorable.
