# OPTIMIZATIONS.md

Audit date: 2026-03-15
Scope: `url-shortener-plus` full repository (static analysis + light runtime measurements)
Method: source review, `npm test`, `node --check`, SQLite `EXPLAIN QUERY PLAN`, lightweight query timings, asset size/compression checks, bcrypt event-loop benchmark

### 1) Optimization Summary

Current optimization health is mixed: the codebase is functionally stable, but several high-ROI bottlenecks remain on auth, startup, and unbounded data paths.

Top 3 highest-impact improvements:
1. Convert synchronous bcrypt calls in request handlers to async (`await bcrypt.hash/compare`) to remove event-loop stalls.
2. Add bounded/paginated stats and dashboard data access (avoid full-table-in-memory processing per request).
3. Replace startup-wide idempotency-by-error-swallowing migrations with schema-versioned one-time migrations.

Biggest risk if no changes are made:
- Under concurrent auth traffic and growing click/report datasets, response latency and tail behavior will degrade sharply, with request queuing caused by sync crypto and avoidable DB/serialization work.

Light runtime evidence snapshot:
- `npm test`: 14/14 passing
- `node --check server.js routes/admin.js routes/auth.js public/script.js public/lang.js`: passing
- DB sample size (local): `users=14`, `urls=69`, `clicks=52`, `webhook_deliveries=216` (small now; scale risks marked as likely)
- Bcrypt lag benchmark:
  - `sync_8_compares`: duration `594ms`, max event-loop lag `585ms`
  - `async_serial_8_compares`: duration `605ms`, max lag `10ms`
  - `async_parallel_8_compares`: duration `175ms`, max lag `15ms`

### 2) Findings (Prioritized)

#### F1
- **Title**: Synchronous bcrypt in hot auth paths blocks the event loop
- **Category**: CPU / Concurrency
- **Severity**: Critical
- **Impact**: Lower p95/p99 auth latency, better throughput under concurrent sign-in/reset traffic
- **Evidence**:
  - `server.js:4166`, `server.js:4281`, `server.js:5675`, `server.js:5681`, `server.js:5777`
  - `server.js:1068`, `server.js:1077` (`hashLinkPassword` / `verifyLinkPassword` use sync bcrypt)
  - `routes/auth.js:19`, `routes/auth.js:80`
  - Benchmark: sync compares produced `~585ms` max loop lag for 8 operations; async version stayed around `10-15ms` lag
- **Why it’s inefficient**: `hashSync/compareSync` executes CPU-bound work on the main thread, stalling unrelated requests.
- **Recommended fix**:
  - Replace sync bcrypt calls in request handlers with async forms.
  - Make password helper variants async where used in request path.
  - Keep compatibility by introducing async helper wrappers first, then swapping call sites.
- **Tradeoffs / Risks**: Requires async refactor through callbacks/promises in affected handlers; behavior must remain identical.
- **Expected impact estimate**: High; tail latency and concurrency behavior materially improved (qualitatively 2x-5x under auth-heavy bursts).
- **Removal Safety**: Likely Safe
- **Reuse Scope**: Service-wide
- **Classification**: Reuse Opportunity

#### F2
- **Title**: Unbounded in-memory stats/dashboard/export processing
- **Category**: Algorithm / DB / Memory
- **Severity**: High
- **Impact**: Lower memory usage, smaller payloads, more stable latency as data grows
- **Evidence**:
  - Stats API loads all clicks: `server.js:6627` (`SELECT * FROM clicks WHERE url_id = ?`), then aggregates in JS (`server.js:6638-6665`)
  - Dashboard route loads all user links and builds a large HTML string in-process: `server.js:7165-7468`
  - Export route fetches all rows then materializes CSV/XLSX in memory: `server.js:6941-7017`
  - Current timings are small only because dataset is small (e.g., dashboard query avg `~0.6204ms` on 69 URLs)
