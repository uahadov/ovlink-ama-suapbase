'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const demoFunnel = require('../src/lib/demo-funnel');
const { dbRunAsync } = require('../src/db/helpers');

function requestJson(baseUrl, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, baseUrl);
    const payload = body !== null ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch { json = null; }
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('P40 unit: pricing catalog syncs with real entitlements, exposes 5 synthetic demo steps & enforces consent/honeypot', () => {
  const catalog = demoFunnel.getPublicPricingCatalog('az');
  assert.equal(catalog.contract_version, 'demo-funnel-v1');
  assert.equal(catalog.tiers.length, 5);
  assert.equal(catalog.demo_steps.length, 5);
  assert.match(catalog.synthetic_demo_disclaimer, /sintetik/i);

  const starter = catalog.tiers.find((t) => t.plan_code === 'starter');
  const agency = catalog.tiers.find((t) => t.plan_code === 'agency');
  assert.equal(starter.monthly_usd, 7);
  assert.equal(agency.monthly_usd, 49);

  // Honeypot spam rejected
  const spam = demoFunnel.validateDemoBookingInput({
    website_url: 'https://spam.bot',
    name: 'Bot',
    email: 'bot@spam.test',
    consent_given: true,
  });
  assert.equal(spam.error, 'spam_detected');

  // Missing consent rejected
  const noConsent = demoFunnel.validateDemoBookingInput({
    name: 'Aysel Mammadova',
    email: 'aysel@agency.az',
    consent_given: false,
  });
  assert.equal(noConsent.error, 'consent_required');
});

test('P40 DB + HTTP: public pricing, demo booking, funnel attribution & authenticated summary work end-to-end', async () => {
  await demoFunnel.ensureDemoFunnelTables();
  let activeUserId = null;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = activeUserId ? { userId: activeUserId } : {};
    next();
  });
  app.use(require('../src/routes/api/campaigns'));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let createdRef = null;

  try {
    const cat = await requestJson(baseUrl, 'GET', '/api/public/pricing-plans?lang=en');
    assert.equal(cat.status, 200);
    assert.equal(cat.body.demo_steps.length, 5);

    const bad = await requestJson(baseUrl, 'POST', '/api/public/demo-booking', {
      name: 'Test User',
      email: 'test@agency.az',
      consent_given: false,
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'consent_required');

    const ok = await requestJson(baseUrl, 'POST', '/api/public/demo-booking', {
      name: 'Aysel Aliyeva',
      email: 'aysel@demo-agency.az',
      company: 'Demo Agency AZ',
      plan_interest: 'agency',
      consent_given: true,
      utm_source: 'linkedin',
    });
    assert.equal(ok.status, 201);
    assert.match(ok.body.booking_ref, /^DEMO-/);
    createdRef = ok.body.booking_ref;

    const ev = await requestJson(baseUrl, 'POST', '/api/public/funnel-event', {
      event_type: 'demo_completed',
      plan_code: 'agency',
      source_cta: 'pricing_interactive_demo',
    });
    assert.equal(ev.status, 201);
    assert.equal(ev.body.recorded, true);

    // Unauthenticated funnel summary blocked
    const unauth = await requestJson(baseUrl, 'GET', '/api/funnel/summary');
    assert.equal(unauth.status, 401);

    // Authenticated funnel summary returns counts
    activeUserId = 40001;
    const sum = await requestJson(baseUrl, 'GET', '/api/funnel/summary');
    assert.equal(sum.status, 200);
    assert.ok(sum.body.counts.cta_demo_submit >= 1);
    assert.ok(sum.body.counts.demo_completed >= 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (createdRef) {
      await dbRunAsync('DELETE FROM demo_leads WHERE booking_ref = ?', [createdRef]).catch(() => {});
    }
    await dbRunAsync("DELETE FROM funnel_events WHERE source_cta IN ('pricing_demo_form', 'pricing_interactive_demo')").catch(() => {});
  }
});
