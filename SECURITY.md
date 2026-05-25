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
- Express app <-> SQLite database
- Express app <-> external identity/email services (Google OIDC, Resend)
- DNS lookups for custom-domain verification

## Security controls in place
- `helmet` with CSP, frame protections, HSTS in production
- CSRF protection via `lusca.csrf`
- Session cookies with `HttpOnly`, `SameSite=Lax`, `Secure` in production
- Session regeneration on sign-in and verification flows
- Request size limits for JSON and urlencoded payloads
- Route-level and global rate limiting
- Input validation/sanitization (`express-validator`, allowlist regexes)
- Parameterized SQL queries for user-supplied values
- Role-based admin middleware and object-owner checks in user endpoints

## Operational security checklist
- Set `SESSION_SECRET` to a high-entropy value (>=64 bytes)
- Set `API_KEY_HASH_SECRET` and `WEBHOOK_HASH_SECRET` to independent high-entropy values (>=64 bytes each)
- Set `PUBLIC_BASE_URL` and/or `BASE_URL` in production (HTTPS origins)
- Set `NODE_ENV=production`
- Set `TRUST_PROXY_HOPS` explicitly (never blanket trust proxy)
- Keep `ALLOW_INSECURE_WEBHOOK_HTTP` disabled in production
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
