# SECURITY.md

## Scope and threat model (summary)
Ovlink is a Node.js + Express URL shortener with account authentication, admin moderation, short-link redirects, password-protected links, and custom domains.

Primary protected assets:
- User accounts and sessions
- Admin sessions and moderation actions
- Redirect integrity (short code -> destination)
- Database records (users, urls, reports, clicks, domains)

Primary trust boundaries:
- Browser <-> Express app
- Express app <-> Database (PostgreSQL in production / SQLite in local dev)
- Express app <-> external identity/email services (Google OIDC, Resend)
- DNS lookups for custom-domain verification

## Analytics data model (what is stored about a click)

| Field | Stored when | Notes |
|---|---|---|
| `click_time` | always | UTC ISO string |
| `browser`, `os`, `country` | always | consent marker instead of real values in essential mode |
| `device_type`, `is_bot` | analytics consent | derived from the User-Agent; bots are flagged, never dropped silently |
| `referrer_host`, `utm_source/medium/campaign` | analytics consent | self-referrals are recorded as `direct` |
| `ip_hash` | analytics consent | HMAC-SHA256 of the IP (`hashIpForStorage`); the raw IP is never persisted |
| `city` | analytics consent | city-level geography only with analytics consent |
| conversion event (`link_conversions`) | only when the owner embeds the pixel | stored as `(goal, day, ip_hash)`, deduplicated per visitor/day; no raw IP |

- `link_stats_daily` keeps per-link/day `clicks`, `uniques`, `bots`. Unique visitors
  are exact: `click_uniques` holds one row per `(url_id, day, ip_hash)` and acts as
  the arbiter, so repeat visits from one network count once per day.
- `GET /api/stats/:short` now aggregates in SQL over an indexed
  `(url_id, click_time)` range instead of loading every click row into memory.
  Supported query parameters: `days` (`1..365` or `all`), `bots` (`include`/`exclude`),
  `limit` (raw click rows, default 2000, max 5000).
- Essential-consent clicks are still counted in the daily rollup but never carry
  attribution or a visitor hash.

### Recommended follow-ups
- Enforce a retention window for raw `clicks`/`click_uniques` (e.g. 90 days free,
  365 days Pro) — the rollups keep the long-term history either way.
- Expose the same aggregate endpoint through the Pro API (`/api/pro/v1/...`).

### Shared statistics links
- `stats_shares` stores only `SHA-256(token)` — the raw token exists in the share
  URL and nowhere else. Every share has `expires_at` (7/30/90/365 days) and can be
  revoked instantly (`revoked_at`); validation is fail-closed.
- Shared payloads go through `toPublicPayload()`: click-level rows, consent marker
  counts and internal diagnostics are removed. The share window is pinned to the
  row's `days` so the audience cannot widen it via query parameters.
- `/stats/shared/*` sends `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`
  so a shared token cannot leak through external assets.
- `/embed/:short` deliberately relaxes framing (`frame-ancestors *`, `X-Frame-Options:
  ALLOWALL`) so the widget can be embedded, but keeps `default-src 'none'` and has no
  scripts of its own.

### Campaigns
- Campaigns are strictly owner-scoped (`campaigns.user_id`): every read/write path
  resolves the campaign through `getCampaignForUser()` before touching data.
- Assigning a link (`POST /api/links/:short/campaign`) requires both link ownership
  (workspace-aware) and campaign ownership, so a guessed id cannot move someone
  else's links into your grouping.
- Deleting a campaign nulls `urls.campaign_id` first; short links and their history
  are never destroyed by campaign management.

