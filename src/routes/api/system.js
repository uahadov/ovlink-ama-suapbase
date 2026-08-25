const express = require('express');
const path = require('path');
const { getPublicBaseUrl } = require('../../config/index');

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
  '/abuse-safety',
  '/updates',
]);

// Internal ops docs must never be publicly served.
router.use((req, res, next) => {
  const p = (req.path || '').toString().trim().toLowerCase();
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

router.get('/sitemap.xml', (req, res) => {
  res.type('application/xml');
  res.sendFile(sitemapFile, (err) => {
    if (!err) return;
    const base = getPublicBaseUrl(req);
    const lastmod = new Date().toISOString().slice(0, 10);
    const urls = PUBLIC_INDEXABLE_PATHS.map((p) => `  <url>\n    <loc>${base}${p}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`).join('\n');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;
    if (!res.headersSent) res.type('application/xml').send(xml);
  });
});

module.exports = router;