- **Why it’s inefficient**: Runtime and memory are O(n) per request; no pagination/windowing means latency grows with user data size.
- **Recommended fix**:
  - Add pagination and date-range controls to stats/dashboard endpoints.
  - Move heavy aggregations into SQL (`GROUP BY`, bucketed time grouping).
  - For export, enforce synchronous cap and add async export path for large datasets.
- **Tradeoffs / Risks**: Introduces API contract changes; requires backward-compatible rollout for existing frontend calls.
- **Expected impact estimate**: High at scale; often 10x+ payload/work reduction for large users.
- **Removal Safety**: Needs Verification
- **Reuse Scope**: Service-wide
- **Classification**: Reuse Opportunity

#### F3
- **Title**: Startup migration flow executes repeated DDL/DML on every boot
- **Category**: DB / I/O / Reliability
- **Severity**: High
- **Impact**: Faster startup, fewer lock/contention events, reduced accidental startup-side data churn
- **Evidence**:
  - Large startup migration block: `server.js:3689-4102`
  - Counts from static scan: `ALTER TABLE` occurrences `41`, `db.run(...)` occurrences `171`
  - Repeated startup data writes include `UPDATE`/`DELETE` paths like `server.js:3941-3944`
  - Duplicate schema management path exists (`ensureUserSessionsSchema()` around `server.js:1535-1588` and called at `server.js:4102`)
- **Why it’s inefficient**: Re-running many migration statements and corrective updates at each process start adds avoidable DB work and lock risk.
- **Recommended fix**:
  - Introduce explicit schema version table and one-time migrations.
  - Move cleanup transforms to versioned migration steps.
  - Remove duplicated schema-ensure paths after migration framework adoption.
- **Tradeoffs / Risks**: Migration framework transition needs careful idempotency and rollback handling.
- **Expected impact estimate**: Medium to High startup stability improvement; boot-time savings depend on DB size.
- **Removal Safety**: Needs Verification
- **Reuse Scope**: Service-wide
- **Classification**: Over-Abstracted Code

#### F4
- **Title**: Session and rate-limit stores are process-local memory stores
- **Category**: Reliability / Cost / Scalability
- **Severity**: High
- **Impact**: Predictable behavior across restarts/replicas, reduced abuse bypass across nodes
- **Evidence**:
  - Session middleware has no explicit store configured: `server.js:2754-2767`
  - Multiple `express-rate-limit` instances defined with default store (no shared external store): `server.js:2410-2468`
- **Why it’s inefficient**: Memory stores do not scale horizontally, reset on restart, and can produce inconsistent throttling/session behavior.
- **Recommended fix**:
  - Move sessions to persistent/shared store (`connect-sqlite3` or Redis).
  - Move limiter state to shared backend store for multi-instance correctness.
- **Tradeoffs / Risks**: Adds infrastructure/dependency and operational complexity.
- **Expected impact estimate**: High reliability/scalability gain for production deployments.
- **Removal Safety**: Needs Verification
- **Reuse Scope**: Service-wide
- **Classification**: Reuse Opportunity

#### F5
- **Title**: `ORDER BY datetime(...)` patterns defeat index ordering and trigger temp sorts
- **Category**: DB
- **Severity**: High
- **Impact**: Lower DB CPU and memory for listing endpoints
- **Evidence**:
  - Query usage examples: `server.js:4714`, `server.js:5326`, `server.js:5422`, `server.js:5800`
  - `EXPLAIN QUERY PLAN` showed `USE TEMP B-TREE FOR ORDER BY` in key queries
  - Direct comparison showed index use when not wrapping `created_at` in `datetime()` for admin auth logs
- **Why it’s inefficient**: Function-wrapped sort keys frequently prevent efficient index-order scans.
- **Recommended fix**:
  - Store timestamps as sortable ISO text (already true), order by raw column (`ORDER BY created_at DESC`).
  - Add/adjust composite indexes to match `WHERE + ORDER BY` patterns.