## Security controls in place
- `helmet` with CSP, frame protections, HSTS in production
- CSRF protection via `lusca.csrf` (HMAC-SHA256 over the session id, constant-time compare)
- CSRF exemption is scoped to `/api/pro/v1/*` (API-key authenticated) and `/api/tools/*` only — an API-key-shaped header never disables CSRF for session routes
- Session cookies with `HttpOnly`, `SameSite=Lax`, `Secure` in production
- Session regeneration on sign-in and verification flows
- Request size limits for JSON and urlencoded payloads
- Route-level and global rate limiting
- Input validation/sanitization (`express-validator`, allowlist regexes)
- Parameterized SQL queries for user-supplied values
- Role-based admin middleware and object-owner checks in user endpoints
- One delivery-gate implementation (`applyDeliveryGates`) shared by `/:short` and `/proceed/:short`: disabled flag, expiry, click limit, destination blocklist and the abuse interstitial can no longer be bypassed per route
- Destination blocklist is evaluated against the **resolved** target (A/B and iOS/Android variants included), not only the primary URL
- Dangerous-link interstitial requires a server-signed, short-code-bound, 30-minute confirmation token (`?confirm=<expiry>.<hmac>`); a bare `?confirm=true` is ignored
- Outbound webhook/preview fetches pin the resolved IP, cap the response body (`WEBHOOK_MAX_RESPONSE_BYTES`) and refuse internal-service ports
- SAML ACS fails closed when the browser-bound `RelayState` cookie is missing (login-CSRF / session-swap protection)
- SSO endpoints (`/sso/:id/login`, `/sso/:id/metadata`, `/sso/:id/acs`) are rate limited
- Private HTML (`/dashboard`, `/account`, `/notifications`, `/workspaces`, `/stats-page`, `/proceed`, `/admin`) is sent with `Cache-Control: no-store`; the service worker additionally refuses to cache those paths and honours `no-store`
- Account enumeration: `POST /api/resend-verification` always returns the same generic response
- Unverified `users` rows are purged instead of mutated on re-registration (pre-account-takeover protection)
- Verification codes come from `crypto.randomInt`, not `Math.random`
- Polar webhook dedupe markers are released when processing fails, so provider retries are not swallowed
- Destination health checks (anomaly worker) reuse the outbound guards: resolved-IP pinning, blocked port/host/IP lists, no redirect following, status-code-only reads. Unprobeable targets are recorded as `not_probeable` instead of raising an alarm
- Workspace analytics (`GET /api/workspaces/:id/stats`) requires membership plus an active Pro owner and aggregates only links with that `workspace_id`
- Statistics shares store only `SHA-256(token)`, expire, and can be revoked; shared payloads never include raw click rows
- The conversion pixel ignores automation (bot/empty User-Agent) and, when the visitor chose `essential` consent, counts the conversion without deriving any identifier from the IP
- The live click feed (`GET /api/stats/:short/live`) is owner-scoped, exposes only id/time/browser/os/country/device/bot flag, and never selects `ip_hash`
- Saved segments and alert thresholds are scoped by `user_id`/`url_id`; every read and write re-checks ownership
- The analytics access log stores only an `ip_hash` (never the raw IP), dedupes repeated reads for 5 minutes and is purged after `AUDIT_RETENTION_DAYS` (default 90)
- New Pro API endpoints reuse the frozen `account:read` scope and live in a separate router mounted after `links.js`; no new CSRF exemption surface
- Deleting a link first purges every analytics row that references it (`clicks`, `click_uniques`, `link_stats_daily`, `link_conversions`, `link_funnel_steps`, `stats_shares`, `link_alert_settings`); those foreign keys have no `ON DELETE CASCADE`, so a bare delete would fail on any real link
- Only the link owner may change per-link alert thresholds; workspace members can read them but cannot reconfigure alerts that fire on the owner's account
- Funnel rows are pruned after 180 days by the daily retention worker; the audit log after `AUDIT_RETENTION_DAYS` (default 90)
- The Pro API link search escapes `%`/`_` so a prefix filter cannot silently broaden the result set

## Security regression tests
`test/security-hardening.test.js` covers the delivery gates, the signed confirm token,
outbound port/response limits, CSRF scoping, enumeration and the registration pre-hijack
invariant. `test/analytics-stats.test.js` covers click attribution, unique-visitor
deduplication, bot flagging and the `/api/stats` contract. `test/anomaly-alerts.test.js`
covers spike/drop thresholds, notification dedupe and the private-target probe guards;
`test/workspace-stats.test.js` covers workspace scoping and the Pro/membership gates.
Run `npm test` (PostgreSQL-backed cases skip when no database is reachable).

## Operational security checklist
- Set `SESSION_SECRET` to a high-entropy value (>=64 bytes)
- Set `API_KEY_HASH_SECRET` and `WEBHOOK_HASH_SECRET` to independent high-entropy values (>=64 bytes each)
- Set `PUBLIC_BASE_URL` and/or `BASE_URL` in production (HTTPS origins)
- Set `NODE_ENV=production`
- Set `TRUST_PROXY_HOPS` explicitly (never blanket trust proxy)
- Set `TRUST_EDGE_COUNTRY_HEADER=0` when the app is reachable without a CDN/edge in front (otherwise `CF-IPCountry` can be spoofed into click analytics)
- Keep `ALLOW_INSECURE_WEBHOOK_HTTP` disabled in production
- Keep `ANOMALY_HEALTH_CHECKS=1` only where the app may make outbound requests (it uses the same pinned-IP guards as webhooks); set `ANOMALY_HEALTH_CHECKS=0` on locked-down networks
- Keep the `/api/tools/*` endpoints behind the global rate limiter; raise limits only behind a WAF
- Run `git rm --cached` for any previously committed lead/export files (`.gitignore` already covers them)
- Configure `REDIS_URL` for shared session and rate-limit stores in production
- Keep database file outside public web root
- Rotate OAuth/email API credentials regularly
- Restrict database file permissions to app user only
- Review `npm audit` findings at each release
- Enable centralized logs and alerting for auth/moderation anomalies

## Vulnerability reporting
If you discover a security issue, report privately to project maintainers via the contact channel listed on `/contact`.
Avoid disclosing sensitive details publicly before a fix is released.

## Maintenance cadence
- Dependency audit: weekly
- Secret rotation: quarterly (or immediately on exposure)
- Security regression tests: on each PR and before release
