'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'p20-bot-test-secret-0123456789abcdef0123456789abcdef';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { randomBytes } = require('crypto');

const {
  BOT_CLASSIFIER_VERSION,
  classifyUserAgent,
  isBotUserAgent,
  getBotClassifierSpec,
} = require('../src/lib/bot-classifier');
const analyticsLib = require('../src/lib/analytics');
const { getFullAnalyticsContract, buildMetricsContractMeta } = require('../src/lib/metrics-contract');
const { REDIRECT_CONSENT_MARKER } = require('../src/lib/consent');

const url = process.env.DATABASE_URL || '';
const safeDb = /\/ovlink_[\w]*qa[\w]*$/.test(url.split('?')[0]);

test('P20 unit: classifyUserAgent categorizes bots accurately without false positives on real browsers', () => {
  assert.equal(classifyUserAgent('').category, 'empty_ua');
  assert.equal(classifyUserAgent('   ').is_bot, true);

  assert.equal(classifyUserAgent('facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)').category, 'social_preview');
  assert.equal(classifyUserAgent('TelegramBot (like TwitterBot)').category, 'social_preview');
  assert.equal(classifyUserAgent('WhatsApp/2.23.20.0 A').category, 'social_preview');
  assert.equal(classifyUserAgent('LinkedInBot/1.0 (compatible; Mozilla/5.0)').category, 'social_preview');
  assert.equal(classifyUserAgent('Twitterbot/1.0').category, 'social_preview');

  assert.equal(classifyUserAgent('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2)').category, 'ai_crawler');
  assert.equal(classifyUserAgent('ClaudeBot/1.0; +claudebot@anthropic.com').category, 'ai_crawler');
  assert.equal(classifyUserAgent('PerplexityBot/1.0').category, 'ai_crawler');

  assert.equal(classifyUserAgent('Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/128.0.0.0 Safari/537.36').category, 'headless_automation');
  assert.equal(classifyUserAgent('Playwright/1.48.0').category, 'headless_automation');

  assert.equal(classifyUserAgent('UptimeRobot/2.0').category, 'monitoring');
  assert.equal(classifyUserAgent('curl/8.10.1').category, 'http_client');
  assert.equal(classifyUserAgent('python-requests/2.32.3').category, 'http_client');
  assert.equal(classifyUserAgent('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)').category, 'search_crawler');

  // Real desktop & mobile browsers (including social in-app webviews) must remain human.
  const humanAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21G80 Instagram 345.0.0.29.93',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  ];
  for (const ua of humanAgents) {
    const res = classifyUserAgent(ua);
    assert.equal(res.is_bot, false, `Expected human for UA: ${ua}`);
    assert.equal(res.category, 'human');
    assert.equal(analyticsLib.isBotUserAgent(ua), false);
    assert.equal(isBotUserAgent(ua), false);
  }
});

test('P20 unit: methodology contract documents classifier spec and unfilterable measurements', () => {
  const spec = getBotClassifierSpec();
  assert.equal(spec.version, BOT_CLASSIFIER_VERSION);
  assert.ok(spec.categories.includes('social_preview'));
  assert.ok(spec.categories.includes('ai_crawler'));
  assert.ok(spec.limitations.false_negatives.length >= 1);
  assert.ok(spec.limitations.false_positives.length >= 1);
  const unfilterableKeys = spec.limitations.unfilterable_measurements.map((m) => m.measurement);
  assert.ok(unfilterableKeys.includes('essential_consent_clicks'));
  assert.ok(unfilterableKeys.includes('qr_scans'));

  const contract = getFullAnalyticsContract();
  assert.equal(contract.bot_classifier.version, BOT_CLASSIFIER_VERSION);

  const meta = buildMetricsContractMeta({ includeBots: false, conversionsCount: 2, essentialClicksCount: 3 });
  assert.equal(meta.bot_filter.mode, 'exclude');
  assert.equal(meta.bot_filter.essential_consent_clicks_unfiltered, 3);
  assert.ok(Array.isArray(meta.bot_filter.unfilterable_measurements));
});

