const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/*
 * A17 — programmatic landing pages, OG images and the changelog feed.
 *
 * The manifest is the allowlist; public/lang.js is the dictionary the client
 * switches on. Both must say exactly the same thing, and robots.txt plus
 * sitemap.xml must advertise exactly the slugs the router is willing to render.
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET
  || 'test_session_secret_for_tests_only_very_long_string_must_be_64_bytes_12345678901234567890123456789012';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

const ROOT = path.join(__dirname, '..');
const {
  SEO_LANDING_PAGES,
  LANDING_INDEX_PATH,
  findLandingPage,
  landingPagePaths,
  landingCopy,
  landingShared,
  LANDING_SHARED,
} = require(path.join(ROOT, 'src/lib/seo-pages'));
const { CHANGELOG, buildRssFeed, escapeXml } = require(path.join(ROOT, 'src/lib/changelog'));

const LANGS = ['az', 'tr', 'en'];
const dict = fs.readFileSync(path.join(ROOT, 'public/lang.js'), 'utf8');

/** Language block of public/lang.js, so parity is checked per language. */
function langBlock(lang) {
  const start = dict.indexOf(`    ${lang}: {`);
  assert.ok(start >= 0, `missing ${lang} block in public/lang.js`);
  const next = LANGS.map((l) => dict.indexOf(`    ${l}: {`, start + 1))
    .filter((i) => i > start);
  const end = next.length ? Math.min(...next) : dict.length;
  return dict.slice(start, end);
}

test('SEO-01: manifest is an allowlist of unique, routable slugs', () => {
  const slugs = SEO_LANDING_PAGES.map((page) => page.slug);
  assert.equal(new Set(slugs).size, slugs.length, 'duplicate slug in the manifest');
  assert.ok(slugs.length >= 5, 'expected at least five landing pages');
  const slugRe = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;
  for (const slug of slugs) assert.match(slug, slugRe, `${slug} is not routable`);
  for (const page of SEO_LANDING_PAGES) {
    assert.equal(page.titleKey, `seo_landing_${page.slug.replace(/-/g, '_')}_title`);
    assert.equal(findLandingPage(page.slug), page);
    assert.equal(findLandingPage(page.slug.toUpperCase()), page, 'lookup is case-insensitive');
  }
  assert.equal(findLandingPage('anything-else'), null);
  assert.equal(findLandingPage(''), null);
  assert.equal(findLandingPage(undefined), null);
});

