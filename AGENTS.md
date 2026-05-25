# AGENTS.md

## Must-follow constraints
- Use `npm` with `package-lock.json`; do not switch package manager.
- Do not commit secrets or runtime data (`.env`, `*.db`, logs).
- `SESSION_SECRET` must be high entropy (minimum 64 random bytes) and rotated if exposure is suspected.
- In production, keep `PUBLIC_BASE_URL` and/or `BASE_URL` accurate; these drive canonical redirects and absolute URL generation.
- Do not set `trust proxy` to blanket `true`; use `TRUST_PROXY_HOPS` (explicit hop count).
- For DB changes, add idempotent `CREATE TABLE/ALTER` logic in startup migration flow; do not rely on manual one-off SQL edits.
- `AGENTS.md` is an internal ops document and must not be exposed via public HTTP routes.

## Validation before finishing
- `npm test`
- `node --check server.js routes/admin.js routes/auth.js public/script.js public/lang.js`

## Repo-specific conventions
- Policy/legal/public copy is i18n-driven in `public/lang.js` (`az`, `tr`, `en`) and referenced by `data-i18n` in views.
- If you change user-facing legal/policy text, keep `privacy`, `terms`, and `cookie` text consistent across all 3 languages.
- If you ship a user-visible change, update `views/updates.ejs` and corresponding translation keys in `public/lang.js`.

## Change safety rules
- Preserve existing route compatibility (`/path` and legacy `.html` aliases where already present).
- Preserve consent-gate behavior: decline must not proceed to redirect; redirect analytics must only record when redirect proceeds.
- Keep test helper exports stable unless tests are updated in the same change.
