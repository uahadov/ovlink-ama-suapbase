# DEPLOYMENT_HARDENING.md

## 1) Environment baseline
Required production env vars:
- `NODE_ENV=production`
- `SESSION_SECRET=<64+ random bytes>`
- `API_KEY_HASH_SECRET=<64+ random bytes>`
- `WEBHOOK_HASH_SECRET=<64+ random bytes>`
- `PUBLIC_BASE_URL=https://your-domain`
- `BASE_URL=https://your-domain`
- `TRUST_PROXY_HOPS=<exact hop count, positive integer>`
- `REDIS_URL=redis://...` (shared store for session + rate limits)
- Email/OIDC keys only via environment (never commit real values)

Optional:
- `CUSTOM_DOMAIN_TARGET_HOST`
- `ADDITIONAL_BASE_HOSTS`
- `ALERT_WEBHOOK_URL` and/or `SENTRY_DSN` for incident alerting

## 2) Reverse proxy and TLS
- Terminate TLS at edge/reverse proxy and forward to app privately.
- Forward `X-Forwarded-Proto` correctly.
- Restrict direct origin access where possible.
- Keep `TRUST_PROXY_HOPS` explicit (avoid blanket trust).
- Keep `ALLOW_INSECURE_WEBHOOK_HTTP` disabled in production.

## 3) Cookies and session security
- Session cookie is `HttpOnly`, `SameSite=Lax`, `Secure` in production.
- Keep session TTL short enough for risk profile.
- Use Redis-backed shared session store in production. Memory store is not suitable at scale.

## 4) Headers
Ensure these are present in production responses:
- `Content-Security-Policy`
- `Strict-Transport-Security` (HTTPS only)
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy`
- `Permissions-Policy`
- `X-Frame-Options` / `frame-ancestors`

## 5) Database hardening
- Place SQLite DB on private filesystem path (not inside `/public`).
- Restrict filesystem permissions to app runtime user.
- Back up frequently and encrypt backups at rest.
- Test restore procedures regularly.

## 6) Logging and monitoring
- Log auth failures, admin actions, and suspicious activity.
- Do not log passwords, reset tokens, session IDs, OAuth tokens, or raw secrets.
- Add alerting for abnormal login/report/disable spikes.
- Track at minimum: `5xx rate`, `p95/p99 latency`, `webhook failure ratio`, `rate-limit spike`.

## 7) CI security gates
Required gate before deploy:
- `npm ci`
- `npm test`
- `node --check server.js routes/admin.js routes/auth.js public/script.js public/lang.js`
- `npm audit --omit=dev`

## 8) Incident response basics
- Keep rollback-ready release tags.
- Rotate credentials immediately after suspected leak.
- Preserve logs for forensics.
- Communicate impact and mitigation clearly to users.
- Keep incident owner + escalation channel documented before release.
