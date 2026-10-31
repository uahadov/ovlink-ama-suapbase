const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/*
 * W4.4 — the stats detail page script lives in public/stats-page.js.
 *
 * views/stats-page.ejs used to carry a ~1470-line inline <script> body, which
 * made the view unreviewable and prevented any caching/integrity handling of the
 * page logic. The body is now a normal asset configured through data-*
 * attributes, with STATS_PAGE_INLINE_JS=1 kept as a one-release rollback lever
 * that inlines the *same* file.
 */

const ROOT = path.join(__dirname, '..');
const VIEW = path.join(ROOT, 'views/stats-page.ejs');
const ASSET = path.join(ROOT, 'public/stats-page.js');
const LIB = path.join(ROOT, 'src/lib/stats-page-assets.js');
const ROUTE = path.join(ROOT, 'src/routes/api/analytics.js');

const viewSource = fs.readFileSync(VIEW, 'utf8');
const assetSource = fs.readFileSync(ASSET, 'utf8');

// The repo-wide "Monolith Motion & Interaction Engine" block is a shared
// convention copied into every public view (identical bytes in account.ejs,
// index.ejs, …). It is not part of the stats page logic, so it is the single
// documented exception here rather than something this wave silently grows.
const MOTION_MARKER = 'Monolith Motion & Interaction Engine';

function inlineBodies(source) {
  const bodies = [];
  for (const match of source.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (/\bsrc=/.test(match[1])) continue;
    bodies.push(match[2]);
  }
  return bodies;
}

function countLines(body) {
  return body.split('\n').filter((line) => line.trim()).length;
}

test('STATS-ASSET-01: the analytics logic body is gone from the view', () => {
  const counts = inlineBodies(viewSource).map(countLines);
  const motionCopies = counts.filter((n) => n > 40);
  assert.ok(motionCopies.length <= 1, `unexpected long inline scripts in stats-page.ejs: ${counts.join(', ')}`);
  assert.ok(
    !viewSource.includes('const essentialMarker = <%-') && !viewSource.includes('const shortCode = <%-'),
    'the extracted analytics block leaked back into the view'
  );
  // ~1580 inline JS lines before W4.4; only the shared motion block remains.
  const totalInline = counts.reduce((a, b) => a + b, 0);
  assert.ok(totalInline < 150, `stats-page.ejs still carries ${totalInline} inline JS lines`);

  // The one exception must be byte-identical to the convention in another view.
  const motionBody = (inlineBodies(viewSource).find((b) => countLines(b) > 40) || '').trim();
  const otherSource = fs.readFileSync(path.join(ROOT, 'views/account.ejs'), 'utf8');
  const otherMotion = (inlineBodies(otherSource).find((b) => b.includes('mCursorArrow')) || '').trim();
  assert.ok(motionBody.length > 0 && otherMotion.length > 0);
  assert.equal(motionBody, otherMotion, 'the motion block drifted from the shared copy');
  assert.ok(viewSource.includes(MOTION_MARKER));
});

test('STATS-ASSET-02: page logic is loaded as a versioned, nonced asset', () => {
  assert.match(viewSource, /<script nonce="<%= nonce %>" src="\/stats-page\.js\?v=<%= assetVersion %>"><\/script>/);
  const scripts = [...viewSource.matchAll(/<script\b([^>]*)>/g)];
  assert.ok(scripts.length > 0);
  for (const tag of scripts) {
    assert.match(tag[1], /nonce="<%= nonce %>"/, 'a <script> tag lost its nonce');
  }
  assert.ok(!/<script(?![^>]*nonce)/.test(viewSource));
});

test('STATS-ASSET-03: page config reaches the asset through data-* attributes', () => {
  assert.match(viewSource, /<body[^>]*data-short-code="<%= shortCode %>"[^>]*>/);
  assert.match(viewSource, /data-essential-marker="<%= consentMarker %>"/);
  // Server values must no longer be spliced into JavaScript source.
  assert.ok(!viewSource.includes('JSON.stringify(shortCode)'), 'inline JS interpolation came back');
  assert.ok(!viewSource.includes('JSON.stringify(consentMarker)'), 'inline JS interpolation came back');
  assert.match(assetSource, /bodyCfg\.shortCode/);
  assert.match(assetSource, /bodyCfg\.essentialMarker/);
});

