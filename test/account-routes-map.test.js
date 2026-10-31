const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/*
 * Route-map regression net for src/routes/api/account.js (C3, W4.1).
 *
 * Same idea as links-route-map.test.js: freeze the URL+method inventory and the
 * auth/limiter contract before helpers are carved out into
 * src/lib/account-security.js. Static source reading, because the guarantee we
 * need is about the registration list itself.
 */

const ROOT = path.join(__dirname, '..');
const ROUTE_FILE = path.join(ROOT, 'src/routes/api/account.js');
const AUTH_ALIAS = path.join(ROOT, 'routes/auth.js');
const SECURITY_LIB = path.join(ROOT, 'src/lib/account-security.js');

const EXPECTED_ROUTES = Object.freeze([
  'POST /api/register',
  'POST /api/verify-email',
  'POST /api/resend-verification',
  'POST /api/login',
  'POST /api/verify-2fa',
  'GET /auth/google',
  'GET /auth/google/callback',
  'POST /api/logout',
  'GET /api/me',
  'GET /api/user/sessions',
  'POST /api/user/sessions/revoke',
  'POST /api/user/sessions/revoke-others',
  'POST /api/user/theme',
  'POST /api/user/settings',
  'POST /api/user/ui-lang',
  'GET /api/user/stats-report',
  'POST /api/user/stats-report',
  'POST /api/user/2fa/setup',
  'POST /api/user/2fa/enable',
  'POST /api/user/2fa/disable',
  'POST /api/user/email/change',
  'POST /api/user/email/confirm',
  'POST /api/user/password',
  'POST /api/forgot-password',
  'POST /api/reset-password',
  'GET /api/notifications',
  'POST /api/notifications/mark-all',
  'POST /api/notifications/delete-all',
]);

// Credentials/session/2FA primitives the split must keep reachable from here.
const EXPECTED_EXPORTS = Object.freeze([
  'generateVerificationCode',
  'normalizeSessionToken',
  'buildBanMessage',
  'verifyTotpToken',
  'handleLogout',
]);

// Password- and e-mail-changing endpoints must stay behind a limiter.
const AUTH_LIMITED_ROUTES = Object.freeze([
  'POST /api/register', 'POST /api/verify-email', 'POST /api/resend-verification',
  'POST /api/login', 'POST /api/verify-2fa', 'GET /auth/google',
  'GET /auth/google/callback', 'POST /api/user/email/change',
  'POST /api/user/email/confirm', 'POST /api/user/password',
  'POST /api/forgot-password', 'POST /api/reset-password',
]);

const source = fs.readFileSync(ROUTE_FILE, 'utf8');

