const express = require('express');
const compression = require('compression');
const path = require('path');
const expressSession = require('express-session');

// Utilities and configs
const { isProdRuntime } = require('./config/index');
const { getRequestGeoMeta, parseAcceptLang } = require('./lib/geo');
const { sendOpsAlert } = require('./lib/alerts');
const { getPublicBaseUrl, hasApiKeyAuthHeader } = require('./lib/security');

// Middleware imports
const langMiddleware = require('./middleware/lang');
const { httpsRedirectMiddleware, canonicalHostMiddleware } = require('./middleware/canonical');
const nonceMiddleware = require('./middleware/nonce');
const helmetMiddleware = require('./middleware/helmet');
const { ipBlacklistMiddleware, slowdownMiddleware } = require('./middleware/ip-blacklist');
const { generalLimiter, mutationLimiter } = require('./middleware/rate-limiter');
const { sessionStore } = require('./config/redis');
const { csrfMiddleware } = require('./middleware/csrf');
const { jsonParser, urlencodedParser } = require('./middleware/body-parser');
const { maintenanceMiddleware, attachSiteSettingsMiddleware } = require('./middleware/maintenance');
const { adsGuardMiddleware, adSandboxMiddleware } = require('./middleware/ads-guard');
const { noindexMiddleware } = require('./middleware/noindex');
const { mountRoutes } = require('./routes/index');

const app = express();

app.set('query parser', 'simple');

let trustProxyHops = Number.parseInt((process.env.TRUST_PROXY_HOPS || '').toString(), 10);
if (isProdRuntime && (!Number.isInteger(trustProxyHops) || trustProxyHops <= 0)) {
  console.warn('[startup] TRUST_PROXY_HOPS not set; defaulting to 1 for production.');
  trustProxyHops = 1;
}
const useTrustProxy = Number.isInteger(trustProxyHops) && trustProxyHops > 0;
app.set('trust proxy', useTrustProxy ? trustProxyHops : false);

const publicDir = path.join(__dirname, '..', 'public');
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

// Apply ALL middleware in EXACT SAME order as server.js
app.use(compression());
app.use(langMiddleware);
app.use(httpsRedirectMiddleware);
app.use(canonicalHostMiddleware);
app.use(nonceMiddleware);
app.use(helmetMiddleware);

// Permissions-Policy header
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Expect-CT', isProdRuntime ? 'max-age=86400, enforce' : 'max-age=0');
  next();
});

// Explicit Admin Static Assets
app.get('/admin/admin.css', (req, res) => {
  res.setHeader('Content-Type', 'text/css');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  return res.sendFile(path.join(publicDir, 'admin', 'admin.css'));
});
app.get('/admin/admin.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  return res.sendFile(path.join(publicDir, 'admin', 'admin.js'));
});

// express.static
app.use(express.static(publicDir, {
  maxAge: isProdRuntime ? '7d' : 0,
  etag: true,
  redirect: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Service-Worker-Allowed', '/');
    } else if (filePath.endsWith('.css') || filePath.endsWith('.js')) {
      res.setHeader('Cache-Control', isProdRuntime ? 'public, max-age=604800, stale-while-revalidate=86400' : 'no-cache');
    }
  }
}));

// Rate Limiters & Security (early)
app.use(ipBlacklistMiddleware);
app.use(slowdownMiddleware);

app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/admin')) {
    return generalLimiter(req, res, next);
  }
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method) && !req.path.startsWith('/admin')) {
    return mutationLimiter(req, res, next);
  }
  return next();
});

// Body parser
app.use(jsonParser);
app.use(urlencodedParser);