- **Tradeoffs / Risks**: Must verify date-format consistency and ordering assumptions.
- **Expected impact estimate**: Medium to High for list-heavy endpoints with larger tables.
- **Removal Safety**: Likely Safe
- **Reuse Scope**: Service-wide
- **Classification**: Reuse Opportunity

#### F6
- **Title**: Ban reset/check logic is duplicated across multiple request paths
- **Category**: Reliability
- **Severity**: Medium
- **Impact**: Less behavioral drift, easier hardening, lower maintenance overhead
- **Evidence**:
  - Repeated update block appears at `server.js:4297`, `4459`, `4505`, `5201`, `5935`, `6553`, `7144`
- **Why it’s inefficient**: Copy-pasted critical logic increases bug surface and makes optimization/security fixes slower.
- **Recommended fix**:
  - Extract one shared helper for ban normalization + active-check result.
  - Reuse in login/OAuth/shorten/report/dashboard paths.
- **Tradeoffs / Risks**: Refactor touches auth and access-control paths; requires regression tests.
- **Expected impact estimate**: Medium (maintainability/reliability), indirect performance benefits via reduced duplicate DB calls.
- **Removal Safety**: Likely Safe
- **Reuse Scope**: Service-wide
- **Classification**: Reuse Opportunity

#### F7
- **Title**: Redirect path executes extra `COUNT(*)` click query per visit
- **Category**: DB / Cost
- **Severity**: Medium
- **Impact**: Lower DB read load on high-traffic links
- **Evidence**:
  - Redirect gating count query: `server.js:6123-6138`
  - Password-protected verify path count query: `server.js:6466-6472`
- **Why it’s inefficient**: Each redirect does read-before-write counting even when only max-click gating is needed.
- **Recommended fix**:
  - Add `urls.click_count` (or equivalent) and update atomically on click insert.
  - Gate max-click checks from denormalized count instead of repeated aggregate scans.
- **Tradeoffs / Risks**: Requires schema/data migration and atomicity safeguards to avoid drift.
- **Expected impact estimate**: Medium now, High for popular links.
- **Removal Safety**: Needs Verification
- **Reuse Scope**: Service-wide
- **Classification**: Reuse Opportunity

#### F8
- **Title**: Frontend payload is large and static caching strategy lacks content hashing
- **Category**: Frontend / Network / Cost
- **Severity**: Medium
- **Impact**: Faster first load, reduced bandwidth, fewer stale-cache incidents
- **Evidence**:
  - Raw sizes: `public/script.js=125726`, `public/lang.js=168034`, `public/style.css=65144`
  - Compressed sizes still meaningful: `script.js gzip=26184`, `lang.js gzip=47203`, `style.css gzip=11265`
  - Widely loaded across views (`/lang.js` + `/script.js` script tags in most templates)
  - Static config uses long immutable cache (`server.js:3377-3385`) but asset names are not hashed
- **Why it’s inefficient**: Big JS parse cost and cache invalidation risk (clients can keep stale immutable assets).
- **Recommended fix**:
  - Add build pipeline (minify, split locale bundles, content-hashed filenames).
  - Keep compatibility by serving legacy filenames temporarily with redirects/manifests.
- **Tradeoffs / Risks**: Build/deploy complexity increases; CSP nonce/script integration must be preserved.
- **Expected impact estimate**: Medium to High frontend latency improvement (especially mobile).
- **Removal Safety**: Needs Verification
- **Reuse Scope**: Service-wide
- **Classification**: Reuse Opportunity

#### F9
- **Title**: Dead/unused code and duplicate artifact files increase maintenance surface
- **Category**: Build / Cost / Maintainability
- **Severity**: Medium
- **Impact**: Smaller review/build surface, less confusion, lower accidental drift risk
- **Evidence**:
  - `routes/auth.js` has no runtime references (`NO_RUNTIME_REFERENCES_TO_routes/auth.js` from grep scan)
  - Duplicate root artifacts present: `homepage.html`, `homepage2.html`, `loginpage.html`, `adminlogin*.html`, root `verify.ejs`, `verify.js`, `AGENTS - Kopya.md`
  - One-off patch scripts only referenced in audit doc (`scripts/patch-*.js` grep hits only in old `OPTIMIZATIONS.md`)
