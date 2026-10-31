const { db } = require('../db/index');
const createAdminRouter = require('../../routes/admin');
const { createRateLimitStore } = require('../config/redis');
const { getRequestIp, getRequestGeoMeta } = require('../lib/geo');
const { blockIp, unblockIp, getBlockedIps } = require('../middleware/ip-blacklist');

function mountRoutes(app) {
  // Order matters! Static/system first, then specific, then catch-all redirect last
  app.use(require('./ads'));
  app.use(require('./api'));
  app.use('/admin', createAdminRouter(db, {
    createRateLimitStore,
    getRequestIp,
    getRequestGeoMeta,
    blockIp,
    unblockIp,
    getBlockedIps,
  }));
  app.use(require('./bots'));
  app.use(require('./consent'));
  app.use(require('./tools'));
  // Scanned QR codes: two segments, so it cannot shadow the /:short catch-all.
  app.use(require('./qr-scan'));
  // SEO landing cluster: /l and /l/<slug> are allowlisted, so /:short is unaffected.
  app.use(require('./seo-landing'));
  app.use(require('./public'));
  app.use(require('./dashboard'));
  // SSO is handled within workspaces routes
  app.use(require('./redirect')); // MUST be last — catches /:short
}

module.exports = { mountRoutes };
