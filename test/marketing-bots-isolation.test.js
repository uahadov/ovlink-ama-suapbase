const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('server.js never starts marketing bots without an explicit flag', () => {
  const source = read('server.js');
  const gateIndex = source.indexOf("isEnabledEnv('ENABLE_MARKETING_BOTS'");
  assert.ok(gateIndex > -1, 'server.js must gate outreach behind ENABLE_MARKETING_BOTS');

  const botIndex = source.indexOf("require('./src/marketing_bots/b2b-email-hunter')");
  assert.ok(botIndex > -1, 'the guarded block should still exist for operators who opt in');
  assert.ok(
    botIndex > gateIndex,
    'marketing bot requires must live inside the ENABLE_MARKETING_BOTS gate'
  );

  const occurrences = (source.match(/marketing_bots/g) || []).length;
  assert.equal(occurrences, 2, 'only b2b-email-hunter and social-listener may be referenced');
});

test('outreach runner is a standalone, syntax-valid entry point', (t) => {
  const runner = path.join(ROOT, 'scripts', 'outreach-runner.js');
  assert.ok(fs.existsSync(runner), 'scripts/outreach-runner.js must exist');
  try {
    require('child_process').execFileSync(process.execPath, ['--check', runner], { stdio: 'pipe' });
  } catch (err) {
    assert.fail(`outreach-runner.js failed node --check: ${err.message}`);
  }
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['start:outreach'], 'node scripts/outreach-runner.js');
});

test('no prospect seed data is bundled with the bots', () => {
  const b2b = read('src/marketing_bots/b2b-email-hunter.js');
  assert.equal(/@growthwavemedia\.com/.test(b2b), false, 'seed lead e-mails must not be in source');
  assert.match(b2b, /JSON\.stringify\(\[\], null, 2\)/, 'the queue must seed as an empty array');
});
