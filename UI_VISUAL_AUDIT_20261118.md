# Ovlink UI/UX visual regression audit — 18 November 2026

## Root cause and scope
The reported production screenshot showed current dashboard HTML combined with unstyled new controls (quick navigation looked like plain text, onboarding progress disappeared, folder/tag filters were cramped, and reset was barely visible). The fallback static asset version was the **unchanged old value `20261102-01`**, allowing browser/CDN caches to reuse older CSS after new HTML deployments. This mismatch is a strongly supported cause, though the remote browser network trace was not available to prove the precise cache entry.

## Implemented fixes
- Static asset query version defaults to a deterministic SHA-256 content digest of shipped CSS/JS; deployment-controlled `ASSET_VERSION` / `RENDER_GIT_COMMIT` overrides remain supported.
- Dashboard-specific `dashboard-ux.css` is loaded after shared CSS and tokens. It creates coherent four-column/2-column quick actions, visible onboarding progress and spacing, a desktop/mobile filter grid, full-width folder/tag selects, and a clearly visible reset button.
- Replaced Bootstrap-only dynamically injected filter classes with native Ovlink Monolith controls; removed redundant second filter-reset listener to prevent duplicated network actions. Existing underlying filter logic, CSRF, data management and navigation remain unchanged.
- Improved mobile `api-guide` and MCP docs: min-width-safe grid, wrapping text, confined scrolling code and client tabs. No changes to network APIs.

## Actual Playwright Chromium checks
1. Public routes tested: `/`, `/pricing`, `/login`, `/register`, `/how-it-works`, `/why-ovlink`, `/faq`, `/updates`, `/mcp`, `/about`, `/contact`, `/docs`, `/api-guide` at **1440, 390 and 320px** = **39 route/viewport checks**, 200 responses and zero document horizontal overflow after fixes.
2. Dashboard: rendered **actual EJS dashboard/partials** with representative fake data and real served CSS/JS; tested viewport widths **1440, 1060, 768, 390, 320px**. Quick links are styled >=46px, onboarding progress bar visible at 7px, folder/tag filters do not overlap, reset is visible, zero page errors and no document overflow. Screenshots saved locally in `/tmp/ovlink-dashboard-visual-<width>.png` (not committed).
3. Existing Playwright isolated browser scenarios: simulated dashboard AJAX slow/fast responses, network error and reset all; campaigns responsive, create/empty/retry/CSV flow tested 320, 390 and 1440px. These tests were **mocked for data** and do not prove authenticated production state.
4. `npm run check:syntax:working`: 195 files checked, pass.
5. 59 focused Node regression tests passed, 0 failed.
6. Full `npm test` without a live configured test DB: 365 total, 306 passed, 7 failed, 52 skipped. Failures include admin/session, registration/security and DB-dependent redirect/delete. **Full suite is not green.** Do not call these enterprise-ready release checks.

## Limitations and release guidance
- Production screenshot was user-provided, not captured from authenticated production session. Further authenticated real-user staging Playwright coverage is needed for account/workspace/analytics/QR features.
- Remote CDN cache invalidation after pushing depends on deployment and cache configuration. New asset digest changes the `?v=` query string; if a CDN ignores query strings, explicitly purge its cache once.
- Local port 9990 uses isolated development PostgreSQL, not production customer data.
- Do not remove previously existing security safeguards or silently change production credentials.
