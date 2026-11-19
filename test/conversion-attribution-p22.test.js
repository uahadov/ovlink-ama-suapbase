'use strict';

process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'p22-attr-test-secret-0123456789abcdef0123456789abcdef';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('node:http');
const { Client } = require('pg');

const {
  UNMATCHED_REASONS,
  attributeConversionEvents,
  getAttributionContractSpec,
} = require('../src/lib/conversion-attribution');
const { hashActorIdentifier } = require('../src/lib/conversion-events');
const { getFullAnalyticsContract } = require('../src/lib/metrics-contract');
const { buildApiKeyValue, hashApiKeyValue, getApiKeyPrefix, getApiKeyLast4 } = require('../src/lib/security');

const url = process.env.DATABASE_URL || '';
const safeDb = /\/ovlink_[\w]*qa[\w]*$/.test(url.split('?')[0]);

async function jsonFetch(baseUrl, path, { method = 'GET', headers = {}, body } = {}) {
  const opts = { method, headers: { ...headers } };
  if (body !== undefined) {
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${baseUrl}${path}`, opts);
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

test('P22 unit: 9 explainable attribution scenarios (last/first touch, window, bot, consent, skew, orphan, multi-currency, dedupe, zero fake ROI)', () => {
  const baseMs = new Date('2026-11-19T12:00:00.000Z').getTime();
  const iso = (deltaMin) => new Date(baseMs + deltaMin * 60000).toISOString();

  const clicks = [
    // Two human clicks for actor A -> tests last_touch vs first_touch
    { id: 1, url_id: 10, click_time: iso(-120), ip_hash: 'actor-a', is_bot: 0, referrer_host: 'google.com', utm_source: 'google' },
    { id: 2, url_id: 10, click_time: iso(-30), ip_hash: 'actor-a', is_bot: 0, referrer_host: 'instagram.com', utm_source: 'instagram' },
    // Click 10 days ago for actor B -> outside 7d window
    { id: 3, url_id: 10, click_time: iso(-14400), ip_hash: 'actor-old', is_bot: 0, referrer_host: 'facebook.com' },
    // Bot click only for actor C
    { id: 4, url_id: 10, click_time: iso(-20), ip_hash: 'actor-bot', is_bot: 1, referrer_host: 'bot.net' },
    // Future click for actor D -> conversion occurred before click (time skew)
    { id: 5, url_id: 10, click_time: iso(15), ip_hash: 'actor-skew', is_bot: 0, referrer_host: 't.me' },
    // Valid human click for USD purchase
    { id: 6, url_id: 10, click_time: iso(-45), ip_hash: 'actor-usd', is_bot: 0, referrer_host: 'linkedin.com' },
  ];

  const events = [
    // S1/S2: Lead matched to click #2 (last_touch) or #1 (first_touch)
    { event_id: 'ev_lead_touch', url_id: 10, goal: 'lead', occurred_at: iso(0), consent_mode: 'analytics', actor_hash: 'actor-a' },
    // S3: Outside 7-day window
    { event_id: 'ev_old', url_id: 10, goal: 'lead', occurred_at: iso(0), consent_mode: 'analytics', actor_hash: 'actor-old' },
    // S4: Bot click only
    { event_id: 'ev_bot', url_id: 10, goal: 'lead', occurred_at: iso(0), consent_mode: 'analytics', actor_hash: 'actor-bot' },
    // S5: Essential consent -> unmeasurable
    { event_id: 'ev_consent', url_id: 10, goal: 'lead', occurred_at: iso(0), consent_mode: 'essential', actor_hash: null },
    // S6: Time skew (event before click)
    { event_id: 'ev_skew', url_id: 10, goal: 'lead', occurred_at: iso(0), consent_mode: 'analytics', actor_hash: 'actor-skew' },
    // S7: Orphan / no prior click
    { event_id: 'ev_orphan', url_id: 10, goal: 'lead', occurred_at: iso(0), consent_mode: 'analytics', actor_hash: 'actor-unknown' },
    // S8a: AZN purchase attributed
    { event_id: 'ev_azn', url_id: 10, goal: 'purchase', occurred_at: iso(0), consent_mode: 'analytics', actor_hash: 'actor-a', value_amount: 100, value_currency: 'AZN' },
    // S8b: USD purchase attributed (must NOT mix with AZN)
    { event_id: 'ev_usd', url_id: 10, goal: 'purchase', occurred_at: iso(0), consent_mode: 'analytics', actor_hash: 'actor-usd', value_amount: 50, value_currency: 'USD' },
    // S9: Duplicate event_id must be ignored defensively
    { event_id: 'ev_azn', url_id: 10, goal: 'purchase', occurred_at: iso(0), consent_mode: 'analytics', actor_hash: 'actor-a', value_amount: 100, value_currency: 'AZN' },
  ];

  // Last-touch verification
  const lastRes = attributeConversionEvents({ events, clicks, windowDays: 7, model: 'last_touch' });
  const byIdLast = Object.fromEntries(lastRes.events.map((e) => [e.event_id, e]));

  assert.equal(lastRes.summary.total_events, 8, 'duplicate event_id must not inflate total');
  assert.equal(lastRes.summary.attributed_events, 3);
  assert.equal(lastRes.summary.unattributed_events, 5);
  assert.equal(byIdLast.ev_lead_touch.matched_click_id, 2);
  assert.equal(byIdLast.ev_lead_touch.source, 'instagram');
  assert.equal(byIdLast.ev_old.unmatched_reason, UNMATCHED_REASONS.OUTSIDE_WINDOW);
  assert.equal(byIdLast.ev_bot.unmatched_reason, UNMATCHED_REASONS.BOT_CLICK_ONLY);
  assert.equal(byIdLast.ev_consent.unmatched_reason, UNMATCHED_REASONS.CONSENT_OR_SESSION);
  assert.equal(byIdLast.ev_skew.unmatched_reason, UNMATCHED_REASONS.TIME_SKEW_BEFORE_CLICK);
  assert.equal(byIdLast.ev_orphan.unmatched_reason, UNMATCHED_REASONS.NO_PRIOR_CLICK);

  // Lead total vs attributed vs unmeasurable consent/session explicitly explained
  assert.deepEqual(lastRes.summary.leads, {
    total: 6,
    attributed: 1,
    unattributed: 5,
    unmeasurable_consent_or_session: 1,
  });

  // Multi-currency strictly separated; ROI is never fabricated
  assert.equal(lastRes.summary.revenue_by_currency.AZN.attributed, 100);
  assert.equal(lastRes.summary.revenue_by_currency.USD.attributed, 50);
  assert.equal(lastRes.summary.roi, null);
  assert.equal(lastRes.summary.roi_status, 'not_computed_without_verified_spend_and_fx');

  // First-touch verification
  const firstRes = attributeConversionEvents({ events, clicks, windowDays: 7, model: 'first_touch' });
  const byIdFirst = Object.fromEntries(firstRes.events.map((e) => [e.event_id, e]));
  assert.equal(byIdFirst.ev_lead_touch.matched_click_id, 1);
  assert.equal(byIdFirst.ev_lead_touch.source, 'google');

  // Methodology contract exposes attribution spec
  const spec = getAttributionContractSpec();
  assert.ok(spec.causality_disclaimer.includes('temporal correlation'));
  assert.equal(getFullAnalyticsContract().attribution.version, 'v1');
});

test('P22 PG + HTTP Scenario 10: end-to-end campaign attribution reconciliation via Pro API & methodology', {
  skip: !safeDb && 'Requires a dedicated Ovlink QA PostgreSQL database',
  timeout: 30000,
}, async () => {
  const { app } = require('../server');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const client = new Client({ connectionString: url });
  await client.connect();

  const code = crypto.randomBytes(5).toString('hex');
  const now = Date.now();
  const isoAgo = (minutes) => new Date(now - minutes * 60000).toISOString();
  const futurePro = new Date(now + 30 * 86400 * 1000).toISOString();
  let ownerId, campaignId, linkId;
  const apiKey = buildApiKeyValue();

  try {
    const u = await client.query(
      "INSERT INTO users(email, email_verified, plan_tier, plan_status, pro_expires_at, created_at) VALUES($1, 1, 'pro', 'active', $2, $3) RETURNING id",
      [`p22-attr-${code}@example.test`, futurePro, isoAgo(300)]
    );
    ownerId = u.rows[0].id;

    const c = await client.query(
      'INSERT INTO campaigns(user_id, name, slug, created_at) VALUES($1, $2, $3, $4) RETURNING id',
      [ownerId, 'P22 Attribution QA', `p22-${code}`, isoAgo(300)]
    );
    campaignId = c.rows[0].id;

    const l = await client.query(
      'INSERT INTO urls(user_id, short, original, created_at, campaign_id) VALUES($1, $2, $3, $4, $5) RETURNING id',
      [ownerId, `p22${code}`, 'https://example.test/p22', isoAgo(300), campaignId]
    );
    linkId = l.rows[0].id;

    await client.query(
      'INSERT INTO api_keys(user_id, name, scopes, key_hash, hash_version, key_prefix, last4, created_at) VALUES($1,$2,$3,$4,2,$5,$6,$7)',
      [ownerId, 'P22 Key', 'account:read,shorten:write', hashApiKeyValue(apiKey), getApiKeyPrefix(apiKey), getApiKeyLast4(apiKey), isoAgo(300)]
    );

    // Seed clicks using hashed actor ID matching P21 ingestion
    const buyerActor = `buyer-${code}`;
    const buyerHash = hashActorIdentifier(buyerActor);
    await client.query(
      'INSERT INTO clicks(url_id, click_time, browser, ip_hash, is_bot, referrer_host, utm_source) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [linkId, isoAgo(180), 'Chrome', buyerHash, 0, 'google.com', 'google']
    );
    await client.query(
      'INSERT INTO clicks(url_id, click_time, browser, ip_hash, is_bot, referrer_host, utm_source) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [linkId, isoAgo(40), 'Chrome', buyerHash, 0, 'instagram.com', 'instagram']
    );

    // Ingest 1 attributed purchase + 1 essential-consent unmeasurable lead via P21 API
    const rPurch = await jsonFetch(baseUrl, '/api/pro/v1/conversions', {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
      body: {
        event_id: `p22_purch_${code}`,
        short: `p22${code}`,
        goal: 'purchase',
        source: 'checkout',
        consent: 'analytics',
        value: 199.5,
        currency: 'AZN',
        actor: { external_id: buyerActor },
      },
    });
    assert.equal(rPurch.status, 201);

    const rEssLead = await jsonFetch(baseUrl, '/api/pro/v1/conversions', {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
      body: {
        event_id: `p22_lead_${code}`,
        short: `p22${code}`,
        goal: 'lead',
        source: 'js_sdk',
        consent: 'essential',
      },
    });
    assert.equal(rEssLead.status, 201);

    // Query Pro v1 attribution endpoint with last_touch & first_touch
    const rAttrLast = await jsonFetch(
      baseUrl,
      `/api/pro/v1/campaigns/${campaignId}/attribution?window_days=7&model=last_touch`,
      { headers: { 'x-api-key': apiKey } }
    );
    assert.equal(rAttrLast.status, 200);
    assert.equal(rAttrLast.body.summary.total_events, 2);
    assert.equal(rAttrLast.body.summary.attributed_events, 1);
    assert.equal(rAttrLast.body.summary.unattributed_events, 1);
    assert.equal(rAttrLast.body.summary.leads.total, 1);
    assert.equal(rAttrLast.body.summary.leads.attributed, 0);
    assert.equal(rAttrLast.body.summary.leads.unmeasurable_consent_or_session, 1);
    assert.equal(rAttrLast.body.summary.revenue_by_currency.AZN.attributed, 199.5);
    assert.equal(rAttrLast.body.summary.attributed_by_source.instagram, 1);
    assert.equal(rAttrLast.body.summary.roi, null);

    const rAttrFirst = await jsonFetch(
      baseUrl,
      `/api/pro/v1/campaigns/${campaignId}/attribution?window_days=7&model=first_touch`,
      { headers: { 'x-api-key': apiKey } }
    );
    assert.equal(rAttrFirst.status, 200);
    assert.equal(rAttrFirst.body.summary.attributed_by_source.google, 1);

    // Methodology endpoint includes P22 attribution spec
    const rMeth = await jsonFetch(baseUrl, '/api/analytics/methodology');
    assert.equal(rMeth.status, 200);
    assert.equal(rMeth.body.attribution.version, 'v1');
  } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (ownerId) {
      await client.query('DELETE FROM conversion_events WHERE user_id=$1', [ownerId]).catch(() => {});
      await client.query('DELETE FROM analytics_audit_log WHERE user_id=$1', [ownerId]).catch(() => {});
      await client.query('DELETE FROM api_keys WHERE user_id=$1', [ownerId]).catch(() => {});
    }
    if (linkId) {
      await client.query('DELETE FROM link_conversions WHERE url_id=$1', [linkId]).catch(() => {});
      await client.query('DELETE FROM clicks WHERE url_id=$1', [linkId]).catch(() => {});
      await client.query('DELETE FROM link_stats_daily WHERE url_id=$1', [linkId]).catch(() => {});
      await client.query('DELETE FROM urls WHERE id=$1', [linkId]).catch(() => {});
    }
    if (campaignId) await client.query('DELETE FROM campaigns WHERE id=$1', [campaignId]).catch(() => {});
    if (ownerId) await client.query('DELETE FROM users WHERE id=$1', [ownerId]).catch(() => {});
    await client.end();
    await require('../src/db/pool').pool.end().catch(() => {});
  }
});
