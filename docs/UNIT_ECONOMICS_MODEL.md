# Ovlink SaaS — Unit Economics & Capacity Pricing Hypothesis (P37 — Calibrated Challenger Ladder)

**Contract Version:** `unit-economics-v1`  
**Honesty Note:** Historical LTV and CAC are intentionally `null` until verified paid B2B customer cohorts exist. This document models **variable infrastructure/operational costs and worst-case gross margin ceilings** so no tier can lose money even at 100% quota saturation.

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

## 2. Calibrated Challenger Pricing & Worst-Case Gross Margin Matrix

| Plan | Monthly Price (USD) | Worst-Case Redirects | Worst-Case Variable + Fee + Support Cost | Worst-Case Net Profit / Gross Margin | Margin Safe? |
| --- | --- | --- | --- | --- | --- |
| **Free** | `$0` | 25,000 | `$0.0573` | Capped <= `$0.25/mo` | Yes |
| **Legacy Pro (Grandfathered)** | `$4.99` | 250,000 | `$1.4946` | `$3.50` (`70.05%`) | Yes |
| **Starter** | `$7` (~12 AZN) | 300,000 | `$1.9000` | `$5.10` (`72.86%`) | Yes |
| **Business** | `$19` (~32 AZN) | 2,000,000 | `$5.9250` | `$13.08` (`68.82%`) | Yes |
| **Agency** | `$49` (~83 AZN) | 5,000,000 | `$15.4100` | `$33.59` (`68.55%`) | Yes |
| **Enterprise** | `$129` (~219 AZN) | 20,000,000 | `$43.8600` | `$85.14` (`66.00%`) | Yes |

## 3. Operational Guardrails

- **Fail-Open Metering:** Any metering write failure (including legacy accounts without organization billing rows) fails open and **never interrupts short-link redirects**.
- **Alert Thresholds:** Soft warnings trigger at `80%` of monthly capacity or `100%` projected end-of-month run-rate; critical alerts trigger at `95%`; margin compression alerts trigger if actual monthly gross margin drops below `65%`.
- **Pricing Hypothesis:** Paid tiers stay 2×–6× cheaper than global competitors (Bitly, Rebrandly, Dub.co, Replug, Linkly, Cutt.ly, Switchy) while preserving `66%–73%` gross margin at 100% worst-case saturation and `~85%–90%` under typical customer load.
