# Ovlink: B2B product reliability and differentiation — 18 November 2026

## Direction
Priorities: **functionality → reliability/data accuracy → automation → performance → UI polish**.
Target first paid users: Azerbaijani agencies, small marketing teams and local SMBs coordinating branded links, QR codes and campaigns. Do not confuse a polished dashboard with a trustworthy team product.

## External benchmark (official product surfaces checked 18 Nov 2026)
- Bitly: group permissions, campaign management, branded links, analytics and CSV export — https://bitly.com/pages/pricing/
- Rebrandly: cross-department workspaces, role-aware collaboration, bulk/high-volume API — https://support.rebrandly.com/en/articles/469693-what-are-workspaces and https://developers.rebrandly.com/docs/api-limits
- Dub: event-level conversion attribution and customer journey data — https://dub.co/analytics

## Implemented in this backend reliability slice
1. **Workspace / campaign ownership:** use shared role-aware write scope for mutations; prevent a teammate from attaching a campaign to a link whose owner is someone else. The check runs atomically inside the UPDATE. Ordinary members retain read access; owner and admin write paths are tested.
2. **Audited server CSV:** `GET /api/campaigns/:id/export.csv?days=30` only serves the owning account and records a durable `campaign.csv.export` receipt before delivery. A failed audit or aggregate returns 503, not a seemingly valid zero report. CSV values are neutralized against spreadsheet formula execution. The campaign UI downloads through this endpoint instead of building unlogged files in the browser.
3. **Data correctness:** campaign list/stats SQL failures now propagate; no silently empty campaign list or fabricated 0 click report when the database cannot answer. CSV explicitly states the bot filter currently applies only to the **source breakdown**, while totals use daily aggregates and may include bot traffic.
4. **Atomic campaign deletion:** link detachment and deleting the campaign share one database transaction, so a failure cannot detach all links while leaving the campaign behind.
5. **Fresh DB migration stability:** fixed DDL ordering for RLS on bot tables, `users.created_at` onboarding index, `notifications` translation columns and legacy `security_events` FK migration. A clean PostgreSQL bootstrap created 44 tables, all 3 bot tables had RLS enabled, and previous missing-table/column warnings did not recur.

## Evidence / scope limits
- Dedicated disposable PostgreSQL integration tests: report ownership, real CSV body + HTTP headers, audit receipt, workspace role/ownership behavior and transaction rollback passed.
- Existing campaign/workspace/report tests: 48/48 pass (some network-email fallback warnings in integration harness).
- Mocked Playwright campaigns workflow 320/390/1440px passed; does not replace a signed-in real company pilot.
- Full application integration suite was not brought to green in this slice; other previously reported QR, auth/admin, workspace and DB fixture issues remain release blockers.
- No customer data touched and no remote production service restarted. Do not call this comprehensive enterprise certification.

## Next release gates (business-facing)
### Gate A — reliable daily operations
- End-to-end onboarding, account session, workspace invite, create/edit link, QR, campaign, export, restore with dedicated PostgreSQL and two representative accounts.
- No P0/P1 bugs in those flows; enforce explicit workspace permission matrix (member/admin/owner) and zero cross-company data exposure.
- Every customer-visible business report must identify time range, attribution definitions, source freshness, excluded/unknown data and export actor.

### Gate B — genuinely shared operations
- Move campaign ownership from account-only toward optional **workspace-owned campaigns** with clear creator/editor/viewer permissions and backwards-compatible migration.
- Read-only shareable client reporting with revocable links, expiry and audit logs; scheduled exports; branded report presets. Do not expose private analytics without deliberate access gates.
- Bulk actions with a preview/dry run, idempotent job keys, progress and a partial-failure export; don't promise atomic bulk workflows before implementing them.

### Gate C — differentiation and scale
- Workflow-aware MCP actions that create a campaign plus tagged links, validate UTMs, build QR assets and summarize attributable outcomes with human-readable provenance.
- Actionable conversion alerts only after bot-filter semantics and unique-visitor attribution are verified against raw click events.
- Instrument real-world p75 LCP/INP/CLS and API p95, queue lag and webhook delivery retry counts; automated restore drill and incident alerts.
- Conduct 3–5 real agency/SMB pilot trials (at least one non-technical marketer) and prioritize observed blockers, not opinions on aesthetics.

## Acceptance principles
No fake analytics, silent retries on destructive writes, unverified customer claims, public production testing with fake users, forced npm audit upgrades, or removing existing security protections simply to make a test pass. Each shipped feature needs measurable adoption and an owned operational failure path.

## B2B continuation — shared campaigns, attributable analytics and reliable weekly reports
- Personal campaign behavior remains backwards compatible. An optional workspace_id makes a campaign shared; owner/admin may create/change/delete, member can read/export, outsiders cannot access. Workspace deletion is transactional: it removes associated campaigns and clears link memberships without deleting redirecting URLs.
- Campaign assignment enforces scope in the database: personal campaigns match the owning user, workspace campaigns match the link's workspace; privileged workspace role is required to mutate. The API and browser selectors expose allowed workspaces and role-aware controls.
- Human-only campaign analytics (`bots=exclude`) derive clicks, per-link/per-day hashed unique visitors, source breakdowns and daily charts from filtered raw click events; conversions require a prior matching non-bot click on the same link and hashed visitor. This is an attribution model, not proof of human identity. If bots are included, the legacy daily rollup is used. CSV exports include measurement methodology, bot-selection and last recorded click time.
- Existing *opt-in* weekly email digest has an atomic PostgreSQL claim to avoid double sends by simultaneous workers. Failed send attempts release their claim for retry; a process crash after claim but before send can delay a digest until the resend window elapses — add leased outbox/delivery receipts before high-volume distribution. No new unsolicited emails were enabled.
- QA evidence: 25/25 DB-backed existing & new campaign/workspace tests; 5/5 weekly report concurrency and existing report tests; 37/37 focused regression tests; Playwright campaign UI with mock API at 320, 390 and 1440px. All destructive QA uses a dedicated disposable local PostgreSQL database, not customer data.
- Release limitations: full application test suite still has unrelated unresolved failures; human-only analytics scans raw events and needs load tests/index validation before high-traffic pilots; no production authenticated customer journey or pilot has yet been certified; workspace campaign shares/exports remain member-only and are not public client links.

### Next operational gates
1. Bench human-only queries for large click volumes and bound/prune expensive raw range scans; add timeouts and p95 metrics.
2. Add workspace event journal for campaign create/update/archive/delete, role changes and exports with actor ID and stable timestamps.
3. Introduce a durable email outbox with leases and delivery receipts, plus explicit schedule/frequency controls before enabling campaign digests.
4. Resolve remaining QR/auth/smoke failures and run a real two-account Playwright pilot on isolated staging.
