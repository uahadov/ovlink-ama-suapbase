'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');

const pdfReport = require('../src/lib/pdf-report');
const campaignReport = require('../public/campaign-report');

test('P27 unit: low-RAM pure-Node PDF 1.4 matches CSV KPIs 1:1 and renders in <100ms', () => {
  const payload = {
    campaign: { id: 10, name: 'Yay Satışı 2026', slug: 'yay-satisi-2026' },
    range: { days: 30, from: '2026-10-20T00:00:00.000Z', to: '2026-11-20T00:00:00.000Z', bots: 'exclude' },
    links_count: 3,
    clicks: 245,
    uniques: 190,
    conversions: 28,
    conversion_rate: 11.4,
    clicks_by_day: [],
    top_links: [{ short: 'yay1', original: 'https://example.com/yay', clicks: 200, uniques: 160, conversions: 24 }],
    top_sources: [{ name: 'instagram', count: 180 }, { name: 'google', count: 65 }],
    top_goals: [{ name: 'lead', count: 28 }],
    generated_at: '2026-11-20T00:30:00.000Z',
    last_recorded_click_at: '2026-11-20T00:15:00.000Z',
  };

  const csv = campaignReport.toCsv(payload);
  const { buffer, render_ms: renderMs, official_status: status } = pdfReport.buildCampaignPdfReport({
    payload,
    officialStatus: 'FINAL',
  });
  const pdfText = buffer.toString('utf8');

  assert.ok(pdfText.startsWith('%PDF-1.4\n'), 'Must output valid PDF 1.4 header');
  assert.ok(pdfText.includes('%%EOF'), 'Must output valid PDF EOF');
  assert.equal(status, 'FINAL');
  assert.ok(renderMs < 100, `Low-RAM render should be fast, got ${renderMs}ms`);
  // 1:1 KPI parity between CSV and PDF
  assert.ok(csv.includes('"Clicks","245"') && pdfText.includes('Clicks: 245'));
  assert.ok(csv.includes('"Unique visitors","190"') && pdfText.includes('Unique visitors: 190'));
  assert.ok(csv.includes('"Conversions","28"') && pdfText.includes('Conversions: 28'));
  assert.ok(csv.includes('"Conversion rate (%)","11.4"') && pdfText.includes('Conversion rate \\(%\\): 11.4'));
});

const dbUrl = process.env.DATABASE_URL || '';
const safeDb = /\/ovlink_[\w]*qa[\w]*$/.test(dbUrl.split('?')[0]);

test('P27 integration: audited /export.pdf matches /export.csv KPIs & async export-jobs track status', { skip: !safeDb && 'Requires isolated QA DB', timeout: 30000 }, async () => {
  const express = require('express');
  const { dbRunAsync } = require('../src/db/helpers');
  const campaignsRouter = require('../src/routes/api/campaigns');

  const suffix = crypto.randomBytes(4).toString('hex');
  const nowIso = new Date().toISOString();
  const uRes = await dbRunAsync(
    "INSERT INTO users (email, email_verified, plan_tier, plan_status, created_at) VALUES (?, 1, 'pro', 'active', ?)",
    [`p27-${suffix}@example.com`, nowIso]
  );
  const userId = Number(uRes.lastID);
  const cRes = await dbRunAsync(
    "INSERT INTO campaigns (user_id, name, slug, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    [userId, `P27 Campaign ${suffix}`, `p27-${suffix}`, nowIso]
  );
  const campaignId = Number(cRes.lastID);
  const urlRes = await dbRunAsync(
    'INSERT INTO urls (user_id, campaign_id, short, original, created_at) VALUES (?, ?, ?, ?, ?)',
    [userId, campaignId, `p27${suffix}`, 'https://example.com/p27', nowIso]
  );
  await dbRunAsync(
    "INSERT INTO clicks (url_id, click_time, ip_hash, referrer_host, is_bot) VALUES (?, ?, 'p27h1', 'google.com', 0)",
    [Number(urlRes.lastID), nowIso]
  );

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { userId }; next(); });
  app.use(campaignsRouter);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const [csvRes, pdfRes] = await Promise.all([
      fetch(`${baseUrl}/api/campaigns/${campaignId}/export.csv?days=30&bots=exclude`),
      fetch(`${baseUrl}/api/campaigns/${campaignId}/export.pdf?days=30&bots=exclude`),
    ]);
    assert.equal(csvRes.status, 200);
    assert.equal(pdfRes.status, 200);
    assert.equal(pdfRes.headers.get('content-type'), 'application/pdf');
    assert.match(pdfRes.headers.get('x-ovlink-snapshot-id') || '', /^rpt_[a-f0-9]{16}$/);

    const csvText = await csvRes.text();
    const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
    const pdfStr = pdfBuf.toString('utf8');
    assert.ok(pdfStr.startsWith('%PDF-1.4\n'));
    assert.ok(csvText.includes('"Clicks","1"') && pdfStr.includes('Clicks: 1'));

    // Async export job creation + status retrieval
    const jobRes = await fetch(`${baseUrl}/api/campaigns/${campaignId}/export-jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'pdf', days: 30, bots: 'exclude' }),
    });
    assert.equal(jobRes.status, 202);
    const { job } = await jobRes.json();
    assert.match(job.job_key, /^exp_/);
    assert.equal(job.status, 'completed');
    assert.ok(job.snapshot_id);

    const statusRes = await fetch(`${baseUrl}/api/campaigns/${campaignId}/export-jobs/${job.job_key}`);
    assert.equal(statusRes.status, 200);
    const statusBody = await statusRes.json();
    assert.equal(statusBody.job.status, 'completed');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
