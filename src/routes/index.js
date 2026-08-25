function mountRoutes(app) {
  // Order matters! Static/system first, then specific, then catch-all redirect last
  app.use(require('./ads'));
  app.use(require('./api'));
  app.use(require('./bots'));
  app.use(require('./consent'));
  app.use(require('./public'));
  app.use(require('./dashboard'));
  // SSO is handled within workspaces routes
  app.use(require('./redirect')); // MUST be last — catches /:short
}

module.exports = { mountRoutes };
