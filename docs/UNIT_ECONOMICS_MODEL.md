# Ovlink SaaS — Unit Economics & Capacity Pricing Hypothesis (P37)

**Contract Version:** `unit-economics-v1`  
**Honesty Note:** Historical LTV and CAC are intentionally `null` until verified paid B2B customer cohorts exist. This document models **variable infrastructure/operational costs and worst-case gross margin ceilings** so no tier can lose money under maximum allowed usage.

## 1. Unit Cost Assumptions (USD)

| Resource | Conservative Unit Cost | Operational Basis |
| --- | --- | --- |
| Redirects (per 1,000,000 clicks) | `$0.45` | Node.js redirect hot path + Redis cache + daily PG rollup |
| PDF Export (per report) | `$0.0015` | Zero-Chromium pure-Node PDF 1.4 generator (<10ms CPU, low RAM) |
| Email Delivery (per message) | `$0.0008` | Scheduled report & alert transactional mail |
| AI Tokens (per 1,000 tokens) | `$0.0025` | MCP workflow summary/drafting budget |
| DB Storage (per GB / month) | `$0.18` | PostgreSQL SSD + WAL + automated backups |
| Support Allocation (per ticket) | `$2.50` | Allocated founder/support handling time |
| Payment Processing (Polar MoR) | `4.0% + $0.40` | Merchant-of-Record checkout & global tax handling |

## 2. Per-Plan Worst-Case Cost & Gross Margin Matrix

| Plan | Monthly Price (USD) | Worst-Case Redirects | Worst-Case Variable + Fee Cost | Worst-Case Gross Margin | Margin Safe? |
| --- | --- | --- | --- | --- | --- |
| **Free** | `$0` | 50,000 | `$0.0685` | N/A (capped <= `$0.25/mo`) | Yes |
| **Legacy Pro (Grandfathered)** | `$4.99` | 250,000 | `$1.4946` | `70.05%` | Yes |
| **Starter** | `$19` | 500,000 | `$4.5600` | `76.00%` | Yes |
| **Business** | `$49` | 2,500,000 | `$11.0850` | `77.38%` | Yes |
| **Agency** | `$129` | 10,000,000 | `$30.4600` | `76.39%` | Yes |
| **Enterprise** | `$349` | 40,000,000 | `$79.7600` | `77.15%` | Yes |

## 3. Operational Guardrails

- **Fail-Open Metering:** Any metering write failure (including legacy accounts without organization billing rows) fails open and **never interrupts short-link redirects**.
- **Alert Thresholds:** Soft warnings trigger at `80%` of monthly capacity or `100%` projected end-of-month run-rate; critical alerts trigger at `95%`; margin compression alerts trigger if actual monthly gross margin drops below `65%`.
- **Pricing Hypothesis:** Paid tiers maintain `>= 70%` gross margin even at 100% worst-case quota saturation, leaving room for fixed VPS/domain overhead and future customer acquisition spend once real CAC/LTV data is measured.
