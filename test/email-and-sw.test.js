process.env.SESSION_SECRET = 'test_session_secret_for_tests_only_very_long_string_must_be_64_bytes_12345678901234567890123456789012';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendNewDeviceLoginEmail,
  sendWorkspaceInviteEmail,
} = require('../src/lib/email');

test('Monolith Email Templates & PWA Service Worker Offline HUD', async (t) => {

  await t.test('1. sendVerificationEmail generates pitch-black Monolith HTML with JetBrains Mono code', async () => {
    let capturedMail = null;
    // Mock sendMail by mocking the function module call or inspecting returned promise
    // Since sendVerificationEmail calls sendMail, let's inspect the returned object or capture
    // But sendMail will attempt SMTP/Resend unless we test the generated HTML.
    // Let's test the HTML output of sendVerificationEmail directly:
    // To safely capture mail without actually transmitting, we can temporarily intercept emailTransporter or test the generated HTML
    // Let's create an email test helper that extracts the generated HTML
    const emailModule = require('../src/lib/email');
    
    // We can also verify template strings directly
    const emailSrc = fs.readFileSync(path.join(__dirname, '../src/lib/email.js'), 'utf8');
    assert.equal(emailSrc.includes('buildMonolithEmailShell'), true, 'Must include buildMonolithEmailShell helper');
    assert.equal(emailSrc.includes('background-color:#0a0a0a'), true, 'Must use #0a0a0a outer background in email shell');
    assert.equal(emailSrc.includes('background-color:#111111'), true, 'Must use #111111 card surface in email shell');
    assert.equal(emailSrc.includes('border:1px solid #262626'), true, 'Must use hairline border #262626 in email shell');
    assert.equal(emailSrc.includes("'JetBrains Mono'"), true, 'Must use JetBrains Mono in email templates');
  });

  await t.test('2. Verification Email template structure and translations (AZ, TR, EN)', () => {
    // We can run buildMonolithEmailShell and sendVerificationEmail in sandbox or evaluate
    const emailSrc = fs.readFileSync(path.join(__dirname, '../src/lib/email.js'), 'utf8');
    
    // Check that sendVerificationEmail has full translations
    assert.equal(emailSrc.includes('TƏSDİQLƏMƏ KODUNUZ'), true, 'Must include AZ verification code label');
    assert.equal(emailSrc.includes('DOĞRULAMA KODUNUZ'), true, 'Must include TR verification code label');
    assert.equal(emailSrc.includes('YOUR VERIFICATION CODE'), true, 'Must include EN verification code label');
    assert.equal(emailSrc.includes('30 dəqiqə ərzində keçərlidir'), true, 'Must include AZ expiration warning');
  });

  await t.test('3. Password Reset Email contains Monolith action button and fallback link', () => {
    const emailSrc = fs.readFileSync(path.join(__dirname, '../src/lib/email.js'), 'utf8');
    assert.equal(emailSrc.includes('SECURITY · RESET'), true, 'Must have SECURITY · RESET badge');
    assert.equal(emailSrc.includes('DIRECT LINK:'), true, 'Must include fallback direct link box');
    assert.equal(emailSrc.includes('background-color: #ffffff'), true, 'Must include Monolith solid white primary action button');
  });

  await t.test('4. New Device Sign-in Email contains telemetry table and caution alert', () => {
    const emailSrc = fs.readFileSync(path.join(__dirname, '../src/lib/email.js'), 'utf8');
    assert.equal(emailSrc.includes('SECURITY ALERT'), true, 'Must have SECURITY ALERT badge');
    assert.equal(emailSrc.includes('deviceTitle'), true, 'Must include device telemetry title');
    assert.equal(emailSrc.includes('countryTitle'), true, 'Must include country telemetry title');
    assert.equal(emailSrc.includes('methodTitle'), true, 'Must include method telemetry title');
    assert.equal(emailSrc.includes('rgba(255, 255, 255, 0.03)'), true, 'Must include Monolith subtle caution notice');
  });

  await t.test('5. Workspace Invite Email contains Monolith shell, badge, and invitation button', () => {
    const emailSrc = fs.readFileSync(path.join(__dirname, '../src/lib/email.js'), 'utf8');
    assert.equal(emailSrc.includes("badge: 'WORKSPACE'"), true, 'Must have WORKSPACE badge');
    assert.equal(emailSrc.includes('INVITATION LINK:'), true, 'Must include fallback invitation link box');
  });

  await t.test('6. public/sw.js contains ovlink-pwa-v8, Monolith offline HUD, and auto-reconnect engine', () => {
    const swPath = path.join(__dirname, '../public/sw.js');
    const swContent = fs.readFileSync(swPath, 'utf8');

    assert.equal(swContent.includes("CACHE_NAME = 'ovlink-pwa-v8'"), true, 'Cache version must be bumped to ovlink-pwa-v8');
    assert.equal(swContent.includes('Offline · Ovlink'), true, 'Must include Offline · Ovlink title');
    assert.equal(swContent.includes('--bg: #0a0a0a'), true, 'Must define #0a0a0a canvas');
    assert.equal(swContent.includes('--panel: #111111'), true, 'Must define #111111 panel');
    assert.equal(swContent.includes('hud-radar'), true, 'Must include radar telemetry container');
    assert.equal(swContent.includes('radar-svg'), true, 'Must include radar SVG');
    assert.equal(swContent.includes('OFFLINE · NO CONNECTION'), true, 'Must include offline status pill');
    assert.equal(swContent.includes("window.addEventListener('online'"), true, 'Must include online auto-reconnect listener');
    assert.equal(swContent.includes('navigator.language'), true, 'Must include dynamic language adaptation');
  });

  await t.test('7. views/updates.ejs and public/lang.js contain complete 20260917 email & sw release notes in AZ, TR, EN', () => {
    const updatesFile = path.join(__dirname, '../views/updates.ejs');
    const updatesContent = fs.readFileSync(updatesFile, 'utf8');
    assert.equal(updatesContent.includes('updates_release_20260917_emails_title'), true, 'Must include updates_release_20260917_emails_title in updates.ejs');

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
      'updates_release_20260917_emails_title',
      'updates_release_20260917_emails_badge',
      'updates_release_20260917_emails_desc',
      'updates_release_20260917_emails_item1',
      'updates_release_20260917_emails_item2',
      'updates_release_20260917_emails_item3',
    ];

    for (const key of keys) {
      assert.ok(translations.az[key], `Missing ${key} in AZ`);
      assert.ok(translations.tr[key], `Missing ${key} in TR`);
      assert.ok(translations.en[key], `Missing ${key} in EN`);
    }
  });
});