test('STATS-ASSET-04: the extracted asset is one IIFE and keeps the moved functions', () => {
  assert.match(assetSource, /^\/\/ Stats detail page logic[\s\S]*\n\(function \(\) \{/);
  assert.match(assetSource, /\}\)\(\);\s*$/);
  assert.equal((assetSource.match(/^\(function \(\) \{/gm) || []).length, 1);
  assert.ok(!assetSource.includes('<%'), 'EJS leaked into the static asset');
  for (const name of ['renderKpis', 'renderTimeChart', 'renderActivityTable', 'renderGeoMap',
    'applyAnalyticsView', 'renderAnomalies', 'renderFunnel', 'renderVisitors', 'loadExtras']) {
    assert.ok(new RegExp(`function ${name}\\(`).test(assetSource), `${name} was lost in the move`);
  }
  // Nothing may reach out to globals that only existed inside the old inline scope.
  assert.ok(!/\bwindow\.__OVLINK_STATS_PAGE__\s*=/.test(assetSource),
    'the asset must read the fallback config, not define it');
  assert.match(assetSource, /window\.__OVLINK_STATS_PAGE__/);
});

test('STATS-ASSET-05: STATS_PAGE_INLINE_JS inlines the same body, escaped', () => {
  const libSource = fs.readFileSync(LIB, 'utf8');
  assert.match(libSource, /isEnabledEnv\('STATS_PAGE_INLINE_JS'\)/);
  assert.match(libSource, /replace\(\/<\/g, '\\\\u003c'\)/);

  const { buildInlineStatsPage, statsPageInlineJs, SCRIPT_PATH } = require(LIB);
  assert.equal(SCRIPT_PATH, ASSET);
  // Lever off (default) → the view gets the plain <script src>.
  delete process.env.STATS_PAGE_INLINE_JS;
  assert.equal(statsPageInlineJs({ shortCode: 'abc' }), null);
  process.env.STATS_PAGE_INLINE_JS = '1';
  try {
    const inline = statsPageInlineJs({ shortCode: 'abc', essentialMarker: '__essential__' });
    assert.equal(typeof inline, 'string');
    assert.match(inline, /^window\.__OVLINK_STATS_PAGE__ = \{"shortCode":"abc","essentialMarker":"__essential__"\};\n/);
    assert.equal(inline, buildInlineStatsPage({ shortCode: 'abc', essentialMarker: '__essential__' }));
    assert.ok(inline.includes(assetSource), 'inline body must be the shipped asset, byte for byte');
    assert.ok(!/<[a-z]/.test(inline.slice(0, 200)), 'raw markup in the injected config');
    // Hostile short codes are escaped, so they cannot close the script element.
    const hostile = buildInlineStatsPage({ shortCode: '</script><script>alert(1)</script>' });
    assert.ok(!hostile.slice(0, 300).includes('</script>'), 'unescaped </script> in config payload');
  } finally {
    delete process.env.STATS_PAGE_INLINE_JS;
  }
});

test('STATS-ASSET-06: the view branches on the local and the route supplies it', () => {
  assert.match(viewSource, /<% if \(locals\.statsPageInlineJs\) \{ %>/);
  const routeSource = fs.readFileSync(ROUTE, 'utf8');
  assert.match(routeSource, /require\('\.\.\/\.\.\/lib\/stats-page-assets'\)/);
  assert.match(routeSource, /statsPageInlineJs: statsPageInlineJs\(\{/);
  assert.match(routeSource, /essentialMarker: REDIRECT_CONSENT_MARKER/);
});

test('STATS-ASSET-07: workspace ownership SQL is single-sourced', () => {
  const linkAccess = fs.readFileSync(path.join(ROOT, 'src/lib/link-access.js'), 'utf8');
  const linksSource = fs.readFileSync(path.join(ROOT, 'src/routes/api/links.js'), 'utf8');
  const analyticsSource = fs.readFileSync(ROUTE, 'utf8');
  const SQL = "'(user_id = ? OR workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ?))'";
  assert.ok(linkAccess.includes(SQL), 'link-access.js must own the read-scope fragment');
  for (const [name, src] of [['analytics.js', analyticsSource], ['links.js', linksSource]]) {
    assert.ok(!src.includes(SQL), `${name} still redefines the ownership fragment`);
    assert.match(src, /require\('\.\.\/\.\.\/lib\/link-access'\)/);
  }
});
