const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');

process.env.SESSION_SECRET = 'test_session_secret_for_tests_only_very_long_string_must_be_64_bytes_12345678901234567890123456789012';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

const { app, helpers } = require('../server');

let server;
let baseUrl;
const createdUserIds = [];

test.before(async () => {
  const migrationDrainDeadline = Date.now() + 10000;
  while (!helpers.isDbMigrationQueueDrained() && Date.now() < migrationDrainDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  for (const userId of createdUserIds) {
    try {
      await helpers.dbRunAsync('DELETE FROM urls WHERE user_id = ?', [userId]);
      await helpers.dbRunAsync('DELETE FROM users WHERE id = ?', [userId]);
    } catch {}
  }
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  const migrationDrainDeadline = Date.now() + 10000;
  while (!helpers.isDbMigrationQueueDrained() && Date.now() < migrationDrainDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    await helpers.closeDbPool();
  } catch {}
});

async function getCsrfSession() {
  const res = await fetch(`${baseUrl}/api/csrf`);
  const setCookies = (typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')]) || [];
  const sidCookie = setCookies
    .map((c) => (c ? c.split(';')[0] : ''))
    .find((c) => c.startsWith('connect.sid='));
  const { csrfToken } = await res.json();
  return { cookie: sidCookie, csrfToken };
}

test('Advanced Settings: i18n parity, UTM presets, and PRO A/B + Device gating', async (t) => {
  await t.test('1. i18n parity: all advanced settings keys exist in public/lang.js and public/lang-home.js', async () => {
    const langHomeCode = fs.readFileSync(path.join(__dirname, '../public/lang-home.js'), 'utf8');
    const langMainCode = fs.readFileSync(path.join(__dirname, '../public/lang.js'), 'utf8');

    const ctxHome = {
      window: { addEventListener: () => {} },
      document: { querySelectorAll: () => [], addEventListener: () => {}, cookie: '' },
      localStorage: { getItem: () => null, setItem: () => {} }
    };
    vm.createContext(ctxHome);
    const homeTranslations = vm.runInContext(langHomeCode + '\n; homeTranslations;', ctxHome);

    const ctxMain = {
      window: { addEventListener: () => {} },
      document: { querySelectorAll: () => [], addEventListener: () => {}, cookie: '' },
      localStorage: { getItem: () => null, setItem: () => {} }
    };
    vm.createContext(ctxMain);
    const mainTranslations = vm.runInContext(langMainCode + '\n; translations;', ctxMain);

    const requiredKeys = [
      'adv_tab_general',
      'adv_tab_utm',
      'adv_tab_ab',
      'adv_tab_device',
      'adv_utm_params_title',
      'adv_utm_template_select',
      'adv_utm_save_tooltip',
      'adv_utm_source',
      'adv_utm_source_ph',
      'adv_utm_medium',
      'adv_utm_medium_ph',
      'adv_utm_campaign',
      'adv_utm_campaign_ph',
      'adv_ab_title',
      'adv_ab_url_b',
      'adv_ab_url_b_ph',
      'adv_ab_split',
      'adv_ab_hint',
      'adv_device_title',
      'adv_device_ios',
      'adv_device_ios_ph',
      'adv_device_android',
      'adv_device_android_ph',
      'pro_badge',
      'pro_feature_required',
    ];

    ['az', 'tr', 'en'].forEach((lang) => {
      requiredKeys.forEach((k) => {
        assert.ok(
          homeTranslations[lang] && homeTranslations[lang][k],
          `Missing '${k}' in public/lang-home.js for language '${lang}'`
        );
        assert.ok(
          mainTranslations[lang] && mainTranslations[lang][k],
          `Missing '${k}' in public/lang.js for language '${lang}'`
        );
      });
    });
  });

  await t.test('2. POST /api/shorten blocks non-pro / guest users from using A/B testing or Device targeting', async () => {
    const { cookie, csrfToken } = await getCsrfSession();

    // Guest attempt with original_b
    const guestRes1 = await fetch(`${baseUrl}/api/shorten`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie,
        'x-csrf-token': csrfToken
      },
      body: JSON.stringify({
        original: 'https://example.com/main',
        original_b: 'https://example.com/variant-b',
        lang: 'en'
      })
    });
    assert.equal(guestRes1.status, 403);
    const body1 = await guestRes1.json();
    assert.match(body1.error, /only available for PRO users|PRO/i);

    // Guest attempt with ios_url
    const guestRes2 = await fetch(`${baseUrl}/api/shorten`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie,
        'x-csrf-token': csrfToken
      },
      body: JSON.stringify({
        original: 'https://example.com/main',
        ios_url: 'https://apps.apple.com/app/test',
        lang: 'en'
      })
    });
    assert.equal(guestRes2.status, 403);
    const body2 = await guestRes2.json();
    assert.match(body2.error, /only available for PRO users|PRO/i);

    // Guest attempt with android_url
    const guestRes3 = await fetch(`${baseUrl}/api/shorten`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie,
        'x-csrf-token': csrfToken
      },
      body: JSON.stringify({
        original: 'https://example.com/main',
        android_url: 'https://play.google.com/store/apps/test',
        lang: 'tr'
      })
    });
    assert.equal(guestRes3.status, 403);
    const body3 = await guestRes3.json();
    assert.match(body3.error, /PRO kullanıcılar|PRO/i);
  });

  await t.test('3. Redirection resolves based on device and A/B split percentage', async () => {
    const fakeRowIos = {
      id: 9991,
      short: 'test_ios',
      original: 'https://example.com/default',
      original_b: null,
      ios_url: 'https://apps.apple.com/app/custom-ios',
      android_url: 'https://play.google.com/custom-android',
      ab_split_percent: 50
    };
    const fakeRowAndroid = {
      id: 9992,
      short: 'test_android',
      original: 'https://example.com/default',
      original_b: null,
      ios_url: 'https://apps.apple.com/app/custom-ios',
      android_url: 'https://play.google.com/custom-android',
      ab_split_percent: 50
    };
    const fakeRowAbA = {
      id: 9993,
      short: 'test_ab_a',
      original: 'https://example.com/target-a',
      original_b: 'https://example.com/target-b',
      ios_url: null,
      android_url: null,
      ab_split_percent: 100 // 100% to A
    };
    const fakeRowAbB = {
      id: 9994,
      short: 'test_ab_b',
      original: 'https://example.com/target-a',
      original_b: 'https://example.com/target-b',
      ios_url: null,
      android_url: null,
      ab_split_percent: 0 // 0% to A -> 100% to B
    };

    const reqIos = { headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)' } };
    const reqAndroid = { headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7)' } };
    const reqDesktop = { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } };

    if (helpers.resolveFinalRedirectUrl) {
      assert.equal(helpers.resolveFinalRedirectUrl(reqIos, fakeRowIos), 'https://apps.apple.com/app/custom-ios');
      assert.equal(helpers.resolveFinalRedirectUrl(reqAndroid, fakeRowAndroid), 'https://play.google.com/custom-android');
      assert.equal(helpers.resolveFinalRedirectUrl(reqDesktop, fakeRowAbA), 'https://example.com/target-a');
      assert.equal(helpers.resolveFinalRedirectUrl(reqDesktop, fakeRowAbB), 'https://example.com/target-b');
    }
  });
});
