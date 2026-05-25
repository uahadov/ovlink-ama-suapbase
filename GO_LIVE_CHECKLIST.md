# GO_LIVE_CHECKLIST.md

## Required before production release
- [ ] `SESSION_SECRET` is set and >=64 random bytes.
- [ ] `API_KEY_HASH_SECRET` is set and >=64 random bytes.
- [ ] `WEBHOOK_HASH_SECRET` is set and >=64 random bytes.
- [ ] `PUBLIC_BASE_URL` and/or `BASE_URL` points to the real HTTPS origin.
- [ ] `TRUST_PROXY_HOPS` is set to exact reverse-proxy hop count.
- [ ] `REDIS_URL` is configured and reachable from app runtime.
- [ ] `ALLOW_INSECURE_WEBHOOK_HTTP` is not enabled.
- [ ] Alerting destination is configured (`ALERT_WEBHOOK_URL` and/or `SENTRY_DSN`).
- [ ] CI gate passed (`npm test`, `node --check ...`, `npm audit --omit=dev`).
- [ ] Rollback target and incident owner confirmed.

## Smoke checks (staging/production)
- [ ] Login and register flow works.
- [ ] Link create and redirect flow works.
- [ ] Pro API key auth + scope checks work.
- [ ] `Idempotency-Key` replay behavior works on `/api/pro/v1/shorten`.
- [ ] Webhook create/test/replay works with HTTPS targets.
