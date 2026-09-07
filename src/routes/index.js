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
  app.use(require('./public'));
  app.use(require('./dashboard'));
  // SSO is handled within workspaces routes
  app.use(require('./redirect')); // MUST be last — catches /:short
}

module.exports = { mountRoutes };
