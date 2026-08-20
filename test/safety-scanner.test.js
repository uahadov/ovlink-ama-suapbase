const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'b66f58f96f4a4f6090de997ca71b72910d9695f95f24ddf9b255f4cbebf9804cff9e1b9d79f60df7e840a9136dbf126fd1f6f4f94b1f8cfbd93afbfccf8d4f8a';
process.env.NODE_ENV = 'test';
process.env.BASE_URL = '';
process.env.PUBLIC_BASE_URL = '';

const { helpers } = require('../server');

test.after(async () => {
  try {
    const migrationDrainDeadline = Date.now() + 3000;
    while (!helpers.isDbMigrationQueueDrained() && Date.now() < migrationDrainDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await helpers.closeDbPool();
  } catch {}
});

test('isSuspiciousOrPhishingUrl detects raw IP hostnames and octal/hex formats', () => {
  assert.equal(helpers.isSuspiciousOrPhishingUrl('http://192.168.1.1/login').suspicious, true);
  assert.equal(helpers.isSuspiciousOrPhishingUrl('http://1.2.3.4/update.html').suspicious, true);
  assert.equal(helpers.isSuspiciousOrPhishingUrl('http://[::1]/panel').suspicious, true);
  assert.equal(helpers.isSuspiciousOrPhishingUrl('http://0x7f000001/').suspicious, true);
});

test('isSuspiciousOrPhishingUrl blocks dangerous executable and installer files', () => {
  const exts = ['.exe', '.apk', '.bat', '.scr', '.vbs', '.cmd', '.msi', '.ps1'];
  for (const ext of exts) {
    const check = helpers.isSuspiciousOrPhishingUrl(`https://example.com/downloads/setup${ext}`);
    assert.equal(check.suspicious, true, `Extension ${ext} should be flagged as suspicious`);
    assert.equal(check.reason, 'dangerous_extension');
  }
});

test('isSuspiciousOrPhishingUrl correctly isolates UGC platforms like mediafire and drive', () => {
  // UGC with dangerous APK file -> flagged with isUgc: true
  const mediafireApk = helpers.isSuspiciousOrPhishingUrl('https://www.mediafire.com/file/free-gemini.apk');
  assert.equal(mediafireApk.suspicious, true);
  assert.equal(mediafireApk.isUgc, true);
  assert.equal(mediafireApk.reason, 'dangerous_extension');

  // UGC with clean PDF file -> NOT suspicious
  const mediafirePdf = helpers.isSuspiciousOrPhishingUrl('https://www.mediafire.com/file/lecture_notes_2026.pdf');
  assert.equal(mediafirePdf.suspicious, false);
  assert.equal(mediafirePdf.isUgc, true);

  // Google Drive clean doc -> NOT suspicious
  const driveClean = helpers.isSuspiciousOrPhishingUrl('https://drive.google.com/file/d/1A2B3C4D5E/view');
  assert.equal(driveClean.suspicious, false);
  assert.equal(driveClean.isUgc, true);

  // Github repo clean link -> NOT suspicious
  const githubClean = helpers.isSuspiciousOrPhishingUrl('https://github.com/facebook/react');
  assert.equal(githubClean.suspicious, false);
  assert.equal(githubClean.isUgc, true);
});

test('isSuspiciousOrPhishingUrl detects phishing and scam keywords', () => {
  const phishingUrls = [
    'https://free-nitro-discord.xyz/gift',
    'https://telegram-airdrop-claim.top/auth',
    'https://binance-security-update.com/login',
    'https://metamask-verify-wallet.net/restore',
    'https://paypal-login-security.info/account'
  ];

  for (const url of phishingUrls) {
    const check = helpers.isSuspiciousOrPhishingUrl(url);
    assert.equal(check.suspicious, true, `URL ${url} should be flagged as phishing pattern`);
    assert.equal(check.reason, 'phishing_pattern');
  }
});

test('isSuspiciousOrPhishingUrl allows standard legitimate URLs', () => {
  const safeUrls = [
    'https://google.com',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://en.wikipedia.org/wiki/Node.js',
    'https://medium.com/@author/modern-web-development-2026',
    'https://ovlink.sbs/about'
  ];

  for (const url of safeUrls) {
    const check = helpers.isSuspiciousOrPhishingUrl(url);
    assert.equal(check.suspicious, false, `Legitimate URL ${url} should pass`);
  }
});

test('checkLiveThreat correctly returns safe status for clean URLs', async () => {
  const res = await helpers.checkLiveThreat('https://github.com/nodejs/node');
  assert.equal(res.threat, false);
});