test('SEO-02: every manifest string exists in the matching language block of lang.js', () => {
  const problems = [];
  const check = (lang, key, value) => {
    if (!value) { problems.push(`${lang}: ${key} is empty`); return; }
    if (!langBlock(lang).includes(`: "${value.replace(/"/g, '\\"')}"`)) {
      problems.push(`${lang}: ${key} text is not in public/lang.js`);
    }
  };
  for (const page of SEO_LANDING_PAGES) {
    const prefix = `seo_landing_${page.slug.replace(/-/g, '_')}`;
    for (const lang of LANGS) {
      check(lang, `${prefix}_title`, page.copy.title[lang]);
      check(lang, `${prefix}_lead`, page.copy.lead[lang]);
      page.copy.points.forEach((point, idx) => check(lang, `${prefix}_p${idx + 1}`, point[lang]));
    }
    assert.deepEqual(page.pointKeys, [`${prefix}_p1`, `${prefix}_p2`, `${prefix}_p3`]);
    assert.equal(page.leadKey, `${prefix}_lead`);
  }
  for (const lang of LANGS) {
    check(lang, 'seo_landing_badge', LANDING_SHARED.badge[lang]);
    check(lang, 'seo_landing_cta', LANDING_SHARED.cta[lang]);
    check(lang, 'seo_landing_more_title', LANDING_SHARED.more_title[lang]);
    check(lang, 'seo_landing_back_title', LANDING_SHARED.back_title[lang]);
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('SEO-03: copy resolution falls back to Azerbaijani and keeps keys for the client', () => {
  const page = SEO_LANDING_PAGES[0];
  const en = landingCopy(page, 'en');
  assert.equal(en.title, page.copy.title.en);
  assert.equal(en.points.length, 3);
  assert.deepEqual(en.pointKeys, page.pointKeys);
  assert.equal(landingCopy(page, 'de').title, page.copy.title.az, 'unknown language falls back to az');
  assert.equal(landingCopy(page, null).lead, page.copy.lead.az);
  assert.equal(landingCopy(null, 'en'), null);
  assert.equal(landingShared('tr').badge, LANDING_SHARED.badge.tr);
});

test('SEO-04: indexable paths cover the hub and every slug', () => {
  const paths = landingPagePaths();
  assert.deepEqual(paths, [LANDING_INDEX_PATH, ...SEO_LANDING_PAGES.map((page) => `/l/${page.slug}`)]);
  // Two segments everywhere: the cluster must not eat a one-character short code.
  for (const p of paths) assert.match(p, /^\/l\/[a-z0-9-]+$/);
  const system = fs.readFileSync(path.join(ROOT, 'src/routes/api/system.js'), 'utf8');
  assert.match(system, /\.\.\.landingPagePaths\(\),/);
  assert.match(system, /require\('\.\.\/\.\.\/lib\/seo-pages'\)/);
});

test('SEO-05: static robots.txt and sitemap.xml advertise exactly the rendered slugs', () => {
  const robots = fs.readFileSync(path.join(ROOT, 'public/robots.txt'), 'utf8');
  const sitemap = fs.readFileSync(path.join(ROOT, 'public/sitemap.xml'), 'utf8');
  for (const p of landingPagePaths()) {
    assert.ok(robots.includes(`Allow: ${p}\n`), `robots.txt has no Allow for ${p}`);
    assert.ok(sitemap.includes(`<loc>https://ovlink.sbs${p}</loc>`), `sitemap.xml has no ${p}`);
  }
  // No sitemap entry may point at a slug the allowlist refuses.
  const locs = (sitemap.match(/<loc>https:\/\/ovlink\.sbs(\/l[^<]*)<\/loc>/g) || [])
    .map((tag) => tag.replace(/.*ovlink\.sbs/, '').replace(/<\/loc>/, ''));
  const allowed = new Set(landingPagePaths());
  assert.deepEqual(locs.filter((p) => !allowed.has(p)), []);
});

test('SEO-06: the landing router only renders allowlisted slugs', () => {
  const route = fs.readFileSync(path.join(ROOT, 'src/routes/seo-landing.js'), 'utf8');
  assert.match(route, /router\.get\('\/l\/:slug'/);
  assert.match(route, /if \(!page\) return next\(\);/);
  assert.match(route, /if \(!SLUG_RE\.test\(raw\)\) return next\(\);/);
  // Mounted before ./public so /:short stays untouched, and never after redirect.js.
  const index = fs.readFileSync(path.join(ROOT, 'src/routes/index.js'), 'utf8');
  const mountOrder = ['seo-landing', 'public', 'redirect'].map((name) => index.indexOf(`./${name}`));
  assert.ok(mountOrder.every((i) => i >= 0), 'mount lines missing');
  assert.deepEqual([...mountOrder].sort((a, b) => a - b), mountOrder, 'wrong mount order');
});

test('SEO-07: changelog data is dated, slugged and XML-escaped', () => {
  assert.ok(CHANGELOG.length >= 5);
  const slugs = CHANGELOG.map((entry) => entry.slug);
  assert.equal(new Set(slugs).size, slugs.length, 'duplicate changelog slug');
  for (const entry of CHANGELOG) {
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(entry.title.length > 3 && entry.summary.length > 10);
  }
  assert.equal(escapeXml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
});

test('SEO-08: RSS is well formed, self-referencing and free of raw markup', () => {
  const xml = buildRssFeed({ siteUrl: 'https://ovlink.sbs/', siteName: 'Ovlink changelog', description: 'D' });
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<rss version="2\.0"/);
  assert.ok(xml.trimEnd().endsWith('</rss>'));
  // Trailing slash must be normalised, otherwise <loc> values double up.
  assert.ok(xml.includes('<link>https://ovlink.sbs</link>'));
  assert.ok(xml.includes('href="https://ovlink.sbs/updates.xml"'));
  assert.equal((xml.match(/<item>/g) || []).length, CHANGELOG.length);
  assert.equal((xml.match(/<guid isPermaLink="false">/g) || []).length, CHANGELOG.length);
  assert.ok(!/&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(xml), 'raw ampersand in the feed');
  assert.match(xml, /<lastBuildDate>[A-Z][a-z]{2}, /);
});

// ─── HTTP surface (needs the same environment as the rest of the suite) ───

let server = null;
let baseUrl = '';
let dbAvailable = false;

test.beforeEach(async () => {
  const { app, helpers } = require('../server');
  try {
    await helpers.dbGetAsync('SELECT 1');
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
  if (!dbAvailable || server) return;
  server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('SEO-09: /l/<slug> renders, unknown slugs do not create a page', async (t) => {
  if (!dbAvailable) return t.skip('database unavailable');
  const page = SEO_LANDING_PAGES[1];
  const headers = { 'accept-language': 'en' };
  const res = await fetch(`${baseUrl}/l/${page.slug}`, { headers });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes(`<title>${page.copy.title.en}</title>`), 'title is not the manifest copy');
  assert.ok(html.includes(page.copy.lead.en), 'lead copy missing from the rendered page');
  assert.ok(html.includes(page.copy.points[0].en), 'first point missing from the rendered page');
  assert.ok(html.includes('<html lang="en" dir="ltr">'), `lang/dir not rendered: ${html.slice(0, 120)}`);
  assert.ok(html.includes('<meta property="og:image"'), 'no og:image on a landing page');
  assert.ok(html.includes('/og/l-qr-code-generator.svg'), 'og:image does not point at the generated slug');
  assert.ok(html.includes('href="/l/free-link-shortener"'), 'interlinks missing');
  assert.ok(!html.includes(`href="/${page.slug}"`), 'page must not link to itself');
  assert.ok(html.includes('id="mainContent"'), 'no main landmark target');

  // The same page in Azerbaijani must render Azerbaijani copy, not English.
  const az = await fetch(`${baseUrl}/l/${page.slug}`, { headers: { cookie: 'lang_default=az' } });
  assert.equal(az.status, 200);
  const azHtml = await az.text();
  assert.ok(azHtml.includes(page.copy.title.az), 'az cookie did not switch the rendered copy');

  const index = await fetch(`${baseUrl}/l/guides`, { headers });
  assert.equal(index.status, 200);
  const indexHtml = await index.text();
  assert.ok(!indexHtml.includes('href="/l/guides"'), 'the hub must not link to itself');
  for (const other of SEO_LANDING_PAGES) {
    assert.ok(indexHtml.includes(`href="/l/${other.slug}"`), `index does not link ${other.slug}`);
  }

  const missing = await fetch(`${baseUrl}/l/not-in-the-manifest`, { headers });
  assert.equal(missing.status, 404);
  const injection = await fetch(`${baseUrl}/l/%3Cscript%3E`, { headers });
  assert.ok([400, 404].includes(injection.status), 'unsafe slug must not render');
});

test('SEO-10: /og/<slug>.svg is SVG, immutable and revalidatable', async (t) => {
  if (!dbAvailable) return t.skip('database unavailable');
  const res = await fetch(`${baseUrl}/og/l-qr-code-generator.svg`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /image\/svg\+xml/);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const etag = res.headers.get('etag');
  assert.ok(etag, 'no ETag');
  const svg = await res.text();
  assert.match(svg, /^<\?xml version="1\.0"/);
  assert.match(svg, /width="1200" height="630"/);
  assert.ok(svg.includes('Qr Code Generator'), `label not derived from the slug: ${svg.slice(0, 200)}`);

  const again = await fetch(`${baseUrl}/og/l-qr-code-generator.svg`, { headers: { 'if-none-match': etag } });
  assert.equal(again.status, 304);

  const hostile = await fetch(`${baseUrl}/og/%3Cscript%3E.svg`);
  assert.equal(hostile.status, 404);
  const body = await (await fetch(`${baseUrl}/og/home.svg`)).text();
  assert.ok(!/<script/i.test(body), 'svg must not contain a script element');
});

test('SEO-11: /updates.xml serves the feed', async (t) => {
  if (!dbAvailable) return t.skip('database unavailable');
  const res = await fetch(`${baseUrl}/updates.xml`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/rss\+xml/);
  assert.match(res.headers.get('cache-control'), /max-age=86400/);
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, follow');
  const xml = await res.text();
  assert.match(xml, /<rss version="2\.0"/);
  assert.equal((xml.match(/<item>/g) || []).length, CHANGELOG.length);
});
