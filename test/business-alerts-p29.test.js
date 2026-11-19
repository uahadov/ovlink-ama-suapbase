'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');

const businessAlerts = require('../src/lib/business-alerts');

test('P29 unit: noise floor suppresses tiny volume, low data flags suspicious, high volume triggers anomaly', () => {
  // Below noise floor
  const tiny = businessAlerts.evaluateTrafficSignal({ baselineClicks: 2, currentClicks: 0 });
  assert.equal(tiny.triggered, false);
  assert.equal(tiny.reason, 'below_noise_floor');

  // Low data -> flagged as suspicious, never definitive failure
  const low = businessAlerts.evaluateTrafficSignal({ baselineClicks: 10, currentClicks: 2, minSampleSize: 30 });
  assert.equal(low.triggered, true);
  assert.equal(low.confidence, 'low_data_suspicious');
  assert.equal(low.label, 'suspicious');

  // Sufficient data -> high-confidence anomaly
  const high = businessAlerts.evaluateTrafficSignal({ baselineClicks: 120, currentClicks: 20, minSampleSize: 30 });
  assert.equal(high.triggered, true);
  assert.equal(high.confidence, 'high');
  assert.equal(high.severity, 'critical');
  assert.equal(high.direction, 'drop');
});

const dbUrl = process.env.DATABASE_URL || '';
const safeDb = /\/ovlink_[\w]*qa[\w]*$/.test(dbUrl.split('?')[0]);

test('P29 integration: preferences, synthetic anomaly alert, anti-spam dedupe & open->resolved lifecycle', { skip: !safeDb && 'Requires isolated QA DB', timeout: 30000 }, async () => {
  const express = require('express');
  const { dbRunAsync } = require('../src/db/helpers');
  const campaignsRouter = require('../src/routes/api/campaigns');

  const suffix = crypto.randomBytes(4).toString('hex');
  const nowIso = new Date().toISOString();
  const uRes = await dbRunAsync(
    "INSERT INTO users (email, email_verified, plan_tier, plan_status, created_at) VALUES (?, 1, 'pro', 'active', ?)",
    [`p29-${suffix}@example.com`, nowIso]
  );
  const userId = Number(uRes.lastID);
  const cRes = await dbRunAsync(
    "INSERT INTO campaigns (user_id, name, slug, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    [userId, `P29 Campaign ${suffix}`, `p29-${suffix}`, nowIso]
  );
  const campaignId = Number(cRes.lastID);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { userId }; next(); });
  app.use(campaignsRouter);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const jsonHeaders = { 'content-type': 'application/json' };

  try {
    // 1. Update notification preferences
    const prefRes = await fetch(`${baseUrl}/api/business-alerts/preferences`, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({
        channels: ['in_app', 'webhook'],
        frequency: 'hourly_digest',
        drop_threshold_percent: 45,
        min_sample_size: 25,
        dedupe_window_minutes: 120,
      }),
    });
    assert.equal(prefRes.status, 200);
    const { preferences } = await prefRes.json();
    assert.equal(preferences.frequency, 'hourly_digest');
    assert.equal(preferences.min_sample_size, 25);

    // 2. Evaluate synthetic anomaly twice -> first creates alert, second deduplicates (no spam)
    const evalPayload = {
      signal_type: 'traffic_anomaly',
      campaign_id: campaignId,
      baseline_clicks: 100,
      current_clicks: 20,
    };
    const e1 = await fetch(`${baseUrl}/api/business-alerts/evaluate`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(evalPayload),
    });
    assert.equal(e1.status, 201);
    const e1Body = await e1.json();
    assert.equal(e1Body.deduplicated, false);
    assert.equal(e1Body.alert.status, 'open');
    assert.equal(e1Body.alert.ops_escalated, true);

    const e2 = await fetch(`${baseUrl}/api/business-alerts/evaluate`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(evalPayload),
    });
    assert.equal(e2.status, 200);
    const e2Body = await e2.json();
    assert.equal(e2Body.deduplicated, true);
    assert.equal(e2Body.alert.id, e1Body.alert.id);
    assert.equal(e2Body.alert.occurrence_count, 2);

    // 3. Alert remains open until explicitly resolved
    const listOpen = await fetch(`${baseUrl}/api/business-alerts?status=open`);
    assert.equal(listOpen.status, 200);
    const openBody = await listOpen.json();
    assert.equal(openBody.alerts.length, 1);

    const resolveRes = await fetch(`${baseUrl}/api/business-alerts/${e1Body.alert.id}`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({ status: 'resolved' }),
    });
    assert.equal(resolveRes.status, 200);
    const resolved = await resolveRes.json();
    assert.equal(resolved.status, 'resolved');
    assert.ok(resolved.resolved_at);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
