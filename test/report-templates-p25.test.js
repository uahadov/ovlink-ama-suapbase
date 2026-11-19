'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');

const reportTemplates = require('../src/lib/report-templates');

test('P25 unit: reusable template renders AZ/TR/EN, Monolith baseline, decor-only logo, empty state & print parity', () => {
  assert.equal(reportTemplates.sanitizeLogoUrl('javascript:alert(1)'), null);
  assert.equal(reportTemplates.sanitizeLogoUrl('http://insecure.test/logo.png'), null);
  assert.equal(reportTemplates.sanitizeLogoUrl('https://cdn.example.com/logo.png'), 'https://cdn.example.com/logo.png');

  const tpl = {
    id: 1,
    name: 'Aylıq Agentlik Şablonu',
    client_name: 'Default Client',
    logo_url: 'https://cdn.example.com/logo.png',
    locale: 'az',
    default_period_days: 30,
    sections: ['executive_summary', 'campaign_comparison', 'top_links', 'conclusion_note'],
    explanation_note: 'İzah qeydi',
    conclusion_note: 'Nəticə qeydi',
  };

  // Reuse 1 template across 3 distinct clients + 3 locales (AZ, TR, EN)
  const clients = [
    { name: 'Müştəri A', lang: 'az', clicks: 150, uniques: 110, conversions: 15, rate: 10 },
    { name: 'Müşteri B', lang: 'tr', clicks: 80, uniques: 60, conversions: 8, rate: 10 },
    { name: 'Client C (Empty)', lang: 'en', clicks: 0, uniques: 0, conversions: 0, rate: 0 },
  ];

  for (const c of clients) {
    const rendered = reportTemplates.renderCampaignReportFromTemplate({
      template: tpl,
      campaignStats: {
        campaign: { id: 1, name: c.name, slug: 'cmp' },
        range: { days: 30, from: '2026-10-20T00:00:00.000Z', to: '2026-11-20T00:00:00.000Z', bots: 'exclude' },
        clicks: c.clicks,
        uniques: c.uniques,
        conversions: c.conversions,
        conversion_rate: c.rate,
        top_links: c.clicks > 0 ? [{ short: 'abc', original: 'https://example.com', clicks: c.clicks }] : [],
        top_sources: c.clicks > 0 ? [{ name: 'instagram', count: c.clicks }] : [],
      },
      clientOverride: { name: c.name },
      lang: c.lang,
    });
    assert.equal(rendered.visual_baseline, 'monolith');
    assert.equal(rendered.logo_mode, 'decor_only');
    assert.equal(rendered.locale, c.lang);
    assert.equal(rendered.header.client_name, c.name);
    assert.equal(rendered.empty_state.is_empty, c.clicks === 0);

    const html = reportTemplates.renderTemplatePrintHtml(rendered);
    assert.ok(html.includes(`data-kpi="clicks">${c.clicks}<`));
    assert.ok(html.includes(`data-kpi="uniques">${c.uniques}<`));
    assert.ok(html.includes(`data-kpi="conversions">${c.conversions}<`));
    assert.ok(html.includes('client-logo-decor'));
    if (c.clicks === 0) assert.ok(html.includes('empty-state'));
  }
});

const dbUrl = process.env.DATABASE_URL || '';
const safeDb = /\/ovlink_[\w]*qa[\w]*$/.test(dbUrl.split('?')[0]);

test('P25 integration: CRUD template & reuse across 3 campaigns with JSON/HTML print parity', { skip: !safeDb && 'Requires isolated QA DB', timeout: 30000 }, async () => {
  const express = require('express');
  const { dbRunAsync } = require('../src/db/helpers');
  const campaignsRouter = require('../src/routes/api/campaigns');

  const suffix = crypto.randomBytes(4).toString('hex');
  const nowIso = new Date().toISOString();
  const uRes = await dbRunAsync(
    "INSERT INTO users (email, email_verified, plan_tier, plan_status, created_at) VALUES (?, 1, 'pro', 'active', ?)",
    [`p25-${suffix}@example.com`, nowIso]
  );
  const userId = Number(uRes.lastID);

  // Create 3 campaigns representing 3 agency clients
  const campaignIds = [];
  for (let i = 1; i <= 3; i += 1) {
    const cRes = await dbRunAsync(
      "INSERT INTO campaigns (user_id, name, slug, status, created_at) VALUES (?, ?, ?, 'active', ?)",
      [userId, `Client ${i} Campaign ${suffix}`, `p25-c${i}-${suffix}`, nowIso]
    );
    const cid = Number(cRes.lastID);
    campaignIds.push(cid);
    const urlRes = await dbRunAsync(
      'INSERT INTO urls (user_id, campaign_id, short, original, created_at) VALUES (?, ?, ?, ?, ?)',
      [userId, cid, `p25${i}${suffix}`, `https://example.com/c${i}`, nowIso]
    );
    if (i < 3) {
      await dbRunAsync(
        "INSERT INTO clicks (url_id, click_time, ip_hash, referrer_host, utm_source, is_bot) VALUES (?, ?, ?, 'instagram.com', 'instagram', 0)",
        [Number(urlRes.lastID), nowIso, `h${i}`]
      );
    }
  }

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { userId };
    next();
  });
  app.use(campaignsRouter);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const createRes = await fetch(`${baseUrl}/api/report-templates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Agency Standard v1',
        logo_url: 'https://cdn.example.com/agency.png',
        locale: 'az',
        default_period_days: 30,
        explanation_note: 'Aylıq icmal',
        conclusion_note: 'Növbəti ay hədəfləri',
      }),
    });
    assert.equal(createRes.status, 201);
    const { template } = await createRes.json();
    assert.ok(template.id > 0);

    // Reuse the single template across all 3 client campaigns (in AZ, TR, EN)
    const langs = ['az', 'tr', 'en'];
    for (let idx = 0; idx < 3; idx += 1) {
      const cid = campaignIds[idx];
      const jsonRes = await fetch(`${baseUrl}/api/campaigns/${cid}/template-report?template_id=${template.id}&bots=exclude&lang=${langs[idx]}`);
      assert.equal(jsonRes.status, 200);
      const reportJson = await jsonRes.json();
      assert.equal(reportJson.locale, langs[idx]);
      assert.equal(reportJson.empty_state.is_empty, idx === 2);

      const htmlRes = await fetch(`${baseUrl}/api/campaigns/${cid}/template-report?template_id=${template.id}&bots=exclude&lang=${langs[idx]}&format=html`);
      assert.equal(htmlRes.status, 200);
      const html = await htmlRes.text();
      assert.ok(html.includes(`data-kpi="clicks">${reportJson.kpis.clicks}<`));
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
