# Ovlink SaaS — Technical Release Gates & Go-Live Checklist (P48)

**Contract Version:** `release-gate-v1`  
**Golden Rule:** Red CI tests are never hidden or skipped; Monolith visual baseline is never redesigned without explicit approval; production deploy requires explicit founder sign-off.

## 1. Automated Technical Release Gates

1. **Syntax & Structural Gate:** `node scripts/check-syntax.js` + `node scripts/release-gate-check.js` -> `ok: true`.
2. **Full Regression Suite:** All unit, contract, API, MCP, billing, entitlement, onboarding, trust, and performance tests **100% PASS, 0 FAIL, 0 SKIP** against isolated PostgreSQL 16 + Redis 7.4.
3. **Playwright Visual & Responsive Gate:** 320, 390, 768, 1440 px × AZ/TR/EN with 0 horizontal overflow, 0 console/page errors, `prefers-reduced-motion`, and Monolith baseline preserved.
4. **Backup & Restore Drill (Zero Data Loss):** Real `pg_dump` → clean target DB → `pg_restore` verifying row-count parity across `users`, `workspaces`, `urls`, `campaigns`, and `org_billing_accounts`.
5. **Canary / Rollback Safety:** Tag release (`v2.0.0-rcX`), run `/health` + `/api/public/trust-status` smoke check, and keep additive-only migrations so code rollback never drops customer data.

## 2. Remaining Manual Business Prerequisites Before P49 Live Launch

- [ ] **Polar.sh Live Seller Onboarding:** Verify Azerbaijan seller payout eligibility in the live Polar seller dashboard.
- [ ] **P05 / P43–P46 Real Buyer Validation:** Complete real agency discovery interviews, pilot onboarding, and approved customer feedback.
- [ ] **P38 5-Person Comprehension Check:** Confirm 5 real people understand Ovlink's homepage offer in 5–10 seconds.
- [ ] **P42 Legal Counsel Review:** Obtain qualified lawyer sign-off on Azerbaijan Personal Data Law & cross-border transfer disclosures.
