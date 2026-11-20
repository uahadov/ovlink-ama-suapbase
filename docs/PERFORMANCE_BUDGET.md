# Ovlink SaaS — Performance Budget & Scaling Guide (P47)

**Contract Version:** `perf-guard-v1`  
**SLA Honesty Note:** A single small VPS targets best-effort `99.5%–99.9%` availability. We explicitly do **not** claim `99.99%` SLA without multi-AZ redundancy and automated failover.

## 1. Performance Targets (Low-RAM VPS Budget)

| Flow | Target p95 | Backpressure Behavior |
| --- | --- | --- |
| Short-link redirect (`/s` hot path) | `< 35 ms` | **Never throttled**; fail-open analytics & metering |
| Authenticated API / Campaign list | `< 150 ms` | Bounded pagination (`limit <= 200`, `offset <= 50,000`) |
| A4 PDF report generation | `< 50 ms` | Zero-Chromium pure-Node (<10ms typical); `503 Retry-After: 30` under RSS >= 450MB |
| Background job queue | `< 200` pending lag | `FOR UPDATE SKIP LOCKED` + bounded retry + dead-letter cap |

## 2. Database Indexing & Preaggregation

- `link_stats_daily` daily preaggregation prevents full `clicks` scans for dashboard charts.
- Composite indexes `idx_urls_workspace_created` (`urls(workspace_id, created_at DESC)`) and `idx_clicks_url_time_bot` (`clicks(url_id, click_time DESC)`) keep workspace listings and campaign date-range scans index-backed.
- Verified in isolated PostgreSQL 16 QA (`HANDOFF/EVIDENCE/P47-perf-benchmark-2026-11-20.json`) without altering any analytical totals.