function registrationBlocks(src) {
  const out = [];
  for (const m of src.matchAll(/router\.(get|post|put|patch|delete|all)\(/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i += 1) {
      const c = src[i];
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
    }
    const args = src.slice(m.index + m[0].length, i - 1);
    const pathMatch = args.match(/^\s*(\[[^\]]*\]|'[^']*'|"[^"]*")/);
    if (!pathMatch) continue;
    const token = pathMatch[1].trim();
    const paths = token.startsWith('[')
      ? [...token.matchAll(/['"]([^'"]+)['"]/g)].map((p) => p[1])
      : [token.slice(1, -1)];
    for (const p of paths) out.push({ method: m[1].toUpperCase(), path: p, args });
  }
  return out;
}

const routes = registrationBlocks(source);
const routeKeys = routes.map((r) => `${r.method} ${r.path}`);
const byKey = new Map(routes.map((r) => [`${r.method} ${r.path}`, r.args]));

test('ACCOUNT-MAP-01: endpoint set and registration order are unchanged', () => {
  assert.deepEqual(routeKeys, [...EXPECTED_ROUTES]);
});

test('ACCOUNT-MAP-02: no path+method pair is registered twice', () => {
  const seen = new Set();
  const dupes = [];
  for (const key of routeKeys) {
    if (seen.has(key)) dupes.push(key);
    seen.add(key);
  }
  assert.deepEqual(dupes, [], `duplicate registrations: ${dupes.join(', ')}`);
});

test('ACCOUNT-MAP-03: sensitive endpoints keep their limiter', () => {
  for (const key of AUTH_LIMITED_ROUTES) {
    const args = byKey.get(key);
    assert.ok(args, `${key} disappeared`);
    assert.match(args, /authLimiter/, `${key} lost authLimiter`);
  }
  for (const key of ['POST /api/user/2fa/setup', 'POST /api/user/2fa/enable',
    'POST /api/user/2fa/disable', 'POST /api/user/stats-report']) {
    assert.match(byKey.get(key), /sensitiveActionLimiter/, `${key} lost sensitiveActionLimiter`);
    assert.match(byKey.get(key), /requireSignedIn/, `${key} lost the session guard`);
  }
});

test('ACCOUNT-MAP-04: logout keeps the session-record delete', () => {
  // Mirror of test/forensic-fixes.test.js DEF-10 — the fix must survive the split.
  assert.match(source, /router\.post\('\/api\/logout', handleLogout\)/);
  assert.match(source, /DELETE FROM express_sessions WHERE sid = \?/);
  assert.ok(!source.includes('WHERE user_id = ? AND sid = ?'), 'legacy broken WHERE came back');
  assert.ok(fs.existsSync(AUTH_ALIAS), 'routes/auth.js compatibility alias is gone');
  assert.match(fs.readFileSync(AUTH_ALIAS, 'utf8'), /require\('\.\.\/src\/routes\/api\/account'\)/);
});

test('ACCOUNT-MAP-05: TOTP verification is single-sourced and constant-time compares stay', () => {
  // Every totp.verify call now goes through the lib helper; window/encoding
  // tuning must not be duplicated back into the route file.
  assert.equal((source.match(/speakeasy\.totp\.verify\(/g) || []).length, 0,
    'account.js re-implemented totp.verify instead of using verifyTotpToken');
  assert.match(source, /verifyTotpToken\(user\.totp_secret, code\)/);
  assert.match(source, /verifyTotpToken\(row\.totp_pending_secret, code\)/);
  assert.match(source, /verifyTotpToken\(row\.totp_secret, code\)/);
  assert.match(source, /tsscmp\(/, 'constant-time code compare was removed');
  if (fs.existsSync(SECURITY_LIB)) {
    const libSource = fs.readFileSync(SECURITY_LIB, 'utf8');
    assert.match(libSource, /speakeasy\.totp\.verify\(\{[\s\S]*?window: 1[\s\S]*?\}\)/);
    assert.match(libSource, /encoding: 'base32'/);
    // e-mail codes must come from a CSPRNG, and session tokens keep the shape
    // gate that protects the revoke-by-token endpoints.
    assert.match(libSource, /return crypto\.randomInt\(100000, 1000000\)\.toString\(\);/);
    assert.match(libSource, /\/\^\[A-Za-z0-9_-\]\{20,128\}\$\//);
  }
});

test('ACCOUNT-MAP-06: helper extraction keeps the original exports available', () => {
  const exported = [...source.matchAll(/^module\.exports\.([A-Za-z0-9_]+)\s*=/gm)].map((m) => m[1]);
  for (const name of EXPECTED_EXPORTS) {
    assert.ok(exported.includes(name), `module.exports.${name} is gone`);
  }
  assert.match(source, /^module\.exports = router;/m);
  // handleLogout must stay defined here (it is the /api/logout handler).
  assert.match(source, /^function handleLogout\(req, res\) \{/m);
  if (fs.existsSync(SECURITY_LIB)) {
    const libNames = [...fs.readFileSync(SECURITY_LIB, 'utf8')
      .matchAll(/^module\.exports = \{([\s\S]*?)\};/m)]
      .flatMap((m) => m[1].split(',').map((t) => t.trim()));
    for (const name of ['generateVerificationCode', 'normalizeSessionToken', 'buildBanMessage', 'verifyTotpToken']) {
      assert.ok(libNames.includes(name), `${name} is not exported from account-security.js`);
      assert.ok(exported.includes(name), `${name} moved but is no longer re-exported from account.js`);
      assert.ok(source.includes(`${name}(`), `${name} is no longer called from account.js`);
    }
  }
});
