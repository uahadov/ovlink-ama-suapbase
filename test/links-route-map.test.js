const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/*
 * Route-map regression net for src/routes/api/links.js (C3, W4.1).
 *
 * The file is being carved into helpers, so the *set* of endpoints and the
 * order they are registered in must be frozen before anything moves. A static
 * read is deliberate: Express 5 keeps its stack in internals that are not part
 * of the public API, and the guarantee we need — "the same URL with the same
 * method still exists" — is a property of the source.
 */

const ROOT = path.join(__dirname, '..');
const ROUTE_FILE = path.join(ROOT, 'src/routes/api/links.js');
const INDEX_FILE = path.join(ROOT, 'src/routes/api/index.js');

// One entry per router registration, in source order. Array paths are expanded
// because each element is an independently reachable URL.
const EXPECTED_ROUTES = Object.freeze([
  'GET /api/pro/v1/account',
  'ALL /api/pro/v1/account',
  'POST /api/pro/v1/shorten',
  'ALL /api/pro/v1/shorten',
  'GET /api/pro/v1/links/:short/stats',
  'GET /api/pro/v1/links/:short/clicks',
  'ALL /api/pro/v1/links/:short/stats',
  'ALL /api/pro/v1/links/:short/clicks',
  'POST /api/shorten',
  'POST /api/report',
  'POST /api/user/delete',
  'POST /api/user/delete-bulk',
  'POST /api/user/link/update',
  'POST /api/user/link/meta',
  'GET /api/user/export',
  'GET /api/links/export/csv',
  'POST /api/user/import',
]);

// Names imported by other modules (pro-v1, tests) — the move-only shim contract.
const EXPECTED_EXPORTS = Object.freeze([
  'escapeCsvCell',
  'parseTagsJson',
  'normalizeTagsInput',
  'normalizeIdempotencyKey',
  'buildShortenIdempotencyRequestHash',
  'getUrlHostname',
]);

// Mount order decides precedence when two routers answer the same path.
const EXPECTED_MOUNT_ORDER = Object.freeze([
  'system', 'links', 'pro-v1', 'mcp', 'qr', 'qr-manage', 'analytics', 'campaigns',
  'segments', 'account', 'onboarding', 'webhooks', 'api-keys', 'workspaces',
  'custom-domains', 'billing',
]);

const source = fs.readFileSync(ROUTE_FILE, 'utf8');

