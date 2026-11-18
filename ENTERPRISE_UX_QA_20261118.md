# Ovlink enterprise UX — implementation & verification (18 November 2026)

## Applied in branch `feat/enterprise-ux-20261118`
- Contextual dashboard action navigation (new link, QR, campaigns, workspace).
- First-run progress indicator, based on existing server-side onboarding state.
- Responsive monochrome styles; 44px action targets; visible keyboard focus; reduced motion.
- AZ/TR/EN translations and end-user changelog entry.
- Added `test/enterprise-ux.test.js` and `ENTERPRISE_PRODUCT_ROADMAP.md`.

## Evidence
- Before screenshots: `artifacts/visual/live-desktop-before.png`, `live-mobile-before.png` (public live homepage).
- After screenshots: `artifacts/visual/dashboard-desktop-after.png`, `dashboard-mobile-after.png` (representative static fixture, **not** authenticated full page).
- Playwright Chromium 159, static fixture: widths 320, 390, 768, 1440 px; 4 actions present; no horizontal overflow, 44px action targets; onboarding progress 1/3 and no uncaught JS errors.
- Focused Node tests: 12 pass / 0 fail / 2 skipped (database unavailable).
- Full suite in worktree: 318 tests / 256 pass / 10 fail / 52 skipped. Failures include pre-existing categories (a11y/RTL, analytics fixtures, backup tests, geo rendering, stats assets) and require controlled baseline comparison. An earlier run in original tree used a different environment and cannot be directly compared.
- `npm run check:syntax` passed; `git diff --check` passed.

## Limits / not claimed
- No verified authenticated dashboard end-to-end session; only static component fixture and public-site screenshot.
- No production release or server deployment, no real business pilot, no field Core Web Vitals metrics.
- Do not merge until baseline failures classified, authenticated flows exercised, and a production-like preview tested.
