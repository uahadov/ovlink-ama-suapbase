const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');

process.env.SESSION_SECRET = 'test_session_secret_for_tests_only_very_long_string_must_be_64_bytes_12345678901234567890123456789012';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

const { app } = require('../server');

test('Phase 3 Critical Views Redesign: Zero Bootstrap, Monolith compliance, and i18n', async (t) => {
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

  await t.test('1. /how-it-works adheres to Monolith dark theme, 0 Bootstrap, and bespoke SVGs', async () => {
    const res = await fetch(`${baseUrl}/how-it-works`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.equal(html.includes('bootstrap.min.css'), false, 'must not include bootstrap.min.css');
    assert.equal(html.includes('bootstrap.bundle.min.js'), false, 'must not include bootstrap.bundle.min.js');
    assert.equal(html.includes('Poppins'), false, 'must not include Poppins');
    assert.equal(html.includes('id="cursorGlow"'), true, 'must include custom cursor');
    assert.equal(html.includes('m-hiw-pipeline'), true, 'must include 4-step pipeline');
    assert.equal(html.includes('data-i18n="how_title"'), true, 'must have localized title');
    assert.equal(html.includes('m-nav'), true, 'must include universal navbar');
    assert.equal(html.includes('m-footer'), true, 'must include universal footer');
  });

  await t.test('2. /pro adheres to Monolith dark theme, 0 Bootstrap, and Polar session sync', async () => {
    const res = await fetch(`${baseUrl}/pro`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.equal(html.includes('bootstrap.min.css'), false, 'must not include bootstrap.min.css');
    assert.equal(html.includes('bootstrap.bundle.min.js'), false, 'must not include bootstrap.bundle.min.js');
    assert.equal(html.includes('Poppins'), false, 'must not include Poppins');
    assert.equal(html.includes('id="cursorGlow"'), true, 'must include custom cursor');
    assert.equal(html.includes('m-pro-halo-svg-wrap'), true, 'must include golden halo SVG');
    assert.equal(html.includes('id="proManageBtn"'), true, 'must preserve proManageBtn');
    assert.equal(html.includes('data-i18n="pro_success_title"'), true, 'must have localized success title');
    assert.equal(html.includes('m-pro-perks-grid'), true, 'must have Bento entitlements grid');
  });

  await t.test('3. error-blocked view adheres to Monolith dark theme, 0 Bootstrap, and threat radar', async () => {
    const testApp = express();
    testApp.set('view engine', 'ejs');
    testApp.set('views', path.join(__dirname, '..', 'views'));
    const html = await new Promise((resolve, reject) => {
      testApp.render('error-blocked', { csrfToken: 'test-token', siteSettings: {} }, (err, str) => {
        if (err) return reject(err);
        resolve(str);
      });
    });
    assert.equal(html.includes('bootstrap.min.css'), false, 'must not include bootstrap.min.css');
    assert.equal(html.includes('bg-light'), false, 'must not include bg-light');
    assert.equal(html.includes('id="cursorGlow"'), true, 'must include cursor glow');
    assert.equal(html.includes('m-gateway-card--threat'), true, 'must include threat quarantine card');
    assert.equal(html.includes('m-anim-radar'), true, 'must include animated radar SVG');
    assert.equal(html.includes('data-i18n="error_blocked_title"'), true, 'must include localized title');
  });

  await t.test('4. error-unauthorized view adheres to Monolith dark theme, 0 Bootstrap, and padlock beam', async () => {
    const testApp = express();
    testApp.set('view engine', 'ejs');
    testApp.set('views', path.join(__dirname, '..', 'views'));
    const html = await new Promise((resolve, reject) => {
      testApp.render('error-unauthorized', { csrfToken: 'test-token', shortCode: 'test-short', siteSettings: {} }, (err, str) => {
        if (err) return reject(err);
        resolve(str);
      });
    });
    assert.equal(html.includes('bootstrap.min.css'), false, 'must not include bootstrap.min.css');
    assert.equal(html.includes('bg-primary'), false, 'must not include bg-primary legacy navbar');
    assert.equal(html.includes('id="cursorGlow"'), true, 'must include cursor glow');
    assert.equal(html.includes('m-gateway-card--warning'), true, 'must include access lock card');
    assert.equal(html.includes('m-anim-beam'), true, 'must include keyhole beam scan SVG');
    assert.equal(html.includes('test-short'), true, 'must render short code');
  });

  await t.test('5. maintenance view adheres to Monolith dark theme, 0 Bootstrap, and gears mesh', async () => {
    const testApp = express();
    testApp.set('view engine', 'ejs');
    testApp.set('views', path.join(__dirname, '..', 'views'));
    const html = await new Promise((resolve, reject) => {
      testApp.render('maintenance', {
        csrfToken: 'test-token',
        maintenanceMessageAz: 'Test elanı',
        maintenanceMessageTr: 'Test duyurusu',
        maintenanceMessageEn: 'Test notice'
      }, (err, str) => {
        if (err) return reject(err);
        resolve(str);
      });
    });
    assert.equal(html.includes('bootstrap.min.css'), false, 'must not include bootstrap.min.css');
    assert.equal(html.includes('id="cursorGlow"'), true, 'must include cursor glow');
    assert.equal(html.includes('m-anim-gear-cw'), true, 'must include animated gear SVG');
    assert.equal(html.includes('id="maintenanceMessage"'), true, 'must include announcement container');
    assert.equal(html.includes('data-az="Test elanı"'), true, 'must pass announcement data');
  });

  await t.test('6. i18n parity check for all Phase 3 translation keys', async () => {
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
      'how_title', 'how_subtitle', 'how_pipeline_1_title', 'how_pipeline_2_title', 'how_pipeline_3_title', 'how_pipeline_4_title',
      'how_arch_title', 'how_arch_1_title', 'how_arch_2_title', 'how_arch_3_title', 'how_arch_4_title',
      'pro_success_title', 'pro_success_intro', 'pro_manage_cta', 'pro_perk_1_title', 'pro_perk_2_title',
      'error_blocked_title', 'error_blocked_msg', 'error_blocked_status', 'error_blocked_home',
      'unauth_page_title', 'unauth_title', 'unauth_stats_msg', 'unauth_desc',
      'maintenance_title', 'maintenance_msg', 'maintenance_status', 'maintenance_refresh'
    ];

    for (const key of requiredKeys) {
      assert.ok(translations.az[key], `Missing ${key} in AZ`);
      assert.ok(translations.tr[key], `Missing ${key} in TR`);
      assert.ok(translations.en[key], `Missing ${key} in EN`);
    }
  });
});
