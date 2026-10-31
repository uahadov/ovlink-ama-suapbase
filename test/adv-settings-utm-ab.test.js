const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const bcrypt = require('bcrypt');

process.env.SESSION_SECRET = 'test_session_secret_for_tests_only_very_long_string_must_be_64_bytes_12345678901234567890123456789012';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

const { app, helpers } = require('../server');
const { blindIndex, encryptAES256GCM } = require('../utils/crypto');

const TEST_PASSWORD = 'TestPassword123!';
let server;
let baseUrl;
const createdUserIds = [];

let hasPostgres = false;

test.before(async () => {
  try {
    await helpers.dbGetAsync('SELECT 1');
    hasPostgres = true;
  } catch (err) {
    hasPostgres = false;
  }
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
      await helpers.dbRunAsync('DELETE FROM user_sessions WHERE user_id = ?', [userId]);
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

async function seedUser({ plan = 'free' } = {}) {
  const email = `adv-test-${plan}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  const proExpires = plan === 'pro' ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() : null;
  await helpers.dbRunAsync(
    'INSERT INTO users (email, email_hash, password, email_verified, plan_tier, plan_status, pro_expires_at, created_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)',
    [encryptAES256GCM(email), blindIndex(email), passwordHash, plan, 'active', proExpires, new Date().toISOString()]
  );
  const row = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [blindIndex(email)]);
  createdUserIds.push(row.id);
  return { id: row.id, email };
}

async function loginSession(email) {
  const { cookie, csrfToken } = await getCsrfSession();
  const res = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookie,
      'x-csrf-token': csrfToken
    },
    body: JSON.stringify({ email, password: TEST_PASSWORD, lang: 'en' })
  });
  assert.equal(res.status, 200, `login must succeed for ${email}`);
  const setCookies = (typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')]) || [];
  const sidCookie = setCookies
    .map((c) => (c ? c.split(';')[0] : ''))
    .find((c) => c.startsWith('connect.sid='));
  const finalCookie = sidCookie || cookie;
  const csrfRes = await fetch(`${baseUrl}/api/csrf`, { headers: { 'cookie': finalCookie } });
  const { csrfToken: freshToken } = await csrfRes.json();
  return { cookie: finalCookie, csrfToken: freshToken };
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
      'adv_utm_popular_templates',
      'adv_utm_custom_templates',
      'adv_utm_no_params_alert',
      'adv_utm_prompt_name',
      'adv_utm_save_error',
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

    // Explicit assertions for pro_feature_required across AZ, TR, EN
    assert.equal(
      homeTranslations.az.pro_feature_required,
      'A/B Test və Cihaz Hədəfləməsi yalnız PRO istifadəçilər üçündür. Zəhmət olmasa Pro plana keçin.'
    );
    assert.equal(
      homeTranslations.tr.pro_feature_required,
      'A/B Test ve Cihaz Hedefleme yalnızca PRO kullanıcılar içindir. Lütfen Pro plana yükseltin.'
    );
    assert.equal(
      homeTranslations.en.pro_feature_required,
      'A/B Testing and Device Targeting are only available for PRO users. Please upgrade to Pro.'
    );

    assert.equal(
      mainTranslations.az.pro_feature_required,
      'A/B Test və Cihaz Hədəfləməsi yalnız PRO istifadəçilər üçündür. Zəhmət olmasa Pro plana keçin.'
    );
    assert.equal(
      mainTranslations.tr.pro_feature_required,
      'A/B Test ve Cihaz Hedefleme yalnızca PRO kullanıcılar içindir. Lütfen Pro plana yükseltin.'
    );
    assert.equal(
      mainTranslations.en.pro_feature_required,
      'A/B Testing and Device Targeting are only available for PRO users. Please upgrade to Pro.'
    );
  });

  await t.test('2. Builtin UTM templates exist with correct structure in frontend scripts and index.ejs markup', async () => {
    const homeJsCode = fs.readFileSync(path.join(__dirname, '../public/home.js'), 'utf8');
    const scriptJsCode = fs.readFileSync(path.join(__dirname, '../public/script.js'), 'utf8');
    const indexEjsCode = fs.readFileSync(path.join(__dirname, '../views/index.ejs'), 'utf8');

    // Verify index.ejs markup elements and form submit safeguards
    assert.ok(
      indexEjsCode.includes('<form id="shortenForm" action="javascript:void(0);">'),
      'views/index.ejs shortenForm must include action="javascript:void(0);" submit safeguard'
    );
    assert.ok(
      indexEjsCode.includes('action="javascript:void(0);"'),
      'views/index.ejs forms must have action="javascript:void(0);" submit safeguards'
    );
    assert.ok(indexEjsCode.includes('id="utmTemplateSelect"'), 'views/index.ejs must contain utmTemplateSelect');
    assert.ok(indexEjsCode.includes('id="utmSource"'), 'views/index.ejs must contain utmSource');
    assert.ok(indexEjsCode.includes('id="utmMedium"'), 'views/index.ejs must contain utmMedium');
    assert.ok(indexEjsCode.includes('id="utmCampaign"'), 'views/index.ejs must contain utmCampaign');
    assert.ok(indexEjsCode.includes('id="saveUtmTemplateBtn"'), 'views/index.ejs must contain saveUtmTemplateBtn');

    const extractTemplates = (code) => {
      const match = code.match(/const\s+BUILTIN_UTM_TEMPLATES\s*=\s*(\[[\s\S]*?\]);/);
      assert.ok(match, 'BUILTIN_UTM_TEMPLATES definition must be present');
      return vm.runInNewContext(match[1]);
    };

    const homeTemplates = extractTemplates(homeJsCode);
    const scriptTemplates = extractTemplates(scriptJsCode);

    [homeTemplates, scriptTemplates].forEach((templates) => {
      assert.ok(Array.isArray(templates), 'Templates must be an array');
      assert.ok(templates.length >= 5, 'Must have at least 5 builtin templates');
      templates.forEach((tpl) => {
        assert.ok(typeof tpl.name === 'string' && tpl.name.trim().length > 0, 'Template name must be non-empty string');
        assert.ok(typeof tpl.source === 'string' && tpl.source.trim().length > 0, 'Template source must be non-empty string');
        assert.ok(typeof tpl.medium === 'string' && tpl.medium.trim().length > 0, 'Template medium must be non-empty string');
        assert.ok(typeof tpl.campaign === 'string' && tpl.campaign.trim().length > 0, 'Template campaign must be non-empty string');
      });
    });

    const expectedSources = ['facebook', 'google', 'tiktok', 'newsletter', 'linkedin', 'twitter', 'youtube'];
    expectedSources.forEach((src) => {
      assert.ok(
        homeTemplates.some((t) => t.source === src),
        `BUILTIN_UTM_TEMPLATES in home.js must include source "${src}"`
      );
      assert.ok(
        scriptTemplates.some((t) => t.source === src),
        `BUILTIN_UTM_TEMPLATES in script.js must include source "${src}"`
      );
    });
  });

  await t.test('3. POST /api/shorten blocks non-pro / guest users from using A/B testing or Device targeting with localized errors', async (st) => {
    if (!hasPostgres) {
      st.skip('PostgreSQL database not reachable in test environment');
      return;
    }
    const expectedAzError = 'Bu inkişaf etmiş xüsusiyyətlər (A/B, Cihaz) yalnız PRO istifadəçilər üçündür.';
    const expectedTrError = 'Bu gelişmiş özellikler (A/B, Cihaz) yalnızca PRO kullanıcılar içindir.';
    const expectedEnError = 'These advanced features (A/B, Device Targeting) are only available for PRO users.';

    const { cookie: guestCookie, csrfToken: guestCsrfToken } = await getCsrfSession();

    // 1. Guest attempts with localized responses
    // Guest attempt with original_b (AZ)
    const guestResAz = await fetch(`${baseUrl}/api/shorten`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': guestCookie,
        'x-csrf-token': guestCsrfToken
      },
      body: JSON.stringify({
        original: 'https://example.com/main',
        original_b: 'https://example.com/variant-b',
        lang: 'az'
      })
    });
    assert.equal(guestResAz.status, 403);
    const guestBodyAz = await guestResAz.json();
    assert.equal(guestBodyAz.error, expectedAzError);

    // Guest attempt with ios_url (TR)
    const guestResTr = await fetch(`${baseUrl}/api/shorten`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': guestCookie,
        'x-csrf-token': guestCsrfToken
      },
      body: JSON.stringify({
        original: 'https://example.com/main',
        ios_url: 'https://apps.apple.com/app/test',
        lang: 'tr'
      })
    });
    assert.equal(guestResTr.status, 403);
    const guestBodyTr = await guestResTr.json();
    assert.equal(guestBodyTr.error, expectedTrError);

    // Guest attempt with android_url (EN)
    const guestResEn = await fetch(`${baseUrl}/api/shorten`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': guestCookie,
        'x-csrf-token': guestCsrfToken
      },
      body: JSON.stringify({
        original: 'https://example.com/main',
        android_url: 'https://play.google.com/store/apps/test',
        lang: 'en'
      })
    });
    assert.equal(guestResEn.status, 403);
    const guestBodyEn = await guestResEn.json();
    assert.equal(guestBodyEn.error, expectedEnError);

    // 2. Logged-in Free / Non-PRO user attempts with localized responses
    const freeUser = await seedUser({ plan: 'free' });
    const freeSession = await loginSession(freeUser.email);

    // Free user attempt with original_b (AZ)
    const freeResAz = await fetch(`${baseUrl}/api/shorten`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': freeSession.cookie,
        'x-csrf-token': freeSession.csrfToken
      },
      body: JSON.stringify({
        original: 'https://example.com/main',
        original_b: 'https://example.com/variant-b',
        lang: 'az'
      })
    });
    assert.equal(freeResAz.status, 403);
    const freeBodyAz = await freeResAz.json();
    assert.equal(freeBodyAz.error, expectedAzError);

    // Free user attempt with ios_url (TR)
    const freeResTr = await fetch(`${baseUrl}/api/shorten`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': freeSession.cookie,
        'x-csrf-token': freeSession.csrfToken
      },
      body: JSON.stringify({
        original: 'https://example.com/main',
        ios_url: 'https://apps.apple.com/app/test',
        lang: 'tr'
      })
    });
    assert.equal(freeResTr.status, 403);
    const freeBodyTr = await freeResTr.json();
    assert.equal(freeBodyTr.error, expectedTrError);

    // Free user attempt with android_url (EN)
    const freeResEn = await fetch(`${baseUrl}/api/shorten`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': freeSession.cookie,
        'x-csrf-token': freeSession.csrfToken
      },
      body: JSON.stringify({
        original: 'https://example.com/main',
        android_url: 'https://play.google.com/store/apps/test',
        lang: 'en'
      })
    });
    assert.equal(freeResEn.status, 403);
    const freeBodyEn = await freeResEn.json();
    assert.equal(freeBodyEn.error, expectedEnError);

    // 3. Logged-in PRO user succeeds with A/B and Device targeting
    const proUser = await seedUser({ plan: 'pro' });
    const proSession = await loginSession(proUser.email);

    const proRes = await fetch(`${baseUrl}/api/shorten`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': proSession.cookie,
        'x-csrf-token': proSession.csrfToken
      },
      body: JSON.stringify({
        original: 'https://example.com/pro-main',
        original_b: 'https://example.com/pro-variant-b',
        ab_split_percent: 40,
        ios_url: 'https://apps.apple.com/app/pro-ios',
        android_url: 'https://play.google.com/store/apps/pro-android',
        lang: 'en'
      })
    });
    assert.equal(proRes.status, 200, 'Pro user should be permitted to use A/B and Device targeting');
    const proBody = await proRes.json();
    assert.ok(proBody.short, 'Response must include created short link');

    const createdRow = await helpers.dbGetAsync('SELECT * FROM urls WHERE short = ?', [proBody.short]);
    assert.ok(createdRow, 'Created URL row must exist in DB');
    assert.equal(createdRow.original_b, 'https://example.com/pro-variant-b');
    assert.equal(createdRow.ios_url, 'https://apps.apple.com/app/pro-ios');
    assert.equal(createdRow.android_url, 'https://play.google.com/store/apps/pro-android');
    assert.equal(createdRow.ab_split_percent, 40);
  });

  await t.test('4. Redirection resolves based on device and A/B split percentage', async () => {
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
