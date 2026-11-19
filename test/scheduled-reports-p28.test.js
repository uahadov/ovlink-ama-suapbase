'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');

const scheduledReports = require('../src/lib/scheduled-reports');

test('P28 unit: 29/30/31 month-end clamping, timezone validation & deterministic delivery_key', () => {
  assert.equal(scheduledReports.isValidTimezone('Asia/Baku'), true);
  assert.equal(scheduledReports.isValidTimezone('Europe/Istanbul'), true);
  assert.equal(scheduledReports.isValidTimezone('Invalid/Mars'), false);

  // Jan 31 -> Feb 28 (non-leap 2026) and Feb 29 (leap 2028)
  const feb2026 = scheduledReports.computeNextRunAt({
    cadence: 'monthly',
    dayOfMonth: 31,
    hourUtc: 9,
    fromDate: new Date('2026-01-31T10:00:00.000Z'),
  });
  assert.equal(feb2026, '2026-02-28T09:00:00.000Z');

  const feb2028 = scheduledReports.computeNextRunAt({
    cadence: 'monthly',
    dayOfMonth: 31,
    hourUtc: 9,
    fromDate: new Date('2028-01-31T10:00:00.000Z'),
  });
  assert.equal(feb2028, '2028-02-29T09:00:00.000Z');

  // Same schedule & period yields identical idempotent delivery key
  const k1 = scheduledReports.buildDeliveryKey({ scheduleId: 7, scheduledForIso: '2026-11-23T09:00:00.000Z' });
  const k2 = scheduledReports.buildDeliveryKey({ scheduleId: 7, scheduledForIso: '2026-11-23T09:00:00.000Z' });
  assert.equal(k1, k2);
});

const dbUrl = process.env.DATABASE_URL || '';
const safeDb = /\/ovlink_[\w]*qa[\w]*$/.test(dbUrl.split('?')[0]);

test('P28 integration: opt-in consent gate, idempotent retry dispatch, bounce auto-pause & cancel', { skip: !safeDb && 'Requires isolated QA DB', timeout: 30000 }, async () => {
  const express = require('express');
  const { dbRunAsync } = require('../src/db/helpers');
  const campaignsRouter = require('../src/routes/api/campaigns');

  const suffix = crypto.randomBytes(4).toString('hex');
  const nowIso = new Date().toISOString();
  const uRes = await dbRunAsync(
    "INSERT INTO users (email, email_verified, plan_tier, plan_status, created_at) VALUES (?, 1, 'pro', 'active', ?)",
    [`p28-${suffix}@example.com`, nowIso]
  );
  const userId = Number(uRes.lastID);
  const cRes = await dbRunAsync(
    "INSERT INTO campaigns (user_id, name, slug, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    [userId, `P28 Campaign ${suffix}`, `p28-${suffix}`, nowIso]
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
    // 1. Missing opt-in consent is rejected (400)
    const noConsentRes = await fetch(`${baseUrl}/api/report-schedules`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ campaign_id: campaignId, recipients: ['cmo@client.test'], consent_confirmed: false }),
    });
    assert.equal(noConsentRes.status, 400);

    // 2. Valid opt-in schedule created
    const createRes = await fetch(`${baseUrl}/api/report-schedules`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        campaign_id: campaignId,
        recipients: ['cmo@client.test'],
        consent_confirmed: true,
        timezone: 'Asia/Baku',
        cadence: 'monthly',
        day_of_month: 31,
      }),
    });
    assert.equal(createRes.status, 201);
    const { schedule } = await createRes.json();
    assert.equal(schedule.status, 'active');

    // 3. Preview works without dispatching
    const prevRes = await fetch(`${baseUrl}/api/report-schedules/${schedule.id}/preview`, { method: 'POST' });
    assert.equal(prevRes.status, 200);

    // 4. Dispatch twice for exact same scheduled_for -> second call deduplicates (no duplicate report)
    const fixedSlot = '2026-11-30T09:00:00.000Z';
    const d1 = await fetch(`${baseUrl}/api/report-schedules/${schedule.id}/dispatch`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ scheduled_for: fixedSlot }),
    });
    assert.equal(d1.status, 200);
    const d1Body = await d1.json();
    assert.equal(d1Body.deduplicated, false);

    const d2 = await fetch(`${baseUrl}/api/report-schedules/${schedule.id}/dispatch`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ scheduled_for: fixedSlot }),
    });
    assert.equal(d2.status, 200);
    const d2Body = await d2.json();
    assert.equal(d2Body.deduplicated, true);
    assert.equal(d2Body.delivery.delivery_key, d1Body.delivery.delivery_key);

    // 5. Bounce pauses schedule with visible paused_reason
    const bounceRes = await fetch(`${baseUrl}/api/report-schedules/${schedule.id}/bounce`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ detail: '550 mailbox unavailable' }),
    });
    assert.equal(bounceRes.status, 200);
    const bounceBody = await bounceRes.json();
    assert.equal(bounceBody.status, 'paused');
    assert.match(bounceBody.paused_reason, /recipient_bounced/);

    // 6. Cancel schedule
    const cancelRes = await fetch(`${baseUrl}/api/report-schedules/${schedule.id}/cancel`, { method: 'POST' });
    assert.equal(cancelRes.status, 200);
    const cancelBody = await cancelRes.json();
    assert.equal(cancelBody.status, 'cancelled');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