- **Why it’s inefficient**: Dead code/files consume attention, increase onboarding friction, and can hide stale logic.
- **Recommended fix**:
  - Remove or archive dead files after reference verification.
  - Keep operational scripts in a clearly documented maintenance folder if still needed.
- **Tradeoffs / Risks**: Requires confirmation no external jobs/tooling rely on these files.
- **Expected impact estimate**: Low to Medium runtime impact, High maintainability ROI.
- **Removal Safety**: Needs Verification
- **Reuse Scope**: Repository-wide
- **Classification**: Dead Code

#### F10
- **Title**: Monolithic server file and inline HTML assembly reduce optimization agility
- **Category**: Build / Reliability
- **Severity**: Medium
- **Impact**: Faster iteration on performance work, clearer ownership of hot paths
- **Evidence**:
  - `server.js` size: `313922 bytes`, `6736 lines`
  - `/dashboard` builds full HTML string in route handler (`server.js:7177-7468`) despite existing view-driven architecture elsewhere
- **Why it’s inefficient**: Large mixed-concern file and inline-template logic increase refactor risk and make targeted optimization harder.
- **Recommended fix**:
  - Split route/service/data modules and move inline dashboard markup into dedicated view template path.
  - Keep route compatibility and behavior unchanged during extraction.
- **Tradeoffs / Risks**: Medium migration effort; requires careful regression checks.
- **Expected impact estimate**: Medium engineering velocity gain; indirect runtime benefit.
- **Removal Safety**: Needs Verification
- **Reuse Scope**: Service-wide
- **Classification**: Reuse Opportunity

### 3) Quick Wins (Do First)

Fastest high-value changes by implementation effort vs impact:
1. Replace `ORDER BY datetime(created_at)` with `ORDER BY created_at` where timestamp is ISO text; add missing companion indexes for hot list queries.
2. Convert auth-path sync bcrypt calls to async in `register/login/password-reset/password-change` handlers.
3. Introduce hard caps/default limits for stats and export endpoints (e.g., default date window + max rows) before larger API redesign.
4. Extract duplicated ban-check/reset into one helper and reuse across all call sites.
5. Remove clearly unused repository artifacts (`routes/auth.js` and duplicate root HTML files) after a final dependency check.

### 4) Deeper Optimizations (Do Next)

Architectural refactors with strong longer-term ROI:
1. Build schema-versioned migration runner and retire startup-wide repeated migration block.
2. Move session and rate-limit state to shared persistent stores for multi-instance correctness.
3. Redesign analytics path:
   - SQL-side aggregations
   - bounded API windows
   - optional pre-aggregated hourly/daily tables for high-volume links.
4. Add async export jobs for large datasets with downloadable artifact links.
5. Break `server.js` into route/service/data modules and eliminate inline large HTML assembly paths.

Proposed public APIs / interfaces (documented proposals only; not implemented):
1. `GET /api/stats/:short?from=<ISO>&to=<ISO>&bucket=hour|day&limit=<n>&cursor=<token>`
2. `GET /api/stats/:short/summary` returning bounded counters + top dimensions only
3. `POST /api/user/export/jobs` + `GET /api/user/export/jobs/:id` + `GET /api/user/export/jobs/:id/download`

### 5) Validation Plan

Benchmarks and profiling strategy:
1. Keep baseline checks in CI/local:
   - `npm test`
   - `node --check server.js routes/admin.js routes/auth.js public/script.js public/lang.js`
