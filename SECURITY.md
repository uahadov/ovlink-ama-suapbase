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

## Security regression tests
`test/security-hardening.test.js` covers the delivery gates, the signed confirm token,
outbound port/response limits, CSRF scoping, enumeration and the registration pre-hijack
invariant. Run `npm test` (PostgreSQL-backed cases skip when no database is reachable).

## Operational security checklist
- Set `SESSION_SECRET` to a high-entropy value (>=64 bytes)
- Set `API_KEY_HASH_SECRET` and `WEBHOOK_HASH_SECRET` to independent high-entropy values (>=64 bytes each)
- Set `PUBLIC_BASE_URL` and/or `BASE_URL` in production (HTTPS origins)
- Set `NODE_ENV=production`
- Set `TRUST_PROXY_HOPS` explicitly (never blanket trust proxy)
- Set `TRUST_EDGE_COUNTRY_HEADER=0` when the app is reachable without a CDN/edge in front (otherwise `CF-IPCountry` can be spoofed into click analytics)
- Keep `ALLOW_INSECURE_WEBHOOK_HTTP` disabled in production
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
