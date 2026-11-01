const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { getPublicBaseUrl } = require('../../lib/security');
const { buildRssFeed } = require('../../lib/changelog');
const { landingPagePaths } = require('../../lib/seo-pages');
const { ASSET_VERSION } = require('../../config/index');

const router = express.Router();

const publicDir = path.join(__dirname, '../../..', 'public');
const robotsFile = path.join(publicDir, 'robots.txt');
const sitemapFile = path.join(publicDir, 'sitemap.xml');

const PUBLIC_INDEXABLE_PATHS = Object.freeze([
  '/',
  '/privacy',
  '/terms',
  '/contact',
  '/pricing',
  '/cookie-policy',
  '/about',
  '/how-it-works',
  '/why-ovlink',
  '/faq',
  '/help',
  '/docs',
  '/api-guide',
  '/mcp',
  '/abuse-safety',
  '/updates',
  // Programmatic landing pages come from the allowlisted manifest, so robots and
  // the sitemap can never advertise a slug the router refuses to render.
  ...landingPagePaths(),
]);

/**
 * Label for a generated OG image. The slug is the only input and every
 * character that is not a letter, digit, space or hyphen is dropped, so no
 * request can inject markup into the SVG.
 */
function ogLabelForSlug(rawSlug) {
  const cleaned = (rawSlug || '').toString().toLowerCase().replace(/\.svg$/, '').replace(/\/+$/, '');
  if (!/^[a-z0-9][a-z0-9 -]{0,47}$/.test(cleaned)) return 'Ovlink';
  if (cleaned === 'home' || cleaned === 'l') return 'Ovlink';
  // '/l/<slug>' pages carry the landing namespace as a leading 'l-'; it is not
  // part of the title a reader should see on the image.
  const words = cleaned
    .replace(/^l-(?=\S)/, '')
    .replace(/^-+|-+$/g, '')
    .split(/[- ]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return words.length ? words.join(' ') : 'Ovlink';
}

function escapeSvg(value) {
  return (value || '').toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 1200x630 OG image drawn as SVG by string concatenation - no rasteriser and no
 * new dependency in the request path.
 */
function buildOgSvg(label) {
  const safeLabel = escapeSvg(label);
  const lines = [];
  const width = Math.max(1, Math.floor(safeLabel.length / 24));
  // Simple two-line wrap so long page names do not overflow the canvas.
  if (width <= 1) {
    lines.push(safeLabel);
  } else {
    const words = safeLabel.split(' ');
    let current = '';
    for (const word of words) {
      if ((current + ' ' + word).trim().length > 24) { lines.push(current.trim()); current = word; }
      else { current = `${current} ${word}`.trim(); }
    }
    if (current) lines.push(current);
  }

  const textBlock = lines.slice(0, 3).map((line, index) => (
    `<text x="96" y="${330 + index * 78}" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif" font-size="64" font-weight="700" fill="#ffffff">${line}</text>`
  )).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${safeLabel} - Ovlink">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0a0a0a"/>
      <stop offset="100%" stop-color="#1e293b"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <circle cx="1090" cy="120" r="210" fill="#3b82f6" opacity="0.18"/>
  <circle cx="140" cy="560" r="170" fill="#22c55e" opacity="0.12"/>
  <text x="96" y="150" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif" font-size="34" font-weight="700" letter-spacing="6" fill="#60a5fa">OVLINK</text>
  ${textBlock}
  <text x="96" y="548" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif" font-size="30" fill="#94a3b8">Link shortening, QR codes and click analytics</text>
</svg>`;
}

// Internal ops docs must never be publicly served.
router.use((req, res, next) => {
  const p = (req.path || '').toString().replace(/\/+/g, '/').trim().toLowerCase();
  if (p === '/agents' || p === '/agents.md') {
    return res.status(404).send('Not found');
  }
  return next();
});

// SEO helpers: robots.txt & sitemap.xml
router.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.sendFile(robotsFile, (err) => {
    if (!err) return;
    const base = getPublicBaseUrl(req);
    const lines = [
      'User-agent: *',
      'Disallow: /admin',
      'Disallow: /admin/',
      'Disallow: /login',
      'Disallow: /login.html',
      'Disallow: /register',
      'Disallow: /register.html',
      'Disallow: /dashboard',
      'Disallow: /dashboard.html',
      'Disallow: /stats',
      'Disallow: /stats.html',
      'Disallow: /account',
      'Disallow: /notifications',
      'Disallow: /forgot-password',
      'Disallow: /reset-password',
      ...PUBLIC_INDEXABLE_PATHS.map((pagePath) => `Allow: ${pagePath}`),
      'Sitemap: ' + base + '/sitemap.xml',
    ];
    if (!res.headersSent) res.type('text/plain').send(lines.join('\n'));
  });
});

router.get(['/sitemap.xml', '/sitemap1.xml', '/sitemap_index.xml'], (req, res) => {
  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.sendFile(sitemapFile, (err) => {
    if (!err) return;
    const base = getPublicBaseUrl(req);
    const lastmod = new Date().toISOString().slice(0, 10);
    const urls = PUBLIC_INDEXABLE_PATHS.map((p) => `  <url>\n    <loc>${base}${p}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`).join('\n');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;
    if (!res.headersSent) res.type('application/xml').send(xml);
  });
});

// Changelog feed (A17). Static data, so the response is cacheable for a day.
router.get('/updates.xml', (req, res) => {
  const base = getPublicBaseUrl(req);
  const xml = buildRssFeed({
    siteUrl: base,
    siteName: 'Ovlink changelog',
    description: 'Product updates for Ovlink: link shortening, QR codes and click analytics.',
  });
  res.status(200)
    .type('application/rss+xml; charset=utf-8')
    .set('Cache-Control', 'public, max-age=86400')
    .set('X-Robots-Tag', 'noindex, follow')
    .send(xml);
});

// Generated Open Graph image (A17). SVG only: no rasteriser may enter the
// request path. Immutable content keyed by slug + app version.
router.get('/og/:slug', (req, res) => {
  const raw = (req.params.slug || '').toString();
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(raw)) {
    return res.status(404).type('text/plain').send('Not found');
  }
  const slugKey = raw.replace(/\.svg$/i, '').toLowerCase();
  const label = ogLabelForSlug(slugKey);
  const etag = '"' + crypto.createHash('sha1').update(`${slugKey}|${label}|${ASSET_VERSION}`).digest('hex') + '"';

  res.set('ETag', etag);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  if (req.headers['if-none-match'] === etag) return res.status(304).end();

  return res.status(200).type('image/svg+xml').send(buildOgSvg(label));
});

module.exports = router;
