# Ovlink SaaS — Trust, Support SLA, Incident Recovery & Privacy Legal Checklist (P42)

**Contract Version:** `trust-support-v1`  
**Honesty Disclosure:** Ovlink does **not** claim third-party certifications (SOC 2, ISO 27001, HIPAA) without completed external audits. The legal checklist below is an operational preparation list for qualified legal counsel, **not** formal legal advice.

## 1. Realistic Support SLA

| Plan | Channel | Target Response |
| --- | --- | --- |
| Free | Self-service Help Center | Best effort (no SLA) |
| Starter ($7/mo) | Email & Support Ticket | 48 business hours |
| Business ($19/mo) | Email & Support Ticket | 24 business hours |
| Agency ($49/mo) | Priority Support Ticket | 12 business hours |
| Enterprise ($129/mo) | Priority Ticket & Ops Escalation | 4 business hours |

## 2. Incident Communication & Recovery Runbook

1. **Detect:** Health check (`/health`, `/api/public/trust-status`) and P29 business alerts flag DB/redirect degradation.
2. **Communicate:** Record incident in `system_incidents` with severity (`minor|major|critical`), transparent user-facing status, and honest timeline (never hide outages).
3. **Recover:** Restore from verified PostgreSQL backup (`pg_dump`/`pg_restore` tested in P12), verify redirect hot-path SLO, and publish post-incident resolution timestamp.

## 3. Subprocessors & Data Retention

- **VPS / Cloud Infrastructure:** Application, PostgreSQL & Redis hosting.
- **Polar.sh:** Merchant of Record billing, VAT/sales tax, and receipts.
- **Transactional Mail Provider:** Verification codes, team invites, scheduled reports, and alerts.
- **Self-Serve Data Rights:** Authenticated users can export their scoped data bundle (`GET /api/privacy/data-export`, password hashes/secrets excluded) and request verified account deletion (`POST /api/privacy/data-delete` with `confirm_text: "DELETE"`).

## 4. Legal Counsel Review Checklist (Azerbaijan & Cross-Border)

- [ ] Review registration/operator duties under the Law of the Republic of Azerbaijan on Personal Data (*"Fərdi məlumatlar haqqında" Qanun*).
- [ ] Validate explicit user consent wording for cross-border data processing (EU/US hosting + Polar.sh billing).
- [ ] Approve B2B Data Processing Agreement (DPA) template before enterprise procurement.
