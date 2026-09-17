const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');

process.env.SESSION_SECRET = 'test_session_secret_for_tests_only_very_long_string_must_be_64_bytes_12345678901234567890123456789012';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

const { app } = require('../server');

test('Phase 4 Final Views Redesign: Zero Bootstrap, Monolith compliance, and i18n', async (t) => {
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(() => {
    server.close();
  });

  await t.test('1. /tools/preview adheres to Monolith dark theme, 0 Bootstrap, and AI studio', async () => {
    const res = await fetch(`${baseUrl}/tools/preview`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.equal(html.includes('bootstrap.min.css'), false, 'must not include bootstrap.min.css');
    assert.equal(html.includes('bootstrap.bundle.min.js'), false, 'must not include bootstrap.bundle.min.js');
    assert.equal(html.includes('Poppins'), false, 'must not include Poppins');
    assert.equal(html.includes('id="cursorGlow"'), true, 'must include custom cursor');
    assert.equal(html.includes('m-tool-hero'), true, 'must include tool hero');
    assert.equal(html.includes('m-preview-composer'), true, 'must include preview composer');
    assert.equal(html.includes('id="platformSwitcher"'), true, 'must include platform switcher');
    assert.equal(html.includes('id="previewCard"'), true, 'must include preview card');
    assert.equal(html.includes('id="aiBox"'), true, 'must include AI studio box');
    assert.equal(html.includes('m-nav'), true, 'must include universal navbar');
    assert.equal(html.includes('m-footer'), true, 'must include universal footer');
  });

  await t.test('2. error-disabled view adheres to Monolith dark theme, 0 Bootstrap, and spark SVG', async () => {
    const testApp = express();
    testApp.set('view engine', 'ejs');
    testApp.set('views', path.join(__dirname, '..', 'views'));
    const html = await new Promise((resolve, reject) => {
      testApp.render('error-disabled', { csrfToken: 'test-token', reason: 'Təhlükəsizlik qaydası', siteSettings: {} }, (err, str) => {
        if (err) return reject(err);
        resolve(str);
      });
    });
    assert.equal(html.includes('bootstrap.min.css'), false, 'must not include bootstrap.min.css');
    assert.equal(html.includes('bg-light'), false, 'must not include bg-light');
    assert.equal(html.includes('id="cursorGlow"'), true, 'must include cursor glow');
    assert.equal(html.includes('m-gateway-card--threat'), true, 'must include threat gateway card');
    assert.equal(html.includes('m-anim-spark'), true, 'must include severed link spark animation');
    assert.equal(html.includes('data-i18n="error_disabled_title"'), true, 'must include localized title');
    assert.equal(html.includes('Təhlükəsizlik qaydası'), true, 'must render provided reason');
  });

  await t.test('3. error-expired view adheres to Monolith dark theme, 0 Bootstrap, and sand trickle SVG', async () => {
    const testApp = express();
    testApp.set('view engine', 'ejs');
    testApp.set('views', path.join(__dirname, '..', 'views'));
    const html = await new Promise((resolve, reject) => {
      testApp.render('error-expired', { csrfToken: 'test-token', siteSettings: {} }, (err, str) => {
        if (err) return reject(err);
        resolve(str);
      });
    });
    assert.equal(html.includes('bootstrap.min.css'), false, 'must not include bootstrap.min.css');
    assert.equal(html.includes('bg-light'), false, 'must not include bg-light');
    assert.equal(html.includes('id="cursorGlow"'), true, 'must include cursor glow');
    assert.equal(html.includes('m-gateway-card--warning'), true, 'must include warning gateway card');
    assert.equal(html.includes('m-anim-sand'), true, 'must include flowing hourglass sand animation');
    assert.equal(html.includes('data-i18n="error_expired_title"'), true, 'must include localized title');
  });

  await t.test('4. error-max-clicks view adheres to Monolith dark theme, 0 Bootstrap, and overload gauge', async () => {
    const testApp = express();
    testApp.set('view engine', 'ejs');
    testApp.set('views', path.join(__dirname, '..', 'views'));
    const html = await new Promise((resolve, reject) => {
      testApp.render('error-max-clicks', { csrfToken: 'test-token', siteSettings: {} }, (err, str) => {
        if (err) return reject(err);
        resolve(str);
      });
    });
    assert.equal(html.includes('bootstrap.min.css'), false, 'must not include bootstrap.min.css');
    assert.equal(html.includes('bg-light'), false, 'must not include bg-light');
    assert.equal(html.includes('id="cursorGlow"'), true, 'must include cursor glow');
    assert.equal(html.includes('m-gateway-card--threat'), true, 'must include threat gateway card');
    assert.equal(html.includes('m-anim-gauge'), true, 'must include overload gauge animation');
    assert.equal(html.includes('data-i18n="error_max_clicks_title"'), true, 'must include localized title');
    assert.equal(html.includes('href="/pro"'), true, 'must include pro upgrade link');
  });

  await t.test('5. error-banned view adheres to Monolith dark theme, 0 Bootstrap, countdown preservation, and lockout SVG', async () => {
    const testApp = express();
    testApp.set('view engine', 'ejs');
    testApp.set('views', path.join(__dirname, '..', 'views'));
    const html = await new Promise((resolve, reject) => {
      testApp.render('error-banned', {
        csrfToken: 'test-token',
        until: '2026-12-31 23:59',
        untilIso: '2026-12-31T23:59:00Z',
        remaining: '3 ay',
        reason: 'Spam aktivliyi',
        siteSettings: {}
      }, (err, str) => {
        if (err) return reject(err);
        resolve(str);
      });
    });
    assert.equal(html.includes('bootstrap.min.css'), false, 'must not include bootstrap.min.css');
    assert.equal(html.includes('bg-light'), false, 'must not include bg-light');
    assert.equal(html.includes('id="cursorGlow"'), true, 'must include cursor glow');
    assert.equal(html.includes('m-gateway-card--threat'), true, 'must include threat gateway card');
    assert.equal(html.includes('m-anim-ban'), true, 'must include lockout slash animation');
    assert.equal(html.includes('js-ban-until'), true, 'must include js-ban-until for timer hook');
    assert.equal(html.includes('js-ban-remaining'), true, 'must include js-ban-remaining for timer hook');
    assert.equal(html.includes('data-iso="2026-12-31T23:59:00Z"'), true, 'must preserve ISO timestamp attribute');
    assert.equal(html.includes('Spam aktivliyi'), true, 'must render provided reason');
    assert.equal(html.includes('support@ovlink.sbs'), true, 'must include support contact email');
  });

  await t.test('6. error-warning view adheres to Monolith dark theme, 0 Bootstrap, warning wave SVG, and confirm query', async () => {
    const testApp = express();
    testApp.set('view engine', 'ejs');
    testApp.set('views', path.join(__dirname, '..', 'views'));
    const html = await new Promise((resolve, reject) => {
      testApp.render('error-warning', { csrfToken: 'test-token', short: 'warn123', siteSettings: {} }, (err, str) => {
        if (err) return reject(err);
        resolve(str);
      });
    });
    assert.equal(html.includes('bootstrap.min.css'), false, 'must not include bootstrap.min.css');
    assert.equal(html.includes('bg-light'), false, 'must not include bg-light');
    assert.equal(html.includes('id="cursorGlow"'), true, 'must include cursor glow');
    assert.equal(html.includes('m-gateway-card--warning'), true, 'must include warning gateway card');
    assert.equal(html.includes('m-anim-warn-wave'), true, 'must include warning wave animation');
    assert.equal(html.includes('/warn123?confirm=true'), true, 'must include confirm query param');
    assert.equal(html.includes('data-i18n="danger_title"'), true, 'must include danger_title');
  });

  await t.test('7. i18n parity check for all Phase 4 translation keys across az, tr, and en', async () => {
    const langContent = fs.readFileSync(path.join(__dirname, '..', 'public', 'lang.js'), 'utf8');
    const vm = require('node:vm');
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
    assert.ok(translations, 'translations object must exist in lang.js');
    assert.ok(translations.az, 'az dictionary exists');
    assert.ok(translations.tr, 'tr dictionary exists');
    assert.ok(translations.en, 'en dictionary exists');

    const requiredKeys = [
      'error_disabled_title', 'error_disabled_msg', 'error_disabled_status', 'error_disabled_reason', 'error_disabled_home',
      'error_expired_title', 'error_expired_msg', 'error_expired_status', 'error_expired_home',
      'error_max_clicks_title', 'error_max_clicks_msg', 'error_max_clicks_status', 'error_max_clicks_pro_hint', 'error_max_clicks_pricing_cta', 'error_max_clicks_home',
      'error_banned_title', 'error_banned_msg', 'error_banned_status', 'error_banned_until', 'error_banned_remaining', 'error_banned_reason', 'error_banned_support', 'error_banned_home',
      'danger_title', 'danger_msg', 'danger_status', 'danger_continue', 'danger_back',
      'preview_tool_title', 'preview_tool_desc', 'preview_input_placeholder', 'preview_generate_btn',
      'preview_platform_twitter', 'preview_platform_fb', 'preview_platform_linkedin', 'preview_platform_discord',
      'preview_ai_title', 'preview_ai_btn', 'preview_cta_title', 'preview_cta_desc', 'preview_cta_btn'
    ];

    for (const key of requiredKeys) {
      assert.ok(translations.az[key], `Missing ${key} in AZ`);
      assert.ok(translations.tr[key], `Missing ${key} in TR`);
      assert.ok(translations.en[key], `Missing ${key} in EN`);
    }
  });
});
