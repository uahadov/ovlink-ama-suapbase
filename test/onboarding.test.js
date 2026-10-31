const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcrypt');

process.env.SESSION_SECRET = 'test_session_secret_for_tests_only_very_long_string_must_be_64_bytes_12345678901234567890123456789012';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

const { buildOnboardingState } = require('../src/lib/onboarding-state');

const root = path.join(__dirname, '..');
const TEST_PASSWORD = 'ObTest!2026x';

/* ── pure checklist state ───────────────────────────────────────── */

test('ONB-01: a fresh account sees all three steps', () => {
  const state = buildOnboardingState({ userRow: {}, totalLinks: 0, qrCount: 0, hasFirstClick: false });
  assert.equal(state.visible, true);
  assert.equal(state.completed, false);
  assert.deepEqual(state.steps.map((s) => s.done), [false, false, false]);
  assert.deepEqual(state.steps.map((s) => s.i18nKey), ['onboard_step_link', 'onboard_step_qr', 'onboard_step_click']);
});

test('ONB-02: one link flips only the first step', () => {
  const state = buildOnboardingState({ userRow: {}, totalLinks: 1, qrCount: 0, hasFirstClick: false });
  assert.equal(state.hasLink, true);
  assert.deepEqual(state.steps.map((s) => s.done), [true, false, false]);
  assert.equal(state.visible, true);
});

test('ONB-03: finishing every step hides the panel', () => {
  const state = buildOnboardingState({ userRow: {}, totalLinks: 4, qrCount: 2, hasFirstClick: true });
  assert.equal(state.completed, true);
  assert.equal(state.visible, false);
});

test('ONB-04: dismissal wins over progress', () => {
  const state = buildOnboardingState({ userRow: { onboarding_dismissed_at: '2026-10-01T00:00:00.000Z' }, totalLinks: 0 });
  assert.equal(state.dismissed, true);
  assert.equal(state.visible, false);
  assert.equal(state.nudgeEligible, false, 'a dismissed user must not be nudged by e-mail');
});

test('ONB-05: only an empty free account is nudge-eligible', () => {
  assert.equal(buildOnboardingState({ userRow: {}, totalLinks: 0, onFreePlan: true }).nudgeEligible, true);
  assert.equal(buildOnboardingState({ userRow: {}, totalLinks: 0, onFreePlan: false }).nudgeEligible, false);
  assert.equal(buildOnboardingState({ userRow: {}, totalLinks: 2, onFreePlan: true }).nudgeEligible, false);
});

/* ── wiring ─────────────────────────────────────────────────────── */