2. Query-plan validation for each changed SQL path:
   - Run `EXPLAIN QUERY PLAN`
   - Reject regressions that introduce `USE TEMP B-TREE FOR ORDER BY` on hot endpoints unless unavoidable.
3. Endpoint micro-benchmarks (before/after):
   - `/api/login` under concurrent requests
   - `/api/stats/:short` with increasing click cardinality
   - `/dashboard` and `/api/user/export` for large user datasets
4. Event-loop profiling:
   - Use `clinic`, `0x`, or `node --cpu-prof` around auth and redirect paths
   - Track max loop lag and p95/p99 latency.
5. Frontend metrics:
   - Compare JS/CSS transfer size, parse/eval time, and first-interaction latency after bundling/splitting.

Metrics to compare before/after:
1. API p50/p95/p99 latency (`/api/login`, `/api/stats`, `/dashboard` page render)
2. Event-loop lag (max and p95)
3. DB query time and temp-sort incidence
4. Memory footprint for session + limiter state
5. Response payload size for stats/export endpoints

Correctness guardrails:
1. Preserve route compatibility (`/path` and legacy `.html` aliases)
2. Preserve consent-gate behavior and redirect analytics rules
3. Preserve auth/session semantics (including OAuth and bans)
4. Add tests for pagination/date-window edge cases and max-click behavior if API changes are introduced

### 6) Optimized Code / Patch (proposal only, not applied)

Below are proposal snippets to make changes concrete. They are not applied in this audit task.

#### Proposal A: Async bcrypt in login path

```diff
--- a/server.js
+++ b/server.js
@@
-app.post('/api/login', authLimiter, [...], (req, res) => {
+app.post('/api/login', authLimiter, [...], async (req, res) => {
@@
-  db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
+  db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
@@
-    if (!bcrypt.compareSync(password, user.password)) {
+    const passwordOk = await bcrypt.compare(password, user.password || '');
+    if (!passwordOk) {
       return res.status(401).json({ error: wrongMsg });
     }
```

What changed:
- Handler becomes `async`.
- `compareSync` replaced with awaited `compare`.
- Keeps current behavior while removing event-loop blocking.

#### Proposal B: Bounded stats API query contract

```diff
--- a/server.js
+++ b/server.js
@@
-app.get('/api/stats/:short', (req, res) => {
+app.get('/api/stats/:short', (req, res) => {
+  const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
+  const to = req.query.to ? new Date(req.query.to) : new Date();
+  const limit = Math.min(Number.parseInt(req.query.limit || '5000', 10), 5000);
@@
-  db.all('SELECT * FROM clicks WHERE url_id = ?', [url.id], ...)
+  db.all(
+    `SELECT click_time, browser, os, country
+       FROM clicks
+      WHERE url_id = ? AND click_time >= ? AND click_time < ?
+      ORDER BY click_time DESC
+      LIMIT ?`,
+    [url.id, from.toISOString(), to.toISOString(), limit],
+    ...
+  )
```

What changed:
- Adds bounded time-window and row cap.
- Reduces unbounded memory growth risk.

#### Proposal C: Remove `datetime(...)` wrappers for index-friendly sorting

```diff
--- a/server.js
+++ b/server.js
@@
-ORDER BY datetime(n.created_at) DESC LIMIT 50
+ORDER BY n.created_at DESC LIMIT 50
@@
-ORDER BY datetime(last_seen_at) DESC
+ORDER BY last_seen_at DESC
@@
-ORDER BY datetime(d.created_at) DESC LIMIT 30
+ORDER BY d.created_at DESC LIMIT 30
```

What changed:
- Preserves chronological sort for ISO timestamps.
- Allows better index-order utilization and avoids temp sort structures.

---

Assumptions used in this report:
1. Local DB is currently small; scale-sensitive findings are marked as likely and paired with measurement plans.
2. Scope is audit-only documentation. No production code/schema/runtime behavior was changed.
3. Output mode requested was full overwrite of `OPTIMIZATIONS.md`.