// Session & CSRF
const forceSecureCookie = ['1', 'true', 'yes', 'on'].includes(
  (process.env.FORCE_SECURE_COOKIE || '').toString().trim().toLowerCase()
);
const sessionCookieSecure = forceSecureCookie ? true : 'auto';
const sessionOptions = {
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  proxy: useTrustProxy,
  cookie: {
    httpOnly: true,
    secure: sessionCookieSecure,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
};
sessionOptions.store = sessionStore;
app.use(expressSession(sessionOptions));

// Patch req.session.regenerate
app.use((req, res, next) => {
  if (req.session && req.session.regenerate) {
    const orig = req.session.regenerate.bind(req.session);
    req.session.regenerate = function(cb) {
      orig(function(err) {
        if (err) return cb(err);
        const hostHeader = (req.get('host') || '').toLowerCase();
        const isLocalhost = hostHeader.includes('localhost') || hostHeader.includes('127.0.0.1') || hostHeader.includes('[::1]');
        const forceSecureCookie = ['1', 'true', 'yes', 'on'].includes((process.env.FORCE_SECURE_COOKIE || '').toString().trim().toLowerCase());
        if (isLocalhost) {
          req.session.cookie.secure = false;
        } else {
          req.session.cookie.secure = forceSecureCookie || req.secure || isProdRuntime;
        }
        cb();
      });
    };
  }
  next();
});

// Dynamic cookie secure flag override for local testing
app.use((req, res, next) => {
  if (req.session && req.session.cookie) {
    const hostHeader = (req.get('host') || '').toLowerCase();
    const isLocalhost = hostHeader.includes('localhost') || hostHeader.includes('127.0.0.1') || hostHeader.includes('[::1]');
    const forceSecureCookie = ['1', 'true', 'yes', 'on'].includes((process.env.FORCE_SECURE_COOKIE || '').toString().trim().toLowerCase());
    if (isLocalhost) {
      req.session.cookie.secure = false;
    } else {
      req.session.cookie.secure = forceSecureCookie || req.secure || isProdRuntime;
    }
  }
  next();
});

function requiresInlineCsrfRoute(pathname) {
  const path = (pathname || '').toString();
  return path.startsWith('/admin')
    || path === '/login'
    || path === '/register'
    || path === '/forgot-password'
    || path === '/reset-password'
    || path.startsWith('/proceed/')
    || path.startsWith('/consent/redirect/');
}

function isServerWebhookRoute(pathname) {
  const path = (pathname || '').toString();
  return path === '/api/bots/telegram/webhook' ||
         path === '/api/bots/discord/interactions' ||
         path === '/api/polar/webhook';
}

function isSamlAcsRoute(pathname) {
  return /^\/sso\/\d+\/acs$/.test((pathname || '').toString());
}

app.use((req, res, next) => {
  const isStaticLike = /\.(css|js|png|jpg|jpeg|webp|svg|ico|woff2?|ttf|map|txt|xml|webmanifest)$/i.test(req.path);
  const skipStaticPath = req.path === '/robots.txt' || req.path === '/sitemap.xml' || req.path === '/favicon.ico';
  if (req.method === 'GET' && (isStaticLike || skipStaticPath)) return next();
  if (req.path.startsWith('/consent/redirect/')) return next();
  if (req.method === 'POST' && isServerWebhookRoute(req.path)) return next();
  if (req.method === 'POST' && isSamlAcsRoute(req.path)) return next();
  const hasApiKeyHeader = hasApiKeyAuthHeader(req);
  if (req.path.startsWith('/api/') && hasApiKeyHeader) return next();
  return csrfMiddleware(req, res, next);
});

app.use(maintenanceMiddleware);
app.use(attachSiteSettingsMiddleware);
app.use(adsGuardMiddleware);
app.use(adSandboxMiddleware);
app.use(noindexMiddleware);

app.use((req, res, next) => {
  const p = (req.path || '').toString().trim().toLowerCase();
  if (p === '/agents' || p === '/agents.md') {
    return res.status(404).send('Not found');
  }
  return next();
});

// Mount Routes
mountRoutes(app);

// Global Error Handler
app.use((err, req, res, next) => {
  if (!err) return next();
  if (res.headersSent) return next(err);
  console.error('[error-handler]', err && (err.stack || err.message || err));
  const isApi = req.path.startsWith('/api/');
  const accept = (req.get('accept') || '').toLowerCase();
  const wantsJson =
    isApi ||
    req.is('application/json') ||
    (accept.includes('application/json') && !accept.includes('text/html'));

  const isCsrf = err && (err.code === 'EBADCSRFTOKEN' || /csrf/i.test(err.message || ''));
  if (isCsrf) {
    if (wantsJson && (req.path === '/api/auth/login' || req.path === '/api/login')) {
      return res.status(401).json({ error: 'Email or password is incorrect.' });
    }
    const msg = 'Session refreshed. Please try again.';
    const referer = (req.get('referer') || '').toString();
    let target = req.path.startsWith('/admin') ? '/admin/login' : '/';

    if (referer) {
      try {
        const base = getPublicBaseUrl(req);
        const refUrl = new URL(referer, base);
        const baseUrl = new URL(base);
        if (refUrl.origin === baseUrl.origin && !refUrl.pathname.startsWith('/api/')) {
          target = refUrl.pathname + (refUrl.search || '');
        }
      } catch {}
    }

    let redirectTo = target;
    try {
      const base = getPublicBaseUrl(req);
      const targetUrl = new URL(target, base);
      targetUrl.searchParams.delete('msg');
      targetUrl.searchParams.set('msg', msg);
      const search = targetUrl.searchParams.toString();
      redirectTo = targetUrl.pathname + (search ? `?${search}` : '');
    } catch {
      const sep = target.includes('?') ? '&' : '?';
      redirectTo = `${target}${sep}msg=${encodeURIComponent(msg)}`;
    }

    if (wantsJson) {
      const jsonMsg = `${msg} (csrf)`;
      return res.status(403).json({ error: jsonMsg, redirect: redirectTo });
    }
    return res.redirect(303, redirectTo);
  }

  const isJsonParseError = err && (
    err.type === 'entity.parse.failed' ||
    (err instanceof SyntaxError && /json/i.test((err.message || '').toString()))
  );
  if (isJsonParseError && wantsJson) {
    return res.status(400).json({
      error: 'Invalid JSON body. Send valid JSON with Content-Type: application/json.',
    });
  }

  const status = (err.status || 500);
  const message = status >= 500
    ? 'Server error.'
    : (status === 404 ? 'Not found.' : 'Request could not be processed.');

  if (status >= 500) {
    sendOpsAlert('http_5xx:' + req.path, 'HTTP 5xx', `${req.method} ${req.originalUrl}\n${(err && (err.message || err.toString()) || '').toString().slice(0, 500)}`);
  }

  if (wantsJson) {
    return res.status(status).json({ error: message });
  }
  return res.status(status).send(message);
});

module.exports = { app };