test('P20 PG integration: delayed conversions, essential-consent clicks, link A/B variant bot filter & campaign KPI consistency', {
  skip: !safeDb && 'Requires a dedicated Ovlink QA PostgreSQL database',
  timeout: 30000,
}, async () => {
  const client = new Client({ connectionString: url });
  await client.connect();
  let userId, campaignId, linkId;
  const code = randomBytes(6).toString('hex');
  const now = Date.now();
  const isoAgo = (minutes) => new Date(now - minutes * 60000).toISOString();
  const today = new Date(now).toISOString().slice(0, 10);

  try {
    const user = await client.query('INSERT INTO users(email, created_at) VALUES($1,$2) RETURNING id',
      [`p20-bot-qa-${code}@example.test`, isoAgo(6000)]);
    userId = user.rows[0].id;
    const campaign = await client.query('INSERT INTO campaigns(user_id,name,slug,created_at) VALUES($1,$2,$3,$4) RETURNING id',
      [userId, 'P20 Human Stability QA', `p20-${code}`, isoAgo(6000)]);
    campaignId = campaign.rows[0].id;
    const link = await client.query('INSERT INTO urls(user_id,short,original,created_at,campaign_id) VALUES($1,$2,$3,$4,$5) RETURNING id',
      [userId, `p20-${code}`, 'https://example.test/p20', isoAgo(6000), campaignId]);
    linkId = link.rows[0].id;

    // 1) Human click 3 days ago (4320 min ago) on variant 'a'
    await client.query(
      'INSERT INTO clicks(url_id,click_time,browser,ip_hash,is_bot,referrer_host,variant) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [linkId, isoAgo(4320), 'Chrome', 'human-delayed', 0, 'instagram.com', 'a']
    );
    // 2) Essential-only consent click (no ip_hash, browser='__essential__', is_bot=0)
    await client.query(
      'INSERT INTO clicks(url_id,click_time,browser,os,country,ip_hash,is_bot,referrer_host,variant) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [linkId, isoAgo(30), REDIRECT_CONSENT_MARKER, REDIRECT_CONSENT_MARKER, REDIRECT_CONSENT_MARKER, null, 0, null, 'a']
    );
    // 3) Bot click on variant 'b'
    await client.query(
      'INSERT INTO clicks(url_id,click_time,browser,ip_hash,is_bot,referrer_host,variant) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [linkId, isoAgo(20), 'Unknown', 'bot-visitor', 1, 'preview-bot.net', 'b']
    );

    // Delayed conversion (3 days after human-delayed click -> MUST match)
    await client.query(
      'INSERT INTO link_conversions(url_id,goal,day,ip_hash,created_at) VALUES($1,$2,$3,$4,$5)',
      [linkId, 'purchase', today, 'human-delayed', isoAgo(10)]
    );
    // Conversion before any click / orphan visitor (MUST be excluded in bots=exclude)
    await client.query(
      'INSERT INTO link_conversions(url_id,goal,day,ip_hash,created_at) VALUES($1,$2,$3,$4,$5)',
      [linkId, 'purchase', today, 'orphan-visitor', isoAgo(5)]
    );
    // Bot conversion (MUST be excluded in bots=exclude)
    await client.query(
      'INSERT INTO link_conversions(url_id,goal,day,ip_hash,created_at) VALUES($1,$2,$3,$4,$5)',
      [linkId, 'signup', today, 'bot-visitor', isoAgo(4)]
    );

    const { loadCampaignStats } = require('../src/lib/campaigns');
    const { loadLinkStats } = require('../src/lib/link-stats');

    const humanCampaign = await loadCampaignStats({
      campaign: { id: campaignId, name: 'P20 Human Stability QA' },
      query: { days: 7, bots: 'exclude' },
    });

    // 2 human clicks (1 normal + 1 essential-consent), 1 unique (essential has NULL ip_hash), 1 matched delayed conversion
    assert.equal(humanCampaign.clicks, 2);
    assert.equal(humanCampaign.uniques, 1);
    assert.equal(humanCampaign.bots, 0);
    assert.equal(humanCampaign.conversions, 1);
    assert.equal(humanCampaign.goals.purchase, 1);
    assert.equal(humanCampaign.goals.signup, undefined);
    assert.equal(humanCampaign.sources['instagram.com'], 1);
    assert.equal(humanCampaign.sources.direct, 1);
    assert.equal(humanCampaign.sources['preview-bot.net'], undefined);
    assert.equal(humanCampaign.data_contract.bot_filter.mode, 'exclude');
    assert.equal(humanCampaign.data_contract.bot_filter.essential_consent_clicks_unfiltered, 1);
    assert.ok(
      humanCampaign.data_contract.bot_filter.unfilterable_measurements.some(
        (m) => m.measurement === 'essential_consent_clicks'
      )
    );

    // Link stats with bots=exclude must also exclude bot hits from A/B variant_clicks
    const humanLink = await loadLinkStats({
      urlRow: { id: linkId, short: `p20-${code}`, original: 'https://example.test/p20', created_at: isoAgo(6000) },
      query: { days: 7, bots: 'exclude' },
    });
    assert.equal(humanLink.total_clicks, 2);
    assert.equal(humanLink.variant_clicks.a, 2);
    assert.equal(humanLink.variant_clicks.b, undefined);

    const allLink = await loadLinkStats({
      urlRow: { id: linkId, short: `p20-${code}`, original: 'https://example.test/p20', created_at: isoAgo(6000) },
      query: { days: 7, bots: 'include' },
    });
    assert.equal(allLink.total_clicks, 3);
    assert.equal(allLink.variant_clicks.a, 2);
    assert.equal(allLink.variant_clicks.b, 1);
  } finally {
    if (linkId) {
      await client.query('DELETE FROM link_conversions WHERE url_id=$1', [linkId]).catch(() => {});
      await client.query('DELETE FROM clicks WHERE url_id=$1', [linkId]).catch(() => {});
      await client.query('DELETE FROM link_stats_daily WHERE url_id=$1', [linkId]).catch(() => {});
      await client.query('DELETE FROM urls WHERE id=$1', [linkId]).catch(() => {});
    }
    if (campaignId) await client.query('DELETE FROM campaigns WHERE id=$1', [campaignId]).catch(() => {});
    if (userId) await client.query('DELETE FROM users WHERE id=$1', [userId]).catch(() => {});
    await client.end();
    await require('../src/db/pool').pool.end().catch(() => {});
  }
});
