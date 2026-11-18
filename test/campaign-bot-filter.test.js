'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { randomBytes } = require('crypto');
const url = process.env.DATABASE_URL || '';
const safeDb = /\/ovlink_[\w]*qa[\w]*$/.test(url.split('?')[0]);

test('campaign human-only metrics consistently exclude bots and unattributed conversions', {
  skip: !safeDb && 'Requires a dedicated Ovlink QA PostgreSQL database', timeout: 25000,
}, async () => {
  const client = new Client({ connectionString: url });
  await client.connect();
  let userId, campaignId, linkId;
  const code = randomBytes(6).toString('hex');
  const now = Date.now();
  const clickTime = minutes => new Date(now - minutes * 60000).toISOString();
  try {
    const user = await client.query('INSERT INTO users(email, created_at) VALUES($1,$2) RETURNING id',
      [`bot-filter-qa-${code}@example.test`, clickTime(10)]);
    userId = user.rows[0].id;
    const campaign = await client.query('INSERT INTO campaigns(user_id,name,slug,created_at) VALUES($1,$2,$3,$4) RETURNING id',
      [userId, 'Bot comparison QA', `bots-${code}`, clickTime(10)]);
    campaignId = campaign.rows[0].id;
    const link = await client.query('INSERT INTO urls(user_id,short,original,created_at,campaign_id) VALUES($1,$2,$3,$4,$5) RETURNING id',
      [userId, `human-${code}`, 'https://example.test/qa', clickTime(10), campaignId]);
    linkId = link.rows[0].id;
    for (const [min, ip, isBot, source] of [
      [6, 'visitor-a', 0, 'ads'], [5, 'visitor-a', 0, 'ads'], [4, 'visitor-bot', 1, 'bot-source'],
    ]) {
      await client.query('INSERT INTO clicks(url_id,click_time,ip_hash,is_bot,referrer_host) VALUES($1,$2,$3,$4,$5)',
        [linkId, clickTime(min), ip, isBot, source]);
    }
    for (const [min, ip] of [[3, 'visitor-a'], [2, 'visitor-bot']]) {
      await client.query('INSERT INTO link_conversions(url_id,goal,day,ip_hash,created_at) VALUES($1,$2,$3,$4,$5)',
        [linkId, 'signup', new Date(now).toISOString().slice(0, 10), ip, clickTime(min)]);
    }
    await client.query('INSERT INTO link_stats_daily(url_id,day,clicks,uniques,bots,conversions,last_click_at) VALUES($1,$2,3,2,1,2,$3)',
      [linkId, new Date(now).toISOString().slice(0, 10), clickTime(4)]);

    const stats = require('../src/lib/campaigns');
    const [all, humans] = await Promise.all([
      stats.loadCampaignStats({ campaign: { id: campaignId, name: 'Bot comparison QA' }, query: { days: 7, bots: 'include' } }),
      stats.loadCampaignStats({ campaign: { id: campaignId, name: 'Bot comparison QA' }, query: { days: 7, bots: 'exclude' } }),
    ]);
    assert.deepEqual([all.clicks, all.uniques, all.bots, all.conversions], [3, 2, 1, 2]);
    assert.deepEqual([humans.clicks, humans.uniques, humans.bots, humans.conversions], [2, 1, 0, 1]);
    assert.equal(humans.conversion_rate, 50);
    assert.equal(humans.top_links[0].clicks, 2);
    assert.equal(humans.top_links[0].uniques, 1);
    assert.equal(humans.top_links[0].conversions, 1);
    assert.equal(humans.sources.ads, 2);
    assert.equal(humans.sources['bot-source'], undefined);
    assert.equal(humans.goals.signup, 1);
    assert.equal(humans.clicks_by_day.at(-1).count, 2);
    assert.equal(humans.metric_method, 'raw_nonbot_events');
    assert.equal(humans.conversion_method, 'conversions_with_prior_nonbot_click_match');
    assert.ok(humans.last_recorded_click_at);
    assert.equal(all.metric_method, 'daily_rollup');
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
