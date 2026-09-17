const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

process.env.SESSION_SECRET = 'test_session_secret_for_tests_only_very_long_string_must_be_64_bytes_12345678901234567890123456789012';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
const { app, helpers } = require('../server');

test('Admin Console Monolith Redesign & Orphan Partials Cleanup', async (t) => {
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(async () => {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    await new Promise((resolve) => server.close(resolve));
    try {
      if (helpers && typeof helpers.closeDbPool === 'function') {
        await helpers.closeDbPool();
      }
    } catch {}
  });

  await t.test('1. Orphan legacy partials are deleted and not referenced in any view', () => {
    const orphan1 = path.join(__dirname, '../views/partials/public-navbar.ejs');
    const orphan2 = path.join(__dirname, '../views/partials/public-footer.ejs');
    const orphan3 = path.join(__dirname, '../views/partials/cookie-banner.ejs');

    assert.equal(fs.existsSync(orphan1), false, 'views/partials/public-navbar.ejs must be deleted');
    assert.equal(fs.existsSync(orphan2), false, 'views/partials/public-footer.ejs must be deleted');
    assert.equal(fs.existsSync(orphan3), false, 'views/partials/cookie-banner.ejs must be deleted');

    // Recursively check all .ejs files in views
    function scanDir(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.name.endsWith('.ejs')) {
          const content = fs.readFileSync(fullPath, 'utf8');
          assert.equal(content.includes('partials/public-navbar'), false, `${entry.name} must not include partials/public-navbar`);
          assert.equal(content.includes('partials/public-footer'), false, `${entry.name} must not include partials/public-footer`);
          assert.equal(content.includes("include('cookie-banner')"), false, `${entry.name} must not include cookie-banner`);
        }
      }
    }
    scanDir(path.join(__dirname, '../views'));
  });

  await t.test('2. /admin/login renders with Monolith dark styling, Inter fonts, and #cursorGlow', async () => {
    const res = await fetch(`${baseUrl}/admin/login`);
    assert.equal(res.status, 200, 'Admin login page must return status 200');
    const html = await res.text();

    assert.equal(html.includes('id="cursorGlow"'), true, 'Must include #cursorGlow ambient cursor');
    assert.equal(html.includes('family=Inter'), true, 'Must load Inter Google font');
    assert.equal(html.includes('family=JetBrains+Mono'), true, 'Must load JetBrains Mono Google font');
    assert.equal(html.includes('/admin/admin.css'), true, 'Must link to /admin/admin.css');
    assert.equal(html.includes('/home-logo.svg'), true, 'Must use Monolith /home-logo.svg');
    assert.equal(html.includes('/logo.webp'), true, 'Must include /logo.webp fallback');
    assert.equal(html.includes('bootstrap.min.css'), false, 'Must not include bootstrap.min.css');
    assert.equal(html.includes('bootstrap.bundle.min.js'), false, 'Must not include bootstrap.bundle.min.js');
    assert.equal(html.includes('admin-login-card'), true, 'Must include admin-login-card container');
    assert.equal(html.includes('admin-login-chip'), true, 'Must include admin-login-chip badge');
  });

  await t.test('3. views/admin/2fa.ejs contains Monolith dark styling, fonts, and #cursorGlow', () => {
    const file = path.join(__dirname, '../views/admin/2fa.ejs');
    const content = fs.readFileSync(file, 'utf8');

    assert.equal(content.includes('id="cursorGlow"'), true, 'Must include #cursorGlow ambient cursor');
    assert.equal(content.includes('family=Inter'), true, 'Must load Inter Google font');
    assert.equal(content.includes('family=JetBrains+Mono'), true, 'Must load JetBrains Mono Google font');
    assert.equal(content.includes('/home-logo.svg'), true, 'Must use Monolith /home-logo.svg');
    assert.equal(content.includes('/logo.webp'), true, 'Must include /logo.webp fallback');
    assert.equal(content.includes('/logo.png'), false, 'Must not use legacy /logo.png');
  });

  await t.test('4. views/admin/partials/layout-top.ejs contains Monolith console layout, fonts, and #cursorGlow', () => {
    const file = path.join(__dirname, '../views/admin/partials/layout-top.ejs');
    const content = fs.readFileSync(file, 'utf8');

    assert.equal(content.includes('id="cursorGlow"'), true, 'Must include #cursorGlow ambient cursor');
    assert.equal(content.includes('family=Inter'), true, 'Must load Inter Google font');
    assert.equal(content.includes('family=JetBrains+Mono'), true, 'Must load JetBrains Mono Google font');
    assert.equal(content.includes('/home-logo.svg'), true, 'Must use Monolith /home-logo.svg');
    assert.equal(content.includes('/logo.webp'), true, 'Must include /logo.webp fallback');
    assert.equal(content.includes('/logo.png'), false, 'Must not use legacy /logo.png');
    assert.equal(content.includes('admin-shell'), true, 'Must include admin-shell');
    assert.equal(content.includes('sidebar'), true, 'Must include sidebar');
  });

  await t.test('5. public/admin/admin.css contains pitch-black Monolith design tokens', () => {
    const file = path.join(__dirname, '../public/admin/admin.css');
    const content = fs.readFileSync(file, 'utf8');

    assert.equal(content.includes('--bg: #0a0a0a;'), true, 'Must define pitch-black canvas --bg: #0a0a0a');
    assert.equal(content.includes('--panel: #111111;'), true, 'Must define dark card surface --panel: #111111');
    assert.equal(content.includes("'Inter'"), true, 'Must use Inter typography');
    assert.equal(content.includes("'JetBrains Mono'"), true, 'Must use JetBrains Mono for telemetry/codes');
    assert.equal(content.includes('#cursorGlow'), true, 'Must include #cursorGlow CSS rules');
    assert.equal(content.includes('radial-gradient'), true, 'Must include subtle ambient radial gradients');
  });

  await t.test('6. public/admin/admin.js contains cursor glow animation and dark theme default', () => {
    const file = path.join(__dirname, '../public/admin/admin.js');
    const content = fs.readFileSync(file, 'utf8');

    assert.equal(content.includes("qs('#cursorGlow')"), true, 'Must query #cursorGlow');
    assert.equal(content.includes("storedTheme = 'dark';"), true, 'Must default storedTheme to dark');
    assert.equal(content.includes("window.addEventListener('mousemove'"), true, 'Must track cursor on mousemove');
  });

  await t.test('7. views/updates.ejs and public/lang.js contain complete 20260917 admin release notes in AZ, TR, EN', () => {
    const updatesFile = path.join(__dirname, '../views/updates.ejs');
    const updatesContent = fs.readFileSync(updatesFile, 'utf8');
    assert.equal(updatesContent.includes('updates_release_20260917_admin_title'), true, 'Must include updates_release_20260917_admin_title in updates.ejs');

    const langContent = fs.readFileSync(path.join(__dirname, '../public/lang.js'), 'utf8');
    const sandbox = {
      window: { addEventListener: () => {} },
      localStorage: { getItem: () => null, setItem: () => {} },
      document: {
        addEventListener: () => {},
        querySelectorAll: () => [],
        getElementById: () => null,
        cookie: '',
        documentElement: { setAttribute: () => {}, lang: 'az' }
      }
    };
    vm.createContext(sandbox);
    const translations = vm.runInContext(langContent + '\n; translations;', sandbox);

    const keys = [
      'updates_release_20260917_admin_title',
      'updates_release_20260917_admin_badge',
      'updates_release_20260917_admin_desc',
      'updates_release_20260917_admin_item1',
      'updates_release_20260917_admin_item2',
      'updates_release_20260917_admin_item3',
    ];

    for (const key of keys) {
      assert.ok(translations.az[key], `Missing ${key} in AZ`);
      assert.ok(translations.tr[key], `Missing ${key} in TR`);
      assert.ok(translations.en[key], `Missing ${key} in EN`);
    }
  });

  await t.test('8. /admin/login initializes session and sets connect.sid cookie for CSRF protection', async () => {
    const getRes = await fetch(`${baseUrl}/admin/login`);
    assert.equal(getRes.status, 200);
    const setCookie = getRes.headers.get('set-cookie');
    assert.ok(setCookie, 'GET /admin/login must return Set-Cookie header');
    assert.ok(setCookie.includes('connect.sid='), 'Set-Cookie must set connect.sid');

    const html = await getRes.text();
    const tokenMatch = html.match(/name="_csrf"\s+value="([^"]+)"/);
    assert.ok(tokenMatch && tokenMatch[1], 'Must render _csrf hidden input');
    const token = tokenMatch[1];
    const cookie = setCookie.split(';')[0];

    const postRes = await fetch(`${baseUrl}/admin/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'cookie': cookie
      },
      body: `email=testadmin%40ovlink.sbs&password=wrongpass&_csrf=${encodeURIComponent(token)}`,
      redirect: 'manual'
    });

    const location = postRes.headers.get('location') || '';
    assert.equal(location.includes('Session+refreshed'), false, 'Must not fail with CSRF session refreshed error');
    assert.equal(postRes.status, 401, 'Should fail with 401 invalid credentials, not CSRF error');
  });
});
