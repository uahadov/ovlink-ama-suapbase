# OVLINK — Enterprise-Ready Product Development Plan
**Baseline:** 18 November 2026 | **Branch:** `feat/enterprise-ux-20261118` | **Scope:** product quality, experience, reliability; protect existing security.

## Product vision
Ovlink is an everyday link, QR and campaign operations workspace for marketing teams, agencies and small businesses. The goal is not to accumulate features but to reduce time-to-value: first link → campaign → shared report with measurable outcome. Keep the Monolith identity: dark-first, quiet monochrome, restrained motion, good typography, no neon or noisy gradients. Do not claim enterprise readiness without evidence from real usage and reliability checks.

## Objective release gates
- New users can create their first link and understand next steps without instruction; measure funnel and time-to-first-link.
- All primary workflows: keyboard-accessible, responsive at 320/390/768/1440px, translated AZ/TR/EN, visible loading/empty/error/success states, clear permissions and recovery.
- Baseline tests are recorded and all newly introduced test failures are zero before a change is merged.
- Measure p75 field LCP <=2.5s, INP <=200ms, CLS <=0.1 on representative traffic; these are targets, **not measured achievements**. Track bundle sizes and API p95 separately.
- A real agency/company pilot completes invite → link → campaign → team reporting → export, with no blocked critical issue.

## P0 — establish an honest baseline (before refactoring)
1. Make a matrix of pages and journeys: public hero, registration, login, dashboard, link create/edit, QR, campaigns, stats, workspace, billing, API/MCP.
2. Capture Playwright desktop/mobile baseline screenshots; record viewport overflow, console errors, missing labels and broken links.
3. Categorize every baseline failing test as reproducible product bug, test fixture/infrastructure gap, or obsolete expectation. Re-run in controlled env before fixing; never delete a failing test to improve the tally.
4. Measure actual navigation latency, JS/CSS bytes, browser performance, empty/loaded/error states and top accessibility gaps.

## P1 — cohesive navigation and everyday workflow
1. Dashboard hierarchy: primary create action; scan cards; actionable links table; workspaces/campaigns/QR quick links. Keep contextual nav on mobile.
2. Onboarding: factual three-step progress; clear completion and next task; dismissed state persistent; works without JS where feasible.
3. Links workspace: consistent search/filter/sort/bulk-select, meaningful empty and error states, reversible destructive actions where feasible, pagination for scale.
4. Reuse standardized button, input, table, badge, empty-state, skeleton, toast and modal components; remove template inline styles incrementally.
5. Acceptance: existing routing and click consent behavior unchanged; translated nav and keyboard focus verified with Playwright.

## P2 — business/agency workflows
1. Campaign: group URL + QR assets by purpose, UTM presets, campaign-level analytics, named exports, unambiguous attribution definitions.
2. Workspace: switching and ownership/roles clear in UI; invitation and permission states understandable; audit changes and reconciliation.
3. Reporting: export with date range, metric definitions, bot filtering and branded presentation; show data freshness and privacy constraints.
4. QR management: persistent assets, readable scan metrics, consistent destinations, brand presets and print/export quality.
5. Differentiation: workflow-aware MCP actions and clear, auditable AI assistance, **not** unverifiable automated insights.
6. Acceptance: pilot user can share a campaign report and delegate link management without asking support.

## P3 — speed and stability
1. Separate critical and deferred JS, remove duplicate CSS declarations safely, cache immutable assets, audit fonts and external dependency overhead.
2. Optimize stats charts/data access with bounded queries, caching and pagination; profile p95 API and DB timings; do not degrade data accuracy.
3. Build CI gates: syntax, unit/integration, route smoke, Playwright visual diff, a11y checks, i18n parity, release smoke.
4. Define error budgets, backup restore drills and incident recovery for paying teams; existing security safeguards remain mandatory.
5. Acceptance: 7-day pilot reliability run, reproducible performance measurement and clean release checks.

## Implementation strategy
- Work in separate Git worktree, avoid modifying original source tree or production deployment.
- Prefer thin, reversible changes with tests + screenshots; avoid broad rewrites.
- For each release: record before → apply → verify desktop/mobile + keyboard + all language variants → review diffs → document release.
- Flag risky product changes; don't promise a feature until verified end-to-end.

## Implemented — phase 1 + phase 2 operational slices (18 Nov 2026)
- Dashboard context actions and responsive Monolith navigation across link, QR, campaign and team journeys.
- Dashboard link finder: **actual folder/tag toolbar**, explicit search/filter/sort labels, async loading/error/zero-result feedback, reset-all, stale request cancellation and successful navigation URL synchronization.
- Bulk selection counter with disabled delete action for zero selections; existing confirmation and CSRF protections retained.
- Onboarding progress tied to account-wide link state even when search/workspace filters show zero results. Server-rendered fallback text localized AZ/TR/EN before JavaScript runs.
- Campaign experience: meaningful empty state, keyboard focus into first action, refresh/retry controls, optimistic prevention of stale detailed responses, accessible labels and responsive 320px+ presentation.
- CSV campaign report from **real existing API data**: actual date window, bot inclusion, total/unique/conversions, daily clicks, top links/sources/goals, spreadsheet formula neutralization. This is download/export; it is **not yet a shared scheduled branded PDF report**.
- Extracted ~21KB campaign controller into a versioned, cacheable JS asset; no framework migration, no added JS dependencies.
- Baseline regressions addressed: repeated/incorrect i18n keys, spacing token adoption, safe geo-map renderer source consistency, logger injected-sink semantics, shared motion script parity, test parser assumptions for EJS, backup-drill guard test assumptions.
- **Real reliability issue fixed:** `scripts/seed-schema.js` now actually starts idempotent migrations before waiting for the queue; isolated PostgreSQL seeding with five checked core tables succeeded.

## Remaining mandatory release work
1. Authenticated end-to-end user journeys against isolated staging DB and browser, including workspace invitations/permissions, campaign CRUD and QR across accounts; fixtures tested so far are mock-API browser flows.
2. True workspace/team workflow and access controls audit, custom branding and agency report sharing, business pilot interviews and repeat usage measurement.
3. Consolidate large legacy inline CSS and repeated motion scripts, measure actual p75 field Web Vitals and backend p95, implement CI-driven visual diffs and accessibility audits.
4. Clean remaining DB/worker migration warnings, distinguish pre-existing test failures from new defects, run migration/restore drill and 7–14 day stability checks.
5. Production release only after approvals, staging smoke tests, backup restore verification and rollback plan. No production deployment in this stage.

## Source references checked 18 Nov 2026
- Playwright screenshot & visual comparison: https://playwright.dev/docs/screenshots , https://playwright.dev/docs/test-snapshots
- W3C WCAG 2.2: https://www.w3.org/TR/WCAG22/
- Google Core Web Vitals: https://developers.google.com/search/docs/appearance/core-web-vitals
- Bitly current enterprise surface: https://bitly.com/pages/solutions/enterprise/ and https://support.bitly.com/hc/en-us/articles/34262355353997-What-s-new-at-Bitly

## B2B operations slice — 18 Nov 2026
See `ENTERPRISE_OPERATIONS_20261118.md` for the applied server-side fixes, PostgreSQL QA evidence, competitor benchmark and rollout gates. This new phase prioritizes campaign/report consistency, role-scoped mutations, transactional cleanup and reliable migration over cosmetic UI work.
