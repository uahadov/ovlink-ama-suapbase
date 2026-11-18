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

## Current implementation (phase 1 slice)
- Added dashboard links/QR/campaigns/team navigation using existing routes/anchors.
- Added onboarding progress bar computed server-side from already available state.
- Added accessible focus styles, mobile action grid, reduced-motion support, three-language copy and changelog.
- Pending: authenticated Playwright walkthrough with representative account, deep refactor of inline styles, business pilot and field performance evidence.

## Source references checked 18 Nov 2026
- Playwright screenshot & visual comparison: https://playwright.dev/docs/screenshots , https://playwright.dev/docs/test-snapshots
- W3C WCAG 2.2: https://www.w3.org/TR/WCAG22/
- Google Core Web Vitals: https://developers.google.com/search/docs/appearance/core-web-vitals
- Bitly current enterprise surface: https://bitly.com/pages/solutions/enterprise/ and https://support.bitly.com/hc/en-us/articles/34262355353997-What-s-new-at-Bitly
