const serverless = require('serverless-http');

// server.js is the PM2 entry point: it owns migrations, schedulers, bots and the
// test-only helper export surface. The serverless function must not pull that
// whole graph into a cold start, so it requires the Express app directly.
// src/app.js exports { app } (see src/app.js).
const { app } = require('../../src/app');

// Serverless capability limits (see DEPLOYMENT_HARDENING.md):
// - no background schedulers / setInterval workers (they live in server.js)
// - no marketing or chat bots
// - no writable filesystem assumptions (public/ and bot_data/ are read-only)
// - sessions must use Redis or the Postgres store; probes hit /health, which is
//   mounted before the session middleware.
exports.handler = serverless(app, {
  binary: [
    'image/png',
    'image/webp',
    'image/x-icon',
    'image/vnd.microsoft.icon',
    'image/jpeg',
    'image/svg+xml',
    'application/octet-stream',
    'font/woff',
    'font/woff2',
    'font/ttf',
    'application/font-woff',
    'application/font-woff2',
  ],
});
