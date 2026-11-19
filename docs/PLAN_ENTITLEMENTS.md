# Ovlink Plan Entitlements & Quota Policy (P35)

## Existing Link & Historical Data Guarantee
When an organization reaches a monthly quota, cancels, or has a trial expire:
1. **Existing short links continue redirecting normally** — traffic is never broken.
2. **Historical campaigns, clicks, conversions, and report snapshots are never deleted.**
3. Only **creating new resources above the active tier's hard limit** is gated, returning a clear `upgrade_reason` and `recommended_tier`.

## Soft Warning vs. Hard Limit
- **Soft Warning (`>= 80%`)**: Operation is allowed (`allowed: true`), `level: 'soft_warning'`, and an upgrade notice is returned.
- **Hard Limit (`> 100%`)**: Operation is blocked (`allowed: false`), `level: 'hard_limit'`, with the exact `metric`, `used/limit`, and `recommended_tier`.