test('ONB-06: checklist, dismiss route and dashboard wiring exist', () => {
  const partial = fs.readFileSync(path.join(root, 'views/partials/onboarding-checklist.ejs'), 'utf8');
  assert.match(partial, /onboardingChecklist/);
  assert.match(partial, /\/api\/user\/onboarding-dismiss/);
  assert.match(partial, /x-csrf-token/);
  assert.match(partial, /nonce=/, 'inline script must stay nonce-guarded');

  const dashboardView = fs.readFileSync(path.join(root, 'views/dashboard.ejs'), 'utf8');
  assert.match(dashboardView, /include\('partials\/onboarding-checklist'\)/);

  const dashboardRoute = fs.readFileSync(path.join(root, 'src/routes/dashboard.js'), 'utf8');
  assert.match(dashboardRoute, /buildOnboardingState\(/);
  assert.match(dashboardRoute, /onboarding_dismissed_at/);

  const dismissRoute = fs.readFileSync(path.join(root, 'src/routes/api/onboarding.js'), 'utf8');
  assert.match(dismissRoute, /router\.post\('\/api\/user\/onboarding-dismiss'/);
  assert.match(dismissRoute, /req\.session\.userId/, 'must be session-scoped');

  const apiIndex = fs.readFileSync(path.join(root, 'src/routes/api/index.js'), 'utf8');
  assert.match(apiIndex, /require\('\.\/onboarding'\)/);
});

test('ONB-07: nudge worker is flag-gated, registered and claims before sending', () => {
  const worker = fs.readFileSync(path.join(root, 'src/lib/onboarding-worker.js'), 'utf8');
  assert.match(worker, /ENABLE_ONBOARDING_NUDGE/, 'default must be off');
  assert.match(worker, /onboarding_nudged_at IS NULL/, 'once-only guard');
  assert.match(worker, /beat\('onboarding-nudge'\)/, 'health heartbeat');
  assert.match(worker, /LIMIT \?/, 'batch must be bounded');

  // The claim UPDATE must run before the send so a failing SMTP call cannot
  // re-queue the same account on the next tick.
  assert.ok(
    worker.indexOf('UPDATE users SET onboarding_nudged_at') < worker.indexOf('sendOnboardingNudgeEmail(address'),
    'claim-before-send ordering is required'
  );

  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(server, /scheduleOnboardingNudge\(\)/);

  const email = fs.readFileSync(path.join(root, 'src/lib/email.js'), 'utf8');
  assert.match(email, /function sendOnboardingNudgeEmail/);
  assert.match(email, /sendOnboardingNudgeEmail,\n  buildPaymentFailedContent/, 'sender must be exported');
});

test('ONB-08: onboarding and billing copy exists in all three languages', () => {
  const lang = fs.readFileSync(path.join(root, 'public/lang.js'), 'utf8');
  const keys = [
    'onboard_title', 'onboard_subtitle', 'onboard_dismiss',
    'onboard_step_link', 'onboard_step_qr', 'onboard_step_click',
    'onboard_cta_link', 'onboard_cta_qr', 'onboard_cta_stats',
    'onboard_nudge_subject', 'onboard_nudge_desc',
    'billing_portal_cta', 'billing_manage_cta',
    'billing_payment_failed_title', 'billing_payment_failed_desc',
  ];
  for (const key of keys) {
    const count = (lang.match(new RegExp('^\\s*' + key + '\\s*:', 'gm')) || []).length;
    assert.equal(count, 3, `${key} must be defined in az, tr and en (found ${count})`);
  }
});

/* ── runtime behaviour (needs a database) ───────────────────────── */

const { app, helpers } = require('../server');
const { blindIndex, encryptAES256GCM } = require('../utils/crypto');

const createdUserIds = [];
let hasPostgres = false;

test.before(async () => {
  try {
    await helpers.dbGetAsync('SELECT 1');
    hasPostgres = true;
  } catch (err) {
    hasPostgres = false;
  }
  const deadline = Date.now() + 20000;
  while (!helpers.isDbMigrationQueueDrained() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

test.after(async () => {
  for (const id of createdUserIds) {
    try { await helpers.dbRunAsync('DELETE FROM users WHERE id = ?', [id]); } catch {}
  }
  try { await helpers.closeDbPool(); } catch {}
});

test('ONB-09: the day-3 nudge runs exactly once per account', async (t) => {
  if (!hasPostgres) {
    t.skip('PostgreSQL database not reachable in test environment');
    return;
  }

  const worker = require('../src/lib/onboarding-worker');
  const emailLib = require('../src/lib/email');
  const originalSender = emailLib.sendOnboardingNudgeEmail;
  const recipients = [];
  emailLib.sendOnboardingNudgeEmail = async (to) => {
    recipients.push(to);
    return { accepted: [to] };
  };

  try {
    const email = `onb-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    await helpers.dbRunAsync(
      'INSERT INTO users (email, email_hash, password, email_verified, plan_tier, plan_status, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)',
      [encryptAES256GCM(email), blindIndex(email), passwordHash, 'free', 'active', fiveDaysAgo]
    );
    const row = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [blindIndex(email)]);
    createdUserIds.push(row.id);

    const first = await worker.runOnboardingNudges();
    assert.ok(first.candidates > 0, 'a five-day-old free account is due');
    assert.equal(recipients.filter((to) => to === email).length, 1, 'exactly one nudge on the first pass');

    const stamped = await helpers.dbGetAsync('SELECT onboarding_nudged_at FROM users WHERE id = ?', [row.id]);
    assert.ok(stamped && stamped.onboarding_nudged_at, 'the guard column must be stamped');

    const second = await worker.runOnboardingNudges();
    assert.equal(recipients.filter((to) => to === email).length, 1, 'a second pass must not repeat the e-mail');
    assert.equal(second.candidates >= 0, true);
  } finally {
    emailLib.sendOnboardingNudgeEmail = originalSender;
  }
});

test('ONB-10: /api/user/onboarding-dismiss records the dismissal', async (t) => {
  if (!hasPostgres) {
    t.skip('PostgreSQL database not reachable in test environment');
    return;
  }

  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const email = `onb-dismiss-${Date.now()}@example.com`;
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
  await helpers.dbRunAsync(
    'INSERT INTO users (email, email_hash, password, email_verified, plan_tier, plan_status, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)',
    [encryptAES256GCM(email), blindIndex(email), passwordHash, 'free', 'active', new Date().toISOString()]
  );
  const row = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [blindIndex(email)]);
  createdUserIds.push(row.id);

  const bootstrap = await fetch(`${baseUrl}/api/csrf`);
  const cookies = (typeof bootstrap.headers.getSetCookie === 'function' ? bootstrap.headers.getSetCookie() : [bootstrap.headers.get('set-cookie')]) || [];
  const sid = cookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('connect.sid='));
  const { csrfToken } = await bootstrap.json();

  const login = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { cookie: sid, 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: TEST_PASSWORD, lang: 'en' }),
  });
  assert.equal(login.status, 200);
  const after = (typeof login.headers.getSetCookie === 'function' ? login.headers.getSetCookie() : [login.headers.get('set-cookie')]) || [];
  const newSid = after.map((c) => c.split(';')[0]).find((c) => c.startsWith('connect.sid=')) || sid;
  const csrfRes = await fetch(`${baseUrl}/api/csrf`, { headers: { cookie: newSid } });
  const { csrfToken: fresh } = await csrfRes.json();

  const res = await fetch(`${baseUrl}/api/user/onboarding-dismiss`, {
    method: 'POST',
    headers: { cookie: newSid, 'x-csrf-token': fresh, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).dismissed, true);

  const updated = await helpers.dbGetAsync('SELECT onboarding_dismissed_at FROM users WHERE id = ?', [row.id]);
  assert.ok(updated && updated.onboarding_dismissed_at, 'dismissal must persist');
});
