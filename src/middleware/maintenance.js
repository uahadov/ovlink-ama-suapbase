const { pickLang } = require('../lib/i18n');

// Global mutable settings updated from DB periodically
const siteSettings = {
  maintenance_enabled: '0',
  maintenance_message_az: '',
  maintenance_message_tr: '',
  maintenance_message_en: '',
  abuse_email_alert: '',
};

function maintenanceMiddleware(req, res, next) {
  if (siteSettings.maintenance_enabled !== '1') return next();

  const isAdminSession = !!(req.session && req.session.adminUserId);
  const isAdminRoute = req.path.startsWith('/admin');
  const isAsset = /\.(css|js|png|jpg|jpeg|webp|svg|ico|woff2?|ttf)$/i.test(req.path);

  if (isAdminSession || isAdminRoute || isAsset) return next();

  const allowedPublic = new Set(['/privacy', '/terms', '/contact', '/pricing', '/privacy.html', '/terms.html', '/contact.html', '/pricing.html']);
  if (allowedPublic.has(req.path)) return next();

  const accept = (req.get('accept') || '').toLowerCase();
  const wantsJson = req.path.startsWith('/api/') || req.is('application/json') || (accept.includes('application/json') && !accept.includes('text/html'));

  if (wantsJson) {
    const msg = pickLang(res.locals.defaultLang, 'Xidmət müvəqqəti əlçatmazdır.', 'Hizmet geçici olarak kullanılamıyor.', 'Service temporarily unavailable.');
    return res.status(503).json({ error: msg });
  }

  return res.status(503).render('maintenance', {
    csrfToken: res.locals._csrf,
    maintenanceMessageAz: siteSettings.maintenance_message_az || '',
    maintenanceMessageTr: siteSettings.maintenance_message_tr || '',
    maintenanceMessageEn: siteSettings.maintenance_message_en || ''
  });
}

function attachSiteSettingsMiddleware(req, res, next) {
  res.locals.siteSettings = siteSettings;
  next();
}

module.exports = {
  siteSettings,
  maintenanceMiddleware,
  attachSiteSettingsMiddleware
};
