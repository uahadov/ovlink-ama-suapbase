const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');

process.env.SESSION_SECRET = 'test_session_secret_for_tests_only_very_long_string_must_be_64_bytes_12345678901234567890123456789012';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '4f9a1c2b8e7d6053a1f0c9b82d7e4156a3c8f0d2b6e4917c5a0d3f8e2b4c6a9d';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

const { app, helpers } = require('../server');
const { ensureDbTables } = require('../src/db/migrate');
const { blindIndex, encryptAES256GCM } = require('../utils/crypto');
const campaignLib = require('../src/lib/campaigns');

const TEST_PASSWORD = 'CampaignTestPass123!';
const CONSENT_COOKIE = 'ovlink_redirect_consent=analytics';
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const createdUserIds = [];
const createdShorts = [];
let hasPostgres = false;

function uniqueShort(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

test.before(async () => {
  try {
    await helpers.dbGetAsync('SELECT 1');
    hasPostgres = true;
  } catch {
    hasPostgres = false;
  }

  if (hasPostgres) {
    ensureDbTables();
    const deadline = Date.now() + 20000;
    while (!helpers.isDbMigrationQueueDrained() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
});

test.after(async () => {
  for (const short of createdShorts) {
    try { await helpers.dbRunAsync('DELETE FROM clicks WHERE url_id IN (SELECT id FROM urls WHERE short = ?)', [short]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM link_stats_daily WHERE url_id IN (SELECT id FROM urls WHERE short = ?)', [short]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM urls WHERE short = ?', [short]); } catch {}
  }
  for (const userId of createdUserIds) {
    try { await helpers.dbRunAsync('DELETE FROM click_uniques WHERE url_id IN (SELECT id FROM urls WHERE user_id = ?)', [userId]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM urls WHERE user_id = ?', [userId]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM campaigns WHERE user_id = ?', [userId]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM user_sessions WHERE user_id = ?', [userId]); } catch {}
    try { await helpers.dbRunAsync('DELETE FROM users WHERE id = ?', [userId]); } catch {}
  }

  const deadline = Date.now() + 10000;
  while (!helpers.isDbMigrationQueueDrained() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try { await helpers.closeDbPool(); } catch {}
});

test('CM-01: campaign names are normalized and slugified (incl. Azerbaijani letters)', () => {
  assert.equal(campaignLib.normalizeCampaignName('  Yay   Satışı  '), 'Yay Satışı');
  assert.equal(campaignLib.normalizeCampaignName(''), '');
  assert.equal(campaignLib.normalizeCampaignName('x'.repeat(200)).length, campaignLib.CAMPAIGN_NAME_MAX);

  assert.equal(campaignLib.slugifyCampaignName('Spring Sale 2026'), 'spring-sale-2026');
  assert.equal(campaignLib.slugifyCampaignName('Yay Satışı'), 'yay-satisi');
  assert.equal(campaignLib.slugifyCampaignName('Çox Gözəl'), 'cox-gozel');
  assert.equal(campaignLib.slugifyCampaignName('  --  '), '');
  assert.ok(campaignLib.slugifyCampaignName('y'.repeat(120)).length <= campaignLib.CAMPAIGN_SLUG_MAX);
});

test('CM-02: campaigns group links, aggregate stats and survive link cleanup', async (t) => {
  if (!hasPostgres) {
    t.skip('PostgreSQL database not reachable in test environment');
    return;
  }

  async function seedUser(prefix) {
    const email = `${prefix}-${Date.now()}@example.com`;
    const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
    await helpers.dbRunAsync(
      'INSERT INTO users (email, email_hash, password, email_verified, plan_tier, plan_status, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)',
      [encryptAES256GCM(email), blindIndex(email), passwordHash, 'free', 'active', new Date().toISOString()]
    );
    const row = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [blindIndex(email)]);
    createdUserIds.push(row.id);
    return { id: row.id, email };
  }

  const owner = await seedUser('campaign-owner');
  const stranger = await seedUser('campaign-stranger');

  const short = uniqueShort('cmp');
  const inserted = await helpers.dbRunAsync(
    'INSERT INTO urls (original, short, created_at, user_id) VALUES (?, ?, ?, ?)',
    ['https://example.com/destination', short, new Date().toISOString(), owner.id]
  );
  createdShorts.push(short);
  assert.ok(inserted.lastID, 'link must exist');

  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function getCsrfSession() {
    const res = await fetch(`${baseUrl}/api/csrf`);
    const setCookies = (typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')]) || [];
    const sidCookie = setCookies
      .map((c) => (c ? c.split(';')[0] : ''))
      .find((c) => c.startsWith('connect.sid='));
    const { csrfToken } = await res.json();
    return { cookie: sidCookie, csrfToken };
  }

  async function loginSession(email, password = TEST_PASSWORD) {
    const { cookie, csrfToken } = await getCsrfSession();
    const res = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ email, password, lang: 'en' }),
    });
    assert.equal(res.status, 200, `login must succeed for ${email}`);
    const setCookies = (typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')]) || [];
    const sidCookie = setCookies
      .map((c) => (c ? c.split(';')[0] : ''))
      .find((c) => c.startsWith('connect.sid='));
    const finalCookie = sidCookie || cookie;
    const csrfRes = await fetch(`${baseUrl}/api/csrf`, { headers: { Cookie: finalCookie } });
    const { csrfToken: freshToken } = await csrfRes.json().catch(() => ({}));
    return { cookie: finalCookie, csrfToken: freshToken || '' };
  }

  try {
    await t.test('1. campaign can be created, renamed and rejects duplicates', async () => {
      const { cookie, csrfToken } = await loginSession(owner.email);

      const createRes = await fetch(`${baseUrl}/api/campaigns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name: 'Yay Satışı', goal: 'signup' }),
      });
      assert.equal(createRes.status, 201);
      const created = await createRes.json();
      assert.equal(created.campaign.slug, 'yay-satisi');
      assert.equal(created.campaign.goal, 'signup');
      const campaignId = created.campaign.id;

      const duplicateRes = await fetch(`${baseUrl}/api/campaigns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name: 'Yay Satışı' }),
      });
      assert.equal(duplicateRes.status, 409, 'duplicate slugs must be rejected');

      const invalidRes = await fetch(`${baseUrl}/api/campaigns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name: ' ' }),
      });
      assert.equal(invalidRes.status, 400);

      const renameRes = await fetch(`${baseUrl}/api/campaigns/${campaignId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name: 'Yay Satışı 2026' }),
      });
      assert.equal(renameRes.status, 200);
      const renamed = await renameRes.json();
      assert.equal(renamed.campaign.slug, 'yay-satisi-2026');
    });

    await t.test('2. links can be assigned only to the owner campaigns', async () => {
      const { cookie, csrfToken } = await loginSession(owner.email);
      const listRes = await fetch(`${baseUrl}/api/campaigns`, { headers: { Cookie: cookie } });
      const list = await listRes.json();
      const campaignId = list.campaigns[0].id;

      const assignRes = await fetch(`${baseUrl}/api/links/${short}/campaign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, 'x-csrf-token': csrfToken },
        body: JSON.stringify({ campaign_id: campaignId }),
      });
      assert.equal(assignRes.status, 200);

      const linkCampaign = await fetch(`${baseUrl}/api/links/${short}/campaign`, { headers: { Cookie: cookie } });
      const linkCampaignBody = await linkCampaign.json();
      assert.equal(linkCampaignBody.campaign.id, campaignId);

      // A stranger cannot see or steal the campaign.
      const strangerSession = await loginSession(stranger.email);
      const strangerAssign = await fetch(`${baseUrl}/api/links/${short}/campaign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: strangerSession.cookie, 'x-csrf-token': strangerSession.csrfToken },
        body: JSON.stringify({ campaign_id: campaignId }),
      });
      assert.equal(strangerAssign.status, 404, 'foreign links must not be assignable');

      const strangerStats = await fetch(`${baseUrl}/api/campaigns/${campaignId}`, { headers: { Cookie: strangerSession.cookie } });
      assert.equal(strangerStats.status, 404, 'foreign campaigns must not be readable');
    });

    await t.test('3. campaign stats aggregate every assigned link', async () => {
      await fetch(`${baseUrl}/${short}`, {
        headers: { Cookie: CONSENT_COOKIE, 'user-agent': CHROME_UA, referer: 'https://news.example/story' },
        redirect: 'manual',
      });
      await fetch(`${baseUrl}/${short}`, {
        headers: { Cookie: CONSENT_COOKIE, 'user-agent': CHROME_UA },
        redirect: 'manual',
      });

      // wait for the fire-and-forget rollup
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const row = await helpers.dbGetAsync(
          'SELECT COALESCE(SUM(d.clicks), 0) AS clicks FROM link_stats_daily d JOIN urls u ON u.id = d.url_id WHERE u.short = ?',
          [short]
        );
        if (row && Number(row.clicks) >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const { cookie } = await loginSession(owner.email);
      const listRes = await fetch(`${baseUrl}/api/campaigns?days=30`, { headers: { Cookie: cookie } });
      const list = await listRes.json();
      const campaign = list.campaigns[0];

      assert.equal(campaign.links_count, 1);
      assert.equal(campaign.clicks, 2);
      assert.equal(campaign.uniques, 1, 'one visitor, two clicks');

      const statsRes = await fetch(`${baseUrl}/api/campaigns/${campaign.id}?days=30`, { headers: { Cookie: cookie } });
      assert.equal(statsRes.status, 200);
      const stats = await statsRes.json();

      assert.equal(stats.clicks, 2);
      assert.equal(stats.links_count, 1);
      assert.equal(stats.top_links.length, 1);
      assert.equal(stats.top_links[0].short, short);
      assert.equal(stats.top_links[0].clicks, 2);
      assert.equal(stats.sources['news.example'], 1);
      assert.ok(Array.isArray(stats.clicks_by_day) && stats.clicks_by_day.length >= 1);
      assert.equal(stats.range.days, 30);
    });

    await t.test('4. deleting a campaign keeps its links alive', async () => {
      const { cookie, csrfToken } = await loginSession(owner.email);
      const listRes = await fetch(`${baseUrl}/api/campaigns`, { headers: { Cookie: cookie } });
      const campaignId = (await listRes.json()).campaigns[0].id;

      const deleteRes = await fetch(`${baseUrl}/api/campaigns/${campaignId}`, {
        method: 'DELETE',
        headers: { Cookie: cookie, 'x-csrf-token': csrfToken },
      });
      assert.equal(deleteRes.status, 200);

      const linkRow = await helpers.dbGetAsync('SELECT id, campaign_id FROM urls WHERE short = ?', [short]);
      assert.ok(linkRow && linkRow.id, 'the link itself must survive');
      assert.equal(linkRow.campaign_id, null);

      const linkCampaign = await fetch(`${baseUrl}/api/links/${short}/campaign`, { headers: { Cookie: cookie } });
      assert.equal((await linkCampaign.json()).campaign, null);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
