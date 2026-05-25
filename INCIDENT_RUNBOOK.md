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
