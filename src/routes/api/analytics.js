const express = require('express');
const router = express.Router();
const { db } = require('../../db/index');
const { normalizeShortCode } = require('../../lib/url-helpers');

const REDIRECT_CONSENT_MARKER = '__ESSENTIAL__';
const WORKSPACE_SCOPED_LINK_OWNERSHIP_SQL = '(user_id = ? OR workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ?))';

function getEssentialAnalyticsValue(raw) {
  const v = (raw || '').toString().trim();
  if (!v) return 'Unknown';
  return v;
}

function handleStatsApiRequest(req, res, rawShort) {
  if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Giriş gerekli.' });
  const requestedShort = Array.isArray(rawShort) ? rawShort[0] : rawShort;
  const short = normalizeShortCode(requestedShort);
  if (!short) return res.status(400).json({ error: 'Geçersiz kısa kod.' });

  db.get(`SELECT * FROM urls WHERE short = ? AND ${WORKSPACE_SCOPED_LINK_OWNERSHIP_SQL}`, [short, req.session.userId, req.session.userId], (err, url) => {
    if (err || !url) return res.status(404).json({ error: 'Link bulunamadı veya yetkiniz yok.' });

    db.all('SELECT * FROM clicks WHERE url_id = ?', [url.id], (err, clicks) => {
      if (err) return res.status(500).json({ error: 'Veri alınamadı.' });

      const stats = {
        total_clicks: (clicks || []).length,
        browsers: {},
        os: {},
        countries: {},
        clicks_over_time: {}
      };

      (clicks || []).forEach(click => {
        const browserKey = click.browser === REDIRECT_CONSENT_MARKER ? REDIRECT_CONSENT_MARKER : getEssentialAnalyticsValue(click.browser);
        const osKey = click.os === REDIRECT_CONSENT_MARKER ? REDIRECT_CONSENT_MARKER : getEssentialAnalyticsValue(click.os);
        const countryKey = click.country === REDIRECT_CONSENT_MARKER ? REDIRECT_CONSENT_MARKER : getEssentialAnalyticsValue(click.country);

        // Browser
        stats.browsers[browserKey] = (stats.browsers[browserKey] || 0) + 1;
        // OS
        stats.os[osKey] = (stats.os[osKey] || 0) + 1;
        // Country
        stats.countries[countryKey] = (stats.countries[countryKey] || 0) + 1;
        // Time (hour bucket, UTC key)
        const clickDate = new Date(click.click_time);
        if (Number.isFinite(clickDate.getTime())) {
          const hourBucketMs = Math.floor(clickDate.getTime() / 3600000) * 3600000;
          const bucketKey = new Date(hourBucketMs).toISOString();
          stats.clicks_over_time[bucketKey] = (stats.clicks_over_time[bucketKey] || 0) + 1;
        }
      });

      // Sort Time Stats chronologically
      const sortedKeys = Object.keys(stats.clicks_over_time)
        .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());

      const clicks_by_day = sortedKeys.map(k => ({
        date: k,
        count: stats.clicks_over_time[k]
      }));

      res.json({
        ...stats,
        short: url.short,
        original: url.original,
        created_at: url.created_at,
        clicks_total: stats.total_clicks,
        clicks_by_day: clicks_by_day
      });
    });
  });
}

// İstatistik API (GET /api/stats/:short)
router.get('/api/stats/:short', (req, res) => {
  return handleStatsApiRequest(req, res, req.params.short);
});

// Legacy uyumluluk: GET /api/stats?short=...
router.get('/api/stats', (req, res) => {
  return handleStatsApiRequest(req, res, req.query.short);
});

// İstatistik Sayfası (GET /stats-page/:short)
router.get('/stats-page/:short', (req, res) => {
  if (!req.session || !req.session.userId) return res.redirect('/login');
  const short = normalizeShortCode(req.params.short);
  if (!short) return res.status(404).send('Link bulunamadı.');

  // Güvenlik: Sadece link sahibi veya aynı workspace üyesi görebilir
  db.get(
    `SELECT user_id, workspace_id FROM urls WHERE short = ? AND ${WORKSPACE_SCOPED_LINK_OWNERSHIP_SQL}`,
    [short, req.session.userId, req.session.userId],
    (err, row) => {
      if (err || !row) return res.status(404).send('Link bulunamadı.');
      if (row.user_id !== req.session.userId && !row.workspace_id) {
        return res.status(403).render('error-unauthorized', {
          csrfToken: res.locals._csrf,
          shortCode: short
        });
      }

      res.render('stats-page', {
        csrfToken: res.locals._csrf,
        shortCode: short,
        consentMarker: REDIRECT_CONSENT_MARKER
      });
    }
  );
});

module.exports = router;
