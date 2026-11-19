'use strict';

process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'p23-decision-test-secret-0123456789abcdef0123456789abcdef';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('node:http');
const { Client } = require('pg');

const {
  buildDecisionAnalyticsReport,
  buildDecisionCsv,
} = require('../src/lib/decision-analytics');
const { hashActorIdentifier } = require('../src/lib/conversion-events');
const { REDIRECT_CONSENT_MARKER } = require('../src/lib/consent');
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

test('P23 unit: 5 core KPIs, 3-channel comparison, period-over-period deltas, unknown visibility & 1:1 CSV parity', () => {
  const now = new Date('2026-11-20T10:00:00.000Z');
  const report = buildDecisionAnalyticsReport({
    campaign: { id: 42, name: '=Formula Campaign', slug: 'formula-camp' },
    rangeDays: 7,
    includeBots: false,
    now,
    lastClickAt: '2026-11-20T09:30:00.000Z',
    currentClicksRows: [
      { utm_source: 'instagram', referrer_host: 'instagram.com', browser: null, clicks: 40, uniques: 32 },
      { utm_source: 'google', referrer_host: 'google.com', browser: null, clicks: 30, uniques: 25 },
      { utm_source: 'telegram', referrer_host: 't.me', browser: null, clicks: 20, uniques: 18 },
      { utm_source: null, referrer_host: null, browser: REDIRECT_CONSENT_MARKER, clicks: 10, uniques: 0 },
    ],
    previousClicksRows: [
      { utm_source: 'instagram', referrer_host: 'instagram.com', browser: null, clicks: 20, uniques: 16 },
      { utm_source: 'google', referrer_host: 'google.com', browser: null, clicks: 30, uniques: 25 },
    ],
    attributionReport: {
      model: 'last_touch',
      window_days: 7,
      summary: {
        total_events: 10,
        attributed_events: 7,
        unattributed_events: 3,
        leads: { total: 6, attributed: 4, unattributed: 2, unmeasurable_consent_or_session: 1 },
        purchases: { total: 4, attributed: 3, unattributed: 1 },
        revenue_by_currency: { AZN: { total: 300, attributed: 250, unattributed: 50, events_count: 4 } },
        attributed_by_source: { google: 4, instagram: 2, telegram: 1 },
        roi: null,
      },
      events: [
        { goal: 'lead', status: 'attributed' },
        { goal: 'lead', status: 'unmatched' },
        { goal: 'purchase', status: 'attributed' },
      ],
    },
  });

  // Exactly 5 core KPIs
  assert.equal(Object.keys(report.core_kpis).length, 5);
  assert.equal(report.core_kpis.clicks.value, 100);
  assert.equal(report.core_kpis.clicks.previous, 50);
  assert.equal(report.core_kpis.clicks.delta_percent, 100);
  assert.equal(report.core_kpis.attributed_conversions.value, 7);
  assert.equal(report.core_kpis.unknown_and_unattributed.unknown_or_direct_clicks, 10);
  assert.equal(report.core_kpis.unknown_and_unattributed.unattributed_conversions, 3);
  assert.equal(report.core_kpis.unknown_and_unattributed.unmeasurable_consent_or_session_leads, 1);

  // 3 measurable channels + unknown_consent visible
  assert.equal(report.channel_comparison.length, 4);
  assert.equal(report.decision_summary.top_by_clicks.channel, 'instagram');
  assert.equal(report.decision_summary.top_by_attributed_conversions.channel, 'google');
  assert.equal(report.decision_summary.roi, null);
  assert.equal(report.badges.freshness.status, 'fresh');
  assert.equal(report.badges.bot_filter, 'human_only');

  // Telegram had 0 previous clicks -> delta_percent is null (never fake +100%)
  const tg = report.channel_comparison.find((c) => c.channel === 'telegram');
  assert.equal(tg.delta_percent, null);

  // CSV matches exact JSON numbers and neutralizes formula injection
  const csv = buildDecisionCsv(report);
  assert.ok(csv.includes("\"'=Formula Campaign\""));
  assert.ok(csv.includes('"Clicks","100","50","100","exact"'));
  assert.ok(csv.includes('"google","30","25","30","30","0","4","13.3","measured"'));
  assert.ok(csv.includes('"unknown_consent","10","0","10","0","","0","0","unmeasurable_consent"'));
});