function registrationBlocks(src) {
  // Yield [method, path, argText] with the argument list balanced on parens.
  const out = [];
  const re = /router\.(get|post|put|patch|delete|all)\(/g;
  for (const m of src.matchAll(re)) {
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
    const paths = pathMatch[1].trim().startsWith('[')
      ? [...pathMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((p) => p[1])
      : [pathMatch[1].trim().slice(1, -1)];
    for (const p of paths) out.push({ method: m[1].toUpperCase(), path: p, args });
  }
  return out;
}

const routes = registrationBlocks(source);
const routeKeys = routes.map((r) => `${r.method} ${r.path}`);

test('LINKS-MAP-01: endpoint set and registration order are unchanged', () => {
  assert.deepEqual(routeKeys, [...EXPECTED_ROUTES]);
});

test('LINKS-MAP-02: no path+method pair is registered twice', () => {
  const counts = new Map();
  for (const key of routeKeys) counts.set(key, (counts.get(key) || 0) + 1);
  const duplicates = [...counts].filter(([, n]) => n > 1).map(([k]) => k);
  assert.deepEqual(duplicates, [], `duplicate registrations: ${duplicates.join(', ')}`);
});

test('LINKS-MAP-03: api router mount order is preserved', () => {
  const indexSource = fs.readFileSync(INDEX_FILE, 'utf8');
  const mounted = [...indexSource.matchAll(/router\.use\(require\('\.\/([a-z0-9-]+)'\)\)/g)].map((m) => m[1]);
  assert.deepEqual(mounted, [...EXPECTED_MOUNT_ORDER]);
});

test('LINKS-MAP-04: the pro v1 aliases stay reachable from this router', () => {
  // pro-v1.js is mounted right after links.js; if either moves, the public API
  // contract changes silently. Pin the pairing here.
  const proSource = fs.readFileSync(path.join(ROOT, 'src/routes/api/pro-v1.js'), 'utf8');
  assert.match(proSource, /router\.(get|post|use)\(/);
  assert.ok(routeKeys.includes('GET /api/pro/v1/account'));
  assert.ok(routeKeys.includes('POST /api/pro/v1/shorten'));
  // Every `all` fallback must be shadowed by a real verb handler on the same
  // path (it is a 405 shim, not a standalone endpoint).
  const pro = routes.filter((r) => r.path.startsWith('/api/pro/v1/'));
  for (const entry of pro) {
    if (entry.method !== 'ALL') continue;
    const guarded = pro.some((r) => r.path === entry.path && r.method !== 'ALL');
    assert.ok(guarded, `ALL ${entry.path} has no guarded verb handler`);
    assert.match(entry.args, /,\s*\(req, res(?:,\s*next)?[\s\S]{0,40}=>/, `ALL ${entry.path} gained middleware`);
  }
});

test('LINKS-MAP-05: every handler keeps its auth guard chain', () => {
  // CSRF is applied per-router by csrfRouter in src/routes/api/index.js, so the
  // file-level guard contract here is session/API-key auth + rate limiting.
  const byKey = new Map(routes.map((r) => [`${r.method} ${r.path}`, r.args]));
  const proKeys = [...byKey.keys()].filter((k) => k.includes('/api/pro/v1/') && !k.startsWith('ALL '));
  assert.ok(proKeys.length >= 4, `expected pro v1 guarded routes, found ${proKeys.length}`);
  for (const key of proKeys) {
    const args = byKey.get(key);
    assert.match(args, /authenticateProApiKey/, `${key} lost API-key auth`);
    assert.match(args, /requireApiScope\(API_KEY_SCOPES\.[A-Z_]+\)/, `${key} lost its scope check`);
    assert.match(args, /proReadLimiter|proWriteLimiter/, `${key} lost its limiter`);
  }
  // Session routes authenticate inline (`req.session.userId`) and authorize via
  // the workspace ownership SQL fragment — both are part of the audit surface.
  const sessionRoutes = [
    'POST /api/shorten', 'POST /api/user/delete', 'POST /api/user/delete-bulk',
    'POST /api/user/link/update', 'POST /api/user/link/meta',
    'GET /api/user/export', 'POST /api/user/import',
  ];
  for (const key of sessionRoutes) {
    assert.ok(byKey.has(key), `${key} disappeared`);
  }
  const sessionChecks = (source.match(/req\.session\.userId/g) || []).length;
  assert.ok(sessionChecks >= sessionRoutes.length,
    `only ${sessionChecks} session checks for ${sessionRoutes.length} session routes`);
  assert.ok((source.match(/WORKSPACE_LINK_MUTATION_SQL/g) || []).length >= 4,
    'workspace ownership guard no longer applied on link mutations');
  // Public write endpoints keep their limiter (no session to check).
  assert.match(byKey.get('POST /api/report'), /reportLimiter/);
  assert.match(byKey.get('POST /api/shorten'), /shortenLimiter/);
  assert.match(byKey.get('POST /api/shorten'), /body\('original'\)[\s\S]{0,80}isURL\(\)/,
    '/api/shorten lost its input validation chain');
  assert.match(source, /validationResult\(req\)/);
});

test('LINKS-MAP-06: helper extraction keeps the original exports available', () => {
  const exported = [...source.matchAll(/^module\.exports\.([A-Za-z0-9_]+)\s*=/gm)].map((m) => m[1]);
  for (const name of EXPECTED_EXPORTS) {
    assert.ok(exported.includes(name), `module.exports.${name} is gone`);
  }
  assert.match(source, /^module\.exports = router;/m);

  // Whatever is moved into src/lib must be re-exported from here (move-only +
  // shim contract): same export name, same behaviour, old import path intact.
  const libFiles = ['src/lib/link-input.js', 'src/lib/link-access.js'];
  for (const rel of libFiles) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) continue;
    const libSource = fs.readFileSync(file, 'utf8');
    const libNames = new Set([
      ...[...libSource.matchAll(/^module\.exports\.([A-Za-z0-9_]+)\s*=/gm)].map((m) => m[1]),
      ...[...libSource.matchAll(/^module\.exports = \{([\s\S]*?)\};?/gm)]
        .flatMap((m) => m[1].split(',').map((t) => t.trim().split(':')[0].trim())),
    ].filter(Boolean));
    assert.ok(libNames.size > 0, `${rel} exports nothing`);
    assert.ok(new RegExp(`require\\('\\.\\./\\.\\./lib/${rel.replace('src/lib/', '').replace(/\.js$/, '')}(?:\\.js)?'\\)`).test(source),
      `links.js does not require ${rel}`);
    // Names the rest of the app imports from links.js may not silently vanish.
    for (const name of EXPECTED_EXPORTS) {
      if (!libNames.has(name)) continue;
      assert.ok(exported.includes(name), `${name} moved to ${rel} but is no longer exported from links.js`);
      assert.ok(source.includes(name), `${name} no longer referenced in links.js`);
    }
  }
});