test('P23 PG + HTTP integration: 3-channel synthetic comparison, unknown/unattributed visibility, 404 on invalid campaign & OpenAPI', {
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
      [`p23-dec-${code}@example.test`, futurePro, isoAgo(30000)]
    );
    ownerId = u.rows[0].id;

    const c = await client.query(
      'INSERT INTO campaigns(user_id, name, slug, created_at) VALUES($1, $2, $3, $4) RETURNING id',
      [ownerId, 'P23 Decision QA', `p23-${code}`, isoAgo(30000)]
    );
    campaignId = c.rows[0].id;

    const l = await client.query(
      'INSERT INTO urls(user_id, short, original, created_at, campaign_id) VALUES($1, $2, $3, $4, $5) RETURNING id',
      [ownerId, `p23${code}`, 'https://example.test/p23', isoAgo(30000), campaignId]
    );
    linkId = l.rows[0].id;

    await client.query(
      'INSERT INTO api_keys(user_id, name, scopes, key_hash, hash_version, key_prefix, last4, created_at) VALUES($1,$2,$3,$4,2,$5,$6,$7)',
      [ownerId, 'P23 Key', 'account:read,shorten:write', hashApiKeyValue(apiKey), getApiKeyPrefix(apiKey), getApiKeyLast4(apiKey), isoAgo(30000)]
    );

    // Seed 3 channels in current 7d window + 1 bot click (must be excluded) + 1 essential click + 1 previous-window click
    const igActor = `ig-${code}`;
    const ggActor = `gg-${code}`;
    const igHash = hashActorIdentifier(igActor);
    const ggHash = hashActorIdentifier(ggActor);

    const clickRows = [
      // Current 7d: instagram (2 clicks), google (1 click), telegram (1 click), essential (1 click), bot (1 click)
      [isoAgo(120), 'Chrome', igHash, 0, 'instagram.com', 'instagram'],
      [isoAgo(90), 'Chrome', `ig-other-${code}`, 0, 'instagram.com', 'instagram'],
      [isoAgo(80), 'Chrome', ggHash, 0, 'google.com', 'google'],
      [isoAgo(70), 'Chrome', `tg-user-${code}`, 0, 't.me', 'telegram'],
      [isoAgo(60), REDIRECT_CONSENT_MARKER, null, 0, null, null],
      [isoAgo(50), 'Bot', `bot-${code}`, 1, 'bot.net', 'bot-channel'],
      // Previous 7d window (10 days ago = 14400 min ago): instagram (1 click)
      [isoAgo(14400), 'Chrome', `prev-ig-${code}`, 0, 'instagram.com', 'instagram'],
    ];
    for (const [ts, browser, ipHash, isBot, ref, utm] of clickRows) {
      await client.query(
        'INSERT INTO clicks(url_id, click_time, browser, ip_hash, is_bot, referrer_host, utm_source) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [linkId, ts, browser, ipHash, isBot, ref, utm]
      );
    }

    // Ingest 1 attributed purchase on google + 1 unattributed essential lead via P21 API
    const rPurch = await jsonFetch(baseUrl, '/api/pro/v1/conversions', {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
      body: {
        event_id: `p23_p_${code}`,
        short: `p23${code}`,
        goal: 'purchase',
        source: 'checkout',
        consent: 'analytics',
        value: 150,
        currency: 'AZN',
        actor: { external_id: ggActor },
      },
    });
    assert.equal(rPurch.status, 201);

    const rLead = await jsonFetch(baseUrl, '/api/pro/v1/conversions', {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
      body: {
        event_id: `p23_l_${code}`,
        short: `p23${code}`,
        goal: 'lead',
        source: 'js_sdk',
        consent: 'essential',
      },
    });
    assert.equal(rLead.status, 201);

    // Decision endpoint compares 3 measurable channels + unknown_consent
    const rDec = await jsonFetch(baseUrl, `/api/pro/v1/campaigns/${campaignId}/decision?days=7&bots=exclude`, {
      headers: { 'x-api-key': apiKey },
    });
    assert.equal(rDec.status, 200);
    assert.equal(rDec.body.core_kpis.clicks.value, 5); // 2 ig + 1 gg + 1 tg + 1 essential (bot excluded)
    assert.equal(rDec.body.core_kpis.clicks.previous, 1);
    assert.equal(rDec.body.core_kpis.clicks.delta_percent, 400);
    assert.equal(rDec.body.core_kpis.attributed_conversions.value, 1);
    assert.equal(rDec.body.core_kpis.unknown_and_unattributed.unknown_or_direct_clicks, 1);
    assert.equal(rDec.body.core_kpis.unknown_and_unattributed.unattributed_conversions, 1);
    assert.equal(rDec.body.decision_summary.top_by_clicks.channel, 'instagram');
    assert.equal(rDec.body.decision_summary.top_by_attributed_conversions.channel, 'google');
    assert.equal(rDec.body.channel_comparison.some((ch) => ch.channel === 'bot-channel'), false);
    assert.equal(rDec.body.channel_comparison.some((ch) => ch.channel === 'telegram'), true);
    assert.equal(rDec.body.badges.freshness.status, 'fresh');

    // Invalid / non-existent campaign returns 404 (never silently shown as 0)
    const rNotFound = await jsonFetch(baseUrl, '/api/pro/v1/campaigns/999999999/decision', {
      headers: { 'x-api-key': apiKey },
    });
    assert.equal(rNotFound.status, 404);

    // OpenAPI includes /api/pro/v1/campaigns/{id}/decision
    const rOpenApi = await jsonFetch(baseUrl, '/api/pro/v1/openapi.json');
    assert.equal(rOpenApi.status, 200);
    assert.ok(rOpenApi.body.paths['/api/pro/v1/campaigns/{id}/decision']);
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
