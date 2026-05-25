const express = require('express');
const pg = require('pg');
const path = require('path');
const net = require('net');
const dnsNative = require('dns');
const dns = dnsNative.promises;
const session = require('express-session');
const { RedisStore: SessionRedisStore } = require('connect-redis');
const { Resend } = require('resend');
const QRCode = require('qrcode');
const shortid = require('shortid');
const bcrypt = require('bcrypt');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { RedisStore: RateLimitRedisStore } = require('rate-limit-redis');
const { createClient } = require('redis');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const tsscmp = require('tsscmp');
const lusca = require('lusca');
const { body, validationResult } = require('express-validator');
require('dotenv').config();
const isProdRuntime = process.env.NODE_ENV === 'production';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || process.env.SUPABASE_DB_URL,
  ssl: (process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '').includes('localhost') ? false : {
    rejectUnauthorized: false
  }
});

const db = {
  convertSql(sql) {
    if (typeof sql !== 'string') return sql;
    let index = 1;
    let converted = sql.replace(/\?/g, () => `$${index++}`);
    converted = converted.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY');
    
    converted = converted.replace(/datetime\('now'\)/gi, 'CURRENT_TIMESTAMP');
    converted = converted.replace(/datetime\(([^)]+)\)/gi, '$1::timestamp');
    
    converted = converted.replace(/ALTER TABLE (\w+) ADD COLUMN (\w+)/gi, 'ALTER TABLE $1 ADD COLUMN IF NOT EXISTS $2');
    
    if (converted.toUpperCase().includes('PRAGMA TABLE_INFO')) {
      const tableNameMatch = converted.match(/PRAGMA table_info\((\w+)\)/i);
      if (tableNameMatch) {
        const tableName = tableNameMatch[1];
        converted = `SELECT column_name AS name FROM information_schema.columns WHERE table_name = '${tableName}'`;
      }
    }
    
    if (converted.toUpperCase().includes('INSERT OR IGNORE')) {
      if (converted.toLowerCase().includes('site_settings')) {
        converted = converted.replace(/INSERT OR IGNORE INTO site_settings/gi, 'INSERT INTO site_settings')
                              .concat(' ON CONFLICT (key) DO NOTHING');
      } else if (converted.toLowerCase().includes('notifications')) {
        converted = converted.replace(/INSERT OR IGNORE INTO notifications/gi, 'INSERT INTO notifications')
                              .concat(' ON CONFLICT (event_key) DO NOTHING');
      } else if (converted.toLowerCase().includes('blocked_domains')) {
        converted = converted.replace(/INSERT OR IGNORE INTO blocked_domains/gi, 'INSERT INTO blocked_domains')
                              .concat(' ON CONFLICT (domain) DO NOTHING');
      } else {
        converted = converted.replace(/INSERT OR IGNORE INTO/gi, 'INSERT INTO');
      }
    }
    
    return converted;
  },

  _queue: [],
  _isSerializing: false,
  
  _processQueue() {
    if (this._queue.length === 0) {
      this._isSerializing = false;
      return;
    }
    const task = this._queue.shift();
    const pgSql = this.convertSql(task.sql);
    
    // Catch-all query execution
    pool.query(pgSql, task.params, (err, res) => {
      if (err) {
        console.error('[db error]', err.message, 'SQL:', task.sql);
        if (task.callback) task.callback(err);
      } else {
        if (task.type === 'get') {
          if (task.callback) task.callback(null, res.rows[0]);
        } else if (task.type === 'all') {
          if (task.callback) task.callback(null, res.rows);
        } else if (task.type === 'run') {
          const context = {
            lastID: res && res.rows && res.rows[0] ? res.rows[0].id : null,
            changes: res ? res.rowCount : 0
          };
          if (task.callback) task.callback.call(context, null);
        }
      }
      // Process next query
      this._processQueue();
    });
  },

  get(sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    if (this._isSerializing) {
      this._queue.push({ type: 'get', sql, params, callback });
    } else {
      const pgSql = this.convertSql(sql);
      pool.query(pgSql, params, (err, res) => {
        if (err) return callback ? callback(err) : null;
        if (callback) callback(null, res.rows[0]);
      });
    }
  },

  all(sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    if (this._isSerializing) {
      this._queue.push({ type: 'all', sql, params, callback });
    } else {
      const pgSql = this.convertSql(sql);
      pool.query(pgSql, params, (err, res) => {
        if (err) return callback ? callback(err) : null;
        if (callback) callback(null, res.rows);
      });
    }
  },

  run(sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    if (this._isSerializing) {
      this._queue.push({ type: 'run', sql, params, callback });
    } else {
      const pgSql = this.convertSql(sql);
      pool.query(pgSql, params, function(err, res) {
        if (err) return callback ? callback(err) : null;
        const context = {
          lastID: res && res.rows && res.rows[0] ? res.rows[0].id : null,
          changes: res ? res.rowCount : 0
        };
        if (callback) {
          callback.call(context, null);
        }
      });
    }
  },

  serialize(callback) {
    this._isSerializing = true;
    callback();
    this._processQueue();
  }
};


function isEnabledEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return !!fallback;
  return ['1', 'true', 'yes', 'on'].includes((raw + '').trim().toLowerCase());
}

function estimateSecretBytes(rawSecret) {
  const raw = (rawSecret || '').toString().trim();
  if (!raw) return 0;

  let best = Buffer.byteLength(raw, 'utf8');
  const compact = raw.replace(/\s+/g, '');

  if (/^[A-Fa-f0-9]+$/.test(compact) && compact.length % 2 === 0) {
    best = Math.max(best, compact.length / 2);
  }

  if (/^[A-Za-z0-9+/_=-]+$/.test(compact)) {
    const normalizedB64 = compact.replace(/-/g, '+').replace(/_/g, '/');
    const padLen = normalizedB64.length % 4 === 0 ? 0 : (4 - (normalizedB64.length % 4));
    const padded = normalizedB64 + '='.repeat(padLen);
    try {
      const decoded = Buffer.from(padded, 'base64');
      if (decoded && decoded.length > 0) {
        best = Math.max(best, decoded.length);
      }
    } catch {
      // ignore decode failures
    }
  }

  return best;
}

if (!process.env.SESSION_SECRET) {
  console.error('[startup] SESSION_SECRET is required');
  process.exit(1);
}

const sessionSecretEstimatedBytes = estimateSecretBytes(process.env.SESSION_SECRET);
if (sessionSecretEstimatedBytes < 64) {
  console.error('[startup] SESSION_SECRET must be at least 64 random bytes (or equivalent encoded length).');
  process.exit(1);
}

function decodeOptionalKeyMaterial(rawValue) {
  const raw = (rawValue || '').toString().trim();
  if (!raw) return null;

  const compact = raw.replace(/\s+/g, '');
  if (/^[A-Fa-f0-9]+$/.test(compact) && compact.length % 2 === 0) {
    try {
      const out = Buffer.from(compact, 'hex');
      if (out.length) return out;
    } catch {}
  }

  if (/^[A-Za-z0-9+/_=-]+$/.test(compact)) {
    try {
      const normalized = compact.replace(/-/g, '+').replace(/_/g, '/');
      const padLen = normalized.length % 4 === 0 ? 0 : (4 - (normalized.length % 4));
      const out = Buffer.from(normalized + '='.repeat(padLen), 'base64');
      if (out.length) return out;
    } catch {}
  }

  return Buffer.from(raw, 'utf8');
}

function resolveSecurityKeyMaterial(envName, label, options = {}) {
  const minBytes = Number.isInteger(options.minBytes) && options.minBytes > 0 ? options.minBytes : 32;
  const allowFallbackInProduction = options.allowFallbackInProduction === true;
  const explicit = decodeOptionalKeyMaterial(process.env[envName]);
  if (explicit && explicit.length) {
    if (explicit.length < minBytes) {
      const msg = `[startup] ${envName} must be at least ${minBytes} random bytes (or equivalent encoded length).`;
      if (isProdRuntime) {
        console.error(msg);
        process.exit(1);
      }
      console.warn(msg);
    }
    return explicit;
  }
  if (isProdRuntime && !allowFallbackInProduction) {
    console.error(`[startup] ${envName} is required in production and must be at least ${minBytes} random bytes.`);
    process.exit(1);
  }
  console.warn(`[startup] ${envName} missing; using SESSION_SECRET-derived fallback key.`);
  return crypto.createHmac('sha256', process.env.SESSION_SECRET).update(label).digest();
}

const API_KEY_HASH_KEY_MATERIAL = resolveSecurityKeyMaterial('API_KEY_HASH_SECRET', 'ovlink:api-key-hash:v2', {
  minBytes: 64,
  allowFallbackInProduction: false,
});
const ASSET_VERSION = (process.env.ASSET_VERSION || process.env.RENDER_GIT_COMMIT || '').toString().trim() || '20260321-1';
const WEBHOOK_HASH_KEY_MATERIAL = resolveSecurityKeyMaterial('WEBHOOK_HASH_SECRET', 'ovlink:webhook-secret-hash:v2', {
  minBytes: 64,
  allowFallbackInProduction: false,
});

const redisUrl = (process.env.REDIS_URL || '').toString().trim();
const requireRedisInProd = isEnabledEnv('REQUIRE_REDIS_IN_PROD', true);
let redisClient = null;

if (redisUrl) {
  redisClient = createClient({
    url: redisUrl,
    socket: {
      reconnectStrategy: (retries) => Math.min(retries * 50, 2000),
    },
  });
  redisClient.on('error', (err) => {
    console.error('[redis] client error', err && (err.message || err));
  });
} else {
  // Redis not configured - using PostgreSQL session store as fallback (Vercel/Supabase deployment)
  console.log('[startup] REDIS_URL not set; using PostgreSQL session store (connect-pg-simple).');
}

const pgSession = require('connect-pg-simple')(session);

const sessionStore = redisClient
  ? new SessionRedisStore({
    client: redisClient,
    prefix: 'ovlink:sess:',
  })
  : new pgSession({
    pool: pool,
    tableName: 'express_sessions',
    createTableIfMissing: true,
  });

function createRateLimitStore(scope) {
  if (!redisClient) return undefined;
  const safeScope = (scope || 'default').toString().trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) || 'default';
  return new RateLimitRedisStore({
    sendCommand: (...args) => redisClient.sendCommand(args),
    prefix: `ovlink:rl:${safeScope}:`,
  });
}

async function ensureRedisConnected() {
  if (!redisClient) return;
  if (redisClient.isOpen) return;
  try {
    await redisClient.connect();
    console.log('[startup] Redis connected.');
  } catch (err) {
    console.error('[startup] Redis connection failed.', err && (err.message || err));
    if (isProdRuntime) process.exit(1);
  }
}


const geoip = require('geoip-lite');

let googleOidc = {
  client: null,
  generators: null,
  ready: false,
  redirectUri: null
};
let googleOidcInitPromise = null;
let googleOidcInitError = null;
const GOOGLE_ISSUER_URL = 'https://accounts.google.com';
const GOOGLE_ISSUER_FALLBACK_METADATA = Object.freeze({
  issuer: GOOGLE_ISSUER_URL,
  authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_endpoint: 'https://oauth2.googleapis.com/token',
  userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
  jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
});

function buildGoogleIssuerFallback(Issuer) {
  return new Issuer(GOOGLE_ISSUER_FALLBACK_METADATA);
}

async function discoverGoogleIssuerWithFallback(Issuer) {
  try {
    return await Issuer.discover(GOOGLE_ISSUER_URL);
  } catch (discoverErr) {
    console.warn('[google-auth] discovery failed; using static issuer metadata fallback');
    return buildGoogleIssuerFallback(Issuer);
  }
}

function getGoogleBaseUrl() {
  return (process.env.PUBLIC_BASE_URL || process.env.BASE_URL || '').toString().trim();
}

function getGoogleRedirectUri(req) {
  const configured = (process.env.GOOGLE_REDIRECT_URI || '').toString().trim();
  if (configured) return configured;

  const base = getGoogleBaseUrl();
  if (base) {
    try {
      return new URL('/auth/google/callback', base).toString();
    } catch {}
  }

  if (req) {
    return buildAbsoluteUrl(req, '/auth/google/callback');
  }

  return googleOidc.redirectUri || '';
}

async function initGoogleOidc(options = {}) {
  const force = options && options.force === true;
  const req = options && options.req ? options.req : null;

  if (!force && googleOidc.ready && googleOidc.client && googleOidc.generators) return true;
  if (!force && googleOidcInitPromise) return googleOidcInitPromise;

  googleOidcInitPromise = (async () => {
    try {
      if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
        googleOidc.ready = false;
        googleOidc.client = null;
        googleOidc.generators = null;
        googleOidcInitError = 'missing_client_credentials';
        return false;
      }

      const redirectUri = getGoogleRedirectUri(req);
      if (!redirectUri) {
        googleOidc.ready = false;
        googleOidc.client = null;
        googleOidc.generators = null;
        googleOidcInitError = 'missing_redirect_uri';
        console.warn('[google-auth] PUBLIC_BASE_URL/BASE_URL or GOOGLE_REDIRECT_URI missing; Google login disabled.');
        return false;
      }

      const mod = await import('openid-client');
      const { Issuer, generators } = mod;
      const googleIssuer = await discoverGoogleIssuerWithFallback(Issuer);
      googleOidc.client = new googleIssuer.Client({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uris: [redirectUri],
        response_types: ['code']
      });
      googleOidc.generators = generators;
      googleOidc.ready = true;
      googleOidc.redirectUri = redirectUri;
      googleOidcInitError = null;
      return true;
    } catch (err) {
      googleOidc.ready = false;
      googleOidc.client = null;
      googleOidc.generators = null;
      googleOidcInitError = (err && err.message) ? err.message : 'init_failed';
      console.error('[google-auth] init failed', err);
      return false;
    } finally {
      googleOidcInitPromise = null;
    }
  })();

  return googleOidcInitPromise;
}

initGoogleOidc();

const createAdminRouter = require('./routes/admin');
const app = express();
const compression = require('compression');
app.set('query parser', 'simple');

// GZIP sıkıştırmasını aktif et
app.use(compression());

app.use((req, res, next) => {
  const geoMeta = getRequestGeoMeta(req);
  let lang = 'en';

  if (geoMeta.country === 'AZ') lang = 'az';
  else if (geoMeta.country === 'TR') lang = 'tr';
  else {
    const acceptLang = parseAcceptLang(req.headers['accept-language']);
    if (acceptLang) lang = acceptLang;
  }

  res.locals.defaultLang = lang;
  res.locals.assetVersion = ASSET_VERSION;
  req.defaultLang = lang;

  const accept = (req.get('accept') || '').toLowerCase();
  const isHtml = accept.includes('text/html');
  const isApi = req.path.startsWith('/api/');
  const isAsset = /\.(css|js|png|jpg|jpeg|webp|svg|ico|woff2?|ttf|map)$/i.test(req.path);
  if (isHtml && !isApi && !isAsset) {
    // lang_default is intentionally readable by client for language switcher (non-HttpOnly).
    res.cookie('lang_default', lang, { httpOnly: false, sameSite: 'Lax', secure: process.env.NODE_ENV === 'production' });
  }
  next();
});

// Render vb. proxy'lerin arkasında çalışırken secure cookie için gerekli
// Trust only known reverse-proxy hops in production.
// Set TRUST_PROXY_HOPS to your exact chain length (e.g. 1 for nginx->app, 2 for cloudflare->nginx->app).
// Keeping this explicit prevents spoofed client IPs from untrusted forwarded headers.
const trustProxyHops = Number.parseInt((process.env.TRUST_PROXY_HOPS || '').toString(), 10);
if (isProdRuntime && (!Number.isInteger(trustProxyHops) || trustProxyHops <= 0)) {
  console.error('[startup] TRUST_PROXY_HOPS must be set to a positive integer in production.');
  process.exit(1);
}
app.set('trust proxy', process.env.NODE_ENV === 'production'
  ? trustProxyHops
  : false);

// Enforce HTTPS in production for all requests
app.use((req, res, next) => {
  if (process.env.NODE_ENV !== 'production') return next();
  const hostHeader = getSafeHostHeader(req);
  if (!hostHeader) return res.status(400).send('Bad Request');
  const host = hostHeader.toLowerCase().split(':')[0];
  const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (isLocalhost) return next();
  if (!req.secure) {
    return res.redirect(301, `https://${hostHeader}${req.originalUrl}`);
  }
  return next();
});

// Keep a single canonical host in production for first-party pages,
// but allow verified custom domains used by short links.
app.use((req, res, next) => {
  if (process.env.NODE_ENV !== 'production') return next();

  const base = (process.env.BASE_URL || '').toString().trim();
  if (!base) return next();

  let baseUrl;
  try {
    baseUrl = new URL(base);
  } catch {
    return next();
  }

  const hostHeader = getSafeHostHeader(req);
  if (!hostHeader) return res.status(400).send('Bad Request');

  const currentHost = hostHeader.toLowerCase();
  const canonicalHost = baseUrl.host.toLowerCase();
  if (currentHost === canonicalHost) return next();

  const currentHostOnly = normalizeHostName(currentHost);
  if (!currentHostOnly) return res.status(400).send('Bad Request');

  if (currentHostOnly === 'localhost' || currentHostOnly === '127.0.0.1' || currentHostOnly === '::1') {
    return next();
  }

  if (isActiveCustomDomainHost(currentHostOnly)) {
    return next();
  }

  return res.redirect(301, `${baseUrl.protocol}//${canonicalHost}${req.originalUrl}`);
});


// Ads render guard (server-side). Default off for restricted/noindex pages.
app.use((req, res, next) => {
  const publicAdsPaths = new Set(['/', '/privacy', '/terms', '/contact', '/cookie-policy', '/about', '/how-it-works', '/why-ovlink', '/faq', '/help', '/docs', '/abuse-safety', '/updates']);
  const restricted = (
    req.path.startsWith('/admin') ||
    req.path === '/login' ||
    req.path === '/login.html' ||
    req.path === '/register' ||
    req.path === '/register.html' ||
    req.path === '/dashboard' ||
    req.path === '/dashboard.html' ||
    req.path === '/stats' ||
    req.path === '/stats.html' ||
    req.path === '/account' ||
    req.path === '/notifications' ||
    req.path === '/forgot-password' ||
    req.path === '/reset-password'
  );
  const socialAdsDisabled = ['0', 'false', 'no', 'off'].includes(
    (process.env.ENABLE_SOCIAL_ADS || '1').toString().trim().toLowerCase()
  );
  const bannerAdsDisabled = ['0', 'false', 'no', 'off'].includes(
    (process.env.ENABLE_BANNER_ADS || '1').toString().trim().toLowerCase()
  );
  res.locals.allowAds = (!restricted && publicAdsPaths.has(req.path));
  res.locals.enableSocialAds = !socialAdsDisabled;
  res.locals.enableBannerAds = !bannerAdsDisabled;
  return next();
});

// Ad iframe sandbox policy:
// In production keep a stricter sandbox (no same-origin).
// In development allow same-origin so vendor scripts that touch document.cookie can run locally.
app.use((req, res, next) => {
  const flags = [
    'allow-scripts',
    'allow-popups',
    'allow-popups-to-escape-sandbox',
    'allow-top-navigation-by-user-activation',
  ];
  const allowSameOriginEnv = ['1', 'true', 'yes', 'on'].includes(
    (process.env.AD_SANDBOX_ALLOW_SAME_ORIGIN || '').toString().trim().toLowerCase()
  );
  if (process.env.NODE_ENV !== 'production' || allowSameOriginEnv) {
    flags.push('allow-same-origin');
  }
  res.locals.adFrameSandbox = flags.join(' ');
  next();
});

// Noindex for non-public routes (auth/admin/internal)
app.use((req, res, next) => {
  const noIndex = [
    /^\/admin(\/|$)/,
    /^\/login$/,
    /^\/login\.html$/,
    /^\/register$/,
    /^\/register\.html$/,
    /^\/dashboard\.html$/,
    /^\/dashboard$/,
    /^\/stats$/,
    /^\/stats\.html$/,
    /^\/account$/,
    /^\/notifications$/,
    /^\/forgot-password$/,
    /^\/reset-password$/,
  ];
  if (noIndex.some((r) => r.test(req.path))) {
    res.set('X-Robots-Tag', 'noindex,nofollow');
  }
  next();
});

// Internal ops docs must never be publicly served.
app.use((req, res, next) => {
  const p = (req.path || '').toString().trim().toLowerCase();
  if (p === '/agents' || p === '/agents.md') {
    return res.status(404).send('Not found');
  }
  return next();
});

// Isolated ad frames:
// Keep main site CSP strict while allowing ad vendors to run inside a sandboxed iframe.
const SANDBOX_AD_FRAME_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  "script-src https: 'unsafe-inline'",
  "connect-src https:",
  "img-src https: data: blob:",
  "style-src https: 'unsafe-inline'",
  "font-src https: data:",
  "frame-src https:",
].join(';');

function renderSandboxedAdFrame(res, bodyHtml, slotName) {
  const safeSlotName = JSON.stringify((slotName || '').toString());
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex,nofollow');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Content-Security-Policy', SANDBOX_AD_FRAME_CSP);
  return res.send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>html,body{margin:0;padding:0;overflow:hidden;background:transparent;}</style>
  </head>
  <body>${bodyHtml}
    <script>
      (function () {
        var slot = ${safeSlotName};
        var didMarkFilled = false;

        function postStatus(status, height) {
          try {
            if (window.parent && window.parent !== window) {
              window.parent.postMessage({
                __ovlinkAdFrame: true,
                slot: slot,
                status: status,
                height: Number.isFinite(height) ? height : 0
              }, '*');
            }
          } catch (_) {}
        }

        function detectFill() {
          var body = document.body;
          if (!body) return;
          var root = document.documentElement || body;
          var height = Math.max(root.scrollHeight || 0, body.scrollHeight || 0, body.offsetHeight || 0);
          var hasRenderableNode = !!body.querySelector('iframe, ins, img, canvas, video');
          var hasClickableNode = !!body.querySelector('a[href], [onclick]');
          var filled = hasRenderableNode || hasClickableNode || height > 60;

          if (filled) {
            didMarkFilled = true;
            postStatus('filled', height);
          } else {
            postStatus('empty', height);
          }
        }

        window.addEventListener('error', function () {
          postStatus('error', 0);
        }, true);

        window.addEventListener('load', function () {
          postStatus('loading', 0);
          setTimeout(detectFill, 1800);
          setTimeout(detectFill, 4500);
        });

        setTimeout(function () {
          if (!didMarkFilled) detectFill();
        }, 7000);
      })();
    </script>
  </body>
</html>`);
}

function renderEmptySandboxedAdFrame(res, slotName) {
  const safeSlotName = JSON.stringify((slotName || '').toString());
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex,nofollow');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Content-Security-Policy', SANDBOX_AD_FRAME_CSP);
  return res.status(200).send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>html,body{margin:0;padding:0;overflow:hidden;background:transparent;}</style>
  </head>
  <body>
    <script>
      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ __ovlinkAdFrame: true, slot: ${safeSlotName}, status: 'error', height: 0 }, '*');
        }
      } catch (_) {}
    </script>
  </body>
</html>`);
}

app.get('/ads/native-frame', (_req, res) => {
  try {
    const bodyHtml = '<div id="container-4bc00d3da0ee32cb76b16cd6f7b9ddb0"></div>'
      + '<script async="async" data-cfasync="false" src="https://pl28903451.effectivegatecpm.com/4bc00d3da0ee32cb76b16cd6f7b9ddb0/invoke.js"></script>';
    return renderSandboxedAdFrame(res, bodyHtml, 'native');
  } catch (err) {
    console.error('[ads] native-frame render failed', err);
    return renderEmptySandboxedAdFrame(res, 'native');
  }
});

app.get('/ads/social-frame', (_req, res) => {
  try {
    const bodyHtml = '<script async="async" data-cfasync="false" src="https://pl28903465.effectivegatecpm.com/0f/b0/f5/0fb0f54e10ef93c822083c8c99a700d0.js"></script>';
    return renderSandboxedAdFrame(res, bodyHtml, 'social');
  } catch (err) {
    console.error('[ads] social-frame render failed', err);
    return renderEmptySandboxedAdFrame(res, 'social');
  }
});

app.get('/ads/banner-frame', (req, res) => {
  try {
    const device = ((req.query.device || '').toString().trim().toLowerCase() === 'mobile') ? 'mobile' : 'desktop';
    const bodyHtml = device === 'mobile'
      ? '<script>atOptions={\'key\':\'bc7bf2b3e03df703d86e7de5734ce292\',\'format\':\'iframe\',\'height\':50,\'width\':320,\'params\':{}};</script><script src="https://www.highperformanceformat.com/bc7bf2b3e03df703d86e7de5734ce292/invoke.js"></script>'
      : '<script>atOptions={\'key\':\'614a4a2cd3ef3f4e132b2113dd3a6600\',\'format\':\'iframe\',\'height\':90,\'width\':728,\'params\':{}};</script><script src="https://www.highperformanceformat.com/614a4a2cd3ef3f4e132b2113dd3a6600/invoke.js"></script>';
    return renderSandboxedAdFrame(res, bodyHtml, 'banner');
  } catch (err) {
    console.error('[ads] banner-frame render failed', err);
    return renderEmptySandboxedAdFrame(res, 'banner');
  }
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
const PORT = process.env.PORT || 3000;
const isProd = (process.env.NODE_ENV === 'production');
const publicDir = path.join(__dirname, 'public');
const robotsFile = path.join(publicDir, 'robots.txt');
const sitemapFile = path.join(publicDir, 'sitemap.xml');

const siteSettings = global.__siteSettings || {
  maintenance_enabled: '0',
  maintenance_message_az: '',
  maintenance_message_tr: '',
  maintenance_message_en: '',
  announcement_enabled: '0',
  announcement_text_az: '',
  announcement_text_tr: '',
  announcement_text_en: ''
};

global.__siteSettings = siteSettings;


// ========================
// YARDIMÇI FUNKSIYALAR
// ========================

// URL'in http:// veya https:// ile başladığından emin olur
function ensureAbsoluteUrl(url) {
  if (!url) return '';
  const raw = (url || '').toString().trim();
  if (!raw) return '';
  const candidate = /^https?:\/\//i.test(raw) ? raw : ('http://' + raw);
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function pickFirstInputValue(...candidates) {
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    const value = candidate.toString().trim();
    if (value) return value;
  }
  return '';
}

function isLikelyBrowserNavigationRequest(req) {
  const secFetchMode = (req.get('sec-fetch-mode') || '').toLowerCase();
  if (secFetchMode === 'navigate') return true;
  const accept = (req.get('accept') || '').toLowerCase();
  return accept.includes('text/html');
}

// Basic HTML escaping for server-rendered error pages
function escapeHtml(value) {
  return (value || '').toString().replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}


const SHORT_CODE_RE = /^[A-Za-z0-9_-]{1,50}$/;
const RESERVED_SHORT_ALIASES = new Set([
  // Public pages
  'about', 'abuse-safety', 'account', 'contact', 'cookie-policy', 'dashboard',
  'docs', 'faq', 'forgot-password', 'help', 'how-it-works', 'login', 'notifications',
  'privacy', 'pricing', 'register', 'reset-password', 'stats', 'stats-page', 'sss', 'terms',
  'updates', 'verify', 'why-ovlink', 'api-guide',
  // System and route namespaces
  'admin', 'api', 'auth', 'consent', 'proceed', 'qrcode', 'verify-email', 'logout',
  // Reserved root-like names
  'robots', 'robots.txt', 'sitemap', 'sitemap.xml', 'bingsiteauth', 'yandex',
  'yandex_71461f9fd9f723bc'
]);
const REDIRECT_CONSENT_COOKIE = 'ovlink_redirect_consent';
const REDIRECT_CONSENT_MARKER = '__ESSENTIAL__';
const REDIRECT_CONSENT_COUNTDOWN_MS = 1000;
const REDIRECT_CONSENT_MAX_TOKEN_AGE_MS = 10 * 60 * 1000;
const REDIRECT_CONSENT_MODES = Object.freeze({
  ESSENTIAL: 'essential',
  ANALYTICS: 'analytics',
});

const PLAN_TIERS = Object.freeze({
  FREE: 'free',
  PRO: 'pro',
});

const PLAN_STATUS = Object.freeze({
  ACTIVE: 'active',
  PAUSED: 'paused',
});

const PRO_FEATURES = Object.freeze({
  api: true,
  webhooks: true,
  ip_security: true,
});

const PRO_API_KEY_MAX_ACTIVE = 2;
const PRO_WEBHOOK_MAX_ACTIVE = 10;
const WEBHOOK_MAX_ATTEMPTS = 5;
const WEBHOOK_RETRY_BASE_MS = 60 * 1000;
const SECURITY_EVENT_RETENTION_DAYS = 30;
const API_IDEMPOTENCY_RETENTION_HOURS = 24;
const PRO_API_USAGE_RETENTION_DAYS = 30;
const PRO_API_READ_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const PRO_API_READ_RATE_LIMIT_MAX = 120;
const PRO_API_WRITE_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const PRO_API_WRITE_RATE_LIMIT_MAX = 35;
const PRO_API_KEY_CREATE_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const PRO_API_KEY_CREATE_RATE_LIMIT_MAX = 8;
const ALLOW_INSECURE_WEBHOOK_HTTP = ['1', 'true', 'yes', 'on'].includes(((process.env.ALLOW_INSECURE_WEBHOOK_HTTP || '') + '').trim().toLowerCase());
if (isProdRuntime && ALLOW_INSECURE_WEBHOOK_HTTP) {
  console.error('[startup] ALLOW_INSECURE_WEBHOOK_HTTP cannot be enabled in production.');
  process.exit(1);
}

const API_KEY_SCOPES = Object.freeze({
  ACCOUNT_READ: 'account:read',
  SHORTEN_WRITE: 'shorten:write',
  WEBHOOKS_READ: 'webhooks:read',
  WEBHOOKS_WRITE: 'webhooks:write',
});

const DEFAULT_API_KEY_SCOPES = Object.freeze([
  API_KEY_SCOPES.ACCOUNT_READ,
  API_KEY_SCOPES.SHORTEN_WRITE,
  API_KEY_SCOPES.WEBHOOKS_READ,
  API_KEY_SCOPES.WEBHOOKS_WRITE,
]);
const DEFAULT_API_KEY_SCOPES_STORAGE = DEFAULT_API_KEY_SCOPES.join(',');
const ALLOWED_API_KEY_SCOPES = new Set(DEFAULT_API_KEY_SCOPES);


const CUSTOM_DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const INTERNAL_HOSTS = new Set();
const ACTIVE_CUSTOM_DOMAIN_HOSTS = new Set();

function normalizeHostName(raw) {
  const value = (raw || '').toString().trim().toLowerCase();
  if (!value) return '';
  const host = value.split(':')[0].replace(/\.+$/, '');
  if (!host) return '';
  return host;
}

function parseHostFromUrl(raw) {
  const value = (raw || '').toString().trim();
  if (!value) return '';
  try {
    const parsed = new URL(value);
    return normalizeHostName(parsed.host || parsed.hostname);
  } catch {
    return '';
  }
}

function getConfiguredBaseHost() {
  return parseHostFromUrl(process.env.PUBLIC_BASE_URL) || parseHostFromUrl(process.env.BASE_URL);
}

function refreshInternalHostCache() {
  INTERNAL_HOSTS.clear();
  const configured = getConfiguredBaseHost();
  if (configured) {
    INTERNAL_HOSTS.add(configured);
    if (configured.startsWith('www.')) {
      INTERNAL_HOSTS.add(configured.slice(4));
    } else {
      INTERNAL_HOSTS.add('www.' + configured);
    }
  }

  const extraHosts = (process.env.ADDITIONAL_BASE_HOSTS || '').toString().split(',').map((v) => normalizeHostName(v)).filter(Boolean);
  for (const host of extraHosts) INTERNAL_HOSTS.add(host);

  INTERNAL_HOSTS.add('localhost');
  INTERNAL_HOSTS.add('127.0.0.1');
  INTERNAL_HOSTS.add('::1');
}

refreshInternalHostCache();

function isInternalHost(rawHost) {
  const host = normalizeHostName(rawHost);
  return !!host && INTERNAL_HOSTS.has(host);
}

function isActiveCustomDomainHost(rawHost) {
  const host = normalizeHostName(rawHost);
  return !!host && ACTIVE_CUSTOM_DOMAIN_HOSTS.has(host);
}

function replaceCustomDomainCache(domains) {
  ACTIVE_CUSTOM_DOMAIN_HOSTS.clear();
  if (!Array.isArray(domains)) return;
  for (const item of domains) {
    const host = normalizeHostName(item);
    if (host) ACTIVE_CUSTOM_DOMAIN_HOSTS.add(host);
  }
}

async function refreshCustomDomainCache() {
  try {
    if (!db) return;
    db.all(
      "SELECT domain FROM custom_domains WHERE status = 'active'",
      [],
      (err, rows) => {
        if (err) return;
        replaceCustomDomainCache((rows || []).map((r) => r.domain));
      }
    );
  } catch {
    // ignore cache refresh errors
  }
}

function normalizeCustomDomainInput(raw) {
  let value = (raw || '').toString().trim().toLowerCase();
  if (!value) return '';

  if (value.startsWith('http://') || value.startsWith('https://')) {
    try {
      value = new URL(value).hostname.toLowerCase();
    } catch {
      return '';
    }
  }

  value = value.split('/')[0].split('?')[0].split('#')[0].trim();
  if (!value) return '';
  value = value.replace(/\.+$/, '');

  if (value.includes(':')) {
    const parts = value.split(':');
    value = (parts[0] || '').trim();
  }

  if (!value || net.isIP(value)) return '';
  if (!CUSTOM_DOMAIN_RE.test(value)) return '';

  return value;
}

function getRequestHostName(req) {
  const hostHeader = getSafeHostHeader(req);
  if (hostHeader) return normalizeHostName(hostHeader);
  return normalizeHostName(req && req.hostname);
}

function getCustomDomainTargetHost() {
  const explicit = normalizeHostName(process.env.CUSTOM_DOMAIN_TARGET_HOST || '');
  if (explicit) return explicit;
  const baseHost = getConfiguredBaseHost();
  return baseHost || '';
}

function getCustomDomainTxtHost(domain) {
  return `_ovlink-challenge.${domain}`;
}

const DNS_FALLBACK_SERVERS = (process.env.DNS_FALLBACK_SERVERS || process.env.DNS_RESOLVERS || '1.1.1.1,8.8.8.8')
  .toString()
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

function sanitizeDnsTxtValue(rawValue) {
  const value = (rawValue || '').toString().trim();
  return value.replace(/^"+|"+$/g, '').trim();
}

function resolveWithServer(server, method, hostname) {
  return new Promise((resolve, reject) => {
    try {
      const resolver = new dnsNative.Resolver();
      resolver.setServers([server]);
      if (typeof resolver[method] !== 'function') {
        return reject(new Error('Unsupported DNS resolver method'));
      }
      resolver[method](hostname, (err, records) => {
        if (err) return reject(err);
        return resolve(records || []);
      });
    } catch (err) {
      return reject(err);
    }
  });
}

async function resolveDnsWithFallback(method, hostname) {
  const host = (hostname || '').toString().trim();
  if (!host) return [];

  const queryHosts = [host];
  if (!host.endsWith('.')) queryHosts.push(`${host}.`);

  for (const queryHost of queryHosts) {
    try {
      const records = await dns[method](queryHost);
      if (records && records.length) return records;
    } catch {
      // continue to fallback servers
    }

    for (const server of DNS_FALLBACK_SERVERS) {
      try {
        const records = await resolveWithServer(server, method, queryHost);
        if (records && records.length) return records;
      } catch {
        // try next server
      }
    }
  }

  return [];
}

async function resolveTxtValues(hostname) {
  const records = await resolveDnsWithFallback('resolveTxt', hostname);
  return (records || []).flat().map((v) => sanitizeDnsTxtValue(v)).filter(Boolean);
}

async function resolveCnameValues(hostname) {
  const records = await resolveDnsWithFallback('resolveCname', hostname);
  return (records || []).map((v) => normalizeHostName(v)).filter(Boolean);
}

async function resolveAddressValues(hostname) {
  const values = new Set();

  const v4 = await resolveDnsWithFallback('resolve4', hostname);
  for (const item of (v4 || [])) {
    const value = (item || '').toString().trim();
    if (value) values.add(value);
  }

  const v6 = await resolveDnsWithFallback('resolve6', hostname);
  for (const item of (v6 || [])) {
    const value = (item || '').toString().trim();
    if (value) values.add(value);
  }

  return Array.from(values);
}

async function verifyCustomDomainDns(domain, verificationToken) {
  const txtHost = getCustomDomainTxtHost(domain);
  const token = sanitizeDnsTxtValue(verificationToken);

  const txtValues = await resolveTxtValues(txtHost);
  const ownershipVerified = !!token && txtValues.some((v) => tsscmp(v, token));

  const cnameValues = await resolveCnameValues(domain);
  const domainAddresses = await resolveAddressValues(domain);
  const expectedTarget = getCustomDomainTargetHost();
  const expectedTargetAddresses = expectedTarget ? await resolveAddressValues(expectedTarget) : [];

  const cnameReady = expectedTarget ? cnameValues.some((v) => v === expectedTarget) : cnameValues.length > 0;
  const addressReady = expectedTarget
    ? domainAddresses.some((ip) => expectedTargetAddresses.includes(ip))
    : domainAddresses.length > 0;
  const routingReady = cnameReady || addressReady;

  return {
    txtHost,
    txtValues,
    cnameValues,
    domainAddresses,
    expectedTarget,
    expectedTargetAddresses,
    ownershipVerified,
    routingReady,
  };
}

function getConfiguredPublicBaseUrl() {
  const raw = (process.env.PUBLIC_BASE_URL || process.env.BASE_URL || '').toString().trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return `${parsed.protocol}//${parsed.host}`.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function parseConfiguredBaseUrl(rawValue) {
  const raw = (rawValue || '').toString().trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.pathname = '/';
    parsed.search = '';
    parsed.hash = '';
    return parsed;
  } catch {
    return null;
  }
}

function validateBaseUrlConfiguration() {
  const rawPublic = (process.env.PUBLIC_BASE_URL || '').toString().trim();
  const rawBase = (process.env.BASE_URL || '').toString().trim();
  const parsedPublic = parseConfiguredBaseUrl(rawPublic);
  const parsedBase = parseConfiguredBaseUrl(rawBase);
  const strict = process.env.NODE_ENV === 'production';

  if (strict && !rawPublic && !rawBase) {
    console.error('[startup] PUBLIC_BASE_URL or BASE_URL must be set in production.');
    process.exit(1);
  }

  if (rawPublic && !parsedPublic) {
    console.error('[startup] PUBLIC_BASE_URL must be a valid absolute http/https URL.');
    if (strict) process.exit(1);
  }

  if (rawBase && !parsedBase) {
    console.error('[startup] BASE_URL must be a valid absolute http/https URL.');
    if (strict) process.exit(1);
  }

  if (strict && parsedPublic && parsedPublic.protocol !== 'https:') {
    console.error('[startup] PUBLIC_BASE_URL must use https in production.');
    process.exit(1);
  }

  if (strict && parsedBase && parsedBase.protocol !== 'https:') {
    console.error('[startup] BASE_URL must use https in production.');
    process.exit(1);
  }

  if (parsedPublic && parsedBase && parsedPublic.origin !== parsedBase.origin) {
    const msg = '[startup] PUBLIC_BASE_URL and BASE_URL should point to the same origin for canonical redirects.';
    if (strict) {
      console.error(msg);
      process.exit(1);
    } else {
      console.warn(msg);
    }
  }
}

validateBaseUrlConfiguration();

function validateOperationalAlertingConfiguration() {
  if (!isProdRuntime) return;
  const hasAlertWebhook = !!(process.env.ALERT_WEBHOOK_URL || '').toString().trim();
  const hasSentry = !!(process.env.SENTRY_DSN || '').toString().trim();
  if (!hasAlertWebhook && !hasSentry) {
    console.warn('[startup] ALERT_WEBHOOK_URL or SENTRY_DSN should be configured in production for incident alerting.');
  }
}

validateOperationalAlertingConfiguration();

function buildAbsoluteUrlForHost(req, host, pathValue) {
  const safeHost = normalizeHostName(host);
  if (!safeHost) return buildAbsoluteUrl(req, pathValue);

  const configuredBase = getConfiguredPublicBaseUrl();
  const configuredProto = configuredBase ? (configuredBase.startsWith('https://') ? 'https' : 'http') : null;
  const proto = configuredProto || (req && req.secure ? 'https' : 'http');
  const base = `${proto}://${safeHost}/`;
  const safePath = (pathValue || '/').toString();
  try {
    return new URL(safePath.startsWith('/') ? safePath : `/${safePath}`, base).toString();
  } catch {
    return base;
  }
}

function buildShortUrl(req, shortCode, customDomainHost = '') {
  const pathValue = '/' + encodeURIComponent((shortCode || '').toString());
  const domainHost = normalizeHostName(customDomainHost);
  if (domainHost) return buildAbsoluteUrlForHost(req, domainHost, pathValue);

  const configured = getConfiguredPublicBaseUrl();
  if (configured) {
    try {
      return new URL(pathValue, configured + '/').toString();
    } catch {}
  }

  return buildAbsoluteUrl(req, pathValue);
}

function getShortHostAccess(row, reqHost) {
  const rowDomainHost = normalizeHostName(row && row.domain_host);
  const currentHost = normalizeHostName(reqHost);

  if (rowDomainHost) {
    if (currentHost === rowDomainHost) return { allowed: true, redirectHost: '' };
    return { allowed: false, redirectHost: rowDomainHost };
  }

  if (isInternalHost(currentHost)) return { allowed: true, redirectHost: '' };
  const fallbackHost = getConfiguredBaseHost();
  return { allowed: false, redirectHost: fallbackHost || '' };
}


function buildCustomDomainPayload(row) {
  if (!row) return null;
  const domain = normalizeHostName(row.domain);
  const txtHost = getCustomDomainTxtHost(domain);
  return {
    id: row.id,
    domain,
    status: (row.status || 'pending_verification').toString(),
    created_at: row.created_at || null,
    verified_at: row.verified_at || null,
    last_checked_at: row.last_checked_at || null,
    routing_ok: row.routing_ok == 1,
    verification: {
      txt_host: txtHost,
      txt_value: row.verification_token,
      cname_target: getCustomDomainTargetHost(),
    }
  };
}

function normalizeShortAlias(raw) {
  const short = (raw || '').toString().trim();
  if (!SHORT_CODE_RE.test(short)) return '';
  return short.toLowerCase();
}

function isReservedShortAlias(raw) {
  const alias = normalizeShortAlias(raw);
  if (!alias) return false;
  return RESERVED_SHORT_ALIASES.has(alias);
}

function generateSafeShortCode(maxAttempts = 20) {
  for (let i = 0; i < maxAttempts; i += 1) {
    const candidate = shortid.generate();
    if (!isReservedShortAlias(candidate)) return candidate;
  }
  return shortid.generate();
}

function normalizeShortCode(raw) {
  const short = (raw || '').toString().trim();
  if (!SHORT_CODE_RE.test(short)) return null;
  return short;
}

function extractImportUrlCandidate(rawLine) {
  const line = (rawLine || '').toString().trim();
  if (!line) return '';

  const lower = line.toLowerCase();
  if (lower === 'url' || lower === 'original' || lower === 'original_url') return '';

  const direct = ensureAbsoluteUrl(line);
  if (direct) return direct;

  const m = line.match(/https?:\/\/[^\s,"]+/i);
  if (m && m[0]) {
    const fromMatch = ensureAbsoluteUrl(m[0]);
    if (fromMatch) return fromMatch;
  }

  const firstCell = line.split(',')[0]?.replace(/^"|"$/g, '').trim() || '';
  const fromCell = ensureAbsoluteUrl(firstCell);
  if (fromCell) return fromCell;

  return '';
}

function normalizeConsentMode(raw) {
  const mode = (raw || '').toString().trim().toLowerCase();
  if (mode === REDIRECT_CONSENT_MODES.ESSENTIAL) return REDIRECT_CONSENT_MODES.ESSENTIAL;
  if (mode === REDIRECT_CONSENT_MODES.ANALYTICS) return REDIRECT_CONSENT_MODES.ANALYTICS;
  return '';
}

function normalizeConsentNext(raw) {
  return (raw || '').toString().trim().toLowerCase() === 'proceed' ? 'proceed' : 'redirect';
}

function isBcryptHash(value) {
  const text = (value || '').toString();
  return /^\$2[abxy]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(text);
}

async function hashLinkPassword(plainPassword) {
  const text = (plainPassword || '').toString();
  if (!text) return '';
  try {
    return await bcrypt.hash(text, 10);
  } catch {
    return '';
  }
}

async function verifyLinkPassword(storedValue, candidateValue) {
  const stored = (storedValue || '').toString();
  const candidate = (candidateValue || '').toString();
  if (!stored) return false;
  if (isBcryptHash(stored)) {
    try {
      return await bcrypt.compare(candidate, stored);
    } catch {
      return false;
    }
  }
  return tsscmp(stored, candidate);
}

function getSafeHostHeader(req) {
  const host = (req.get('host') || '').toString().trim();
  if (!host) return '';
  if (!/^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(host)) return '';
  return host;
}

function getCookieValue(req, name) {
  const key = (name || '').toString().trim();
  if (!key) return '';
  try {
    const cookie = (req.headers.cookie || '').toString();
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = cookie.match(new RegExp('(?:^|;)\\s*' + escapedKey + '=([^;]+)', 'i'));
    if (!m) return '';
    return decodeURIComponent(m[1] || '').trim();
  } catch {
    return '';
  }
}

function getRequestIp(req) {
  // Rely on Express `req.ip` + trusted proxy chain. Do not trust raw forwarded headers here.
  let ip = (req.ip || req.socket?.remoteAddress || '').toString().trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

function getApiKeyHintFromRequest(req) {
  const xKey = (req.get('x-api-key') || '').toString().trim();
  const auth = (req.get('authorization') || '').toString().trim();
  const bearer = auth.match(/^Bearer\s+(.+)$/i);
  const rawKey = xKey || (bearer ? (bearer[1] || '').trim() : '');
  if (!rawKey || !/^ovk_[A-Za-z0-9_-]{20,200}$/.test(rawKey)) return '';
  return crypto.createHash('sha256').update(rawKey).digest('hex').slice(0, 24);
}

function buildRateLimitKey(req, scope = 'global') {
  const safeScope = (scope || 'global').toString().slice(0, 32);
  const apiKeyHint = getApiKeyHintFromRequest(req);
  if (apiKeyHint) {
    return `${safeScope}:api:${apiKeyHint}`;
  }
  if (req && req.session && Number.isInteger(req.session.userId)) {
    return `${safeScope}:user:${req.session.userId}`;
  }
  const ip = getRequestIp(req) || 'unknown';
  return `${safeScope}:ip:${ip}`;
}

function parseAcceptLang(header) {
  const raw = (header || '').toLowerCase();
  if (raw.includes('az')) return 'az';
  if (raw.includes('tr')) return 'tr';
  if (raw.includes('en')) return 'en';
  return '';
}

function isPrivateIp(ip) {
  if (!ip) return false;
  let v = ip.toString().trim().toLowerCase();
  if (v.startsWith('::ffff:')) v = v.slice(7);

  if (v === '::1' || v === '127.0.0.1' || v === 'localhost') return true;
  if (v.startsWith('10.') || v.startsWith('192.168.')) return true;
  if (v.startsWith('172.')) {
    const parts = v.split('.');
    const second = parseInt(parts[1] || '0', 10);
    if (second >= 16 && second <= 31) return true;
  }

  // IPv6 local ranges: loopback/link-local/unique-local
  if (v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80:')) return true;

  return false;
}

function normalizeCountryCode(raw) {
  const code = (raw || '').toString().trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return '';
  // Cloudflare special values are not ISO country codes.
  if (code === 'XX' || code === 'T1' || code === 'A1' || code === 'A2') return '';
  return code;
}

function getRequestGeoMeta(req) {
  const ip = getRequestIp(req);

  // Cloudflare passes real country in CF-IPCountry; prefer it when valid.
  const cfCountry = normalizeCountryCode(req.get('cf-ipcountry') || req.get('x-vercel-ip-country'));

  let country = 'Unknown';
  let city = 'Unknown';

  if (cfCountry) {
    country = cfCountry;
  } else if (isPrivateIp(ip)) {
    country = 'Local Dev';
    city = 'Localhost';
  } else {
    const geo = geoip.lookup(ip || '');
    const geoCountry = normalizeCountryCode(geo && geo.country);
    if (geoCountry) country = geoCountry;
    if (geo && geo.city) city = (geo.city || '').toString().trim() || 'Unknown';
  }

  return { ip, country, city };
}

function getRedirectConsentMode(req) {
  return normalizeConsentMode(getCookieValue(req, REDIRECT_CONSENT_COOKIE));
}

function setRedirectConsentMode(res, mode) {
  const normalized = normalizeConsentMode(mode);
  if (!normalized) return;
  res.cookie(REDIRECT_CONSENT_COOKIE, normalized, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 180 * 24 * 60 * 60 * 1000,
  });
}

function clearRedirectConsentMode(res) {
  if (!res || typeof res.clearCookie !== 'function') return;
  res.clearCookie(REDIRECT_CONSENT_COOKIE, {
    sameSite: 'Lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  });
}

function buildRedirectConsentSignature(short, nextAction, readyAt) {
  const safeShort = (short || '').toString();
  const safeNext = normalizeConsentNext(nextAction);
  const safeReadyAt = Number.parseInt(readyAt, 10);
  if (!safeShort || !Number.isFinite(safeReadyAt)) return '';
  const payload = `${safeShort}|${safeNext}|${safeReadyAt}`;
  return crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('base64url');
}

function isRedirectConsentSignatureValid(short, nextAction, readyAt, signature) {
  const expected = buildRedirectConsentSignature(short, nextAction, readyAt);
  const received = (signature || '').toString().trim();
  if (!expected || !received) return false;
  return tsscmp(expected, received);
}

function setRedirectConsentSession(req, short, nextAction, mode) {
  if (!req || !req.session) return;
  const normalizedMode = normalizeConsentMode(mode);
  const normalizedNext = normalizeConsentNext(nextAction);
  if (!normalizedMode) return;
  req.session.redirectConsentApproved = {
    short: (short || '').toString(),
    next: normalizedNext,
    mode: normalizedMode,
    expiresAt: Date.now() + (10 * 60 * 1000),
  };
}

function clearRedirectConsentSession(req) {
  if (!req || !req.session) return;
  delete req.session.redirectConsentApproved;
}

function getRedirectConsentModeForRequest(req, short, nextAction) {
  const cookieMode = getRedirectConsentMode(req);
  if (cookieMode) return { mode: cookieMode, source: 'cookie' };

  const approved = req && req.session ? req.session.redirectConsentApproved : null;
  const normalizedNext = normalizeConsentNext(nextAction);
  const normalizedShort = (short || '').toString();
  if (approved
    && approved.short === normalizedShort
    && approved.next === normalizedNext
    && Number.isFinite(approved.expiresAt)
    && Date.now() <= approved.expiresAt) {
    const mode = normalizeConsentMode(approved.mode) || REDIRECT_CONSENT_MODES.ANALYTICS;
    return { mode, source: 'session' };
  }

  return { mode: '', source: '' };
}

function getConsentResumePath(short, nextAction) {
  const safeShort = encodeURIComponent((short || '').toString());
  return normalizeConsentNext(nextAction) === 'proceed' ? `/proceed/${safeShort}` : `/${safeShort}`;
}

function getEssentialAnalyticsValue(raw) {
  const v = (raw || '').toString().trim();
  if (!v) return 'Unknown';
  return v;
}

function recordClickEvent(req, row, consentMode) {
  const clickTime = new Date().toISOString();
  const mode = normalizeConsentMode(consentMode);

  if (mode === REDIRECT_CONSENT_MODES.ESSENTIAL) {
    db.run(
      'INSERT INTO clicks (url_id, click_time, browser, os, country) VALUES (?, ?, ?, ?, ?)',
      [row.id, clickTime, REDIRECT_CONSENT_MARKER, REDIRECT_CONSENT_MARKER, REDIRECT_CONSENT_MARKER]
    );
    return;
  }

  const geoMeta = getRequestGeoMeta(req);
  const agent = parseUserAgentInfo(req.headers['user-agent']);
  const osDisplay = agent.os;

  db.run(
    'INSERT INTO clicks (url_id, click_time, browser, os, country) VALUES (?, ?, ?, ?, ?)',
    [row.id, clickTime, getEssentialAnalyticsValue(agent.browser), getEssentialAnalyticsValue(osDisplay), getEssentialAnalyticsValue(geoMeta.country)]
  );
}

function parseUserAgentInfo(userAgentRaw) {
  const ua = (userAgentRaw || '').toString().slice(0, 512);

  let browser = 'Unknown';
  if (/edg\//i.test(ua)) browser = 'Edge';
  else if (/opr\//i.test(ua)) browser = 'Opera';
  else if (/chrome\//i.test(ua) && !/edg\//i.test(ua)) browser = 'Chrome';
  else if (/safari\//i.test(ua) && !/chrome\//i.test(ua)) browser = 'Safari';
  else if (/firefox\//i.test(ua)) browser = 'Firefox';
  else if (/msie|trident/i.test(ua)) browser = 'Internet Explorer';

  let os = 'Unknown';
  if (/windows nt/i.test(ua)) os = 'Windows';
  else if (/android/i.test(ua)) os = 'Android';
  else if (/iphone|ipad|ipod/i.test(ua)) os = 'iOS';
  else if (/mac os x/i.test(ua)) os = 'macOS';
  else if (/linux/i.test(ua)) os = 'Linux';

  return { browser, os };
}

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}



const USER_SESSION_TOUCH_MS = 60 * 1000;

function normalizeFolderName(raw) {
  const text = (raw || '').toString().replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.slice(0, 80);
}

function normalizeTagsInput(raw) {
  let items = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (typeof raw === 'string') {
    const text = raw.trim();
    if (text) {
      if (text.startsWith('[') && text.endsWith(']')) {
        try {
          const parsed = JSON.parse(text);
          if (Array.isArray(parsed)) items = parsed;
          else items = text.split(/[\n,;]+/);
        } catch {
          items = text.split(/[\n,;]+/);
        }
      } else {
        items = text.split(/[\n,;]+/);
      }
    }
  }

  const out = [];
  const seen = new Set();
  for (const item of items) {
    const cleaned = (item || '')
      .toString()
      .replace(/[#<>]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 32);
    if (!cleaned) continue;
    const key = cleaned.toLocaleLowerCase('en-US');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= 12) break;
  }
  return out;
}

function parseTagsJson(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return normalizeTagsInput(parsed);
  } catch {
    return [];
  }
}

function generateVerificationCode() {
  // Keep 6-digit codes unpredictable to reduce brute-force feasibility.
  return crypto.randomInt(0, 1000000).toString().padStart(6, '0');
}

function buildVerificationExpiryIso(minutes = 15) {
  const safeMinutes = Number.isInteger(minutes) && minutes > 0 ? minutes : 15;
  return new Date(Date.now() + safeMinutes * 60 * 1000).toISOString();
}

function normalizeFutureExpiryInput(rawValue) {
  const raw = (rawValue || '').toString().trim();
  if (!raw) return { value: null, error: '' };
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return { value: null, error: 'invalid' };
  if (ms <= Date.now()) return { value: null, error: 'past' };
  return { value: new Date(ms).toISOString(), error: '' };
}

function isIsoTimeExpired(rawValue) {
  const raw = (rawValue || '').toString().trim();
  if (!raw) return false;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return true;
  return Date.now() > ms;
}

function normalizeSessionToken(raw) {
  const token = (raw || '').toString().trim();
  if (!token) return '';
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return '';
  return token;
}

function getOrCreateUserSessionToken(req) {
  if (!req || !req.session) return '';
  const existing = normalizeSessionToken(req.session.userSessionToken);
  if (existing) return existing;
  const token = crypto.randomBytes(24).toString('base64url');
  req.session.userSessionToken = token;
  return token;
}

function hashIpForStorage(ip) {
  const value = (ip || '').toString().trim();
  if (!value) return '';
  return crypto
    .createHash('sha256')
    .update(`${process.env.SESSION_SECRET}|${value}`)
    .digest('hex')
    .slice(0, 24);
}

function maskIpForDisplay(rawIp) {
  let ip = (rawIp || '').toString().trim();
  if (!ip) return '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);

  const ipVersion = net.isIP(ip);
  if (ipVersion === 4) {
    const parts = ip.split('.');
    if (parts.length !== 4) return '';
    return `${parts[0]}.${parts[1]}.x.x`;
  }

  if (ipVersion === 6) {
    const blocks = ip.toLowerCase().split(':').filter(Boolean);
    if (blocks.length >= 2) return `${blocks[0]}:${blocks[1]}:xxxx:xxxx`;
    return 'xxxx:xxxx';
  }

  return '';
}

function buildNetworkFingerprintForDisplay(rawIp) {
  const hash = hashIpForStorage(rawIp);
  if (!hash) return '';
  return hash.slice(0, 10).toUpperCase();
}

function buildDeviceFingerprint(agent, country, uaRaw) {
  const browser = (agent && agent.browser ? agent.browser : 'unknown').toString().toLowerCase();
  const os = (agent && agent.os ? agent.os : 'unknown').toString().toLowerCase();
  const cc = (country || 'unknown').toString().toLowerCase();
  const ua = (uaRaw || '').toString().slice(0, 200).toLowerCase();
  return crypto.createHash('sha256').update(`${browser}|${os}|${cc}|${ua}`).digest('hex');
}

function buildLoginMethodLabel(loginMethod, lang) {
  const safeLang = normalizeLang(lang, 'az');
  const method = (loginMethod || '').toString();
  if (method === 'google') {
    return pickLang(safeLang, 'Google ilə giriş', 'Google ile giriş', 'Google sign-in');
  }
  if (method === 'verify_email') {
    return pickLang(safeLang, 'E-poçt təsdiqi sonrası giriş', 'E-posta doğrulaması sonrası giriş', 'Sign-in after email verification');
  }
  return pickLang(safeLang, 'Parol ilə giriş', 'Parola ile giriş', 'Password sign-in');
}

function upsertUserSessionRecord(req, userId, options = {}, done = () => {}) {
  if (!req || !req.session || !userId) return done();
  const sessionToken = getOrCreateUserSessionToken(req);
  if (!sessionToken) return done();

  const loginMethod = (options.loginMethod || 'password').toString();
  const shouldAlert = options.sendAlert !== false;
  const nowIso = new Date().toISOString();
  const agent = parseUserAgentInfo(req.headers['user-agent']);
  const geoMeta = getRequestGeoMeta(req);
  const country = geoMeta && geoMeta.country ? geoMeta.country : 'Unknown';
  const browser = agent.browser || 'Unknown';
  const os = agent.os || 'Unknown';
  const deviceLabel = `${browser} / ${os}`;
  const ipHash = hashIpForStorage(geoMeta.ip || '');
  const userAgent = (req.headers['user-agent'] || '').toString().slice(0, 512);
  const fingerprint = buildDeviceFingerprint(agent, country, userAgent);

  db.get(
    `SELECT
       COUNT(*) AS total_count,
       SUM(CASE WHEN device_fingerprint = ? THEN 1 ELSE 0 END) AS same_device_count
     FROM user_sessions
     WHERE user_id = ?`,
    [fingerprint, userId],
    (seenErr, seenMeta) => {
      const totalCount = seenErr ? 0 : Number(seenMeta && seenMeta.total_count ? seenMeta.total_count : 0);
      const sameDeviceCount = seenErr ? 0 : Number(seenMeta && seenMeta.same_device_count ? seenMeta.same_device_count : 0);
      const hadPreviousDevice = totalCount > 0;
      const isNewDevice = sameDeviceCount === 0;

      db.run(
        `INSERT INTO user_sessions (
          user_id, session_token, user_agent, device_label, browser, os, country, ip_hash,
          created_at, last_seen_at, last_login_at, last_login_method, is_revoked, revoked_at, device_fingerprint
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
        ON CONFLICT(session_token) DO UPDATE SET
          user_id = excluded.user_id,
          user_agent = excluded.user_agent,
          device_label = excluded.device_label,
          browser = excluded.browser,
          os = excluded.os,
          country = excluded.country,
          ip_hash = excluded.ip_hash,
          last_seen_at = excluded.last_seen_at,
          last_login_at = excluded.last_login_at,
          last_login_method = excluded.last_login_method,
          is_revoked = 0,
          revoked_at = NULL,
          device_fingerprint = excluded.device_fingerprint`,
        [
          userId,
          sessionToken,
          userAgent,
          deviceLabel,
          browser,
          os,
          country,
          ipHash,
          nowIso,
          nowIso,
          nowIso,
          loginMethod,
          fingerprint,
        ],
        (upsertErr) => {
          const shouldNotify = !upsertErr && shouldAlert && loginMethod !== 'session_restore' && hadPreviousDevice && isNewDevice;
          if (shouldNotify) {
            const notificationPayload = {
              titleAz: 'Yeni cihazdan giriş',
              titleTr: 'Yeni cihazdan giriş',
              titleEn: 'New device sign-in',
              bodyAz: `${deviceLabel} (${country}) üzərindən yeni giriş qeydə alındı. Metod: ${buildLoginMethodLabel(loginMethod, 'az')}.`,
              bodyTr: `${deviceLabel} (${country}) üzerinden yeni giriş algılandı. Yöntem: ${buildLoginMethodLabel(loginMethod, 'tr')}.`,
              bodyEn: `A new sign-in was detected from ${deviceLabel} (${country}). Method: ${buildLoginMethodLabel(loginMethod, 'en')}.`,
              eventKey: `security_device_${fingerprint}`,
            };
            createUserNotification(db, userId, 'security', notificationPayload);
            sendNewDeviceLoginEmailForUser(userId, {
              deviceLabel,
              country,
              loginMethod,
              occurredAt: nowIso,
            });
          }
          return done();
        }
      );
    }
  );
}

function escapeCsvCell(value) {
  const raw = value == null ? '' : value.toString();
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}


function ensureUserSessionsSchema(done = () => {}) {
  if (!db) return done();

  db.run(`CREATE TABLE IF NOT EXISTS user_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    session_token TEXT NOT NULL UNIQUE,
    user_agent TEXT,
    device_label TEXT,
    browser TEXT,
    os TEXT,
    country TEXT,
    ip_hash TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    last_login_at TEXT,
    last_login_method TEXT,
    is_revoked INTEGER NOT NULL DEFAULT 0,
    revoked_at TEXT,
    device_fingerprint TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`, () => {
    db.all('PRAGMA table_info(user_sessions)', [], (tableErr, cols) => {
      const existing = new Set((cols || []).map((c) => c.name));
      const missing = [
        ['user_agent', 'TEXT'],
        ['device_label', 'TEXT'],
        ['browser', 'TEXT'],
        ['os', 'TEXT'],
        ['country', 'TEXT'],
        ['ip_hash', 'TEXT'],
        ['created_at', 'TEXT'],
        ['last_seen_at', 'TEXT'],
        ['last_login_at', 'TEXT'],
        ['last_login_method', 'TEXT'],
        ['is_revoked', 'INTEGER NOT NULL DEFAULT 0'],
        ['revoked_at', 'TEXT'],
        ['device_fingerprint', 'TEXT'],
      ].filter(([name]) => !existing.has(name));

      const addMissing = (idx) => {
        if (idx >= missing.length) {
          db.run('CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id)', () => {
            db.run('CREATE INDEX IF NOT EXISTS idx_user_sessions_last_seen ON user_sessions(last_seen_at)', () => {
              db.run('CREATE INDEX IF NOT EXISTS idx_user_sessions_device_fp ON user_sessions(user_id, device_fingerprint)', () => done());
            });
          });
          return;
        }
        const [colName, colType] = missing[idx];
        db.run(`ALTER TABLE user_sessions ADD COLUMN ${colName} ${colType}`, () => addMissing(idx + 1));
      };

      if (tableErr) {
        db.run('CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id)', () => {
          db.run('CREATE INDEX IF NOT EXISTS idx_user_sessions_last_seen ON user_sessions(last_seen_at)', () => {
            db.run('CREATE INDEX IF NOT EXISTS idx_user_sessions_device_fp ON user_sessions(user_id, device_fingerprint)', () => done());
          });
        });
        return;
      }

      addMissing(0);
    });
  });
}

const guestLimitStore = new Map();
function getGuestKey(req) {
  if (req && req.session) {
    if (!req.session.guestKey) {
      req.session.guestKey = crypto.randomBytes(16).toString('hex');
    }
    return req.session.guestKey;
  }
  return 'guest';
}

function buildGuestDailyLimitStoreKey(req, dayKey) {
  const guestKey = getGuestKey(req);
  const safeDayKey = (dayKey || '').toString().trim();
  return `ovlink:guest-limit:${guestKey}:${safeDayKey}`;
}

function normalizePlanTier(raw) {
  const value = (raw || '').toString().trim().toLowerCase();
  return value === PLAN_TIERS.PRO ? PLAN_TIERS.PRO : PLAN_TIERS.FREE;
}

function normalizePlanStatus(raw) {
  const value = (raw || '').toString().trim().toLowerCase();
  return value === PLAN_STATUS.PAUSED ? PLAN_STATUS.PAUSED : PLAN_STATUS.ACTIVE;
}

function parseIsoTimeMs(raw) {
  if (!raw) return Number.NaN;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

function isProAccessActive(userRow, nowMs = Date.now()) {
  if (!userRow) return false;
  const tier = normalizePlanTier(userRow.plan_tier);
  const status = normalizePlanStatus(userRow.plan_status);
  if (tier !== PLAN_TIERS.PRO || status !== PLAN_STATUS.ACTIVE) return false;
  const expiresMs = parseIsoTimeMs(userRow.pro_expires_at);
  if (!Number.isFinite(expiresMs)) return false;
  return expiresMs > nowMs;
}

function isProExpired(userRow, nowMs = Date.now()) {
  if (!userRow) return false;
  if (normalizePlanTier(userRow.plan_tier) !== PLAN_TIERS.PRO) return false;
  const expiresMs = parseIsoTimeMs(userRow.pro_expires_at);
  if (!Number.isFinite(expiresMs)) return true;
  return expiresMs <= nowMs;
}

function buildPlanPayload(userRow, nowMs = Date.now()) {
  const tier = normalizePlanTier(userRow && userRow.plan_tier);
  const status = normalizePlanStatus(userRow && userRow.plan_status);
  const expiresAt = userRow && userRow.pro_expires_at ? userRow.pro_expires_at : null;
  const pausedAt = userRow && userRow.pro_paused_at ? userRow.pro_paused_at : null;
  const expiresMs = parseIsoTimeMs(expiresAt);
  const remainingMs = Number.isFinite(expiresMs) ? Math.max(0, expiresMs - nowMs) : 0;
  const active = isProAccessActive(userRow, nowMs);
  return {
    tier,
    status,
    expires_at: expiresAt,
    paused_at: pausedAt,
    is_active: active,
    remaining_ms: remainingMs,
    features: active ? { ...PRO_FEATURES } : { api: false, webhooks: false, ip_security: false },
  };
}

function buildApiKeyValue() {
  return `ovk_${crypto.randomBytes(32).toString('base64url')}`;
}

function hashApiKeyValueLegacy(rawKey) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET).update((rawKey || '').toString()).digest('hex');
}

function hashApiKeyValueV2(rawKey) {
  return crypto.createHmac('sha256', API_KEY_HASH_KEY_MATERIAL).update((rawKey || '').toString()).digest('hex');
}

function hashWebhookSecretValueV2(rawSecret) {
  return crypto.createHmac('sha256', WEBHOOK_HASH_KEY_MATERIAL).update((rawSecret || '').toString()).digest('hex');
}

function hashApiKeyValue(rawKey) {
  return hashApiKeyValueV2(rawKey);
}

function decodeWebhookSignatureV2Key(rawValue) {
  const value = (rawValue || '').toString().trim();
  if (!value) return null;
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padLen = normalized.length % 4 === 0 ? 0 : (4 - (normalized.length % 4));
    const buf = Buffer.from(normalized + '='.repeat(padLen), 'base64');
    return buf && buf.length ? buf : null;
  } catch {
    return null;
  }
}

function getApiKeyPrefix(rawKey) {
  const value = (rawKey || '').toString();
  return value.slice(0, 12);
}

function getApiKeyLast4(rawKey) {
  const value = (rawKey || '').toString();
  return value.slice(-4);
}

function normalizeWebhookUrl(rawUrl) {
  const value = (rawUrl || '').toString().trim();
  if (!value) return '';
  try {
    const parsed = new URL(value);
    const isHttps = parsed.protocol === 'https:';
    const isHttpAllowed = ALLOW_INSECURE_WEBHOOK_HTTP && parsed.protocol === 'http:';
    if (!isHttps && !isHttpAllowed) return '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

const WEBHOOK_URL_DNS_TIMEOUT_MS = 5000;
const WEBHOOK_BLOCKED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  'metadata.google.internal',
  'metadata',
  'metadata.azure.internal',
  'metadata.aws.internal',
]);
const WEBHOOK_BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];
const WEBHOOK_IP_BLOCKLIST = new net.BlockList();

function addWebhookBlockedSubnet(address, prefix, family) {
  try {
    WEBHOOK_IP_BLOCKLIST.addSubnet(address, prefix, family);
  } catch {}
}

[
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.0.2.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['169.254.169.254', 32, 'ipv4'], // AWS IMDS
  ['100.100.100.200', 32, 'ipv4'], // Alibaba cloud metadata
  ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
  ['2001:db8::', 32, 'ipv6'],
].forEach(([address, prefix, family]) => addWebhookBlockedSubnet(address, prefix, family));

function normalizeIpCandidate(rawIp) {
  let value = (rawIp || '').toString().trim();
  if (!value) return '';
  if (value.startsWith('::ffff:')) value = value.slice(7);
  return value;
}

function isBlockedWebhookIp(rawIp) {
  const ip = normalizeIpCandidate(rawIp);
  if (!ip) return true;
  const version = net.isIP(ip);
  if (!version) return true;
  const family = version === 6 ? 'ipv6' : 'ipv4';
  return WEBHOOK_IP_BLOCKLIST.check(ip, family);
}

function isBlockedWebhookHostname(rawHostname) {
  const host = normalizeHostName(rawHostname);
  if (!host) return true;
  if (WEBHOOK_BLOCKED_HOSTS.has(host)) return true;
  return WEBHOOK_BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

async function resolveWebhookHostnameIps(hostname) {
  const host = normalizeHostName(hostname);
  if (!host) return [];
  const resolverPromise = dns.lookup(host, { all: true, verbatim: true })
    .then((rows) => (rows || []).map((row) => normalizeIpCandidate(row && row.address)).filter(Boolean))
    .catch(() => []);
  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => resolve([]), WEBHOOK_URL_DNS_TIMEOUT_MS);
  });
  const ips = await Promise.race([resolverPromise, timeoutPromise]);
  return Array.isArray(ips) ? ips : [];
}

async function validateOutboundWebhookUrl(rawUrl) {
  const normalized = normalizeWebhookUrl(rawUrl);
  if (!normalized) {
    return { ok: false, normalizedUrl: '', reason: 'invalid_url' };
  }

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    return { ok: false, normalizedUrl: '', reason: 'invalid_url' };
  }

  const hostnameRaw = (parsed.hostname || '').toString().trim().toLowerCase().replace(/\.+$/, '');
  if (!hostnameRaw) {
    return { ok: false, normalizedUrl: '', reason: 'invalid_host' };
  }

  const directIpVersion = net.isIP(hostnameRaw);
  if (directIpVersion) {
    if (isBlockedWebhookIp(hostnameRaw)) {
      return { ok: false, normalizedUrl: '', reason: 'blocked_ip' };
    }
    return { ok: true, normalizedUrl: normalized, reason: '', resolvedIps: [hostnameRaw] };
  }

  const hostname = normalizeHostName(hostnameRaw);
  if (!hostname) {
    return { ok: false, normalizedUrl: '', reason: 'invalid_host' };
  }
  if (isBlockedWebhookHostname(hostname)) {
    return { ok: false, normalizedUrl: '', reason: 'blocked_host' };
  }

  const resolvedIps = await resolveWebhookHostnameIps(hostname);
  if (!resolvedIps.length) {
    return { ok: false, normalizedUrl: '', reason: 'dns_unresolved' };
  }
  if (resolvedIps.some((ip) => isBlockedWebhookIp(ip))) {
    return { ok: false, normalizedUrl: '', reason: 'blocked_ip' };
  }

  return { ok: true, normalizedUrl: normalized, reason: '', resolvedIps };
}

function buildWebhookSignatureV2Key(rawSecret) {
  const secret = (rawSecret || '').toString().trim();
  if (!secret) return '';
  return crypto
    .createHash('sha256')
    .update(`ovlink:webhook-signature:v2|${secret}`)
    .digest('base64url');
}

function normalizeWebhookMessageLocale(rawLocale, fallback = 'auto') {
  const value = (rawLocale || '').toString().trim().toLowerCase();
  if (value === 'az' || value === 'tr' || value === 'en' || value === 'auto') {
    return value;
  }
  return fallback;
}

function normalizeWebhookMessageTemplate(rawTemplate) {
  const value = (rawTemplate || '').toString().replace(/\u0000/g, '').trim();
  if (!value) return '';
  return value.slice(0, 240);
}

function isDiscordIncomingWebhookUrl(rawUrl) {
  const value = (rawUrl || '').toString().trim();
  if (!value) return false;
  try {
    const parsed = new URL(value);
    const host = normalizeHostName(parsed.hostname || '');
    if (!host) return false;
    const isDiscordHost = host === 'discord.com'
      || host.endsWith('.discord.com')
      || host === 'discordapp.com'
      || host.endsWith('.discordapp.com');
    if (!isDiscordHost) return false;
    return /\/api\/webhooks\//i.test(parsed.pathname || '');
  } catch {
    return false;
  }
}

function shortenWebhookText(rawValue, maxLen = 240) {
  const value = (rawValue || '').toString().replace(/\s+/g, ' ').trim();
  if (!value) return '';
  if (value.length <= maxLen) return value;
  return `${value.slice(0, Math.max(0, maxLen - 1))}…`;
}

function formatWebhookTimestampForMessage(rawIso) {
  const ms = Date.parse((rawIso || '').toString());
  if (!Number.isFinite(ms)) return '';
  const dt = new Date(ms);
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = String(dt.getUTCFullYear());
  const hh = String(dt.getUTCHours()).padStart(2, '0');
  const mi = String(dt.getUTCMinutes()).padStart(2, '0');
  const ss = String(dt.getUTCSeconds()).padStart(2, '0');
  return `${dd}.${mm}.${yyyy} ${hh}:${mi}:${ss} UTC`;
}

function resolveWebhookMessageLocale(webhookRow) {
  const configured = normalizeWebhookMessageLocale(webhookRow && webhookRow.message_locale, 'auto');
  if (configured !== 'auto') return configured;
  return normalizeLang(webhookRow && webhookRow.user_ui_lang, 'en');
}

function getWebhookMessageLabels(locale) {
  if (locale === 'tr') {
    return {
      event: 'Ovlink etkinliği',
      deliveryId: 'Teslimat ID',
      attempt: 'Deneme',
      shortUrl: 'Kısa URL',
      originalUrl: 'Orijinal URL',
      domain: 'Alan adı',
      sentAt: 'Gönderim zamanı',
    };
  }
  if (locale === 'az') {
    return {
      event: 'Ovlink hadisəsi',
      deliveryId: 'Çatdırılma ID',
      attempt: 'Cəhd',
      shortUrl: 'Qısa URL',
      originalUrl: 'Orijinal URL',
      domain: 'Domen',
      sentAt: 'Göndərilmə vaxtı',
    };
  }
  return {
    event: 'Ovlink event',
    deliveryId: 'Delivery ID',
    attempt: 'Attempt',
    shortUrl: 'Short URL',
    originalUrl: 'Original URL',
    domain: 'Domain',
    sentAt: 'Sent at',
  };
}

function applyWebhookMessageTemplate(template, tokens) {
  const source = normalizeWebhookMessageTemplate(template);
  if (!source) return '';
  const map = tokens && typeof tokens === 'object' ? tokens : {};
  return source.replace(/\{([a-z0-9_]+)\}/gi, (full, keyRaw) => {
    const key = (keyRaw || '').toString().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(map, key)) return full;
    const value = map[key];
    return value === null || value === undefined ? '' : `${value}`;
  });
}

function buildDiscordWebhookPayload(eventPayload, webhookRow = null) {
  const payload = eventPayload && typeof eventPayload === 'object' ? eventPayload : {};
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};
  const locale = resolveWebhookMessageLocale(webhookRow);
  const labels = getWebhookMessageLabels(locale);
  const eventName = shortenWebhookText(payload.event || 'event', 64);
  const deliveryId = Number.parseInt(payload.delivery_id || '0', 10);
  const attempt = Number.parseInt(payload.attempt || '1', 10) || 1;
  const sentAt = formatWebhookTimestampForMessage(payload.sent_at) || shortenWebhookText(payload.sent_at || '', 40);
  const shortUrl = shortenWebhookText(data.short_url || data.short || '', 280);
  const originalUrl = shortenWebhookText(data.original_url || '', 280);
  const domain = shortenWebhookText(data.domain || '', 120);

  const templateText = applyWebhookMessageTemplate(webhookRow && webhookRow.message_template, {
    event: eventName,
    delivery_id: deliveryId > 0 ? String(deliveryId) : '',
    attempt: String(attempt),
    sent_at: sentAt,
    short_url: shortUrl,
    original_url: originalUrl,
    domain: domain,
  });

  const lines = [];
  lines.push(templateText || `${labels.event}: ${eventName || 'event'}`);
  if (deliveryId > 0) lines.push(`${labels.deliveryId}: #${deliveryId}`);
  lines.push(`${labels.attempt}: ${attempt}`);
  if (shortUrl) lines.push(`${labels.shortUrl}: ${shortUrl}`);
  if (originalUrl) lines.push(`${labels.originalUrl}: ${originalUrl}`);
  if (domain) lines.push(`${labels.domain}: ${domain}`);
  if (sentAt) lines.push(`${labels.sentAt}: ${sentAt}`);

  const content = shortenWebhookText(lines.join('\n'), 1800) || 'Ovlink webhook event';
  return {
    content,
    allowed_mentions: { parse: [] },
  };
}

function normalizeWebhookEvents(raw) {
  const items = Array.isArray(raw) ? raw : (raw || '').toString().split(',');
  const unique = new Set();
  for (const item of items) {
    const value = (item || '').toString().trim().toLowerCase();
    if (!value) continue;
    if (!/^[a-z0-9._:-]{2,64}$/.test(value)) continue;
    unique.add(value);
  }
  if (!unique.size) {
    unique.add('link.created');
    unique.add('link.updated');
    unique.add('link.deleted');
    unique.add('webhook.test');
  }
  return Array.from(unique);
}

function webhookHasEvent(webhookRow, eventName) {
  const event = (eventName || '').toString().trim().toLowerCase();
  if (!event) return false;
  const events = normalizeWebhookEvents((webhookRow && webhookRow.events) || '');
  return events.includes('*') || events.includes(event);
}

function computeWebhookRetryDelayMs(nextAttemptNumber) {
  const safeAttempt = Math.max(1, Number.parseInt(nextAttemptNumber, 10) || 1);
  const delay = WEBHOOK_RETRY_BASE_MS * (2 ** Math.max(0, safeAttempt - 1));
  return Math.min(delay, 30 * 60 * 1000);
}

function safeJsonStringify(value, maxLen = 5000) {
  let out = '{}';
  try {
    out = JSON.stringify(value || {});
  } catch {
    out = '{}';
  }
  if (out.length > maxLen) return out.slice(0, maxLen);
  return out;
}

const API_USAGE_LOGS_CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS api_usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  api_key_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  error_type TEXT NOT NULL DEFAULT 'ok',
  created_at TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(api_key_id) REFERENCES api_keys(id)
)`;
const API_USAGE_LOGS_INDEX_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_api_usage_user_created ON api_usage_logs(user_id, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_api_usage_key_created ON api_usage_logs(api_key_id, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_api_usage_user_error ON api_usage_logs(user_id, error_type, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_api_usage_user_method ON api_usage_logs(user_id, method, created_at)',
];
let apiUsageLogsSchemaReady = false;
let apiUsageLogsSchemaPromise = null;

function ensureApiUsageLogsSchema(force = false) {
  if (!db) return Promise.resolve(false);
  if (!force && apiUsageLogsSchemaReady) return Promise.resolve(true);
  if (!force && apiUsageLogsSchemaPromise) return apiUsageLogsSchemaPromise;

  apiUsageLogsSchemaPromise = new Promise((resolve) => {
    db.serialize(() => {
      db.run(API_USAGE_LOGS_CREATE_TABLE_SQL, () => {});
      API_USAGE_LOGS_INDEX_SQL.forEach((sql) => db.run(sql, () => {}));
      db.get(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'api_usage_logs' LIMIT 1",
        (err, row) => {
          const ready = !err && !!(row && row.name);
          apiUsageLogsSchemaReady = ready;
          apiUsageLogsSchemaPromise = null;
          resolve(ready);
        }
      );
    });
  });
  return apiUsageLogsSchemaPromise;
}

function insertApiUsageLogRow(entry = {}) {
  if (!db) return;
  const userId = Number.parseInt(entry.user_id, 10);
  const apiKeyId = Number.parseInt(entry.api_key_id, 10);
  if (!Number.isInteger(userId) || userId <= 0) return;
  if (!Number.isInteger(apiKeyId) || apiKeyId <= 0) return;

  const endpoint = ((entry.endpoint || '/api/pro/v1') + '').slice(0, 180);
  const method = ((entry.method || 'GET') + '').toUpperCase().slice(0, 16);
  const statusCode = Number.parseInt(entry.status_code, 10) || 0;
  const errorType = ((entry.error_type || classifyApiUsageErrorType(statusCode)) + '').slice(0, 64);
  const createdAt = ((entry.created_at || new Date().toISOString()) + '').slice(0, 40);
  const params = [userId, apiKeyId, endpoint, method, statusCode, errorType, createdAt];

  const runInsert = (isRetry = false) => {
    db.run(
      'INSERT INTO api_usage_logs (user_id, api_key_id, endpoint, method, status_code, error_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      params,
      (err) => {
        if (!err) {
          apiUsageLogsSchemaReady = true;
          return;
        }
        const message = ((err && err.message) || '').toLowerCase();
        if (!isRetry && message.includes('no such table')) {
          apiUsageLogsSchemaReady = false;
          void ensureApiUsageLogsSchema(true).then((ready) => {
            if (ready) runInsert(true);
          });
        }
      }
    );
  };

  void ensureApiUsageLogsSchema().then((ready) => {
    if (!ready) return;
    runInsert(false);
  });
}

function logSecurityEvent(req, eventType, outcome, details = {}) {
  if (!db) return;
  const now = new Date().toISOString();
  const ipRaw = getRequestIp(req);
  const ipHash = buildNetworkFingerprintForDisplay(ipRaw);
  const ipMasked = maskIpForDisplay(ipRaw);
  const userAgent = ((req && req.get && req.get('user-agent')) || '').toString().slice(0, 512);
  const userId = Number.isInteger(details.user_id) ? details.user_id : (req && req.session && req.session.userId ? req.session.userId : null);
  const apiKeyId = Number.isInteger(details.api_key_id) ? details.api_key_id : null;
  const sanitizedDetails = { ...details };
  delete sanitizedDetails.user_id;
  delete sanitizedDetails.api_key_id;
  const detailsJson = safeJsonStringify(sanitizedDetails, 4000);

  db.run(
    'INSERT INTO security_events (created_at, event_type, outcome, user_id, api_key_id, ip_hash, ip_masked, user_agent, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [now, (eventType || '').toString().slice(0, 128), (outcome || '').toString().slice(0, 32), userId, apiKeyId, ipHash || null, ipMasked || null, userAgent, detailsJson],
    () => {}
  );
}

function purgeSecurityEvents() {
  if (!db) return;
  const cutoff = new Date(Date.now() - (SECURITY_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000)).toISOString();
  db.run("DELETE FROM security_events WHERE datetime(created_at) < datetime(?)", [cutoff], () => {});
}

function scheduleSecurityEventPurge() {
  purgeSecurityEvents();
  const timer = setInterval(() => {
    purgeSecurityEvents();
  }, 24 * 60 * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
}

function purgeExpiredApiIdempotencyKeys() {
  if (!db) return;
  const nowIso = new Date().toISOString();
  db.run('DELETE FROM api_idempotency_keys WHERE expires_at <= ?', [nowIso], () => {});
}

function scheduleApiIdempotencyPurge() {
  purgeExpiredApiIdempotencyKeys();
  const timer = setInterval(() => {
    purgeExpiredApiIdempotencyKeys();
  }, 60 * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
}

function purgeApiUsageLogs() {
  if (!db) return;
  const cutoff = new Date(Date.now() - (PRO_API_USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000)).toISOString();
  void ensureApiUsageLogsSchema().then((ready) => {
    if (!ready) return;
    db.run('DELETE FROM api_usage_logs WHERE datetime(created_at) < datetime(?)', [cutoff], () => {});
  });
}

function scheduleApiUsageLogPurge() {
  purgeApiUsageLogs();
  const timer = setInterval(() => {
    purgeApiUsageLogs();
  }, 6 * 60 * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
}

function createUserNotification(db, userId, type, payload = {}) {
  if (!db || !userId) return;
  const {
    titleAz = '',
    titleTr = '',
    titleEn = '',
    bodyAz = '',
    bodyTr = '',
    bodyEn = '',
    linkShort = null,
    eventKey = null,
  } = payload;

  const finalTitleEn = titleEn || titleAz || titleTr || '';
  const finalBodyEn = bodyEn || bodyAz || bodyTr || '';

  db.get(
    'SELECT notify_report, notify_limit, notify_disabled FROM users WHERE id = ?',
    [userId],
    (err, row) => {
      if (err || !row) return;
      if (type === 'report' && row.notify_report != 1) return;
      if (type === 'limit' && row.notify_limit != 1) return;
      if (type === 'disabled' && row.notify_disabled != 1) return;

      const createdAt = new Date().toISOString();
      db.run(
        'INSERT OR IGNORE INTO notifications (user_id, type, title_az, title_tr, title_en, body_az, body_tr, body_en, link_short, event_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          userId,
          type,
          titleAz,
          titleTr,
          finalTitleEn,
          bodyAz,
          bodyTr,
          finalBodyEn,
          linkShort,
          eventKey,
          createdAt,
        ],
      );
    }
  );
}

function buildAnnouncementHtml() {
  if (!siteSettings || siteSettings.announcement_enabled !== '1') return '';
  const az = (siteSettings.announcement_text_az || '').toString();
  const tr = (siteSettings.announcement_text_tr || '').toString();
  const en = (siteSettings.announcement_text_en || '').toString();
  const text = az || tr || en;
  if (!text) return '';
  return `
    <div id="siteAnnouncement" class="site-announcement" data-az="${escapeHtml(az)}" data-tr="${escapeHtml(tr)}" data-en="${escapeHtml(en)}">
      <div class="container">
        <i class="fa-solid fa-bullhorn"></i>
        <span id="siteAnnouncementText">${escapeHtml(text)}</span>
      </div>
    </div>
  `;
}



function pickLang(lang, az, tr, en) {
  if (lang === 'tr') return tr;
  if (lang === 'en') return en;
  return az;
}

function normalizeLang(lang, fallback = 'az') {
  return (lang === 'tr' || lang === 'az' || lang === 'en') ? lang : fallback;
}


function getPublicBaseUrl(req) {
  const configured = getConfiguredPublicBaseUrl();
  if (configured) return configured;

  const proto = req.secure ? 'https' : 'http';
  const hostHeader = getSafeHostHeader(req);
  const host = normalizeHostName(hostHeader);

  // Avoid host-header poisoning: only accept first-party/internal hosts.
  if (hostHeader && host && isInternalHost(host)) {
    return `${proto}://${hostHeader.toLowerCase()}`.replace(/\/+$/, '');
  }

  const fallbackHost = getConfiguredBaseHost() || 'localhost';
  return `${proto}://${fallbackHost}`.replace(/\/+$/, '');
}

function buildAbsoluteUrl(req, pathValue) {
  const base = getPublicBaseUrl(req) + '/';
  const safePath = (pathValue || '/').toString();
  try {
    return new URL(safePath.startsWith('/') ? safePath : `/${safePath}`, base).toString();
  } catch {
    return base;
  }
}

function getLangFromCookie(req) {
  const raw = getCookieValue(req, 'lang_default');
  return raw || null;
}

const DEFAULT_SEO_KEYWORDS = Object.freeze([
  'ovlink',
  'url shortener',
  'link shortener',
  'custom short links',
  'qr code generator',
  'best link shortening sites 2026',
  'top url shorteners 2026 features',
  'link shortening sites',
  'best url shorteners',
  'free url shortener websites',
  'tinyurl alternatives',
  'popular url shortener tools',
  'best url shortener sites 2025',
  'link shortening services comparison',
  'free branded link shortener',
  'url shortener with analytics',
  'top link management platforms',
  'best link shortening sites 2025',
  'top free url shortener for business',
  'link shortener with custom domain free',
  'best link shortening sites',
  'popular URL shortener services',
  'free link shortener websites',
  'best URL shorteners 2025 comparison',
  'free custom domain URL shortener',
  'are URL shorteners safe security risks phishing malware',
]);

function normalizeSeoKeywords(rawKeywords) {
  const output = [];
  const seen = new Set();
  const pushKeyword = (value) => {
    const keyword = (value || '').toString().trim();
    if (!keyword) return;
    const key = keyword.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    output.push(keyword);
  };

  if (Array.isArray(rawKeywords)) {
    rawKeywords.forEach(pushKeyword);
  } else if (typeof rawKeywords === 'string') {
    rawKeywords.split(',').forEach(pushKeyword);
  }

  return output;
}

function buildSeo(req, opts = {}) {
  const base = getPublicBaseUrl(req);
  const rawLang = getLangFromCookie(req) || req.defaultLang || 'en';
  const lang = normalizeLang(rawLang, 'en');
  const title = pickLang(lang, opts.titleAz || 'Ovlink', opts.titleTr || 'Ovlink', opts.titleEn || 'Ovlink');
  const description = pickLang(lang, opts.descAz || '', opts.descTr || '', opts.descEn || '');
  const keywords = normalizeSeoKeywords([
    ...DEFAULT_SEO_KEYWORDS,
    ...normalizeSeoKeywords(opts.keywords || []),
  ]).join(', ');
  const path = (opts.path || req.path || '/').toString();
  const canonical = base + path;
  const org = { "@context": "https://schema.org", "@type": "Organization", "name": "Ovlink", "url": base };
  const website = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "name": "Ovlink",
    "url": base,
    "potentialAction": {
      "@type": "SearchAction",
      "target": `${base}/?q={search_term_string}`,
      "query-input": "required name=search_term_string"
    }
  };
  const hreflangEn = base + path + (path.includes('?') ? '&' : '?') + 'lang=en';
  const hreflangAz = base + path + (path.includes('?') ? '&' : '?') + 'lang=az';
  const hreflangTr = base + path + (path.includes('?') ? '&' : '?') + 'lang=tr';
  const hreflangXDefault = hreflangEn;
  return {
    lang,
    title,
    description,
    keywords,
    canonical,
    ogTitle: title,
    ogDescription: description,
    ogUrl: canonical,
    twitterTitle: title,
    twitterDescription: description,
    hreflangEn,
    hreflangAz,
    hreflangTr,
    hreflangXDefault,
    jsonLd: JSON.stringify([org, website])
  };
}


function formatRemaining(ms, lang) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(days + ' ' + (lang === 'en' ? 'day' : (lang === 'tr' ? 'gün' : 'gün')));
  if (hours) parts.push(hours + ' ' + (lang === 'en' ? 'hour' : (lang === 'tr' ? 'saat' : 'saat')));
  if (!parts.length || minutes) parts.push(minutes + ' ' + (lang === 'en' ? 'minute' : (lang === 'tr' ? 'dakika' : 'dəqiqə')));
  return parts.join(' ');
}

function formatBanInfo(untilIso, lang) {
  if (!untilIso) return { untilText: '', remainingText: '' };
  const date = new Date(untilIso);
  if (Number.isNaN(date.getTime())) return { untilText: untilIso, remainingText: '' };
  const locale = (lang === 'tr') ? 'tr-TR' : (lang === 'en' ? 'en-US' : 'az-AZ');
  const untilText = date.toLocaleString(locale, {
    year: 'numeric',
    month: 'long',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
  const remainingText = formatRemaining(date.getTime() - Date.now(), lang);
  return { untilText, remainingText };
}

function buildBanMessage(uiLang, banUntil, banReason) {
  const lang = normalizeLang(uiLang, 'az');
  let msg = lang === 'tr'
    ? 'Bu hesap engellendi.'
    : (lang === 'en' ? 'This account is blocked.' : 'Bu hesab bloklanıb.');
  const info = formatBanInfo(banUntil, lang);
  if (info.untilText) {
    msg += lang === 'tr'
      ? (' Engelin bitişi: ' + info.untilText)
      : (lang === 'en' ? (' Ban ends: ' + info.untilText) : (' Blok bitişi: ' + info.untilText));
  }
  if (info.remainingText) {
    msg += lang === 'tr'
      ? (' (Kalan süre: ' + info.remainingText + ')')
      : (lang === 'en' ? (' (Time left: ' + info.remainingText + ')') : (' (Qalan müddət: ' + info.remainingText + ')'));
  }
  if (banReason) {
    msg += lang === 'tr'
      ? (' Sebep: ' + banReason)
      : (lang === 'en' ? (' Reason: ' + banReason) : (' Səbəb: ' + banReason));
  }
  msg += lang === 'tr'
    ? ' Destek: support@ovlink.sbs'
    : (lang === 'en' ? ' Support: support@ovlink.sbs' : ' Dəstək: support@ovlink.sbs');
  return msg;
}


// ========================
// GÜVENLİK MİDDLEWARE'LERİ
// ========================

// Nonce oluşturucu middleware
app.use((req, res, next) => {
  res.locals.nonce = crypto.randomBytes(16).toString('base64');
  next();
});

// Helmet - HTTP güvenlik başlıkları (Sıkılaştırılmış)
// Third-party ad scripts are isolated under /ads/* sandbox routes,
// so the main app CSP can stay strict without broad dynamic allowlists.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      scriptSrc: [
        "'self'",
        (req, res) => `'nonce-${res.locals.nonce}'`,
        "https://cdn.jsdelivr.net",
        "https://cdnjs.cloudflare.com",
        "https://unpkg.com"
      ],
      scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`, "https://fonts.googleapis.com", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com", "https://unpkg.com"],
      // Existing templates use inline style attributes in a few places.
      // Keep this until those style attributes are migrated to CSS classes.
      styleSrcAttr: ["'unsafe-inline'"],
      fontSrc: ["'self'", "https://cdnjs.cloudflare.com", "https://fonts.gstatic.com", "data:"],
      imgSrc: [
        "'self'",
        "data:",
        "blob:"
      ],
      connectSrc: [
        "'self'",
        "https://cdn.jsdelivr.net",
        "https://fonts.googleapis.com",
        "https://fonts.gstatic.com"
      ],
      frameSrc: ["'self'"],
      manifestSrc: ["'self'"],
      mediaSrc: ["'self'"],
      workerSrc: ["'self'"],
      upgradeInsecureRequests: []
    }
  },
  crossOriginEmbedderPolicy: false,
  hsts: isProd ? {
    maxAge: 15552000,
    includeSubDomains: true,
    preload: true
  } : false,
  frameguard: {
    action: 'deny'
  }
}));

// Explicitly restrict powerful browser features.
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // Deprecated in modern browsers, but kept explicit to satisfy strict header checks.
  res.setHeader('Expect-CT', isProd ? 'max-age=86400, enforce' : 'max-age=0');
  next();
});


// Rate Limiting - Brute-force saldırılarını engeller
const generalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 dakika
  max: 250, // Maksimum 250 istek
  message: { error: 'Çok fazla istek gönderdiniz. Lütfen 1 dakika sonra tekrar deneyin.' },
  ...(redisClient ? { store: createRateLimitStore('general') } : {}),
  keyGenerator: (req) => buildRateLimitKey(req, 'general'),
  standardHeaders: true,
  legacyHeaders: false
});

// Giriş için daha sıkı rate limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 dakika
  max: 10, // Maksimum 10 giriş denemesi
  message: { error: 'Çok fazla giriş denemesi. Lütfen 15 dakika sonra tekrar deneyin.' },
  ...(redisClient ? { store: createRateLimitStore('auth') } : {}),
  keyGenerator: (req) => {
    const emailHint = ((req.body && req.body.email) || '').toString().trim().toLowerCase().slice(0, 120);
    const base = buildRateLimitKey(req, 'auth');
    return emailHint ? `${base}:email:${emailHint}` : base;
  },
  standardHeaders: true,
  legacyHeaders: false
});

// URL kısaltma için rate limiting
const shortenLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 dakika
  max: 25, // 5 dakikada 25 link
  message: { error: 'Çok fazla link oluşturdunuz. Lütfen 5 dakika sonra tekrar deneyin.' },
  ...(redisClient ? { store: createRateLimitStore('shorten') } : {}),
  keyGenerator: (req) => buildRateLimitKey(req, 'shorten'),
  standardHeaders: true,
  legacyHeaders: false
});

// Raporlama için rate limiting
const reportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 dakika
  max: 15, // 15 dakikada 15 rapor
  message: { error: 'Çok fazla şikayet gönderdiniz. Lütfen 15 dakika sonra tekrar deneyin.' },
  ...(redisClient ? { store: createRateLimitStore('report') } : {}),
  keyGenerator: (req) => buildRateLimitKey(req, 'report'),
  standardHeaders: true,
  legacyHeaders: false
});

// Pro management endpoints: balanced limits (security + usable UX)
const proReadLimiter = rateLimit({
  windowMs: PRO_API_READ_RATE_LIMIT_WINDOW_MS,
  max: PRO_API_READ_RATE_LIMIT_MAX,
  message: { error: 'Too many requests. Please try again shortly.' },
  ...(redisClient ? { store: createRateLimitStore('pro-read') } : {}),
  keyGenerator: (req) => buildRateLimitKey(req, 'pro-read'),
  standardHeaders: true,
  legacyHeaders: false,
});

const proWriteLimiter = rateLimit({
  windowMs: PRO_API_WRITE_RATE_LIMIT_WINDOW_MS,
  max: PRO_API_WRITE_RATE_LIMIT_MAX,
  message: { error: 'Too many write requests. Please slow down.' },
  ...(redisClient ? { store: createRateLimitStore('pro-write') } : {}),
  keyGenerator: (req) => buildRateLimitKey(req, 'pro-write'),
  standardHeaders: true,
  legacyHeaders: false,
});

const proKeyCreateLimiter = rateLimit({
  windowMs: PRO_API_KEY_CREATE_RATE_LIMIT_WINDOW_MS,
  max: PRO_API_KEY_CREATE_RATE_LIMIT_MAX,
  message: { error: 'Too many key creation attempts. Please try again later.' },
  ...(redisClient ? { store: createRateLimitStore('pro-key-create') } : {}),
  keyGenerator: (req) => buildRateLimitKey(req, 'pro-key-create'),
  standardHeaders: true,
  legacyHeaders: false,
});

// Genel rate limiter'ı uygula (sadece GET, admin GET hariç)
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/admin')) {
    return generalLimiter(req, res, next);
  }
  return next();
});

// Geçici e-posta sağlayıcıları (fake adresleri engellemek için)
const tempEmailDomains = ['mailinator.com', 'tempmail.com', '10minutemail.com'];

// Resend API client
const resend = new Resend(process.env.RESEND_API_KEY);


function sendVerificationEmail(to, code, lang = 'az') {
  const uiLang = normalizeLang(lang, 'az');
  const subject = pickLang(uiLang, "Ovlink Təsdiqləmə Kodunuz: " + code, "Ovlink Doğrulama Kodunuz: " + code, "Ovlink Verification Code: " + code);

  const translations = {
    tr: {
      welcome: "Hoş Geldiniz!",
      instruction: "Hesabınızı doğrulamak ve Ovlink'in tüm özelliklerinden yararlanmak için aşağıdaki 6 haneli kodu kullanın.",
      codeLabel: "DOĞRULAMA KODUNUZ",
      warning: "Bu kod 30 dakika süreyle geçerlidir. Eğer bu işlemi siz yapmadıysanız, bu e-postayı güvenle silebilirsiniz.",
      buttonText: "Kodu Doğrula",
      footer: "© 2026 Ovlink. Tüm hakları saklıdır."
    },
    az: {
      welcome: "Xoş Gəldiniz!",
      instruction: "Hesabınızı təsdiqləmək və Ovlink-in bütün imkanlarından yararlanmaq üçün aşağıdakı 6 rəqəmli kodu istifadə edin.",
      codeLabel: "TƏSDİQLƏMƏ KODUNUZ",
      warning: "Bu kod 30 dəqiqə ərzində keçərlidir. Əgər bu əməliyyatı siz etməmisinizsə, bu e-poçtu təhlükəsiz şəkildə silə bilərsiniz.",
      buttonText: "Kodu Təsdiqlə",
      footer: "© 2026 Ovlink. Bütün hüquqlar qorunur."
    },
    en: {
      welcome: "Welcome!",
      instruction: "Use the 6-digit code below to verify your account and access all Ovlink features.",
      codeLabel: "YOUR VERIFICATION CODE",
      warning: "This code is valid for 30 minutes. If you did not request this, you can safely ignore this email.",
      buttonText: "Verify Code",
      footer: "© 2026 Ovlink. All rights reserved."
    }
  };

  const t = translations[uiLang] || translations.az;

  const html = `
    <!DOCTYPE html>
    <html lang="${uiLang}">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${subject}</title>
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
        
        body { margin: 0; padding: 0; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f8fafc; color: #1e293b; }
        .wrapper { width: 100%; table-layout: fixed; background-color: #f8fafc; padding-bottom: 40px; }
        .main { background-color: #ffffff; margin: 40px auto; width: 100%; max-width: 600px; border-radius: 24px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04); }
        .header { background: linear-gradient(135deg, #2563eb 0%, #1e40af 100%); padding: 60px 40px; text-align: center; }
        .logo { color: #ffffff; font-size: 32px; font-weight: 800; letter-spacing: -0.025em; margin: 0; }
        .content { padding: 48px 40px; text-align: center; }
        h1 { font-size: 28px; font-weight: 700; color: #0f172a; margin-bottom: 16px; margin-top: 0; }
        p { font-size: 16px; line-height: 1.6; color: #475569; margin-bottom: 32px; }
        .code-container { background: #f1f5f9; border-radius: 16px; padding: 32px; margin-bottom: 32px; border: 2px solid #e2e8f0; position: relative; }
        .code-label { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #64748b; margin-bottom: 12px; display: block; }
        .code { font-size: 48px; font-weight: 800; color: #2563eb; letter-spacing: 0.2em; margin: 0; text-shadow: 0 2px 4px rgba(37, 99, 235, 0.1); }
        .btn { display: inline-block; padding: 16px 32px; background-color: #2563eb; color: #ffffff !important; text-decoration: none; border-radius: 12px; font-weight: 600; font-size: 16px; transition: all 0.2s; box-shadow: 0 4px 6px -1px rgba(37, 99, 235, 0.2); }
        .warning { font-size: 14px; color: #94a3b8; margin-top: 32px; padding: 20px; border-top: 1px solid #f1f5f9; }
        .footer { text-align: center; padding: 24px 40px; color: #94a3b8; font-size: 13px; }
        
        /* Modern animasyon simulyasiyası */
        @keyframes pulse {
          0% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.02); opacity: 0.95; }
          100% { transform: scale(1); opacity: 1; }
        }
        .animate-pulse { animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
      </style>
    </head>
    <body>
      <div class="wrapper">
        <div class="main">
          <div class="header">
            <div class="logo">OVLINK</div>
          </div>
          <div class="content">
            <h1>${t.welcome}</h1>
            <p>${t.instruction}</p>
            <div class="code-container animate-pulse">
              <span class="code-label">${t.codeLabel}</span>
              <div class="code">${code}</div>
            </div>
            <p class="warning">${t.warning}</p>
          </div>
          <div class="footer">
            ${t.footer}<br>
            Developed with &hearts; by Ulvi Ahadov
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  return resend.emails.send({
    from: process.env.FROM_EMAIL || 'Ovlink <onboarding@resend.dev>',
    to,
    subject,
    text: `${t.instruction}\n\n${t.codeLabel}: ${code}\n\n${t.warning}`,
    html
  });
}

function sendPasswordResetEmail(to, resetUrl, lang = 'az') {
  const uiLang = normalizeLang(lang, 'az');
  const subject = pickLang(uiLang, 'Şifrə Sıfırlama Linki', 'Şifre Sıfırlama Bağlantısı', 'Password Reset Link');
  const title = pickLang(uiLang, 'Şifrəni Sıfırlayın', 'Şifrenizi Sıfırlayın', 'Reset your password');
  const body = pickLang(uiLang, 'Şifrəni sıfırlamaq üçün aşağıdakı linkdən istifadə edin. Bu link 30 dəqiqə etibarlıdır.', 'Şifrenizi sıfırlamak için aşağıdaki bağlantıyı kullanın. Bu bağlantı 30 dakika geçerlidir.', 'Use the link below to reset your password. This link is valid for 30 minutes.');
  const button = pickLang(uiLang, 'Şifrəni Sıfırla', 'Şifreyi Sıfırla', 'Reset Password');
  const footer = pickLang(uiLang, 'Əgər bu istəyi siz etməmisinizsə, bu e-poçtu nəzərə almayın.', 'Eğer bu isteği siz yapmadıysanız, bu e-postayı yok sayın.', 'If you did not request this, you can ignore this email.');

  const html = `
    <!DOCTYPE html>
    <html lang="${uiLang}">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${subject}</title>
    </head>
    <body style="margin:0; padding:0; font-family:Arial, sans-serif; background:#f8fafc; color:#0f172a;">
      <div style="max-width:600px; margin:40px auto; background:#ffffff; border-radius:18px; padding:32px; border:1px solid #e2e8f0;">
        <h1 style="margin-top:0;">${title}</h1>
        <p style="line-height:1.6;">${body}</p>
        <div style="margin:24px 0;">
          <a href="${resetUrl}" style="display:inline-block; padding:12px 20px; background:#2563eb; color:#ffffff; text-decoration:none; border-radius:10px; font-weight:700;">${button}</a>
        </div>
        <p style="font-size:13px; color:#64748b;">${footer}</p>
      </div>
    </body>
    </html>
  `;

  return resend.emails.send({
    from: process.env.FROM_EMAIL || 'Ovlink <onboarding@resend.dev>',
    to,
    subject,
    text: `${body} ${resetUrl}`,
    html
  });
}

function sendNewDeviceLoginEmail(to, details = {}, lang = 'en') {
  if (!process.env.RESEND_API_KEY) return Promise.resolve(null);

  const uiLang = normalizeLang(lang, 'en');
  const safeTo = (to || '').toString().trim();
  if (!safeTo) return Promise.resolve(null);

  const deviceLabel = (details.deviceLabel || 'Unknown device').toString();
  const countryRaw = (details.country || '').toString().trim();
  const country = countryRaw || pickLang(uiLang, 'Naməlum', 'Bilinmiyor', 'Unknown');
  const loginMethod = (details.loginMethod || 'password').toString();
  const occurredAtRaw = (details.occurredAt || '').toString();
  const occurredAtDate = occurredAtRaw ? new Date(occurredAtRaw) : new Date();
  const locale = uiLang === 'tr' ? 'tr-TR' : (uiLang === 'en' ? 'en-US' : 'az-AZ');
  const occurredAt = Number.isNaN(occurredAtDate.getTime())
    ? occurredAtRaw
    : occurredAtDate.toLocaleString(locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

  const subject = pickLang(uiLang, 'Ovlink: Yeni cihazdan giriş', 'Ovlink: Yeni cihazdan giriş', 'Ovlink: New device sign-in');
  const title = pickLang(uiLang, 'Yeni cihazdan giriş aşkarlandı', 'Yeni cihazdan giriş algılandı', 'New device sign-in detected');
  const intro = pickLang(
    uiLang,
    'Hesabınıza yeni bir cihazdan giriş edildi. Bu siz deyildinizsə, təhlükəsizlik üçün şifrənizi dərhal yeniləyin.',
    'Hesabınıza yeni bir cihazdan giriş yapıldı. Bu size ait değilse güvenlik için şifrenizi hemen yenileyin.',
    'A new device signed in to your account. If this was not you, reset your password immediately.'
  );
  const locationNote = pickLang(
    uiLang,
    'Ölkə məlumatı təxmini ola bilər (VPN/proxy və ya operator marşrutlaması səbəbilə).',
    'Ülke bilgisi tahmini olabilir (VPN/proxy veya operatör yönlendirmesi nedeniyle).',
    'Country may be approximate (VPN/proxy or carrier routing can affect this).'
  );
  const privacyNote = pickLang(
    uiLang,
    'Bu giriş bildirişi üçün tam IP ünvanı e-poçtda göstərilmir.',
    'Bu giriş bildirimi için tam IP adresi e-postada gösterilmez.',
    'For this sign-in alert, the full IP address is not shown in email.'
  );

  const methodLabel = buildLoginMethodLabel(loginMethod, uiLang);
  const timeLabel = pickLang(uiLang, 'Vaxt', 'Zaman', 'Time');
  const deviceTitle = pickLang(uiLang, 'Cihaz', 'Cihaz', 'Device');
  const countryTitle = pickLang(uiLang, 'Təxmini ölkə', 'Tahmini ülke', 'Approximate country');
  const methodTitle = pickLang(uiLang, 'Metod', 'Yöntem', 'Method');

  const siteBase = getConfiguredPublicBaseUrl() || 'https://ovlink.sbs';
  const resetPasswordUrl = `${siteBase}/forgot-password`;
  const contactUrl = `${siteBase}/contact`;
  const resetBtn = pickLang(uiLang, 'Şifrəni yenilə', 'Şifreyi yenile', 'Reset password');
  const contactBtn = pickLang(uiLang, 'Dəstək ilə əlaqə', 'Destek ile iletişim', 'Contact support');

  const rows = [
    `<tr><td style="padding:10px 0;color:#667085;font-size:13px;">${deviceTitle}</td><td style="padding:10px 0;color:#0f172a;font-size:14px;font-weight:700;">${escapeHtml(deviceLabel)}</td></tr>`,
    `<tr><td style="padding:10px 0;color:#667085;font-size:13px;">${countryTitle}</td><td style="padding:10px 0;color:#0f172a;font-size:14px;font-weight:700;">${escapeHtml(country)}</td></tr>`,
    `<tr><td style="padding:10px 0;color:#667085;font-size:13px;">${methodTitle}</td><td style="padding:10px 0;color:#0f172a;font-size:14px;font-weight:700;">${escapeHtml(methodLabel)}</td></tr>`,
    `<tr><td style="padding:10px 0;color:#667085;font-size:13px;">${timeLabel}</td><td style="padding:10px 0;color:#0f172a;font-size:14px;font-weight:700;">${escapeHtml(occurredAt)}</td></tr>`,
  ];

  const html = `
    <!DOCTYPE html>
    <html lang="${uiLang}">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${subject}</title>
    </head>
    <body style="margin:0;padding:28px 14px;background:#eef2ff;font-family:Inter,Arial,sans-serif;color:#0f172a;">
      <div style="max-width:660px;margin:0 auto;background:#ffffff;border:1px solid #dbe3ff;border-radius:24px;box-shadow:0 18px 34px rgba(79,70,229,.12);overflow:hidden;">
        <div style="padding:20px 24px;background:linear-gradient(98deg,#4f46e5,#0ea5e9);color:#fff;">
          <div style="font-weight:800;letter-spacing:.08em;font-size:14px;">OVLINK SECURITY</div>
          <div style="opacity:.9;font-size:12px;margin-top:4px;">${pickLang(uiLang, 'Yeni giriş bildirişi', 'Yeni giriş bildirimi', 'New sign-in alert')}</div>
        </div>

        <div style="padding:24px;">
          <h2 style="margin:0 0 10px 0;font-size:28px;line-height:1.15;color:#0b1329;">${title}</h2>
          <p style="margin:0 0 18px 0;color:#334155;line-height:1.65;font-size:14px;">${intro}</p>

          <div style="background:#f8faff;border:1px solid #dbe3ff;border-radius:16px;padding:14px 16px;">
            <table style="width:100%;border-collapse:collapse;">${rows.join('')}</table>
          </div>

          <div style="margin-top:14px;padding:12px 14px;border-radius:12px;background:#eef4ff;border:1px solid #d6e2ff;color:#334155;font-size:12px;line-height:1.55;">
            <div>${privacyNote}</div>
            <div style="margin-top:4px;">${locationNote}</div>
          </div>

          <div style="margin-top:18px;display:flex;gap:10px;flex-wrap:wrap;">
            <a href="${escapeHtml(resetPasswordUrl)}" style="display:inline-block;padding:10px 16px;border-radius:12px;background:#4f46e5;color:#fff;text-decoration:none;font-size:13px;font-weight:700;">${resetBtn}</a>
            <a href="${escapeHtml(contactUrl)}" style="display:inline-block;padding:10px 16px;border-radius:12px;border:1px solid #cbd5ff;color:#334155;text-decoration:none;font-size:13px;font-weight:700;background:#fff;">${contactBtn}</a>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  const text = [
    title,
    intro,
    `${deviceTitle}: ${deviceLabel}`,
    `${countryTitle}: ${country}`,
    `${methodTitle}: ${methodLabel}`,
    `${timeLabel}: ${occurredAt}`,
    privacyNote,
    locationNote,
    `${pickLang(uiLang, 'Şifrəni yenilə', 'Şifreyi yenile', 'Reset password')}: ${resetPasswordUrl}`,
    `${pickLang(uiLang, 'Dəstək ilə əlaqə', 'Destek ile iletişim', 'Contact support')}: ${contactUrl}`,
  ].filter(Boolean).join('\n');

  return resend.emails.send({
    from: process.env.FROM_EMAIL || 'Ovlink <onboarding@resend.dev>',
    to: safeTo,
    subject,
    text,
    html,
  });
}

function sendNewDeviceLoginEmailForUser(userId, details = {}) {
  db.get('SELECT email, ui_lang FROM users WHERE id = ?', [userId], (err, row) => {
    if (err || !row || !row.email) return;
    sendNewDeviceLoginEmail(row.email, details, row.ui_lang || 'en').catch((mailErr) => {
      console.error('new-device-email failed:', mailErr && (mailErr.message || mailErr));
    });
  });
}

// Middleware
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb', parameterLimit: 100 }));
const sessionOptions = {
  secret: process.env.SESSION_SECRET,
  resave: false, // Stale session overwrite riskini azaltır
  saveUninitialized: false, // CSRF secret session'a yazılınca zaten kaydedilir
  rolling: true, // Her istekte cookie süresini uzat
  proxy: isProd,
  cookie: {
    httpOnly: true,
    // Production'da her zaman Secure, geliştirmede otomatik.
    secure: isProd ? true : 'auto',
    sameSite: 'lax', // 'strict' yerine 'lax' daha uyumlu
    maxAge: 24 * 60 * 60 * 1000 // 24 saat
  }
};

// sessionStore is always set (pgSession or redisSession)
sessionOptions.store = sessionStore;
app.use(session(sessionOptions));

app.use((req, res, next) => {
  const reqPath = (req.path || '').toLowerCase();
  const isStaticLike = /\.(css|js|png|jpg|jpeg|webp|svg|ico|woff2?|ttf|map|txt|xml|webmanifest)$/.test(reqPath);
  const skipStaticPath = reqPath === '/robots.txt' || reqPath === '/sitemap.xml' || reqPath === '/favicon.ico' || reqPath === '/site.webmanifest';
  if ((req.method === 'GET' || req.method === 'HEAD') && (isStaticLike || skipStaticPath)) return next();

  if (!req.session || !req.session.userId) return next();

  const sessionToken = getOrCreateUserSessionToken(req);
  if (!sessionToken) return next();

  db.get(
    'SELECT id, is_revoked FROM user_sessions WHERE user_id = ? AND session_token = ? LIMIT 1',
    [req.session.userId, sessionToken],
    (err, row) => {
      if (err) {
        const msg = (err.message || '').toLowerCase();
        if (msg.includes('no such table')) return next();
        return next();
      }

      if (row && row.is_revoked == 1) {
        const fail = () => {
          const accept = (req.get('accept') || '').toLowerCase();
          const wantsJson = req.path.startsWith('/api/') || (accept.includes('application/json') && !accept.includes('text/html'));
          if (wantsJson) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
          return res.redirect('/login');
        };
        try {
          return req.session.destroy(() => fail());
        } catch {
          return fail();
        }
      }

      const now = Date.now();
      const lastTouched = Number(req.session.userSessionTouchedAt || 0);
      const shouldTouch = !lastTouched || (now - lastTouched) >= USER_SESSION_TOUCH_MS;

      if (!row) {
        return upsertUserSessionRecord(req, req.session.userId, { loginMethod: 'session_restore', sendAlert: false }, () => {
          req.session.userSessionTouchedAt = now;
          return next();
        });
      }

      if (!shouldTouch) return next();

      db.run('UPDATE user_sessions SET last_seen_at = ? WHERE id = ?', [new Date(now).toISOString(), row.id], () => {
        req.session.userSessionTouchedAt = now;
        return next();
      });
    }
  );
});

const csrfImpl = {
  create(req, secretKey) {
    const session = req.session;
    if (session === undefined) {
      throw new Error('lusca requires req.session to be available in order to maintain state');
    }

    let secret = session[secretKey];
    if (!secret) {
      // Use URL-safe base64 to avoid + / = issues in form posts.
      secret = crypto.randomBytes(16).toString('base64url');
      session[secretKey] = secret;
    }

    const SALT_LEN = 10;
    const salt = crypto.randomBytes(SALT_LEN).toString('base64url');

    const hash = crypto.createHash('sha256').update(salt + secret).digest('base64url');
    const token = salt + hash;

    return {
      secret,
      token,
      validate(req2, tokenCandidate) {
        try {
          if (typeof tokenCandidate !== 'string') return false;
          const sess = req2.session;
          if (!sess) return false;
          const s = (sess[secretKey] || '').toString();
          if (!s) return false;
          const salt2 = tokenCandidate.slice(0, SALT_LEN);
          const expected = salt2 + crypto.createHash('sha256').update(salt2 + s).digest('base64url');
          return tsscmp(tokenCandidate, expected);
        } catch {
          return false;
        }
      }
    };
  }
};

const csrfProtection = lusca.csrf({
  header: 'x-csrf-token',
  impl: csrfImpl
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

function hasApiKeyAuthHeader(req) {
  const xApiKey = (req.get('x-api-key') || '').toString().trim();
  if (xApiKey) return true;
  const auth = (req.get('authorization') || '').toString().trim();
  return /^Bearer\s+\S+/i.test(auth);
}

app.use((req, res, next) => {
  const isStaticLike = /\.(css|js|png|jpg|jpeg|webp|svg|ico|woff2?|ttf|map|txt|xml|webmanifest)$/i.test(req.path);
  const skipStaticPath = req.path === '/robots.txt' || req.path === '/sitemap.xml' || req.path === '/favicon.ico' || req.path === '/site.webmanifest';
  if (req.method === 'GET' && (isStaticLike || skipStaticPath)) return next();
  // Consent gate POST is protected by signed ready_at/ready_sig fields and should
  // not hard-fail if a browser rotates/blocks session cookies unexpectedly.
  if (req.path.startsWith('/consent/redirect/')) return next();
  const hasApiKeyHeader = hasApiKeyAuthHeader(req);
  // API key authenticated machine-to-machine endpoints do not rely on browser cookies.
  // Keeping CSRF here can break CLI/server integrations without improving protection.
  if (hasApiKeyHeader) return next();

  const isSafeMethod = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
  if (isSafeMethod) {
    const accept = (req.get('accept') || '').toLowerCase();
    const wantsHtml = accept.includes('text/html');
    const needsTokenRoute = req.path === '/api/csrf';
    const needsInlineRoute = requiresInlineCsrfRoute(req.path);
    if (!wantsHtml && !needsTokenRoute && !needsInlineRoute) return next();
  }

  return csrfProtection(req, res, next);
});

// Create inline CSRF tokens only for pages that submit regular HTML forms.
// Public JS pages fetch a token from /api/csrf on demand to reduce first-load overhead.
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();

  const isAdminGet = req.path.startsWith('/admin');
  const needsInlineCsrf = requiresInlineCsrfRoute(req.path);

  if (!needsInlineCsrf || typeof req.csrfToken !== 'function') {
    return next();
  }

  try {
    const token = req.csrfToken();
    if (!res.locals._csrf) res.locals._csrf = token;
    return next();
  } catch {
    const msg = 'Session refreshed. Please try again.';
    const hasMsg = typeof req.query?.msg === 'string' && req.query.msg.length > 0;
    const isSafePath = req.path === '/admin/login' || req.path === '/';
    if (hasMsg || isSafePath) {
      return next();
    }

    const target = isAdminGet ? '/admin/login' : '/';
    if (req.path === target) {
      return next();
    }

    const base = getPublicBaseUrl(req);
    try {
      const targetUrl = new URL(target, base);
      targetUrl.searchParams.delete('msg');
      targetUrl.searchParams.set('msg', msg);
      return res.redirect(303, targetUrl.pathname + (targetUrl.search || ''));
    } catch {
      const sep = target.includes('?') ? '&' : '?';
      return res.redirect(303, `${target}${sep}msg=${encodeURIComponent(msg)}`);
    }
  }
});

app.get('/api/csrf', (req, res) => {
  try {
    const token = typeof req.csrfToken === 'function' ? req.csrfToken() : '';
    return res.json({ csrfToken: token || '' });
  } catch {
    return res.status(500).json({ csrfToken: '' });
  }
});

// Keep sensitive authenticated pages non-cacheable while allowing public pages
// to use revalidation (this also preserves browser back/forward cache for public UX).
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();

  const accept = (req.get('accept') || '').toLowerCase();
  const wantsHtml = accept.includes('text/html');
  if (!wantsHtml && !req.path.startsWith('/admin')) return next();

  const hasUserSession = !!(req.session && (req.session.userId || req.session.adminUserId));
  const isPrivateUiRoute = req.path.startsWith('/dashboard')
    || req.path.startsWith('/account')
    || req.path.startsWith('/notifications')
    || req.path.startsWith('/admin');

  if (hasUserSession || isPrivateUiRoute) {
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
  } else {
    res.set('Cache-Control', 'no-cache, max-age=0, must-revalidate');
  }

  next();
});

app.use((req, res, next) => {
  res.locals.siteSettings = siteSettings;
  next();
});

app.use((req, res, next) => {
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
});

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

// SEO helpers: robots.txt & sitemap.xml
// Verification checklist:
// 1) curl http://localhost:3000/robots.txt
// 2) open http://localhost:3000/sitemap.xml
// 3) language switch works on /privacy, /terms, /contact
// 4) submit sitemap in Google Search Console
// 5) set PUBLIC_BASE_URL correctly in production
app.get('/robots.txt', (req, res) => {
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

app.get('/sitemap.xml', (req, res) => {
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

// Ensure templates that reference `seo` always receive a safe fallback object.
app.use((req, res, next) => {
  if (!res.locals.seo) {
    res.locals.seo = buildSeo(req, {
      path: req.path || '/',
      titleAz: 'Ovlink',
      titleTr: 'Ovlink',
      titleEn: 'Ovlink',
      descAz: 'Ovlink URL qısaltma xidməti.',
      descTr: 'Ovlink URL kısaltma servisi.',
      descEn: 'Ovlink URL shortener service.',
    });
  }
  return next();
});

// Sayfa Rotaları
app.get('/', (req, res) => {
  const seo = buildSeo(req, {
    path: '/',
    titleAz: 'Ovlink - URL Qısaltma',
    titleTr: 'Ovlink - URL Kısaltma',
    titleEn: 'Ovlink - URL Shortener',
    descAz: 'Ovlink linklərinizi qısaldır, izləyir və təhlükəsiz idarə etməyə kömək edir.',
    descTr: 'Ovlink linklerinizi kısaltır, izler ve güvenli şekilde yönetmenize yardımcı olur.',
    descEn: 'Ovlink shortens your links, tracks clicks, and helps you manage them securely.'
  });
  res.render('index', { csrfToken: res.locals._csrf, seo });
});
app.get('/login', (req, res) => res.render('login', { csrfToken: res.locals._csrf }));
app.get('/register', (req, res) => res.render('register', { csrfToken: res.locals._csrf }));
app.get('/stats', (req, res) => res.render('stats', { csrfToken: res.locals._csrf, short: req.query.short || '' }));

app.get('/login.html', (req, res) => res.redirect(301, '/login'));
app.get('/register.html', (req, res) => res.redirect(301, '/register'));
app.get('/dashboard.html', (req, res) => res.redirect(301, '/dashboard'));
app.get('/stats.html', (req, res) => {
  const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  return res.redirect(301, '/stats' + q);
});

app.get('/privacy', (req, res) => {
  const seo = buildSeo(req, {
    path: '/privacy',
    titleAz: 'Məxfilik Siyasəti - Ovlink',
    titleTr: 'Gizlilik Politikası - Ovlink',
    titleEn: 'Privacy Policy - Ovlink',
    descAz: 'Ovlink məxfilik siyasəti və şəxsi məlumatların işlənməsi haqqında məlumat.',
    descTr: 'Ovlink gizlilik politikası ve kişisel verilerin işlenmesi hakkında bilgi.',
    descEn: 'Ovlink privacy policy and how we process personal data.'
  });
  res.render('privacy', { csrfToken: res.locals._csrf, seo });
});
app.get('/privacy.html', (req, res) => {
  const seo = buildSeo(req, {
    path: '/privacy',
    titleAz: 'Məxfilik Siyasəti - Ovlink',
    titleTr: 'Gizlilik Politikası - Ovlink',
    titleEn: 'Privacy Policy - Ovlink',
    descAz: 'Ovlink məxfilik siyasəti və şəxsi məlumatların işlənməsi haqqında məlumat.',
    descTr: 'Ovlink gizlilik politikası ve kişisel verilerin işlenmesi hakkında bilgi.',
    descEn: 'Ovlink privacy policy and how we process personal data.'
  });
  res.render('privacy', { csrfToken: res.locals._csrf, seo });
});

app.get('/terms', (req, res) => {
  const seo = buildSeo(req, {
    path: '/terms',
    titleAz: 'İstifadə Şərtləri - Ovlink',
    titleTr: 'Kullanım Şartları - Ovlink',
    titleEn: 'Terms of Service - Ovlink',
    descAz: 'Ovlink xidmətindən istifadə şərtləri və qaydaları.',
    descTr: 'Ovlink kullanım şartları ve hizmet kuralları.',
    descEn: 'Ovlink terms of service and usage rules.'
  });
  res.render('terms', { csrfToken: res.locals._csrf, seo });
});
app.get('/terms.html', (req, res) => {
  const seo = buildSeo(req, {
    path: '/terms',
    titleAz: 'İstifadə Şərtləri - Ovlink',
    titleTr: 'Kullanım Şartları - Ovlink',
    titleEn: 'Terms of Service - Ovlink',
    descAz: 'Ovlink xidmətindən istifadə şərtləri və qaydaları.',
    descTr: 'Ovlink kullanım şartları ve hizmet kuralları.',
    descEn: 'Ovlink terms of service and usage rules.'
  });
  res.render('terms', { csrfToken: res.locals._csrf, seo });
});

app.get('/contact', (req, res) => {
  const seo = buildSeo(req, {
    path: '/contact',
    titleAz: 'Əlaqə - Ovlink',
    titleTr: 'İletişim - Ovlink',
    titleEn: 'Contact - Ovlink',
    descAz: 'Dəstək və əlaqə üçün Ovlink ilə əlaqə saxlayın.',
    descTr: 'Destek ve iletişim için Ovlink ile iletişime geçin.',
    descEn: 'Contact Ovlink support and get help.'
  });
  res.render('contact', { csrfToken: res.locals._csrf, seo });
});
app.get('/contact.html', (req, res) => {
  const seo = buildSeo(req, {
    path: '/contact',
    titleAz: 'Əlaqə - Ovlink',
    titleTr: 'İletişim - Ovlink',
    titleEn: 'Contact - Ovlink',
    descAz: 'Dəstək və əlaqə üçün Ovlink ilə əlaqə saxlayın.',
    descTr: 'Destek ve iletişim için Ovlink ile iletişime geçin.',
    descEn: 'Contact Ovlink support and get help.'
  });
  res.render('contact', { csrfToken: res.locals._csrf, seo });
});

app.get('/pricing', (req, res) => {
  const seo = buildSeo(req, {
    path: '/pricing',
    titleAz: 'Pro Plan Qiymətləri - Ovlink',
    titleTr: 'Pro Plan Fiyatlandırma - Ovlink',
    titleEn: 'Pro Plan Pricing - Ovlink',
    descAz: 'Ovlink Free və Pro planlarını müqayisə edin. Pro plan üçün qiymət $2/ay.',
    descTr: 'Ovlink Free ve Pro planlarını karşılaştırın. Pro plan fiyatı $2/ay.',
    descEn: 'Compare Ovlink Free and Pro plans. Pro pricing is $2/month.',
  });
  res.render('pricing', { csrfToken: res.locals._csrf, seo });
});
app.get('/pricing.html', (req, res) => res.redirect(301, '/pricing'));

app.get('/cookie-policy', (req, res) => {
  const seo = buildSeo(req, {
    path: '/cookie-policy',
    titleAz: 'Cookie Siyasəti - Ovlink',
    titleTr: 'Çerez Politikası - Ovlink',
    titleEn: 'Cookie Policy - Ovlink',
    descAz: 'Ovlink kuki siyasəti və kukilərin istifadəsi haqqında məlumat.',
    descTr: 'Ovlink çerez politikası ve çerez kullanımı hakkında bilgi.',
    descEn: 'Ovlink cookie policy and how cookies are used.'
  });
  res.render('cookie-policy', { csrfToken: res.locals._csrf, seo });
});
app.get('/cookie-policy.html', (req, res) => {
  const seo = buildSeo(req, {
    path: '/cookie-policy',
    titleAz: 'Cookie Siyasəti - Ovlink',
    titleTr: 'Çerez Politikası - Ovlink',
    titleEn: 'Cookie Policy - Ovlink',
    descAz: 'Ovlink kuki siyasəti və kukilərin istifadəsi haqqında məlumat.',
    descTr: 'Ovlink çerez politikası ve çerez kullanımı hakkında bilgi.',
    descEn: 'Ovlink cookie policy and how cookies are used.'
  });
  res.render('cookie-policy', { csrfToken: res.locals._csrf, seo });
});

app.get('/about', (req, res) => {
  const seo = buildSeo(req, {
    path: '/about',
    titleAz: 'Haqqımızda - Ovlink',
    titleTr: 'Hakkımızda - Ovlink',
    titleEn: 'About - Ovlink',
    descAz: 'Ovlink xidmətinin məqsədi və operator məlumatları.',
    descTr: 'Ovlink hizmetinin amacı ve işletmeci bilgileri.',
    descEn: 'Purpose of Ovlink and operator information.'
  });
  res.render('about', { csrfToken: res.locals._csrf, seo });
});
app.get('/about.html', (req, res) => {
  const seo = buildSeo(req, {
    path: '/about',
    titleAz: 'Haqqımızda - Ovlink',
    titleTr: 'Hakkımızda - Ovlink',
    titleEn: 'About - Ovlink',
    descAz: 'Ovlink xidmətinin məqsədi və operator məlumatları.',
    descTr: 'Ovlink hizmetinin amacı ve işletmeci bilgileri.',
    descEn: 'Purpose of Ovlink and operator information.'
  });
  res.render('about', { csrfToken: res.locals._csrf, seo });
});

app.get('/how-it-works', (req, res) => {
  const seo = buildSeo(req, {
    path: '/how-it-works',
    titleAz: 'Link Qısaltma Necə İşləyir? - Ovlink',
    titleTr: 'Link Kısaltma Nasıl Çalışır? - Ovlink',
    titleEn: 'How URL Shortening Works - Ovlink',
    descAz: 'Qısa linklərin yaradılması, paylaşılması və statistika izahı.',
    descTr: 'Kısa link oluşturma, paylaşım ve istatistik açıklaması.',
    descEn: 'How short links are created, shared, and measured.'
  });
  res.render('how-it-works', { csrfToken: res.locals._csrf, seo });
});
app.get('/how-it-works.html', (req, res) => {
  const seo = buildSeo(req, {
    path: '/how-it-works',
    titleAz: 'Link Qısaltma Necə İşləyir? - Ovlink',
    titleTr: 'Link Kısaltma Nasıl Çalışır? - Ovlink',
    titleEn: 'How URL Shortening Works - Ovlink',
    descAz: 'Qısa linklərin yaradılması, paylaşılması və statistika izahı.',
    descTr: 'Kısa link oluşturma, paylaşım ve istatistik açıklaması.',
    descEn: 'How short links are created, shared, and measured.'
  });
  res.render('how-it-works', { csrfToken: res.locals._csrf, seo });
});
app.get('/why-ovlink', (req, res) => {
  const seo = buildSeo(req, {
    path: '/why-ovlink',
    titleAz: 'Niyə Ovlink? - Ovlink',
    titleTr: 'Neden Ovlink? - Ovlink',
    titleEn: 'Why Ovlink? - Ovlink',
    descAz: 'Ovlink-in dəyəri, təhlükəsizlik və idarəetmə prinsipləri.',
    descTr: 'Ovlink’in değeri, güvenlik ve yönetim yaklaşımı.',
    descEn: 'Ovlink’s value, safety model, and link management approach.'
  });
  res.render('why-ovlink', { csrfToken: res.locals._csrf, seo });
});
app.get('/why-ovlink.html', (req, res) => res.redirect(301, '/why-ovlink'));

app.get('/faq', (req, res) => {
  const seo = buildSeo(req, {
    path: '/faq',
    titleAz: 'FAQ - Ovlink',
    titleTr: 'SSS - Ovlink',
    titleEn: 'FAQ - Ovlink',
    descAz: 'Ovlink haqqında tez-tez verilən suallar və qısa cavablar.',
    descTr: 'Ovlink hakkında sıkça sorulan sorular ve kısa cevaplar.',
    descEn: 'Frequently asked questions about Ovlink.'
  });
  res.render('faq', { csrfToken: res.locals._csrf, seo });
});
app.get('/faq.html', (req, res) => res.redirect(301, '/faq'));
app.get('/sss', (req, res) => res.redirect(301, '/faq'));

app.get('/help', (req, res) => {
  const seo = buildSeo(req, {
    path: '/help',
    titleAz: 'Yardım Mərkəzi - Ovlink',
    titleTr: 'Yardım Merkezi - Ovlink',
    titleEn: 'Help Center - Ovlink',
    descAz: 'Ovlink üçün addım-addım istifadə və problem həlli bələdçisi.',
    descTr: 'Ovlink için adım adım kullanım ve sorun giderme rehberi.',
    descEn: 'Step-by-step help and troubleshooting for Ovlink.'
  });
  res.render('help', { csrfToken: res.locals._csrf, seo });
});
app.get('/help.html', (req, res) => res.redirect(301, '/help'));

app.get('/docs', (req, res) => {
  const seo = buildSeo(req, {
    path: '/docs',
    titleAz: 'Sənədlər - Ovlink',
    titleTr: 'Dokümanlar - Ovlink',
    titleEn: 'Documentation - Ovlink',
    descAz: 'Ovlink iş prinsipi, mövcud funksiyalar və məsuliyyətli istifadə sənədləri.',
    descTr: 'Ovlink çalışma modeli, mevcut özellikler ve sorumlu kullanım dokümanları.',
    descEn: 'Ovlink redirect model, available features, and responsible-use docs.'
  });
  res.render('docs', { csrfToken: res.locals._csrf, seo });
});
app.get('/docs.html', (req, res) => res.redirect(301, '/docs'));

app.get('/api-guide', (req, res) => {
  const seo = buildSeo(req, {
    path: '/api-guide',
    titleAz: 'API İstifadə Bələdçisi - Ovlink',
    titleTr: 'API Kullanım Rehberi - Ovlink',
    titleEn: 'API Usage Guide - Ovlink',
    descAz: 'Ovlink API key istifadə qaydaları və Node.js, Python, C#, C++ nümunələri.',
    descTr: 'Ovlink API key kullanım adımları ve Node.js, Python, C#, C++ örnekleri.',
    descEn: 'Ovlink API key usage guide with Node.js, Python, C#, and C++ examples.'
  });
  res.render('api-guide', { csrfToken: res.locals._csrf, seo });
});
app.get('/api-guide.html', (req, res) => res.redirect(301, '/api-guide'));

app.get('/abuse-safety', (req, res) => {
  const seo = buildSeo(req, {
    path: '/abuse-safety',
    titleAz: 'Abuse & Safety - Ovlink',
    titleTr: 'Abuse & Safety - Ovlink',
    titleEn: 'Abuse & Safety - Ovlink',
    descAz: 'Sui-istifadə, təhlükəsizlik siyasəti və icra tədbirləri barədə məlumat.',
    descTr: 'Kötüye kullanım, güvenlik politikası ve yaptırım süreci hakkında bilgi.',
    descEn: 'Abuse policy, safety standards, and enforcement actions.'
  });
  res.render('abuse-safety', { csrfToken: res.locals._csrf, seo });
});
app.get('/abuse-safety.html', (req, res) => res.redirect(301, '/abuse-safety'));

app.get('/updates', (req, res) => {
  const seo = buildSeo(req, {
    path: '/updates',
    titleAz: 'Yeniliklər - Ovlink',
    titleTr: 'Güncellemeler - Ovlink',
    titleEn: 'Updates - Ovlink',
    descAz: 'Ovlink üçün son ictimai yeniliklər, performans düzəlişləri və buraxılış qeydləri.',
    descTr: 'Ovlink için son herkese açık güncellemeler, performans iyileştirmeleri ve sürüm notları.',
    descEn: 'Latest public updates, performance improvements, and release notes for Ovlink.'
  });
  res.render('updates', { csrfToken: res.locals._csrf, seo });
});
app.get('/updates.html', (req, res) => res.redirect(301, '/updates'));


app.get('/account', (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  return res.render('account', { csrfToken: res.locals._csrf });
});
app.get('/notifications', (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  return res.render('notifications', { csrfToken: res.locals._csrf });
});
app.get('/forgot-password', (req, res) => res.render('forgot-password', { csrfToken: res.locals._csrf }));
app.get('/reset-password', (req, res) => res.render('reset-password', { csrfToken: res.locals._csrf, token: req.query.token || '' }));

app.use(express.static(publicDir, isProd ? {
  maxAge: '365d',
  immutable: true,
  etag: false,
  redirect: false,
} : {
  maxAge: 0,
  etag: true,
  redirect: false,
}));

// Veritabanı bağlantısı ve tabloların oluşturulması


const webhookTimerMap = new Map();

function dbGetAsync(sql, params = []) {
  const pgSql = db.convertSql(sql);
  return pool.query(pgSql, params).then(res => res.rows[0]).catch(err => Promise.reject(err));
}

function dbAllAsync(sql, params = []) {
  const pgSql = db.convertSql(sql);
  return pool.query(pgSql, params).then(res => res.rows).catch(err => Promise.reject(err));
}

function dbRunAsync(sql, params = []) {
  const pgSql = db.convertSql(sql);
  return pool.query(pgSql, params).then(res => ({
    changes: res.rowCount || 0,
    lastID: res.rows && res.rows[0] ? res.rows[0].id : 0
  })).catch(err => Promise.reject(err));
}

async function loadUserPlanRow(userId) {
  if (!Number.isInteger(userId) || userId <= 0) return null;
  return dbGetAsync(
    'SELECT id, plan_tier, plan_status, pro_expires_at, pro_paused_at FROM users WHERE id = ?',
    [userId]
  );
}

async function downgradeExpiredProIfNeeded(userId) {
  const row = await loadUserPlanRow(userId);
  if (!row) return null;
  if (!isProExpired(row)) return row;
  const now = new Date().toISOString();
  await dbRunAsync(
    'UPDATE users SET plan_tier = ?, plan_status = ?, pro_expires_at = NULL, pro_paused_at = NULL, pro_updated_at = ? WHERE id = ?',
    [PLAN_TIERS.FREE, PLAN_STATUS.ACTIVE, now, userId]
  );
  return loadUserPlanRow(userId);
}

async function getEffectivePlanForUser(userId) {
  const row = await downgradeExpiredProIfNeeded(userId);
  return buildPlanPayload(row || {});
}

function requireSignedIn(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

function requireProAccess(feature) {
  return async (req, res, next) => {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      const plan = await getEffectivePlanForUser(req.session.userId);
      if (!plan.is_active || plan.tier !== PLAN_TIERS.PRO || plan.status !== PLAN_STATUS.ACTIVE) {
        logSecurityEvent(req, 'pro.access.denied', 'blocked', { feature: (feature || '').toString().slice(0, 64) });
        return res.status(403).json({ error: 'Pro plan required.' });
      }
      req.proPlan = plan;
      return next();
    } catch {
      return res.status(500).json({ error: 'Server error.' });
    }
  };
}

function scheduleWebhookProcessing(deliveryId, delayMs = 0) {
  const safeId = Number.parseInt(deliveryId, 10);
  if (!Number.isInteger(safeId) || safeId <= 0) return;
  if (webhookTimerMap.has(safeId)) return;
  const safeDelay = Math.max(0, Number.parseInt(delayMs, 10) || 0);
  const timer = setTimeout(() => {
    webhookTimerMap.delete(safeId);
    void processWebhookDelivery(safeId);
  }, safeDelay);
  webhookTimerMap.set(safeId, timer);
  if (typeof timer.unref === 'function') timer.unref();
}

async function updateWebhookFailureState(webhookId, failedAtIso) {
  const now = failedAtIso || new Date().toISOString();
  await dbRunAsync(
    'UPDATE webhooks SET consecutive_failures = COALESCE(consecutive_failures, 0) + 1, last_failure_at = ?, updated_at = ? WHERE id = ?',
    [now, now, webhookId]
  );
}

async function resetWebhookFailureState(webhookId, updatedAtIso) {
  const now = updatedAtIso || new Date().toISOString();
  await dbRunAsync(
    'UPDATE webhooks SET consecutive_failures = 0, last_failure_at = NULL, updated_at = ? WHERE id = ?',
    [now, webhookId]
  );
}

async function processWebhookDelivery(deliveryId) {
  const row = await dbGetAsync(
    'SELECT d.id, d.webhook_id, d.user_id, d.event_type, d.payload_json, d.attempt, d.status, w.url, w.secret_hash, w.signature_v2_key, w.signature_v2_enabled, w.is_active, w.message_locale, w.message_template, u.ui_lang AS user_ui_lang ' +
    'FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id JOIN users u ON u.id = d.user_id WHERE d.id = ?',
    [deliveryId]
  ).catch(() => null);

  if (!row) return;
  if (row.status === 'delivered' || row.status === 'failed' || row.status === 'cancelled') return;

  const plan = await getEffectivePlanForUser(row.user_id).catch(() => null);
  if (!plan || !plan.is_active || plan.tier !== PLAN_TIERS.PRO) {
    await dbRunAsync(
      'UPDATE webhook_deliveries SET status = ?, updated_at = ? WHERE id = ?',
      ['cancelled', new Date().toISOString(), deliveryId]
    ).catch(() => {});
    return;
  }

  if (row.is_active != 1) {
    await dbRunAsync(
      'UPDATE webhook_deliveries SET status = ?, updated_at = ? WHERE id = ?',
      ['cancelled', new Date().toISOString(), deliveryId]
    ).catch(() => {});
    return;
  }

  const now = new Date().toISOString();
  const attemptNumber = (Number.parseInt(row.attempt || '0', 10) || 0) + 1;
  const payload = {
    delivery_id: row.id,
    event: row.event_type,
    attempt: attemptNumber,
    sent_at: now,
    data: (() => {
      try {
        return JSON.parse((row.payload_json || '{}').toString());
      } catch {
        return {};
      }
    })(),
  };
  const isDiscordTarget = isDiscordIncomingWebhookUrl(row.url);
  const outboundPayload = isDiscordTarget ? buildDiscordWebhookPayload(payload, row) : payload;
  const body = JSON.stringify(outboundPayload);

  let httpStatus = 0;
  let responseCode = '';
  let success = false;
  let timeoutHandle = null;

  const targetValidation = await validateOutboundWebhookUrl(row.url).catch(() => ({ ok: false, reason: 'validation_error' }));
  if (!targetValidation || !targetValidation.ok) {
    const blockedNow = new Date().toISOString();
    await updateWebhookFailureState(row.webhook_id, blockedNow).catch(() => {});
    await dbRunAsync(
      'UPDATE webhook_deliveries SET attempt = ?, status = ?, http_status = ?, response_excerpt = ?, next_retry_at = NULL, last_attempt_at = ?, updated_at = ? WHERE id = ?',
      [attemptNumber, 'failed', null, 'blocked_ssrf', blockedNow, blockedNow, deliveryId]
    ).catch(() => {});
    return;
  }

  const targetUrl = targetValidation.normalizedUrl || row.url;
  try {
    const controller = new AbortController();
    timeoutHandle = setTimeout(() => controller.abort(), 10_000);
    const legacySig = row.secret_hash
      ? crypto.createHmac('sha256', row.secret_hash).update(body).digest('hex')
      : '';
    const signatureV2Enabled = row.signature_v2_enabled == 1;
    const signatureV2Key = signatureV2Enabled ? decodeWebhookSignatureV2Key(row.signature_v2_key) : null;
    const signatureTs = String(Math.floor(Date.now() / 1000));
    const headers = {
      'content-type': 'application/json',
      'x-ovlink-event': row.event_type,
      'x-ovlink-delivery-id': String(row.id),
      'x-ovlink-signature-ts': signatureTs,
    };
    if (legacySig) {
      headers['x-ovlink-signature'] = `sha256=${legacySig}`;
    }
    if (signatureV2Key && signatureV2Key.length) {
      const v2Body = `${signatureTs}.${body}`;
      const v2Sig = crypto.createHmac('sha256', signatureV2Key).update(v2Body).digest('hex');
      headers['x-ovlink-signature-v2'] = `sha256=${v2Sig}`;
    }
    if (isDiscordTarget) {
      headers['x-ovlink-destination'] = 'discord';
    }
    const resp = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    httpStatus = Number(resp.status) || 0;
    success = resp.ok;
    if (!success) {
      if (httpStatus >= 500) responseCode = 'http_5xx';
      else if (httpStatus >= 400) responseCode = 'http_4xx';
      else responseCode = 'http_error';
    }
  } catch (err) {
    responseCode = (err && err.name === 'AbortError') ? 'timeout' : 'network_error';
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  if (success) {
    await dbRunAsync(
      'UPDATE webhook_deliveries SET attempt = ?, status = ?, http_status = ?, response_excerpt = ?, next_retry_at = NULL, last_attempt_at = ?, updated_at = ? WHERE id = ?',
      [attemptNumber, 'delivered', httpStatus || null, null, now, now, deliveryId]
    ).catch(() => {});
    await resetWebhookFailureState(row.webhook_id, now).catch(() => {});
    return;
  }

  await updateWebhookFailureState(row.webhook_id, now).catch(() => {});

  if (attemptNumber >= WEBHOOK_MAX_ATTEMPTS) {
    await dbRunAsync(
      'UPDATE webhook_deliveries SET attempt = ?, status = ?, http_status = ?, response_excerpt = ?, next_retry_at = NULL, last_attempt_at = ?, updated_at = ? WHERE id = ?',
      [attemptNumber, 'failed', httpStatus || null, responseCode || 'delivery_failed', now, now, deliveryId]
    ).catch(() => {});
    return;
  }

  const delayMs = computeWebhookRetryDelayMs(attemptNumber + 1);
  const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
  await dbRunAsync(
    'UPDATE webhook_deliveries SET attempt = ?, status = ?, http_status = ?, response_excerpt = ?, next_retry_at = ?, last_attempt_at = ?, updated_at = ? WHERE id = ?',
    [attemptNumber, 'retry_scheduled', httpStatus || null, responseCode || 'delivery_failed', nextRetryAt, now, now, deliveryId]
  ).catch(() => {});
  scheduleWebhookProcessing(deliveryId, delayMs);
}

async function enqueueWebhookEventForUser(userId, eventType, payload = {}) {
  const safeUserId = Number.parseInt(userId, 10);
  if (!Number.isInteger(safeUserId) || safeUserId <= 0) return;
  const event = (eventType || '').toString().trim().toLowerCase();
  if (!event) return;

  const plan = await getEffectivePlanForUser(safeUserId).catch(() => null);
  if (!plan || !plan.is_active || plan.tier !== PLAN_TIERS.PRO) return;

  const hooks = await dbAllAsync(
    'SELECT id, user_id, url, events, is_active FROM webhooks WHERE user_id = ? AND is_active = 1 ORDER BY id DESC LIMIT 100',
    [safeUserId]
  ).catch(() => []);

  if (!hooks || !hooks.length) return;
  const now = new Date().toISOString();
  const payloadJson = safeJsonStringify(payload, 6000);

  for (const hook of hooks) {
    if (!webhookHasEvent(hook, event)) continue;
    try {
      const inserted = await dbRunAsync(
        'INSERT INTO webhook_deliveries (webhook_id, user_id, event_type, payload_json, attempt, status, created_at, updated_at, next_retry_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)',
        [hook.id, safeUserId, event, payloadJson, 'queued', now, now, now]
      );
      if (inserted && inserted.lastID) {
        scheduleWebhookProcessing(inserted.lastID, 0);
      }
    } catch {
      // best effort
    }
  }
}

async function resumePendingWebhookDeliveries() {
  const now = new Date().toISOString();
  const pending = await dbAllAsync(
    "SELECT id, next_retry_at FROM webhook_deliveries WHERE status IN ('queued', 'retry_scheduled') ORDER BY id DESC LIMIT 300",
    []
  ).catch(() => []);

  for (const item of (pending || [])) {
    const id = Number.parseInt(item.id || '0', 10);
    if (!Number.isInteger(id) || id <= 0) continue;
    const retryMs = parseIsoTimeMs(item.next_retry_at || now);
    const delay = Number.isFinite(retryMs) ? Math.max(0, retryMs - Date.now()) : 0;
    scheduleWebhookProcessing(id, delay);
  }
}

db.serialize(() => {

  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    password TEXT,
    email_verified INTEGER DEFAULT 0,
    verification_code TEXT,
    auth_provider TEXT DEFAULT 'local',
    google_id TEXT
  )`);

  // URL tablosu
  db.run(`CREATE TABLE IF NOT EXISTS urls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original TEXT,
    short TEXT UNIQUE,
    created_at TEXT,
    reports INTEGER DEFAULT 0,
    user_id INTEGER,
    link_password TEXT,
    dangerous INTEGER DEFAULT 0,
    expires_at TEXT,
    max_clicks INTEGER,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  db.run('ALTER TABLE urls ADD COLUMN folder_name TEXT', () => {});
  db.run('ALTER TABLE urls ADD COLUMN tags_json TEXT', () => {});

  // Reports tablosu: "reason" ve "user_id" sütunlarını içeriyor.
  db.run(`CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    short TEXT,
    created_at TEXT,
    reason TEXT,
    user_id INTEGER,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  // Tıklama tablosu
  db.run(`CREATE TABLE IF NOT EXISTS clicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url_id INTEGER,
    click_time TEXT,
    ip TEXT,
    browser TEXT,
    os TEXT,
    country TEXT,
    city TEXT,
    FOREIGN KEY(url_id) REFERENCES urls(id)
  )`);

  // ===== Admin System Tables / Indexes (NEW) =====

  // Site settings (maintenance + announcement)
  db.run(`CREATE TABLE IF NOT EXISTS site_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);

  db.run("INSERT OR IGNORE INTO site_settings (key, value) VALUES ('maintenance_enabled', '0')");
  db.run("INSERT OR IGNORE INTO site_settings (key, value) VALUES ('maintenance_message_az', '')");
  db.run("INSERT OR IGNORE INTO site_settings (key, value) VALUES ('maintenance_message_tr', '')");
  db.run("INSERT OR IGNORE INTO site_settings (key, value) VALUES ('maintenance_message_en', '')");
  db.run("INSERT OR IGNORE INTO site_settings (key, value) VALUES ('announcement_enabled', '0')");
  db.run("INSERT OR IGNORE INTO site_settings (key, value) VALUES ('announcement_text_az', '')");
  db.run("INSERT OR IGNORE INTO site_settings (key, value) VALUES ('announcement_text_tr', '')");
  db.run("INSERT OR IGNORE INTO site_settings (key, value) VALUES ('announcement_text_en', '')");

  db.run(`CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    failed_login_count INTEGER DEFAULT 0,
    lock_until TEXT,
    last_failed_at TEXT,
    last_login_at TEXT,
    created_at TEXT
  )`);

  // 2FA migration: no-op if columns already exist
  db.run('ALTER TABLE admin_users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0', () => {});
  db.run('ALTER TABLE admin_users ADD COLUMN totp_secret TEXT', () => {});

  db.run(`CREATE TABLE IF NOT EXISTS blocked_domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT UNIQUE NOT NULL,
    created_at TEXT,
    created_by_admin_id INTEGER,
    note TEXT,
    FOREIGN KEY(created_by_admin_id) REFERENCES admin_users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS admin_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT,
    admin_user_id INTEGER,
    action TEXT,
    target_type TEXT,
    target_id TEXT,
    metadata_json TEXT,
    ip TEXT,
    user_agent TEXT,
    FOREIGN KEY(admin_user_id) REFERENCES admin_users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS admin_auth_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    email_or_username TEXT,
    ip_address TEXT,
    country TEXT,
    user_agent TEXT,
    created_at TEXT
  )`);
  db.run('ALTER TABLE admin_auth_audit ADD COLUMN country TEXT', () => {});

  db.run('CREATE INDEX IF NOT EXISTS idx_admin_auth_audit_created_at ON admin_auth_audit(created_at)', () => {});

  db.run(`CREATE TABLE IF NOT EXISTS guest_limits (
    ip TEXT NOT NULL,
    day TEXT NOT NULL,
    count INTEGER DEFAULT 0,
    updated_at TEXT,
    PRIMARY KEY (ip, day)
  )`);


db.run(`CREATE TABLE IF NOT EXISTS custom_domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  domain TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_verification',
  verification_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  verified_at TEXT,
  last_checked_at TEXT,
  routing_ok INTEGER DEFAULT 0,
  FOREIGN KEY(user_id) REFERENCES users(id)
)`);

  db.run(`CREATE TABLE IF NOT EXISTS user_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    session_token TEXT NOT NULL UNIQUE,
    user_agent TEXT,
    device_label TEXT,
    browser TEXT,
    os TEXT,
    country TEXT,
    ip_hash TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    last_login_at TEXT,
    last_login_method TEXT,
    is_revoked INTEGER NOT NULL DEFAULT 0,
    revoked_at TEXT,
    device_fingerprint TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  db.run('ALTER TABLE user_sessions ADD COLUMN device_fingerprint TEXT', () => {});

  db.run(`CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    scopes TEXT NOT NULL DEFAULT 'account:read,shorten:write,webhooks:read,webhooks:write',
    key_hash TEXT NOT NULL UNIQUE,
    hash_version INTEGER NOT NULL DEFAULT 1,
    key_prefix TEXT NOT NULL,
    last4 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS webhooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    url TEXT NOT NULL,
    secret_hash TEXT NOT NULL,
    secret_hash_version INTEGER NOT NULL DEFAULT 1,
    signature_v2_key TEXT,
    signature_v2_enabled INTEGER NOT NULL DEFAULT 0,
    events TEXT NOT NULL,
    message_locale TEXT NOT NULL DEFAULT 'auto',
    message_template TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_failure_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    webhook_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT,
    attempt INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'queued',
    http_status INTEGER,
    response_excerpt TEXT,
    next_retry_at TEXT,
    last_attempt_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(webhook_id) REFERENCES webhooks(id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS subscription_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    admin_user_id INTEGER,
    target_user_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    old_tier TEXT,
    new_tier TEXT,
    old_status TEXT,
    new_status TEXT,
    old_expires_at TEXT,
    new_expires_at TEXT,
    duration_seconds INTEGER,
    reason TEXT,
    metadata_json TEXT,
    FOREIGN KEY(admin_user_id) REFERENCES admin_users(id),
    FOREIGN KEY(target_user_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS security_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    event_type TEXT NOT NULL,
    outcome TEXT NOT NULL,
    user_id INTEGER,
    api_key_id INTEGER,
    ip_hash TEXT,
    ip_masked TEXT,
    user_agent TEXT,
    details_json TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(api_key_id) REFERENCES api_keys(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS api_idempotency_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    api_key_id INTEGER,
    endpoint TEXT NOT NULL,
    idempotency_hash TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status_code INTEGER,
    response_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    UNIQUE(user_id, endpoint, idempotency_hash),
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(api_key_id) REFERENCES api_keys(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS api_usage_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    api_key_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL,
    method TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    error_type TEXT NOT NULL DEFAULT 'ok',
    created_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(api_key_id) REFERENCES api_keys(id)
  )`);

// Domain-aware short links
db.run('ALTER TABLE urls ADD COLUMN domain_host TEXT', () => {});

  // Privacy scrub: remove legacy full IPs from public analytics/audit tables
  db.run("UPDATE clicks SET ip = NULL WHERE ip IS NOT NULL");
  db.run("UPDATE clicks SET city = NULL WHERE city IS NOT NULL");
  db.run("DELETE FROM guest_limits");

  // Columns for link moderation
  db.run('ALTER TABLE urls ADD COLUMN disabled INTEGER DEFAULT 0', () => {});
  db.run('ALTER TABLE urls ADD COLUMN disabled_reason TEXT', () => {});
  db.run('ALTER TABLE urls ADD COLUMN disabled_at TEXT', () => {});
  db.run('ALTER TABLE urls ADD COLUMN disabled_by_admin_id INTEGER', () => {});

  // Optional notes on user reports
  db.run('ALTER TABLE reports ADD COLUMN notes TEXT', () => {});
  db.run('ALTER TABLE reports ADD COLUMN resolved_at TEXT', () => {});
  db.run('ALTER TABLE reports ADD COLUMN resolved_by_admin_id INTEGER', () => {});

  // Columns for user moderation
  db.run('ALTER TABLE users ADD COLUMN created_at TEXT', () => {});
  db.run('ALTER TABLE users ADD COLUMN last_login_at TEXT', () => {});
  db.run('ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0', () => {});
  db.run('ALTER TABLE users ADD COLUMN ban_until TEXT', () => {});
  db.run('ALTER TABLE users ADD COLUMN ban_reason TEXT', () => {});
  db.run('ALTER TABLE users ADD COLUMN ban_set_at TEXT', () => {});
  db.run('ALTER TABLE users ADD COLUMN ban_set_by_admin_id INTEGER', () => {});

  // User preferences
  db.run("ALTER TABLE users ADD COLUMN ui_lang TEXT DEFAULT 'az'", () => {});
  db.run("ALTER TABLE users ADD COLUMN ui_theme TEXT DEFAULT 'light'", () => {});
  db.run('ALTER TABLE users ADD COLUMN notify_report INTEGER DEFAULT 1', () => {});
  db.run('ALTER TABLE users ADD COLUMN notify_limit INTEGER DEFAULT 1', () => {});
  db.run('ALTER TABLE users ADD COLUMN notify_disabled INTEGER DEFAULT 1', () => {});
  db.run("ALTER TABLE users ADD COLUMN auth_provider TEXT DEFAULT 'local'", () => {});
  db.run('ALTER TABLE users ADD COLUMN google_id TEXT', () => {});
  db.run('ALTER TABLE users ADD COLUMN verification_expires_at TEXT', () => {});
  db.run("ALTER TABLE users ADD COLUMN plan_tier TEXT DEFAULT 'free'", () => {});
  db.run("ALTER TABLE users ADD COLUMN plan_status TEXT DEFAULT 'active'", () => {});
  db.run('ALTER TABLE users ADD COLUMN pro_expires_at TEXT', () => {});
  db.run('ALTER TABLE users ADD COLUMN pro_paused_at TEXT', () => {});
  db.run('ALTER TABLE users ADD COLUMN pro_updated_at TEXT', () => {});
  db.run(`ALTER TABLE api_keys ADD COLUMN scopes TEXT NOT NULL DEFAULT '${DEFAULT_API_KEY_SCOPES_STORAGE}'`, () => {});
  db.run('ALTER TABLE api_keys ADD COLUMN hash_version INTEGER NOT NULL DEFAULT 1', () => {});
  db.run("ALTER TABLE webhooks ADD COLUMN message_locale TEXT DEFAULT 'auto'", () => {});
  db.run('ALTER TABLE webhooks ADD COLUMN message_template TEXT', () => {});
  db.run('ALTER TABLE webhooks ADD COLUMN secret_hash_version INTEGER NOT NULL DEFAULT 1', () => {});
  db.run('ALTER TABLE webhooks ADD COLUMN signature_v2_key TEXT', () => {});
  db.run('ALTER TABLE webhooks ADD COLUMN signature_v2_enabled INTEGER NOT NULL DEFAULT 0', () => {});
  db.run("UPDATE users SET auth_provider = 'local' WHERE auth_provider IS NULL OR auth_provider = ''", () => {});
  db.run("UPDATE users SET plan_tier = 'free' WHERE plan_tier IS NULL OR plan_tier = ''", () => {});
  db.run("UPDATE users SET plan_status = 'active' WHERE plan_status IS NULL OR plan_status = ''", () => {});
  db.run(`UPDATE api_keys SET scopes = '${DEFAULT_API_KEY_SCOPES_STORAGE}' WHERE scopes IS NULL OR TRIM(scopes) = ''`, () => {});
  db.run("UPDATE api_keys SET hash_version = 1 WHERE hash_version IS NULL OR hash_version < 1", () => {});
  db.run("UPDATE webhooks SET message_locale = 'auto' WHERE message_locale IS NULL OR message_locale = ''", () => {});
  db.run("UPDATE webhooks SET secret_hash_version = 1 WHERE secret_hash_version IS NULL OR secret_hash_version < 1", () => {});
  db.run("UPDATE webhooks SET signature_v2_enabled = 0 WHERE signature_v2_enabled IS NULL", () => {});
  db.run("UPDATE webhooks SET signature_v2_enabled = 1 WHERE signature_v2_key IS NOT NULL AND TRIM(signature_v2_key) <> ''", () => {});
  db.run(
    "UPDATE webhooks SET events = 'link.created,link.updated,link.deleted,webhook.test' " +
    "WHERE events IS NULL OR TRIM(events) = '' OR LOWER(REPLACE(events, ' ', '')) = 'link.created'",
    () => {}
  );


  db.run("UPDATE users SET ui_lang = 'az' WHERE ui_lang IS NULL OR ui_lang = ''", () => {});
  db.run("UPDATE users SET ui_theme = 'light' WHERE ui_theme IS NULL OR ui_theme = ''", () => {});
  db.run('UPDATE users SET notify_report = 1 WHERE notify_report IS NULL', () => {});
  db.run('UPDATE users SET notify_limit = 1 WHERE notify_limit IS NULL', () => {});
  db.run('UPDATE users SET notify_disabled = 1 WHERE notify_disabled IS NULL', () => {});

  // Helpful indexes
  db.run('CREATE INDEX IF NOT EXISTS idx_reports_short ON reports(short)', () => {});
  db.run('CREATE INDEX IF NOT EXISTS idx_reports_short_created_at ON reports(short, created_at DESC)', () => {});
  db.run('CREATE INDEX IF NOT EXISTS idx_clicks_url_id ON clicks(url_id)', () => {});
  db.run('CREATE INDEX IF NOT EXISTS idx_urls_user_id ON urls(user_id)', () => {});
  db.run('CREATE INDEX IF NOT EXISTS idx_urls_user_created_at ON urls(user_id, created_at DESC)', () => {});
  db.run('CREATE INDEX IF NOT EXISTS idx_urls_domain_host ON urls(domain_host)', () => {});
  db.run('CREATE INDEX IF NOT EXISTS idx_custom_domains_user_id ON custom_domains(user_id)', () => {});
  db.run('CREATE INDEX IF NOT EXISTS idx_custom_domains_status ON custom_domains(status)', () => {});
  db.run('CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id)', () => {});
  db.run('CREATE INDEX IF NOT EXISTS idx_user_sessions_last_seen ON user_sessions(last_seen_at)', () => {});
  db.run('CREATE INDEX IF NOT EXISTS idx_user_sessions_device_fp ON user_sessions(user_id, device_fingerprint)', () => {});
  db.run('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)', () => {});
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id)', () => {});
  db.run('CREATE INDEX IF NOT EXISTS idx_users_plan ON users(plan_tier, plan_status, pro_expires_at)', () => {});
  db.run('CREATE INDEX IF NOT EXISTS idx_blocked_domains_domain ON blocked_domains(domain)', () => {});
  db.run('CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_log(created_at)', () => {});
  db.run('CREATE INDEX IF NOT EXISTS idx_api_keys_user_active ON api_keys(user_id, revoked_at)', () => {});
  db.run('CREATE INDEX IF NOT EXISTS idx_api_keys_user_created ON api_keys(user_id, created_at DESC)', () => {});
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)', () => {});
  db.run('CREATE INDEX IF NOT EXISTS idx_webhooks_user_active ON webhooks(user_id, is_active)', () => {});
  db.run('CREATE INDEX IF NOT EXISTS idx_webhooks_user_created ON webhooks(user_id, created_at DESC)', () => {});
  db.run('CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id, status, next_retry_at)', () => {});
  db.run('CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_user ON webhook_deliveries(user_id, created_at)', () => {});
  db.run('CREATE INDEX IF NOT EXISTS idx_user_sessions_user_seen ON user_sessions(user_id, is_revoked, last_seen_at DESC)', () => {});
  db.run('CREATE INDEX IF NOT EXISTS idx_api_idem_lookup ON api_idempotency_keys(user_id, endpoint, idempotency_hash)', () => {});
  db.run('CREATE INDEX IF NOT EXISTS idx_api_idem_expiry ON api_idempotency_keys(expires_at)', () => {});
  db.run('CREATE INDEX IF NOT EXISTS idx_api_usage_user_created ON api_usage_logs(user_id, created_at)', () => {});
  db.run('CREATE INDEX IF NOT EXISTS idx_api_usage_key_created ON api_usage_logs(api_key_id, created_at)', () => {});
  db.run('CREATE INDEX IF NOT EXISTS idx_api_usage_user_error ON api_usage_logs(user_id, error_type, created_at)', () => {});
  db.run('CREATE INDEX IF NOT EXISTS idx_api_usage_user_method ON api_usage_logs(user_id, method, created_at)', () => {});
  db.run('CREATE INDEX IF NOT EXISTS idx_subscription_audit_target ON subscription_audit(target_user_id, created_at)', () => {});
  db.run('CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(created_at)', () => {});
  db.run('CREATE INDEX IF NOT EXISTS idx_security_events_type ON security_events(event_type, outcome, created_at)', () => {});

  // Notifications
  db.run('ALTER TABLE notifications ADD COLUMN title_en TEXT', () => {});
  db.run('ALTER TABLE notifications ADD COLUMN body_en TEXT', () => {});
  db.run(`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    title_az TEXT,
    title_tr TEXT,
    title_en TEXT,
    body_az TEXT,
    body_tr TEXT,
    body_en TEXT,
    link_short TEXT,
    event_key TEXT,
    created_at TEXT,
    read_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  db.run('CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id)', () => {});
  db.run('CREATE INDEX IF NOT EXISTS idx_notifications_read_at ON notifications(read_at)', () => {});
  db.run('CREATE INDEX IF NOT EXISTS idx_notifications_user_created_at ON notifications(user_id, created_at DESC)', () => {});
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_user_event ON notifications(user_id, event_key)', () => {});

  // Password reset tokens
  db.run(`CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  const allTablesForRls = [
    'users', 'urls', 'reports', 'clicks', 'site_settings', 'admin_users', 
    'blocked_domains', 'admin_audit_log', 'admin_auth_audit', 'guest_limits',
    'custom_domains', 'user_sessions', 'api_keys', 'webhooks', 'webhook_deliveries',
    'subscription_audit', 'security_events', 'api_idempotency_keys', 'api_usage_logs',
    'notifications', 'password_resets'
  ];
  allTablesForRls.forEach(t => {
    db.run(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`, () => {});
  });

  db.run('CREATE INDEX IF NOT EXISTS idx_password_resets_user_id ON password_resets(user_id)', () => {});
  db.run('CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets(token_hash)', () => {});
  db.run(
    "UPDATE users SET verification_expires_at = ? WHERE email_verified != 1 AND verification_code IS NOT NULL AND (verification_expires_at IS NULL OR TRIM(verification_expires_at) = '')",
    [buildVerificationExpiryIso(30)],
    () => {}
  );

  db.all('SELECT key, value FROM site_settings', [], (err, rows) => {
    if (err || !rows) return;
    rows.forEach((r) => {
      if (r && r.key) siteSettings[r.key] = r.value;
    });
  });

  refreshCustomDomainCache();

  // Seed the first admin user from env (only if table is empty)
  db.get('SELECT COUNT(*) AS cnt FROM admin_users', (err, row) => {
    if (err) return;
    if ((row && row.cnt) > 0) return;
    const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const password = (process.env.ADMIN_PASSWORD || '').toString();
    if (!email || !password) {
      console.warn('[admin] No admin users exist. Set ADMIN_EMAIL and ADMIN_PASSWORD to seed the first admin.');
      return;
    }
    bcrypt.hash(password, 12, (hashErr, hash) => {
      if (hashErr) return;
      db.run(
        'INSERT INTO admin_users (email, password_hash, role, created_at) VALUES (?, ?, ?, ?)',
        [email, hash, 'admin', new Date().toISOString()],
        () => {
        }
      );
    });
  });
});

ensureUserSessionsSchema(() => {});
scheduleSecurityEventPurge();
scheduleApiIdempotencyPurge();
scheduleApiUsageLogPurge();
void resumePendingWebhookDeliveries();

// New secure admin system (replaces all old hidden admin panels)
// Serve /admin directly to avoid an extra 301 hop (/admin -> /admin/),
// which also reduces scanner false positives on redirect-only responses.
app.get('/admin', (req, res) => {
  if (req.session && req.session.adminUserId) return res.redirect('/admin/links');
  if (!isLikelyBrowserNavigationRequest(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.render('admin/login', {
    csrfToken: res.locals._csrf,
    error: (req.query.msg || '').toString() || null,
    next: '/admin/links',
  });
});
app.use('/admin', createAdminRouter(db, {
  createRateLimitStore,
  getRequestIp,
  getRequestGeoMeta,
}));

/* ----------------------
   KULLANICI KAYIT VE E-POSTA DOĞRULAMA
------------------------- */

// Kayıt (POST /api/register)
// Kullanıcı e-posta ve şifre ile kayıt olur, geçici e-posta kontrolü yapılır,
// 6 haneli doğrulama kodu oluşturulur, e-posta gönderilir ve
// kayıt öncesinde email, session'a "tempEmail" olarak kaydedilir.
app.post('/api/register',
  authLimiter,
  [
    body('email')
      .isEmail().withMessage('Düzgün bir e-poçt ünvanı daxil edin.')
      .normalizeEmail()
      .trim()
      .escape(),
    body('password')
      .isLength({ min: 6 }).withMessage('Şifrə ən az 6 simvoldan ibarət olmalıdır.')
      .trim()
  ],
  (req, res) => {
    // Validation sonuçlarını kontrol et
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const uiLang = normalizeLang(req.body && req.body.lang, 'az');
      const err = errors.array()[0] || {};
      let msg = err.msg || 'Validation error.';
      if (err.param === 'email') {
        msg = pickLang(uiLang, 'Düzgün bir e-poçt ünvanı daxil edin.', 'Düzgün bir e-posta adresi girin.', 'Please enter a valid email address.');
      } else if (err.param === 'password') {
        msg = pickLang(uiLang, 'Şifrə ən az 6 simvoldan ibarət olmalıdır.', 'Şifre en az 6 karakter olmalıdır.', 'Password must be at least 6 characters.');
      }
      return res.status(400).json({ error: msg });
    }

    const { email, password, lang } = req.body;
    const uiLang = normalizeLang(lang, 'az');
    if (!email || !password)
      return res.status(400).json({ error: pickLang(uiLang, 'E-poçt və şifrə tələb olunur.', 'E-posta ve şifre gerekli.', 'Email and password are required.') });

    const emailDomain = email.split('@')[1].toLowerCase();
    if (tempEmailDomains.includes(emailDomain)) {
      return res.status(400).json({ error: pickLang(uiLang, 'Bu e-poçt ünvanı müvəqqəti (fake) görünür. Zəhmət olmasa real e-poçt ünvanı daxil edin.', 'Bu e-posta adresi geçici görünüyor. Lütfen gerçek bir e-posta adresi girin.', 'This email address appears to be temporary. Please enter a real email address.') });
    }

    const verificationCode = generateVerificationCode();
    const verificationExpiresAt = buildVerificationExpiryIso(15);
    const initialLang = uiLang;

    bcrypt.hash(password, 10, (hashErr, hashed) => {
      if (hashErr || !hashed) {
        return res.status(500).json({ error: pickLang(uiLang, 'Hesab yaradıla bilmədi.', 'Hesap oluşturulamadı.', 'Account could not be created.') });
      }

      db.run('INSERT INTO users (email, password, verification_code, verification_expires_at, auth_provider, created_at, ui_lang, ui_theme, notify_report, notify_limit, notify_disabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1)', [email, hashed, verificationCode, verificationExpiresAt, 'local', new Date().toISOString(), initialLang, 'light'], function (err) {
        if (err) return res.status(500).json({ error: pickLang(uiLang, 'Bu e-poçt artıq istifadə edilib.', 'Bu e-posta zaten kullanılıyor.', 'This email is already in use.') });

        sendVerificationEmail(email, verificationCode, uiLang)
          .then(() => {
            req.session.tempEmail = email;
            res.json({ message: pickLang(uiLang, `${email} ünvanına təsdiqləmə kodu göndərildi. Zəhmət olmasa təsdiqləmə panelindən istifadə edin.`, `${email} adresine doğrulama kodu gönderildi. Lütfen doğrulama panelini kullanın.`, `A verification code has been sent to ${email}. Please complete verification.`) });
          })
          .catch((error) => {
            console.error("Mail gönderim hatası:", error);
            res.status(500).json({ error: pickLang(uiLang, 'Təsdiqləmə e-poçtu göndərilə bilmədi.', 'Doğrulama e-postası gönderilemedi.', 'Verification email could not be sent.') });
          });
      });
    });
  });

// E-posta Doğrulama (POST /api/verify-email)
// Kullanıcı, doğrulama panelinde girilen kodu gönderir. Kod doğru ise kayıt tamamlanır.
app.post('/api/verify-email',
  authLimiter,
  [
    body('email').isEmail().withMessage('Düzgün bir e-poçt ünvanı daxil edin.').normalizeEmail().trim(),
    body('verificationCode').isLength({ min: 6, max: 6 }).isNumeric().withMessage('Təsdiqləmə kodu 6 rəqəm olmalıdır.').trim(),
  ],
  (req, res) => {
    const uiLang = normalizeLang(req.body && req.body.lang, 'az');
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const first = errors.array()[0] || {};
      if (first.param === 'email') {
        return res.status(400).json({ error: pickLang(uiLang, 'Düzgün bir e-poçt ünvanı daxil edin.', 'Düzgün bir e-posta adresi girin.', 'Please enter a valid email address.') });
      }
      return res.status(400).json({ error: pickLang(uiLang, 'Təsdiqləmə kodu 6 rəqəm olmalıdır.', 'Doğrulama kodu 6 haneli olmalıdır.', 'Verification code must be 6 digits.') });
    }

    const email = (req.body.email || '').toString().trim().toLowerCase();
    const verificationCode = (req.body.verificationCode || '').toString().trim();

    db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
      if (err || !user) return res.status(404).json({ error: pickLang(uiLang, 'İstifadəçi tapılmadı.', 'Kullanıcı bulunamadı.', 'User not found.') });

      const storedCode = (user.verification_code || '').toString();
      const verificationExpiresMs = Date.parse((user.verification_expires_at || '').toString());
      if (!Number.isFinite(verificationExpiresMs) || verificationExpiresMs <= Date.now()) {
        return res.status(400).json({
          error: pickLang(
            uiLang,
            'Təsdiqləmə kodunun vaxtı bitib. Zəhmət olmasa yenidən qeydiyyatdan keçin.',
            'Doğrulama kodunun süresi doldu. Lütfen yeniden kayıt olun.',
            'Verification code has expired. Please register again.'
          )
        });
      }
      const validCode = storedCode.length === verificationCode.length && tsscmp(storedCode, verificationCode);
      if (!validCode) {
        return res.status(400).json({ error: pickLang(uiLang, 'Təsdiqləmə kodu yanlışdır.', 'Doğrulama kodu yanlış.', 'Verification code is incorrect.') });
      }

      db.run('UPDATE users SET email_verified = 1, verification_code = NULL, verification_expires_at = NULL WHERE email = ?', [email], (updateErr) => {
        if (updateErr) {
          return res.status(500).json({ error: pickLang(uiLang, 'Təsdiqləmə tamamlanmadı.', 'Doğrulama tamamlanamadı.', 'Verification could not be completed.') });
        }

        // Prevent session fixation in auto-login after verification.
        return req.session.regenerate((regenErr) => {
          if (regenErr) return res.status(500).json({ error: pickLang(uiLang, 'Oturum açıla bilmədi.', 'Oturum açılamadı.', 'Session could not be created.') });
          req.session.userId = user.id;
          req.session.username = user.email;
          return upsertUserSessionRecord(req, user.id, { loginMethod: 'verify_email' }, () => {
            return req.session.save((saveErr) => {
              if (saveErr) return res.status(500).json({ error: pickLang(uiLang, 'Oturum açıla bilmədi.', 'Oturum açılamadı.', 'Session could not be created.') });
              return res.json({ message: pickLang(uiLang, 'E-poçt təsdiqləndi. Giriş edilir...', 'E-posta doğrulaması başarılı. Giriş yapılıyor...', 'Email verified. Signing you in...'), redirect: '/' });
            });
          });
        });
      });
    });
  }
);

/* ----------------------
   GİRİŞ / ÇIKIŞ İŞLEMLERİ
------------------------- */

app.post('/api/login',
  authLimiter,
  [
    body('email')
      .isEmail().withMessage('Düzgün bir e-poçt ünvanı daxil edin.')
      .normalizeEmail()
      .trim()
      .escape(),
    body('password')
      .notEmpty().withMessage('Şifrə tələb olunur.')
      .trim()
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const uiLang = normalizeLang(req.body && req.body.lang, 'az');
      const err = errors.array()[0] || {};
      let msg = err.msg || 'Validation error.';
      if (err.param === 'email') {
        msg = pickLang(uiLang, 'Düzgün bir e-poçt ünvanı daxil edin.', 'Düzgün bir e-posta adresi girin.', 'Please enter a valid email address.');
      } else if (err.param === 'password') {
        msg = pickLang(uiLang, 'Şifrə tələb olunur.', 'Şifre gerekli.', 'Password is required.');
      }
      return res.status(400).json({ error: msg });
    }
    const uiLang = normalizeLang(req.body && req.body.lang, 'az');
    const { email, password } = req.body;
    db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
      const wrongMsg = pickLang(uiLang, 'E-poçt və ya şifrə yanlışdır.', 'E-posta veya şifre yanlış.', 'Email or password is incorrect.');
      const emailHint = (email || '').toString().trim().slice(0, 128);

      if (err || !user) {
        logSecurityEvent(req, 'auth.login', 'failure', { reason: 'user_not_found', email_hint: emailHint });
        return res.status(401).json({ error: wrongMsg });
      }
      if (!user.password) {
        logSecurityEvent(req, 'auth.login', 'blocked', { reason: 'google_only_account', user_id: user.id });
        return res.status(403).json({ error: pickLang(uiLang, 'Bu hesab Google ilə giriş üçündür.', 'Bu hesap Google ile giriş içindir.', 'This account uses Google sign-in.') });
      }
      return bcrypt.compare(password, user.password, (cmpErr, passwordOk) => {
        if (cmpErr || !passwordOk) {
          logSecurityEvent(req, 'auth.login', 'failure', { reason: 'invalid_password', user_id: user.id });
          return res.status(401).json({ error: wrongMsg });
        }
        if (user.email_verified != 1) {
          logSecurityEvent(req, 'auth.login', 'blocked', { reason: 'email_unverified', user_id: user.id });
          return res.status(403).json({
            error: pickLang(uiLang, 'E-poçt təsdiqlənməyib. Zəhmət olmasa e-poçt qutunuzu yoxlayın.', 'E-posta doğrulanmamış. Lütfen e-posta kutunuzu kontrol edin.', 'Email is not verified. Please check your inbox.')
          });
        }

        // Auto-clear expired temp bans
        if (user.banned == 1 && user.ban_until) {
          const untilMs = Date.parse(user.ban_until);
          if (!Number.isNaN(untilMs) && untilMs <= Date.now()) {
            db.run(
              'UPDATE users SET banned = 0, ban_until = NULL, ban_reason = NULL, ban_set_at = NULL, ban_set_by_admin_id = NULL WHERE id = ?',
              [user.id],
              () => {}
            );
            user.banned = 0;
          }
        }

        // If user is banned: block login (after successful password check)
        const banActive = (user.banned == 1) && (!user.ban_until || (Date.parse(user.ban_until) > Date.now()));
        if (banActive) {
          const msg = buildBanMessage(uiLang, user.ban_until, user.ban_reason);
          logSecurityEvent(req, 'auth.login', 'blocked', { reason: 'banned', user_id: user.id });
          return res.status(403).json({ error: msg });
        }

        return req.session.regenerate((regenErr) => {
          if (regenErr) {
            logSecurityEvent(req, 'auth.login', 'failure', { reason: 'session_regenerate_failed', user_id: user.id });
            return res.status(500).json({ error: pickLang(uiLang, 'Oturum açıla bilmədi.', 'Oturum açılamadı.', 'Session could not be created.') });
          }
          req.session.userId = user.id;
          req.session.username = email;
          db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [new Date().toISOString(), user.id], () => {});
          return upsertUserSessionRecord(req, user.id, { loginMethod: 'password' }, () => {
            return req.session.save((saveErr) => {
              if (saveErr) {
                logSecurityEvent(req, 'auth.login', 'failure', { reason: 'session_save_failed', user_id: user.id });
                return res.status(500).json({ error: pickLang(uiLang, 'Oturum açıla bilmədi.', 'Oturum açılamadı.', 'Session could not be created.') });
              }
              logSecurityEvent(req, 'auth.login', 'success', { user_id: user.id });
              return res.json({ message: pickLang(uiLang, 'Giriş uğurludur', 'Giriş başarılı', 'Login successful'), username: email });
            });
          });
        });
      });
    });
  });


// Google OAuth (OIDC) Login
app.get('/auth/google', authLimiter, async (req, res) => {
  if (!googleOidc.ready || !googleOidc.client || !googleOidc.generators) {
    await initGoogleOidc({ req, force: true });
  }
  if (!googleOidc.ready || !googleOidc.client || !googleOidc.generators) {
    if (googleOidcInitError) {
      console.warn('[google-auth] unavailable', { reason: googleOidcInitError });
    }
    logSecurityEvent(req, 'auth.google.start', 'blocked', { reason: 'google_unavailable' });
    return res.redirect('/login?error=google_unavailable');
  }

  const redirectUri = getGoogleRedirectUri(req);
  if (!redirectUri) {
    logSecurityEvent(req, 'auth.google.start', 'blocked', { reason: 'missing_redirect_uri' });
    return res.redirect('/login?error=google_unavailable');
  }

  const { generators } = googleOidc;
  const state = generators.state();
  const nonce = generators.nonce();
  const codeVerifier = generators.codeVerifier();
  const codeChallenge = generators.codeChallenge(codeVerifier);

  req.session.oauth = {
    state,
    nonce,
    codeVerifier,
    redirectUri,
    createdAt: Date.now()
  };

  const url = googleOidc.client.authorizationUrl({
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
    redirect_uri: redirectUri
  });

  return req.session.save((saveErr) => {
    if (saveErr) {
      console.error('[google-auth] session save failed', saveErr);
      logSecurityEvent(req, 'auth.google.start', 'failure', { reason: 'session_save_failed' });
      return res.redirect('/login?error=google_failed');
    }
    logSecurityEvent(req, 'auth.google.start', 'success', { reason: 'redirect_initiated' });
    return res.redirect(url);
  });
});

app.get('/auth/google/callback', authLimiter, async (req, res) => {
  if (!googleOidc.ready || !googleOidc.client) {
    await initGoogleOidc({ req, force: true });
  }
  if (!googleOidc.ready || !googleOidc.client) {
    logSecurityEvent(req, 'auth.google.callback', 'blocked', { reason: 'google_unavailable' });
    return res.redirect('/login?error=google_unavailable');
  }

  try {
    const oauth = req.session.oauth || {};
    const callbackState = Array.isArray(req.query.state) ? req.query.state[0] : req.query.state;
    const now = Date.now();

    if (!oauth.state || !callbackState || oauth.state !== callbackState) {
      req.session.oauth = null;
      console.warn('[google-auth] state mismatch', {
        hasSession: !!req.session,
        hasOAuth: !!req.session?.oauth,
        hasState: !!oauth.state,
        hasCallbackState: !!callbackState,
      });
      logSecurityEvent(req, 'auth.google.callback', 'failure', { reason: 'state_mismatch' });
      return res.redirect('/login?error=google_failed');
    }

    if (oauth.createdAt && (now - oauth.createdAt) > 10 * 60 * 1000) {
      req.session.oauth = null;
      logSecurityEvent(req, 'auth.google.callback', 'failure', { reason: 'oauth_expired' });
      return res.redirect('/login?error=google_failed');
    }

    const callbackRedirectUri = (oauth.redirectUri || getGoogleRedirectUri(req) || googleOidc.redirectUri || '').toString();
    if (!callbackRedirectUri) {
      req.session.oauth = null;
      logSecurityEvent(req, 'auth.google.callback', 'blocked', { reason: 'missing_redirect_uri' });
      return res.redirect('/login?error=google_unavailable');
    }

    const params = googleOidc.client.callbackParams(req);
    const tokenSet = await googleOidc.client.callback(callbackRedirectUri, params, {
      state: oauth.state,
      nonce: oauth.nonce,
      code_verifier: oauth.codeVerifier
    });

    req.session.oauth = null;

    const claims = tokenSet.claims();
    if (!claims || !claims.email || !claims.email_verified) {
      logSecurityEvent(req, 'auth.google.callback', 'blocked', { reason: 'email_unverified' });
      return res.redirect('/login?error=google_unverified');
    }

    const email = (claims.email || '').toLowerCase();
    const googleId = claims.sub;
    const fallbackLang = normalizeLang(res.locals.defaultLang || 'az', 'az');

    db.get('SELECT * FROM users WHERE google_id = ?', [googleId], (err, user) => {
      if (err) {
        logSecurityEvent(req, 'auth.google.callback', 'failure', { reason: 'db_lookup_failed' });
        return res.redirect('/login?error=google_failed');
      }
      if (user) {
        const uiLang = normalizeLang(user.ui_lang || fallbackLang, 'az');
        if (user.banned == 1 && user.ban_until) {
          const untilMs = Date.parse(user.ban_until);
          if (!Number.isNaN(untilMs) && untilMs <= Date.now()) {
            db.run(
              'UPDATE users SET banned = 0, ban_until = NULL, ban_reason = NULL, ban_set_at = NULL, ban_set_by_admin_id = NULL WHERE id = ?',
              [user.id],
              () => {}
            );
            user.banned = 0;
          }
        }
        const banActive = (user.banned == 1) && (!user.ban_until || (Date.parse(user.ban_until) > Date.now()));
        if (banActive) {
          const msg = buildBanMessage(uiLang, user.ban_until, user.ban_reason);
          logSecurityEvent(req, 'auth.google.callback', 'blocked', { reason: 'banned', user_id: user.id });
          return res.redirect('/login?error=ban&message=' + encodeURIComponent(msg));
        }
        return req.session.regenerate((regenErr) => {
          if (regenErr) {
            logSecurityEvent(req, 'auth.google.callback', 'failure', { reason: 'session_regenerate_failed', user_id: user.id });
            return res.redirect('/login?error=google_failed');
          }
          req.session.userId = user.id;
          req.session.username = user.email;
          db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [new Date().toISOString(), user.id], () => {});
          return upsertUserSessionRecord(req, user.id, { loginMethod: 'google' }, () => {
            return req.session.save((saveErr) => {
              if (saveErr) {
                logSecurityEvent(req, 'auth.google.callback', 'failure', { reason: 'session_save_failed', user_id: user.id });
                return res.redirect('/login?error=google_failed');
              }
              logSecurityEvent(req, 'auth.google.callback', 'success', { reason: 'existing_google_user', user_id: user.id });
              return res.redirect('/');
            });
          });
        });
      }

      db.get('SELECT * FROM users WHERE email = ?', [email], (err2, existing) => {
        if (err2) {
          logSecurityEvent(req, 'auth.google.callback', 'failure', { reason: 'email_lookup_failed' });
          return res.redirect('/login?error=google_failed');
        }

        if (existing) {
          const uiLang = normalizeLang(existing.ui_lang || fallbackLang, 'az');
          if (existing.banned == 1 && existing.ban_until) {
            const untilMs = Date.parse(existing.ban_until);
            if (!Number.isNaN(untilMs) && untilMs <= Date.now()) {
              db.run(
                'UPDATE users SET banned = 0, ban_until = NULL, ban_reason = NULL, ban_set_at = NULL, ban_set_by_admin_id = NULL WHERE id = ?',
                [existing.id],
                () => {}
              );
              existing.banned = 0;
            }
          }
          const banActive = (existing.banned == 1) && (!existing.ban_until || (Date.parse(existing.ban_until) > Date.now()));
          if (banActive) {
            const msg = buildBanMessage(uiLang, existing.ban_until, existing.ban_reason);
            logSecurityEvent(req, 'auth.google.callback', 'blocked', { reason: 'banned', user_id: existing.id });
            return res.redirect('/login?error=ban&message=' + encodeURIComponent(msg));
          }

          return db.run(
            'UPDATE users SET google_id = ?, email_verified = 1 WHERE id = ?',
            [googleId, existing.id],
            (updateErr) => {
              if (updateErr) {
                logSecurityEvent(req, 'auth.google.callback', 'failure', { reason: 'google_attach_failed', user_id: existing.id });
                return res.redirect('/login?error=google_failed');
              }
              req.session.regenerate((regenErr) => {
                if (regenErr) {
                  logSecurityEvent(req, 'auth.google.callback', 'failure', { reason: 'session_regenerate_failed', user_id: existing.id });
                  return res.redirect('/login?error=google_failed');
                }
                req.session.userId = existing.id;
                req.session.username = existing.email;
                db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [new Date().toISOString(), existing.id], () => {});
                return upsertUserSessionRecord(req, existing.id, { loginMethod: 'google' }, () => {
                  return req.session.save((saveErr) => {
                    if (saveErr) {
                      logSecurityEvent(req, 'auth.google.callback', 'failure', { reason: 'session_save_failed', user_id: existing.id });
                      return res.redirect('/login?error=google_failed');
                    }
                    logSecurityEvent(req, 'auth.google.callback', 'success', { reason: 'existing_email_linked', user_id: existing.id });
                    return res.redirect('/');
                  });
                });
              });
            }
          );
        }

        const createdAt = new Date().toISOString();
        const initialLang = fallbackLang;
        db.run(
          'INSERT INTO users (email, password, email_verified, google_id, auth_provider, created_at, ui_lang, ui_theme, notify_report, notify_limit, notify_disabled) VALUES (?, ?, 1, ?, ?, ?, ?, ?, 1, 1, 1)',
          [email, null, googleId, 'google', createdAt, initialLang, 'light'],
          function (err3) {
            if (err3) {
              logSecurityEvent(req, 'auth.google.callback', 'failure', { reason: 'user_create_failed' });
              return res.redirect('/login?error=google_failed');
            }
            const newUserId = this.lastID;
            req.session.regenerate((regenErr) => {
              if (regenErr) {
                logSecurityEvent(req, 'auth.google.callback', 'failure', { reason: 'session_regenerate_failed', user_id: newUserId });
                return res.redirect('/login?error=google_failed');
              }
              req.session.userId = newUserId;
              req.session.username = email;
              db.run('UPDATE users SET last_login_at = ? WHERE id = ?', [new Date().toISOString(), newUserId], () => {});
              return upsertUserSessionRecord(req, newUserId, { loginMethod: 'google' }, () => {
                return req.session.save((saveErr) => {
                  if (saveErr) {
                    logSecurityEvent(req, 'auth.google.callback', 'failure', { reason: 'session_save_failed', user_id: newUserId });
                    return res.redirect('/login?error=google_failed');
                  }
                  logSecurityEvent(req, 'auth.google.callback', 'success', { reason: 'new_google_user', user_id: newUserId });
                  return res.redirect('/');
                });
              });
            });
          }
        );
      });
    });
  } catch (err) {
    console.error('[google-auth] callback failed', err);
    logSecurityEvent(req, 'auth.google.callback', 'failure', { reason: 'callback_exception' });
    return res.redirect('/login?error=google_failed');
  }
});

function handleLogout(req, res) {
  const sessionToken = normalizeSessionToken(req.session && req.session.userSessionToken);
  const userId = req.session && req.session.userId;
  const revokeNow = new Date().toISOString();

  if (userId && sessionToken) {
    db.run(
      'UPDATE user_sessions SET is_revoked = 1, revoked_at = ? WHERE user_id = ? AND session_token = ?',
      [revokeNow, userId, sessionToken],
      () => {}
    );
  }

  try {
    res.clearCookie('connect.sid');
  } catch {}

  // Best-effort session destroy.
  if (req.session) {
    try {
      req.session.destroy(() => {});
    } catch {}
  }

  // If the browser navigates here directly (GET), always go back home.
  if (req.method === 'GET') return res.redirect('/');

  const accept = (req.get('accept') || '').toLowerCase();
  const isNavigate = (req.get('sec-fetch-mode') || '').toLowerCase() === 'navigate';
  const wantsHtml = isNavigate || (accept.includes('text/html') && !accept.includes('application/json'));
  if (wantsHtml) return res.redirect('/');
  return res.json({ message: pickLang(req.defaultLang || 'az', 'Çıxış edildi.', 'Çıkış yapıldı.', 'Logged out.') });
}

app.post('/api/logout', handleLogout);


// Oturum Bilgisi (GET /api/me)
app.get('/api/me', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ user: null });
  }

  db.get(
    'SELECT ui_lang, ui_theme, notify_report, notify_limit, notify_disabled, auth_provider, google_id, password, plan_tier, plan_status, pro_expires_at, pro_paused_at FROM users WHERE id = ?',
    [req.session.userId],
    async (err, row) => {
      if (err || !row) {
        return res.status(500).json({ user: null });
      }

      let plan = buildPlanPayload(row);
      if (isProExpired(row)) {
        try {
          const refreshed = await downgradeExpiredProIfNeeded(req.session.userId);
          plan = buildPlanPayload(refreshed || row);
        } catch {
          // keep current row-derived plan if downgrade fails
        }
      }

      const settings = row ? {
        ui_lang: row.ui_lang || 'az',
        ui_theme: row.ui_theme || 'light',
        notify_report: row.notify_report == 1,
        notify_limit: row.notify_limit == 1,
        notify_disabled: row.notify_disabled == 1,
      } : null;

      return res.json({
        user: {
          id: req.session.userId,
          email: req.session.username,
          isAdmin: !!req.session.adminUserId,
          auth_provider: row && row.auth_provider ? row.auth_provider : 'local',
          has_password: !!(row && row.password),
          has_google: !!(row && row.google_id),
          planTier: plan.tier,
          planStatus: plan.status,
          proExpiresAt: plan.expires_at,
          proPausedAt: plan.paused_at,
          proActive: plan.is_active,
          proFeatures: plan.features,
          settings,
        }
      });
    }
  );
});

async function loadProOverviewPayload(userId, planPayload) {
  const readLimit = PRO_API_READ_RATE_LIMIT_MAX;
  const writeLimit = PRO_API_WRITE_RATE_LIMIT_MAX;
  const payload = {
    plan: planPayload,
    limits: {
      api_keys_max_active: PRO_API_KEY_MAX_ACTIVE,
      webhooks_max_active: PRO_WEBHOOK_MAX_ACTIVE,
      webhook_retry_attempts: WEBHOOK_MAX_ATTEMPTS,
      security_log_retention_days: SECURITY_EVENT_RETENTION_DAYS,
      api_read_window_seconds: Math.floor(PRO_API_READ_RATE_LIMIT_WINDOW_MS / 1000),
      api_write_window_seconds: Math.floor(PRO_API_WRITE_RATE_LIMIT_WINDOW_MS / 1000),
      api_read_limit_per_window: readLimit,
      api_write_limit_per_window: writeLimit,
    },
    api_usage: {
      read_limit_per_window: readLimit,
      write_limit_per_window: writeLimit,
      window_seconds: Math.floor(Math.max(PRO_API_READ_RATE_LIMIT_WINDOW_MS, PRO_API_WRITE_RATE_LIMIT_WINDOW_MS) / 1000),
      read_window_seconds: Math.floor(PRO_API_READ_RATE_LIMIT_WINDOW_MS / 1000),
      write_window_seconds: Math.floor(PRO_API_WRITE_RATE_LIMIT_WINDOW_MS / 1000),
      read_used_current_window: 0,
      write_used_current_window: 0,
      read_remaining_current_window: readLimit,
      write_remaining_current_window: writeLimit,
      last_24h_total: 0,
      last_24h_errors: 0,
      error_types: [],
      status_codes: [],
    },
    api_keys: [],
    webhooks: [],
    deliveries: [],
  };

  if (!planPayload || normalizePlanTier(planPayload.tier) !== PLAN_TIERS.PRO) {
    return payload;
  }

  const apiUsageSchemaReady = await ensureApiUsageLogsSchema().catch(() => false);
  if (!apiUsageSchemaReady) {
    return payload;
  }

  const nowMs = Date.now();
  const readWindowStartIso = new Date(nowMs - PRO_API_READ_RATE_LIMIT_WINDOW_MS).toISOString();
  const writeWindowStartIso = new Date(nowMs - PRO_API_WRITE_RATE_LIMIT_WINDOW_MS).toISOString();
  const lastDayIso = new Date(nowMs - (24 * 60 * 60 * 1000)).toISOString();

  const readWindowRow = await dbGetAsync(
    "SELECT COUNT(*) AS cnt FROM api_usage_logs WHERE user_id = ? AND created_at >= ? AND method IN ('GET','HEAD','OPTIONS')",
    [userId, readWindowStartIso]
  ).catch(() => null);
  const writeWindowRow = await dbGetAsync(
    "SELECT COUNT(*) AS cnt FROM api_usage_logs WHERE user_id = ? AND created_at >= ? AND method NOT IN ('GET','HEAD','OPTIONS')",
    [userId, writeWindowStartIso]
  ).catch(() => null);

  const readUsed = Number.parseInt(readWindowRow && readWindowRow.cnt, 10) || 0;
  const writeUsed = Number.parseInt(writeWindowRow && writeWindowRow.cnt, 10) || 0;
  payload.api_usage.read_used_current_window = readUsed;
  payload.api_usage.write_used_current_window = writeUsed;
  payload.api_usage.read_remaining_current_window = Math.max(0, readLimit - readUsed);
  payload.api_usage.write_remaining_current_window = Math.max(0, writeLimit - writeUsed);

  const totalsRow = await dbGetAsync(
    'SELECT COUNT(*) AS total, SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors FROM api_usage_logs WHERE user_id = ? AND created_at >= ?',
    [userId, lastDayIso]
  ).catch(() => null);
  payload.api_usage.last_24h_total = Number.parseInt(totalsRow && totalsRow.total, 10) || 0;
  payload.api_usage.last_24h_errors = Number.parseInt(totalsRow && totalsRow.errors, 10) || 0;

  const errorTypes = await dbAllAsync(
    'SELECT error_type, COUNT(*) AS cnt FROM api_usage_logs WHERE user_id = ? AND created_at >= ? AND status_code >= 400 GROUP BY error_type ORDER BY cnt DESC LIMIT 8',
    [userId, lastDayIso]
  ).catch(() => []);
  payload.api_usage.error_types = (errorTypes || []).map((row) => ({
    type: (row && row.error_type ? row.error_type : 'unknown').toString(),
    count: Number.parseInt(row && row.cnt, 10) || 0,
  }));

  const statusCodes = await dbAllAsync(
    'SELECT status_code, COUNT(*) AS cnt FROM api_usage_logs WHERE user_id = ? AND created_at >= ? AND status_code >= 400 GROUP BY status_code ORDER BY cnt DESC LIMIT 6',
    [userId, lastDayIso]
  ).catch(() => []);
  payload.api_usage.status_codes = (statusCodes || []).map((row) => ({
    code: Number.parseInt(row && row.status_code, 10) || 0,
    count: Number.parseInt(row && row.cnt, 10) || 0,
  }));

  const apiKeys = await dbAllAsync(
    'SELECT id, name, scopes, key_prefix, last4, created_at, last_used_at, revoked_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
    [userId]
  ).catch(() => []);

  const webhooks = await dbAllAsync(
    'SELECT id, url, events, message_locale, message_template, is_active, signature_v2_enabled, consecutive_failures, last_failure_at, created_at, updated_at FROM webhooks WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
    [userId]
  ).catch(() => []);

  const deliveries = await dbAllAsync(
    'SELECT d.id, d.webhook_id, d.event_type, d.attempt, d.status, d.http_status, d.next_retry_at, d.last_attempt_at, d.created_at, w.url AS webhook_url ' +
    'FROM webhook_deliveries d ' +
    'LEFT JOIN webhooks w ON w.id = d.webhook_id ' +
    'WHERE d.user_id = ? ' +
    'ORDER BY d.created_at DESC LIMIT 30',
    [userId]
  ).catch(() => []);

  payload.api_keys = (apiKeys || []).map((row) => ({
    id: row.id,
    name: row.name || 'API key',
    scopes: normalizeApiKeyScopes(row.scopes || '', DEFAULT_API_KEY_SCOPES),
    key_prefix: row.key_prefix || '',
    last4: row.last4 || '',
    created_at: row.created_at || null,
    last_used_at: row.last_used_at || null,
    revoked_at: row.revoked_at || null,
  }));

  payload.webhooks = (webhooks || []).map((row) => ({
    id: row.id,
    url: row.url || '',
    events: normalizeWebhookEvents(row.events || ''),
    message_locale: normalizeWebhookMessageLocale(row.message_locale, 'auto'),
    message_template: row.message_template || '',
    is_active: row.is_active == 1,
    signature_v2_enabled: row.signature_v2_enabled == 1,
    consecutive_failures: Number(row.consecutive_failures || 0),
    last_failure_at: row.last_failure_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  }));

  payload.deliveries = (deliveries || []).map((row) => ({
    id: row.id,
    webhook_id: row.webhook_id,
    webhook_url: row.webhook_url || '',
    event_type: row.event_type || '',
    attempt: Number(row.attempt || 0),
    status: row.status || 'queued',
    http_status: row.http_status || null,
    next_retry_at: row.next_retry_at || null,
    last_attempt_at: row.last_attempt_at || null,
    created_at: row.created_at || null,
  }));

  return payload;
}

function parseBooleanInput(value, fallback = false) {
  if (value === true || value === false) return value;
  const raw = (value || '').toString().trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return true;
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false;
  return fallback;
}

function normalizeApiKeyScopes(rawScopes, fallbackScopes = DEFAULT_API_KEY_SCOPES) {
  const fallback = Array.isArray(fallbackScopes) && fallbackScopes.length
    ? fallbackScopes
    : DEFAULT_API_KEY_SCOPES;

  const candidates = [];
  if (Array.isArray(rawScopes)) {
    for (const item of rawScopes) candidates.push((item || '').toString().trim().toLowerCase());
  } else if (typeof rawScopes === 'string') {
    const split = rawScopes.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
    candidates.push(...split);
  }

  const picked = new Set();
  for (const scope of candidates) {
    if (ALLOWED_API_KEY_SCOPES.has(scope)) picked.add(scope);
  }

  if (!picked.size) {
    for (const scope of fallback) {
      const normalized = (scope || '').toString().trim().toLowerCase();
      if (ALLOWED_API_KEY_SCOPES.has(normalized)) picked.add(normalized);
    }
  }

  const ordered = [];
  for (const scope of DEFAULT_API_KEY_SCOPES) {
    if (picked.has(scope)) ordered.push(scope);
  }
  return ordered.length ? ordered : [...DEFAULT_API_KEY_SCOPES];
}

function toApiKeyScopesStorage(rawScopes, fallbackScopes = DEFAULT_API_KEY_SCOPES) {
  return normalizeApiKeyScopes(rawScopes, fallbackScopes).join(',');
}

function hasApiScope(grantedScopes, requiredScope) {
  const required = (requiredScope || '').toString().trim().toLowerCase();
  if (!required) return true;
  const granted = new Set(normalizeApiKeyScopes(grantedScopes, DEFAULT_API_KEY_SCOPES));
  if (granted.has(required)) return true;
  if (required === API_KEY_SCOPES.WEBHOOKS_READ && granted.has(API_KEY_SCOPES.WEBHOOKS_WRITE)) return true;
  return false;
}

function requireApiScope(requiredScope) {
  return (req, res, next) => {
    const scopes = normalizeApiKeyScopes(req.apiAuth && req.apiAuth.scopes, DEFAULT_API_KEY_SCOPES);
    if (hasApiScope(scopes, requiredScope)) return next();
    logSecurityEvent(req, 'api.key.scope.denied', 'blocked', {
      user_id: req.apiAuth && Number.isInteger(req.apiAuth.userId) ? req.apiAuth.userId : null,
      api_key_id: req.apiAuth && Number.isInteger(req.apiAuth.apiKeyId) ? req.apiAuth.apiKeyId : null,
      required_scope: requiredScope,
    });
    return res.status(403).json({ error: 'API key scope does not allow this operation.' });
  };
}

function normalizeIdempotencyKey(rawValue) {
  const value = (rawValue || '').toString().trim();
  if (!value) return '';
  if (value.length < 8 || value.length > 120) return '';
  if (!/^[\x21-\x7E]+$/.test(value)) return '';
  return value;
}

function hashApiIdempotencyKey(rawKey) {
  return crypto
    .createHmac('sha256', API_KEY_HASH_KEY_MATERIAL)
    .update(`ovlink:idempotency:${(rawKey || '').toString()}`)
    .digest('hex');
}

function buildShortenIdempotencyRequestHash(payload) {
  const compact = safeJsonStringify(payload, 3000);
  return crypto.createHash('sha256').update(compact).digest('hex');
}

function parseStoredJsonObject(raw, fallback = null) {
  try {
    const parsed = JSON.parse((raw || '').toString());
    return (parsed && typeof parsed === 'object') ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function reserveApiIdempotencyRecord({ userId, apiKeyId, endpoint, rawIdempotencyKey, requestHash }) {
  const key = normalizeIdempotencyKey(rawIdempotencyKey);
  if (!key) return { enabled: false };

  const safeUserId = Number.parseInt(userId, 10);
  const safeApiKeyId = Number.parseInt(apiKeyId, 10);
  if (!Number.isInteger(safeUserId) || safeUserId <= 0 || !requestHash) {
    return { enabled: false };
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + API_IDEMPOTENCY_RETENTION_HOURS * 60 * 60 * 1000).toISOString();
  const endpointKey = (endpoint || '').toString().trim().slice(0, 64) || 'unknown';
  const idemHash = hashApiIdempotencyKey(key);

  await dbRunAsync('DELETE FROM api_idempotency_keys WHERE expires_at <= ?', [nowIso]).catch(() => {});

  try {
    const inserted = await dbRunAsync(
      'INSERT INTO api_idempotency_keys (user_id, api_key_id, endpoint, idempotency_hash, request_hash, status_code, response_json, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)',
      [safeUserId, Number.isInteger(safeApiKeyId) && safeApiKeyId > 0 ? safeApiKeyId : null, endpointKey, idemHash, requestHash, nowIso, nowIso, expiresAt]
    );
    return {
      enabled: true,
      recordId: inserted && inserted.lastID ? inserted.lastID : null,
      keyHash: idemHash,
      requestHash,
      endpoint: endpointKey,
    };
  } catch (err) {
    const msg = (err && err.message ? err.message : '').toLowerCase();
    if (!msg.includes('unique')) throw err;

    const existing = await dbGetAsync(
      'SELECT id, request_hash, status_code, response_json, expires_at FROM api_idempotency_keys WHERE user_id = ? AND endpoint = ? AND idempotency_hash = ? LIMIT 1',
      [safeUserId, endpointKey, idemHash]
    ).catch(() => null);

    if (!existing) {
      return { enabled: true, replayUnavailable: true };
    }
    if ((existing.request_hash || '') !== requestHash) {
      return {
        enabled: true,
        conflict: true,
        statusCode: 409,
        error: 'This Idempotency-Key was already used with a different payload.',
      };
    }
    if (existing.status_code == null) {
      return {
        enabled: true,
        conflict: true,
        statusCode: 409,
        error: 'A request with this Idempotency-Key is already in progress.',
      };
    }
    const replayPayload = parseStoredJsonObject(existing.response_json, null);
    if (!replayPayload) {
      return {
        enabled: true,
        conflict: true,
        statusCode: 409,
        error: 'Stored idempotent response is unavailable. Please retry with a new key.',
      };
    }
    return {
      enabled: true,
      replayed: true,
      statusCode: Number(existing.status_code || 200),
      payload: replayPayload,
    };
  }
}

async function finalizeApiIdempotencyRecord(recordId, statusCode, payload) {
  const safeId = Number.parseInt(recordId, 10);
  if (!Number.isInteger(safeId) || safeId <= 0) return;
  const nowIso = new Date().toISOString();
  await dbRunAsync(
    'UPDATE api_idempotency_keys SET status_code = ?, response_json = ?, updated_at = ? WHERE id = ?',
    [Number.parseInt(statusCode, 10) || 200, safeJsonStringify(payload, 6000), nowIso, safeId]
  ).catch(() => {});
}

async function releaseApiIdempotencyRecord(recordId) {
  const safeId = Number.parseInt(recordId, 10);
  if (!Number.isInteger(safeId) || safeId <= 0) return;
  await dbRunAsync('DELETE FROM api_idempotency_keys WHERE id = ?', [safeId]).catch(() => {});
}

function getApiKeyFromRequest(req) {
  const xKey = (req.get('x-api-key') || '').toString().trim();
  if (xKey) return xKey;
  const auth = (req.get('authorization') || '').toString().trim();
  if (!auth) return '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? (m[1] || '').trim() : '';
}

function classifyApiUsageErrorType(statusCode) {
  const safeCode = Number.parseInt(statusCode, 10);
  if (!Number.isInteger(safeCode)) return 'unknown';
  if (safeCode < 400) return 'ok';
  if (safeCode === 400) return 'bad_request';
  if (safeCode === 401) return 'unauthorized';
  if (safeCode === 403) return 'forbidden';
  if (safeCode === 404) return 'not_found';
  if (safeCode === 409) return 'conflict';
  if (safeCode === 422) return 'validation';
  if (safeCode === 429) return 'rate_limited';
  if (safeCode >= 500) return 'server_error';
  if (safeCode >= 400 && safeCode < 500) return 'client_error';
  return 'unknown';
}

function trackProApiUsage(req, res, next) {
  if (res.locals && res.locals._proApiUsageTracked) return next();
  if (res.locals) res.locals._proApiUsageTracked = true;

  res.on('finish', () => {
    try {
      const auth = req.apiAuth || {};
      const userId = Number.parseInt(auth.userId, 10);
      const apiKeyId = Number.parseInt(auth.apiKeyId, 10);
      if (!Number.isInteger(userId) || userId <= 0) return;
      if (!Number.isInteger(apiKeyId) || apiKeyId <= 0) return;

      const method = ((req.method || 'GET').toString().trim().toUpperCase() || 'GET').slice(0, 16);
      const endpoint = ((req.path || req.originalUrl || '/api/pro/v1') + '').split('?')[0].slice(0, 180);
      const statusCode = Number.parseInt(res.statusCode, 10) || 0;
      const errorType = classifyApiUsageErrorType(statusCode);
      const nowIso = new Date().toISOString();

      insertApiUsageLogRow({
        user_id: userId,
        api_key_id: apiKeyId,
        endpoint,
        method,
        status_code: statusCode,
        error_type: errorType,
        created_at: nowIso,
      });
    } catch {}
  });

  return next();
}

async function authenticateProApiKey(req, res, next) {
  const rawKey = getApiKeyFromRequest(req);
  if (!rawKey || !/^ovk_[A-Za-z0-9_-]{20,200}$/.test(rawKey)) {
    logSecurityEvent(req, 'api.key.auth', 'failure', { reason: 'missing_or_bad_format' });
    return res.status(401).json({ error: 'Invalid API key.' });
  }

  const keyHashV2 = hashApiKeyValueV2(rawKey);
  const keyHashLegacy = hashApiKeyValueLegacy(rawKey);
  try {
    const row = await dbGetAsync(
      'SELECT k.id AS key_id, k.user_id, k.key_hash, k.scopes, COALESCE(k.hash_version, 1) AS hash_version, u.plan_tier, u.plan_status, u.pro_expires_at, u.pro_paused_at ' +
      'FROM api_keys k JOIN users u ON u.id = k.user_id ' +
      'WHERE (k.key_hash = ? OR k.key_hash = ?) AND k.revoked_at IS NULL LIMIT 1',
      [keyHashV2, keyHashLegacy]
    );

    if (!row) {
      logSecurityEvent(req, 'api.key.auth', 'failure', { reason: 'not_found' });
      return res.status(401).json({ error: 'Invalid API key.' });
    }

    const effectivePlan = await getEffectivePlanForUser(row.user_id);
    if (!effectivePlan || !effectivePlan.is_active || effectivePlan.tier !== PLAN_TIERS.PRO) {
      logSecurityEvent(req, 'api.key.auth', 'blocked', { reason: 'plan_not_active', user_id: row.user_id, api_key_id: row.key_id });
      return res.status(403).json({ error: 'Pro plan required.' });
    }

    const now = new Date().toISOString();
    if (row.key_hash === keyHashLegacy && keyHashLegacy !== keyHashV2) {
      await dbRunAsync('UPDATE api_keys SET key_hash = ?, hash_version = 2 WHERE id = ? AND key_hash = ?', [keyHashV2, row.key_id, keyHashLegacy]).catch(() => {});
    }
    await dbRunAsync('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [now, row.key_id]).catch(() => {});
    req.apiAuth = {
      userId: row.user_id,
      apiKeyId: row.key_id,
      scopes: normalizeApiKeyScopes(row.scopes || '', DEFAULT_API_KEY_SCOPES),
      plan: effectivePlan,
    };
    logSecurityEvent(req, 'api.key.auth', 'success', { user_id: row.user_id, api_key_id: row.key_id });
    return next();
  } catch {
    return res.status(500).json({ error: 'Server error.' });
  }
}

app.get('/api/pro/overview', requireSignedIn, proReadLimiter, async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  try {
    const plan = await getEffectivePlanForUser(req.session.userId);
    const payload = await loadProOverviewPayload(req.session.userId, plan);
    return res.json(payload);
  } catch {
    return res.status(500).json({ error: 'Server error.' });
  }
});

app.post('/api/pro/api-keys/create', requireSignedIn, proKeyCreateLimiter, requireProAccess('api_keys.create'), async (req, res) => {
  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const name = ((req.body && req.body.name) || '').toString().trim().slice(0, 60) || 'Primary key';
  const requestedScopes = normalizeApiKeyScopes(req.body && req.body.scopes, DEFAULT_API_KEY_SCOPES);
  const scopesStorage = toApiKeyScopesStorage(requestedScopes, DEFAULT_API_KEY_SCOPES);

  try {
    const countRow = await dbGetAsync(
      'SELECT COUNT(*) AS cnt FROM api_keys WHERE user_id = ? AND revoked_at IS NULL',
      [req.session.userId]
    );
    const activeCount = Number(countRow && countRow.cnt ? countRow.cnt : 0);
    if (activeCount >= PRO_API_KEY_MAX_ACTIVE) {
      return res.status(409).json({
        error: pickLang(
          uiLang,
          `Aktiv API açar limiti dolub (${PRO_API_KEY_MAX_ACTIVE}).`,
          `Aktif API anahtarı limiti doldu (${PRO_API_KEY_MAX_ACTIVE}).`,
          `Active API key limit reached (${PRO_API_KEY_MAX_ACTIVE}).`
        ),
      });
    }

    const rawKey = buildApiKeyValue();
    const now = new Date().toISOString();
    await dbRunAsync(
      'INSERT INTO api_keys (user_id, name, scopes, key_hash, hash_version, key_prefix, last4, created_at) VALUES (?, ?, ?, ?, 2, ?, ?, ?)',
      [req.session.userId, name, scopesStorage, hashApiKeyValue(rawKey), getApiKeyPrefix(rawKey), getApiKeyLast4(rawKey), now]
    );
    logSecurityEvent(req, 'api.key.create', 'success', { user_id: req.session.userId, key_name: name });
    return res.json({
      message: pickLang(uiLang, 'API açarı yaradıldı.', 'API anahtarı oluşturuldu.', 'API key created.'),
      api_key: rawKey,
      scopes: requestedScopes,
    });
  } catch {
    logSecurityEvent(req, 'api.key.create', 'failure', { user_id: req.session.userId });
    return res.status(500).json({ error: pickLang(uiLang, 'API açarı yaradıla bilmədi.', 'API anahtarı oluşturulamadı.', 'API key could not be created.') });
  }
});

app.post('/api/pro/api-keys/revoke', requireSignedIn, proWriteLimiter, requireProAccess('api_keys.revoke'), async (req, res) => {
  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const keyId = Number.parseInt((req.body && req.body.key_id) || '', 10);
  if (!Number.isInteger(keyId) || keyId <= 0) {
    return res.status(400).json({ error: pickLang(uiLang, 'Yanlış açar ID.', 'Geçersiz anahtar ID.', 'Invalid key id.') });
  }

  try {
    const now = new Date().toISOString();
    const result = await dbRunAsync(
      'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
      [now, keyId, req.session.userId]
    );
    if (!result || !result.changes) {
      return res.status(404).json({ error: pickLang(uiLang, 'Açar tapılmadı.', 'Anahtar bulunamadı.', 'Key not found.') });
    }
    logSecurityEvent(req, 'api.key.revoke', 'success', { user_id: req.session.userId, api_key_id: keyId });
    return res.json({ message: pickLang(uiLang, 'API açarı ləğv edildi.', 'API anahtarı iptal edildi.', 'API key revoked.') });
  } catch {
    logSecurityEvent(req, 'api.key.revoke', 'failure', { user_id: req.session.userId, api_key_id: keyId });
    return res.status(500).json({ error: pickLang(uiLang, 'Açar ləğv edilə bilmədi.', 'Anahtar iptal edilemedi.', 'Key could not be revoked.') });
  }
});

app.post('/api/pro/api-keys/rotate', requireSignedIn, proWriteLimiter, requireProAccess('api_keys.rotate'), async (req, res) => {
  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const keyId = Number.parseInt((req.body && req.body.key_id) || '', 10);
  if (!Number.isInteger(keyId) || keyId <= 0) {
    return res.status(400).json({ error: pickLang(uiLang, 'Yanlış açar ID.', 'Geçersiz anahtar ID.', 'Invalid key id.') });
  }

  try {
    const row = await dbGetAsync(
      'SELECT id FROM api_keys WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
      [keyId, req.session.userId]
    );
    if (!row) {
      return res.status(404).json({ error: pickLang(uiLang, 'Açar tapılmadı.', 'Anahtar bulunamadı.', 'Key not found.') });
    }

    const rawKey = buildApiKeyValue();
    const now = new Date().toISOString();
    await dbRunAsync(
      'UPDATE api_keys SET key_hash = ?, hash_version = 2, key_prefix = ?, last4 = ?, last_used_at = NULL, created_at = ? WHERE id = ? AND user_id = ?',
      [hashApiKeyValue(rawKey), getApiKeyPrefix(rawKey), getApiKeyLast4(rawKey), now, keyId, req.session.userId]
    );
    logSecurityEvent(req, 'api.key.rotate', 'success', { user_id: req.session.userId, api_key_id: keyId });
    return res.json({
      message: pickLang(uiLang, 'API açarı yeniləndi.', 'API anahtarı yenilendi.', 'API key rotated.'),
      api_key: rawKey,
    });
  } catch {
    logSecurityEvent(req, 'api.key.rotate', 'failure', { user_id: req.session.userId, api_key_id: keyId });
    return res.status(500).json({ error: pickLang(uiLang, 'Açar yenilənmədi.', 'Anahtar yenilenemedi.', 'Key could not be rotated.') });
  }
});

app.post('/api/pro/api-keys/scopes', requireSignedIn, proWriteLimiter, requireProAccess('api_keys.scopes'), async (req, res) => {
  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const keyId = Number.parseInt((req.body && req.body.key_id) || '', 10);
  if (!Number.isInteger(keyId) || keyId <= 0) {
    return res.status(400).json({ error: pickLang(uiLang, 'Yanlış açar ID.', 'Geçersiz anahtar ID.', 'Invalid key id.') });
  }

  const scopes = normalizeApiKeyScopes(req.body && req.body.scopes, DEFAULT_API_KEY_SCOPES);
  const scopesStorage = toApiKeyScopesStorage(scopes, DEFAULT_API_KEY_SCOPES);

  try {
    const row = await dbGetAsync(
      'SELECT id FROM api_keys WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
      [keyId, req.session.userId]
    );
    if (!row) {
      return res.status(404).json({ error: pickLang(uiLang, 'Açar tapılmadı.', 'Anahtar bulunamadı.', 'Key not found.') });
    }

    await dbRunAsync(
      'UPDATE api_keys SET scopes = ? WHERE id = ? AND user_id = ?',
      [scopesStorage, keyId, req.session.userId]
    );
    logSecurityEvent(req, 'api.key.scopes.update', 'success', { user_id: req.session.userId, api_key_id: keyId });
    return res.json({
      message: pickLang(uiLang, 'API açarı icazələri yeniləndi.', 'API anahtarı izinleri güncellendi.', 'API key scopes updated.'),
      scopes,
    });
  } catch {
    logSecurityEvent(req, 'api.key.scopes.update', 'failure', { user_id: req.session.userId, api_key_id: keyId });
    return res.status(500).json({ error: pickLang(uiLang, 'İcazələr yenilənmədi.', 'İzinler güncellenemedi.', 'Scopes could not be updated.') });
  }
});

app.post('/api/pro/webhooks/create', requireSignedIn, proWriteLimiter, requireProAccess('webhooks.create'), async (req, res) => {
  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const events = normalizeWebhookEvents((req.body && req.body.events) || '');
  const messageLocale = normalizeWebhookMessageLocale(req.body && req.body.message_locale, 'auto');
  const messageTemplate = normalizeWebhookMessageTemplate(req.body && req.body.message_template);

  try {
    const validation = await validateOutboundWebhookUrl(req.body && req.body.url);
    if (!validation || !validation.ok) {
      const rawUrl = ((req.body && req.body.url) || '').toString().trim().toLowerCase();
      const isBlockedTarget = validation && (validation.reason === 'blocked_ip' || validation.reason === 'blocked_host');
      const isHttpOnlyUrl = validation && validation.reason === 'invalid_url' && rawUrl.startsWith('http://');
      const reason = isBlockedTarget
        ? pickLang(uiLang, 'Webhook URL daxili/rezerv şəbəkəyə yönəlir və bloklanıb.', 'Webhook URL dahili/rezerve ağa gidiyor ve engellendi.', 'Webhook URL targets an internal/reserved network and is blocked.')
        : (isHttpOnlyUrl
          ? pickLang(uiLang, 'Webhook URL yalnız HTTPS ola bilər.', 'Webhook URL yalnızca HTTPS olabilir.', 'Webhook URL must use HTTPS.')
          : pickLang(uiLang, 'Webhook URL yanlışdır.', 'Webhook URL geçersiz.', 'Webhook URL is invalid.'));
      return res.status(400).json({ error: reason });
    }
    const webhookUrl = validation.normalizedUrl;

    const countRow = await dbGetAsync(
      'SELECT COUNT(*) AS cnt FROM webhooks WHERE user_id = ?',
      [req.session.userId]
    );
    const totalHooks = Number(countRow && countRow.cnt ? countRow.cnt : 0);
    if (totalHooks >= PRO_WEBHOOK_MAX_ACTIVE) {
      return res.status(409).json({
        error: pickLang(
          uiLang,
          `Webhook limiti dolub (${PRO_WEBHOOK_MAX_ACTIVE}).`,
          `Webhook limiti doldu (${PRO_WEBHOOK_MAX_ACTIVE}).`,
          `Webhook limit reached (${PRO_WEBHOOK_MAX_ACTIVE}).`
        ),
      });
    }

    const now = new Date().toISOString();
    const rawSecret = `whsec_${crypto.randomBytes(32).toString('base64url')}`;
    const secretHash = hashWebhookSecretValueV2(`wh|${rawSecret}`);
    const signatureV2Key = buildWebhookSignatureV2Key(rawSecret);
    const inserted = await dbRunAsync(
      'INSERT INTO webhooks (user_id, url, secret_hash, secret_hash_version, signature_v2_key, signature_v2_enabled, events, message_locale, message_template, is_active, created_at, updated_at) VALUES (?, ?, ?, 2, ?, 1, ?, ?, ?, 1, ?, ?)',
      [req.session.userId, webhookUrl, secretHash, signatureV2Key, events.join(','), messageLocale, messageTemplate || null, now, now]
    );
    logSecurityEvent(req, 'webhook.create', 'success', { user_id: req.session.userId, webhook_id: inserted.lastID });
    return res.json({
      message: pickLang(uiLang, 'Webhook əlavə edildi.', 'Webhook eklendi.', 'Webhook created.'),
      webhook_secret: rawSecret,
    });
  } catch {
    logSecurityEvent(req, 'webhook.create', 'failure', { user_id: req.session.userId });
    return res.status(500).json({ error: pickLang(uiLang, 'Webhook yaradıla bilmədi.', 'Webhook oluşturulamadı.', 'Webhook could not be created.') });
  }
});

app.post('/api/pro/webhooks/update', requireSignedIn, proWriteLimiter, requireProAccess('webhooks.update'), async (req, res) => {
  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const webhookId = Number.parseInt((req.body && req.body.webhook_id) || '', 10);
  if (!Number.isInteger(webhookId) || webhookId <= 0) {
    return res.status(400).json({ error: pickLang(uiLang, 'Yanlış webhook ID.', 'Geçersiz webhook ID.', 'Invalid webhook id.') });
  }

  const events = normalizeWebhookEvents((req.body && req.body.events) || '');
  const bodyObj = req.body && typeof req.body === 'object' ? req.body : {};
  const hasUrl = Object.prototype.hasOwnProperty.call(bodyObj, 'url');
  const hasEvents = Object.prototype.hasOwnProperty.call(bodyObj, 'events');
  const hasIsActive = Object.prototype.hasOwnProperty.call(bodyObj, 'is_active');
  const hasMessageLocale = Object.prototype.hasOwnProperty.call(bodyObj, 'message_locale');
  const hasMessageTemplate = Object.prototype.hasOwnProperty.call(bodyObj, 'message_template');

  try {
    const row = await dbGetAsync(
      'SELECT id, url, events, message_locale, message_template, is_active FROM webhooks WHERE id = ? AND user_id = ?',
      [webhookId, req.session.userId]
    );
    if (!row) {
      return res.status(404).json({ error: pickLang(uiLang, 'Webhook tapılmadı.', 'Webhook bulunamadı.', 'Webhook not found.') });
    }

    const nextMessageLocale = hasMessageLocale
      ? normalizeWebhookMessageLocale(bodyObj.message_locale, normalizeWebhookMessageLocale(row.message_locale, 'auto'))
      : normalizeWebhookMessageLocale(row.message_locale, 'auto');
    const nextMessageTemplate = hasMessageTemplate
      ? normalizeWebhookMessageTemplate(bodyObj.message_template)
      : (row.message_template || '');
    const nextEvents = hasEvents ? events.join(',') : (row.events || 'link.created');
    const nextIsActive = hasIsActive
      ? (parseBooleanInput(bodyObj.is_active, row.is_active == 1) ? 1 : 0)
      : (row.is_active == 1 ? 1 : 0);
    let nextUrl = row.url || '';
    if (hasUrl) {
      const validation = await validateOutboundWebhookUrl(bodyObj.url);
      if (!validation || !validation.ok) {
        const rawUrl = (bodyObj.url || '').toString().trim().toLowerCase();
        const isBlockedTarget = validation && (validation.reason === 'blocked_ip' || validation.reason === 'blocked_host');
        const isHttpOnlyUrl = validation && validation.reason === 'invalid_url' && rawUrl.startsWith('http://');
        const reason = isBlockedTarget
          ? pickLang(uiLang, 'Webhook URL daxili/rezerv şəbəkəyə yönəlir və bloklanıb.', 'Webhook URL dahili/rezerve ağa gidiyor ve engellendi.', 'Webhook URL targets an internal/reserved network and is blocked.')
          : (isHttpOnlyUrl
            ? pickLang(uiLang, 'Webhook URL yalnız HTTPS ola bilər.', 'Webhook URL yalnızca HTTPS olabilir.', 'Webhook URL must use HTTPS.')
            : pickLang(uiLang, 'Webhook URL yanlışdır.', 'Webhook URL geçersiz.', 'Webhook URL is invalid.'));
        return res.status(400).json({ error: reason });
      }
      nextUrl = validation.normalizedUrl;
    }

    await dbRunAsync(
      'UPDATE webhooks SET url = ?, events = ?, message_locale = ?, message_template = ?, is_active = ?, updated_at = ? WHERE id = ? AND user_id = ?',
      [nextUrl, nextEvents, nextMessageLocale, nextMessageTemplate || null, nextIsActive, new Date().toISOString(), webhookId, req.session.userId]
    );
    logSecurityEvent(req, 'webhook.update', 'success', { user_id: req.session.userId, webhook_id: webhookId });
    return res.json({ message: pickLang(uiLang, 'Webhook yeniləndi.', 'Webhook güncellendi.', 'Webhook updated.') });
  } catch {
    logSecurityEvent(req, 'webhook.update', 'failure', { user_id: req.session.userId, webhook_id: webhookId });
    return res.status(500).json({ error: pickLang(uiLang, 'Webhook yenilənmədi.', 'Webhook güncellenemedi.', 'Webhook could not be updated.') });
  }
});

app.post('/api/pro/webhooks/rotate-secret', requireSignedIn, proWriteLimiter, requireProAccess('webhooks.rotate_secret'), async (req, res) => {
  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const webhookId = Number.parseInt((req.body && req.body.webhook_id) || '', 10);
  if (!Number.isInteger(webhookId) || webhookId <= 0) {
    return res.status(400).json({ error: pickLang(uiLang, 'Yanlış webhook ID.', 'Geçersiz webhook ID.', 'Invalid webhook id.') });
  }

  try {
    const hook = await dbGetAsync(
      'SELECT id FROM webhooks WHERE id = ? AND user_id = ?',
      [webhookId, req.session.userId]
    );
    if (!hook) {
      return res.status(404).json({ error: pickLang(uiLang, 'Webhook tapılmadı.', 'Webhook bulunamadı.', 'Webhook not found.') });
    }

    const now = new Date().toISOString();
    const rawSecret = `whsec_${crypto.randomBytes(32).toString('base64url')}`;
    const secretHash = hashWebhookSecretValueV2(`wh|${rawSecret}`);
    const signatureV2Key = buildWebhookSignatureV2Key(rawSecret);

    await dbRunAsync(
      'UPDATE webhooks SET secret_hash = ?, secret_hash_version = 2, signature_v2_key = ?, signature_v2_enabled = 1, updated_at = ? WHERE id = ? AND user_id = ?',
      [secretHash, signatureV2Key, now, webhookId, req.session.userId]
    );

    logSecurityEvent(req, 'webhook.secret.rotate', 'success', { user_id: req.session.userId, webhook_id: webhookId });
    return res.json({
      message: pickLang(uiLang, 'Webhook secret yeniləndi.', 'Webhook secret yenilendi.', 'Webhook secret rotated.'),
      webhook_secret: rawSecret,
    });
  } catch {
    logSecurityEvent(req, 'webhook.secret.rotate', 'failure', { user_id: req.session.userId, webhook_id: webhookId });
    return res.status(500).json({ error: pickLang(uiLang, 'Webhook secret yenilənmədi.', 'Webhook secret yenilenemedi.', 'Webhook secret could not be rotated.') });
  }
});

app.post('/api/pro/webhooks/delete', requireSignedIn, proWriteLimiter, requireProAccess('webhooks.delete'), async (req, res) => {
  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const webhookId = Number.parseInt((req.body && req.body.webhook_id) || '', 10);
  if (!Number.isInteger(webhookId) || webhookId <= 0) {
    return res.status(400).json({ error: pickLang(uiLang, 'Yanlış webhook ID.', 'Geçersiz webhook ID.', 'Invalid webhook id.') });
  }

  try {
    const result = await dbRunAsync('DELETE FROM webhooks WHERE id = ? AND user_id = ?', [webhookId, req.session.userId]);
    if (!result || !result.changes) {
      return res.status(404).json({ error: pickLang(uiLang, 'Webhook tapılmadı.', 'Webhook bulunamadı.', 'Webhook not found.') });
    }
    await dbRunAsync('UPDATE webhook_deliveries SET status = ?, updated_at = ? WHERE webhook_id = ? AND status IN (?, ?)', ['cancelled', new Date().toISOString(), webhookId, 'queued', 'retry_scheduled']).catch(() => {});
    logSecurityEvent(req, 'webhook.delete', 'success', { user_id: req.session.userId, webhook_id: webhookId });
    return res.json({ message: pickLang(uiLang, 'Webhook silindi.', 'Webhook silindi.', 'Webhook deleted.') });
  } catch {
    logSecurityEvent(req, 'webhook.delete', 'failure', { user_id: req.session.userId, webhook_id: webhookId });
    return res.status(500).json({ error: pickLang(uiLang, 'Webhook silinmədi.', 'Webhook silinemedi.', 'Webhook could not be deleted.') });
  }
});

app.post('/api/pro/webhooks/test', requireSignedIn, proWriteLimiter, requireProAccess('webhooks.test'), async (req, res) => {
  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const webhookId = Number.parseInt((req.body && req.body.webhook_id) || '', 10);
  if (!Number.isInteger(webhookId) || webhookId <= 0) {
    return res.status(400).json({ error: pickLang(uiLang, 'Yanlış webhook ID.', 'Geçersiz webhook ID.', 'Invalid webhook id.') });
  }

  try {
    const hook = await dbGetAsync(
      'SELECT id, user_id, events, is_active FROM webhooks WHERE id = ? AND user_id = ?',
      [webhookId, req.session.userId]
    );
    if (!hook) {
      return res.status(404).json({ error: pickLang(uiLang, 'Webhook tapılmadı.', 'Webhook bulunamadı.', 'Webhook not found.') });
    }
    if (hook.is_active != 1) {
      return res.status(400).json({ error: pickLang(uiLang, 'Webhook passivdir.', 'Webhook pasif.', 'Webhook is inactive.') });
    }
    if (!webhookHasEvent(hook, 'webhook.test')) {
      return res.status(400).json({
        error: pickLang(
          uiLang,
          "Bu webhook üçün 'webhook.test' eventi aktiv deyil.",
          "Bu webhook için 'webhook.test' etkinliği aktif değil.",
          "This webhook does not have 'webhook.test' enabled."
        ),
      });
    }

    const now = new Date().toISOString();
    const payloadJson = safeJsonStringify({
      source: 'manual_test',
      by_user_id: req.session.userId,
      generated_at: now,
    });

    const inserted = await dbRunAsync(
      'INSERT INTO webhook_deliveries (webhook_id, user_id, event_type, payload_json, attempt, status, created_at, updated_at, next_retry_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)',
      [webhookId, req.session.userId, 'webhook.test', payloadJson, 'queued', now, now, now]
    );
    scheduleWebhookProcessing(inserted.lastID, 0);
    logSecurityEvent(req, 'webhook.test', 'success', { user_id: req.session.userId, webhook_id: webhookId });
    return res.json({ message: pickLang(uiLang, 'Test göndərildi.', 'Test gönderildi.', 'Test delivery queued.') });
  } catch {
    logSecurityEvent(req, 'webhook.test', 'failure', { user_id: req.session.userId, webhook_id: webhookId });
    return res.status(500).json({ error: pickLang(uiLang, 'Test göndərilə bilmədi.', 'Test gönderilemedi.', 'Test could not be queued.') });
  }
});

app.post('/api/pro/webhooks/replay', requireSignedIn, proWriteLimiter, requireProAccess('webhooks.replay'), async (req, res) => {
  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const deliveryId = Number.parseInt((req.body && req.body.delivery_id) || '', 10);
  if (!Number.isInteger(deliveryId) || deliveryId <= 0) {
    return res.status(400).json({ error: pickLang(uiLang, 'Yanlış çatdırılma ID.', 'Geçersiz teslimat ID.', 'Invalid delivery id.') });
  }

  try {
    const delivery = await dbGetAsync(
      'SELECT id, webhook_id, user_id, status FROM webhook_deliveries WHERE id = ? AND user_id = ? LIMIT 1',
      [deliveryId, req.session.userId]
    );
    if (!delivery) {
      return res.status(404).json({ error: pickLang(uiLang, 'Çatdırılma tapılmadı.', 'Teslimat bulunamadı.', 'Delivery not found.') });
    }

    const hook = await dbGetAsync(
      'SELECT id, is_active FROM webhooks WHERE id = ? AND user_id = ? LIMIT 1',
      [delivery.webhook_id, req.session.userId]
    );
    if (!hook) {
      return res.status(404).json({ error: pickLang(uiLang, 'Webhook tapılmadı.', 'Webhook bulunamadı.', 'Webhook not found.') });
    }
    if (hook.is_active != 1) {
      return res.status(400).json({ error: pickLang(uiLang, 'Webhook passivdir.', 'Webhook pasif.', 'Webhook is inactive.') });
    }

    const now = new Date().toISOString();
    await dbRunAsync(
      'UPDATE webhook_deliveries SET attempt = 0, status = ?, http_status = NULL, response_excerpt = NULL, next_retry_at = ?, last_attempt_at = NULL, updated_at = ? WHERE id = ? AND user_id = ?',
      ['queued', now, now, deliveryId, req.session.userId]
    );
    scheduleWebhookProcessing(deliveryId, 0);
    logSecurityEvent(req, 'webhook.delivery.replay', 'success', { user_id: req.session.userId, webhook_id: delivery.webhook_id, delivery_id: deliveryId });
    return res.json({ message: pickLang(uiLang, 'Çatdırılma yenidən növbəyə alındı.', 'Teslimat yeniden kuyruğa alındı.', 'Delivery replay queued.') });
  } catch {
    logSecurityEvent(req, 'webhook.delivery.replay', 'failure', { user_id: req.session.userId, delivery_id: deliveryId });
    return res.status(500).json({ error: pickLang(uiLang, 'Çatdırılma təkrar oluna bilmədi.', 'Teslimat tekrar başlatılamadı.', 'Delivery replay failed.') });
  }
});

app.get('/api/pro/v1/account', authenticateProApiKey, trackProApiUsage, proReadLimiter, requireApiScope(API_KEY_SCOPES.ACCOUNT_READ), async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  try {
    const overview = await loadProOverviewPayload(req.apiAuth.userId, req.apiAuth.plan);
    return res.json({
      account: {
        user_id: req.apiAuth.userId,
        plan: req.apiAuth.plan,
        features: req.apiAuth.plan.features,
        api_key_scopes: normalizeApiKeyScopes(req.apiAuth.scopes || '', DEFAULT_API_KEY_SCOPES),
      },
      limits: overview.limits,
    });
  } catch {
    return res.status(500).json({ error: 'Server error.' });
  }
});

app.all('/api/pro/v1/account', (req, res, next) => {
  if (req.method === 'GET') return next();
  res.set('Allow', 'GET');
  return res.status(405).json({ error: 'Method not allowed. Use GET /api/pro/v1/account.' });
});

app.post('/api/pro/v1/shorten', authenticateProApiKey, trackProApiUsage, proWriteLimiter, requireApiScope(API_KEY_SCOPES.SHORTEN_WRITE), async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const originalInput = pickFirstInputValue(
    body.original_url,
    body.originalUrl,
    body.original,
    body.url,
    body.target_url,
    body.targetUrl,
    body.link
  );
  const customAliasInput = pickFirstInputValue(
    body.custom_alias,
    body.customAlias,
    body.customLink,
    body.alias,
    body.short
  );
  const rawCustomDomainInput = pickFirstInputValue(
    body.custom_domain,
    body.customDomain,
    body.domain,
    body.domain_host,
    body.domainHost
  );
  const requestedDomain = normalizeCustomDomainInput(rawCustomDomainInput);
  const expiresAtInput = pickFirstInputValue(
    body.expires_at,
    body.expiresAt,
    body.expiry_at,
    body.expiryAt
  );
  const maxClicksInput = body.max_clicks ?? body.maxClicks;
  const rawIdempotencyKey = (req.get('idempotency-key') || '').toString();
  const idempotencyKey = normalizeIdempotencyKey(rawIdempotencyKey);
  const hasIdempotencyKey = rawIdempotencyKey.trim().length > 0;
  const ownerId = req.apiAuth && req.apiAuth.userId ? req.apiAuth.userId : 0;

  if (hasIdempotencyKey && !idempotencyKey) {
    return res.status(400).json({ error: 'Invalid Idempotency-Key header.' });
  }

  const originalAbs = ensureAbsoluteUrl(originalInput);
  if (!originalAbs) {
    return res.status(400).json({ error: 'Invalid original_url.' });
  }

  if (!Number.isInteger(ownerId) || ownerId <= 0) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  if (rawCustomDomainInput && !requestedDomain) {
    return res.status(400).json({ error: 'Invalid custom_domain.' });
  }

  let destinationHostname = '';
  try {
    destinationHostname = normalizeHostName(new URL(originalAbs).hostname || '');
  } catch {
    destinationHostname = '';
  }

  let idempotencyState = null;
  try {
    const userRow = await dbGetAsync(
      'SELECT id, banned, ban_until, ban_reason FROM users WHERE id = ? LIMIT 1',
      [ownerId]
    );
    if (!userRow) return res.status(401).json({ error: 'Unauthorized.' });

    if (userRow.banned == 1 && userRow.ban_until) {
      const untilMs = Date.parse(userRow.ban_until);
      if (!Number.isNaN(untilMs) && untilMs <= Date.now()) {
        await dbRunAsync(
          'UPDATE users SET banned = 0, ban_until = NULL, ban_reason = NULL, ban_set_at = NULL, ban_set_by_admin_id = NULL WHERE id = ?',
          [ownerId]
        ).catch(() => {});
        userRow.banned = 0;
        userRow.ban_until = null;
      }
    }

    const banActive = (userRow.banned == 1) && (!userRow.ban_until || (Date.parse(userRow.ban_until) > Date.now()));
    if (banActive) {
      return res.status(403).json({ error: 'Account is temporarily restricted.' });
    }

    if (destinationHostname) {
      const blocked = await dbGetAsync(
        "SELECT domain FROM blocked_domains WHERE ? = domain OR ? LIKE '%.' || domain LIMIT 1",
        [destinationHostname, destinationHostname]
      );
      if (blocked && blocked.domain) {
        return res.status(403).json({ error: 'Destination domain is blocked.' });
      }
    }

    let selectedDomainHost = '';
    if (requestedDomain) {
      const domainRow = await dbGetAsync(
        'SELECT id, domain, status FROM custom_domains WHERE user_id = ? AND domain = ? LIMIT 1',
        [ownerId, requestedDomain]
      );
      if (!domainRow) {
        return res.status(400).json({ error: 'Custom domain is not linked to your account.' });
      }
      if ((domainRow.status || '').toString() !== 'active') {
        return res.status(400).json({ error: 'Custom domain is not active.' });
      }
      selectedDomainHost = normalizeHostName(domainRow.domain);
    }

    let short = '';
    if (customAliasInput) {
      if (!SHORT_CODE_RE.test(customAliasInput)) {
        return res.status(400).json({ error: 'Invalid custom_alias format.' });
      }
      if (isReservedShortAlias(customAliasInput)) {
        return res.status(400).json({ error: 'custom_alias is reserved.' });
      }
      short = customAliasInput;
      const exists = await dbGetAsync('SELECT id FROM urls WHERE short = ? LIMIT 1', [short]);
      if (exists && exists.id) {
        return res.status(409).json({ error: 'custom_alias is already in use.' });
      }
    } else {
      short = generateSafeShortCode();
    }

    const expiresValidation = normalizeFutureExpiryInput(expiresAtInput);
    if (expiresValidation.error === 'invalid') {
      return res.status(400).json({ error: 'Invalid expires_at.' });
    }
    if (expiresValidation.error === 'past') {
      return res.status(400).json({ error: 'expires_at must be in the future.' });
    }
    const expiresAtValue = expiresValidation.value;

    let maxClicksValue = null;
    if (maxClicksInput !== undefined && maxClicksInput !== null && `${maxClicksInput}`.trim() !== '') {
      const parsedMax = Number.parseInt(`${maxClicksInput}`, 10);
      if (!Number.isInteger(parsedMax) || parsedMax < 1) {
        return res.status(400).json({ error: 'max_clicks must be an integer >= 1.' });
      }
      maxClicksValue = parsedMax;
    }

    const createdAt = new Date().toISOString();
    const shortUrl = buildShortUrl(req, short, selectedDomainHost);
    const requestHash = buildShortenIdempotencyRequestHash({
      owner_id: ownerId,
      original_url: originalAbs,
      custom_alias: customAliasInput || '',
      custom_domain: requestedDomain || '',
      expires_at: expiresAtValue || '',
      max_clicks: maxClicksValue == null ? null : maxClicksValue,
    });
    idempotencyState = await reserveApiIdempotencyRecord({
      userId: ownerId,
      apiKeyId: req.apiAuth && req.apiAuth.apiKeyId,
      endpoint: 'pro.v1.shorten',
      rawIdempotencyKey: idempotencyKey,
      requestHash,
    });
    if (idempotencyState && idempotencyState.replayed) {
      res.setHeader('Idempotency-Replayed', 'true');
      return res.status(idempotencyState.statusCode || 200).json(idempotencyState.payload || {});
    }
    if (idempotencyState && idempotencyState.conflict) {
      return res.status(idempotencyState.statusCode || 409).json({ error: idempotencyState.error || 'Idempotency conflict.' });
    }

    const inserted = await dbRunAsync(
      'INSERT INTO urls (original, short, created_at, user_id, link_password, expires_at, max_clicks, domain_host) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [originalAbs, short, createdAt, ownerId, '', expiresAtValue, maxClicksValue, selectedDomainHost || null]
    ).catch((insertErr) => {
      const msg = (insertErr && insertErr.message ? insertErr.message : '').toLowerCase();
      if (msg.includes('unique') && msg.includes('urls.short')) return null;
      throw insertErr;
    });

    if (!inserted) {
      if (idempotencyState && idempotencyState.recordId) {
        await releaseApiIdempotencyRecord(idempotencyState.recordId);
      }
      return res.status(409).json({ error: 'Generated short code collided. Please retry.' });
    }

    void enqueueWebhookEventForUser(ownerId, 'link.created', {
      short,
      short_url: shortUrl,
      original_url: originalAbs,
      domain: selectedDomainHost || null,
      created_at: createdAt,
    });

    const responsePayload = {
      id: inserted.lastID || null,
      short,
      short_url: shortUrl,
      original_url: originalAbs,
      domain: selectedDomainHost || null,
      expires_at: expiresAtValue,
      max_clicks: maxClicksValue,
      created_at: createdAt,
    };
    if (idempotencyState && idempotencyState.recordId) {
      await finalizeApiIdempotencyRecord(idempotencyState.recordId, 201, responsePayload);
    }
    return res.status(201).json(responsePayload);
  } catch (err) {
    if (idempotencyState && idempotencyState.recordId) {
      await releaseApiIdempotencyRecord(idempotencyState.recordId);
    }
    const message = (err && err.message ? err.message : '').toLowerCase();
    if (message.includes('api_idempotency_keys')) {
      return res.status(409).json({ error: 'Idempotency processing conflict. Please retry.' });
    }
    return res.status(500).json({ error: 'Server error.' });
  }
});

app.all('/api/pro/v1/shorten', (req, res, next) => {
  if (req.method === 'POST') return next();
  res.set('Allow', 'POST');
  return res.status(405).json({ error: 'Method not allowed. Use POST /api/pro/v1/shorten.' });
});

app.get('/api/user/sessions', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ sessions: [] });
  }

  upsertUserSessionRecord(req, req.session.userId, { loginMethod: 'session_restore', sendAlert: false }, () => {
    const currentToken = normalizeSessionToken(req.session.userSessionToken);
    db.all(
      `SELECT id, session_token, device_label, browser, os, country, created_at, last_seen_at, last_login_at, last_login_method
       FROM user_sessions
       WHERE user_id = ? AND is_revoked = 0
       ORDER BY last_seen_at DESC
       LIMIT 20`,
      [req.session.userId],
      (err, rows) => {
        if (err) {
          console.error('user sessions load failed:', err.message || err);
          return res.json({ sessions: [] });
        }
        const sessions = (rows || []).map((row) => ({
          id: row.id,
          device_label: row.device_label || 'Unknown device',
          browser: row.browser || 'Unknown',
          os: row.os || 'Unknown',
          country: row.country || 'Unknown',
          created_at: row.created_at || null,
          last_seen_at: row.last_seen_at || null,
          last_login_at: row.last_login_at || null,
          last_login_method: row.last_login_method || 'password',
          is_current: !!currentToken && row.session_token === currentToken,
        }));
        return res.json({ sessions });
      }
    );
  });
});

app.post('/api/user/sessions/revoke', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const sessionId = Number.parseInt((req.body && req.body.session_id) || '', 10);
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    return res.status(400).json({ error: pickLang(uiLang, 'Yanlış sessiya ID.', 'Geçersiz oturum ID.', 'Invalid session id.') });
  }

  const currentToken = normalizeSessionToken(req.session.userSessionToken);

  db.get(
    'SELECT id, session_token FROM user_sessions WHERE id = ? AND user_id = ? AND is_revoked = 0',
    [sessionId, req.session.userId],
    (err, row) => {
      if (err || !row) {
        return res.status(404).json({ error: pickLang(uiLang, 'Sessiya tapılmadı.', 'Oturum bulunamadı.', 'Session not found.') });
      }

      const nowIso = new Date().toISOString();
      db.run(
        'UPDATE user_sessions SET is_revoked = 1, revoked_at = ? WHERE id = ? AND user_id = ?',
        [nowIso, sessionId, req.session.userId],
        function (updateErr) {
          if (updateErr) {
            return res.status(500).json({ error: pickLang(uiLang, 'Sessiya bağlana bilmədi.', 'Oturum kapatılamadı.', 'Session could not be revoked.') });
          }

          if (currentToken && row.session_token === currentToken) {
            try {
              req.session.destroy(() => {});
            } catch {}
            return res.json({ revoked: this.changes || 0, logged_out: true });
          }

          return res.json({ revoked: this.changes || 0, logged_out: false });
        }
      );
    }
  );
});

app.post('/api/user/sessions/revoke-others', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const currentToken = normalizeSessionToken(req.session.userSessionToken);
  const nowIso = new Date().toISOString();

  db.run(
    'UPDATE user_sessions SET is_revoked = 1, revoked_at = ? WHERE user_id = ? AND is_revoked = 0 AND session_token <> ?',
    [nowIso, req.session.userId, currentToken || ''],
    function (err) {
      if (err) {
        return res.status(500).json({ error: 'Server error.' });
      }
      return res.json({ revoked: this.changes || 0 });
    }
  );
});

const handleListDomains = (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  db.all(
    'SELECT id, domain, status, verification_token, created_at, verified_at, last_checked_at, routing_ok FROM custom_domains WHERE user_id = ? ORDER BY datetime(created_at) DESC',
    [req.session.userId],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: 'Could not load domains.' });
      }

      return res.json({
        domains: (rows || []).map((row) => buildCustomDomainPayload(row)),
        target_host: getCustomDomainTargetHost(),
      });
    }
  );
};

app.get('/api/domains', handleListDomains);
// Legacy compatibility path expected by older clients and external backend checks.
app.get('/api/custom-domains', handleListDomains);

app.post('/api/domains/add', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const domain = normalizeCustomDomainInput(req.body && req.body.domain);
  if (!domain) {
    return res.status(400).json({ error: pickLang(uiLang, 'Düzgün domen daxil edin.', 'Geçerli bir alan adı girin.', 'Please enter a valid domain.') });
  }

  if (isInternalHost(domain)) {
    return res.status(400).json({ error: pickLang(uiLang, 'Bu domen sistem tərəfindən istifadə olunur.', 'Bu alan adı sistem tarafından kullanılıyor.', 'This domain is reserved by the system.') });
  }

  db.get('SELECT * FROM custom_domains WHERE domain = ?', [domain], (err, existing) => {
    if (err) {
      return res.status(500).json({ error: pickLang(uiLang, 'Domen əlavə edilə bilmədi.', 'Alan adı eklenemedi.', 'Could not add domain.') });
    }

    if (existing && existing.user_id !== req.session.userId) {
      return res.status(409).json({ error: pickLang(uiLang, 'Bu domen artıq başqa hesabda istifadə olunur.', 'Bu alan adı başka bir hesapta kullanılıyor.', 'This domain is already used by another account.') });
    }

    if (existing && existing.user_id === req.session.userId) {
      return res.json({
        message: pickLang(uiLang, 'Domen artıq mövcuddur.', 'Alan adı zaten mevcut.', 'Domain already exists.'),
        domain: buildCustomDomainPayload(existing),
      });
    }

    const token = crypto.randomBytes(20).toString('hex');
    const now = new Date().toISOString();
    db.run(
      'INSERT INTO custom_domains (user_id, domain, status, verification_token, created_at, routing_ok) VALUES (?, ?, ?, ?, ?, 0)',
      [req.session.userId, domain, 'pending_verification', token, now],
      function (insertErr) {
        if (insertErr) {
          return res.status(500).json({ error: pickLang(uiLang, 'Domen əlavə edilə bilmədi.', 'Alan adı eklenemedi.', 'Could not add domain.') });
        }

        db.get(
          'SELECT id, domain, status, verification_token, created_at, verified_at, last_checked_at, routing_ok FROM custom_domains WHERE id = ?',
          [this.lastID],
          (fetchErr, row) => {
            if (fetchErr || !row) {
              return res.status(500).json({ error: pickLang(uiLang, 'Domen əlavə edildi, amma oxuna bilmədi.', 'Alan adı eklendi ancak okunamadı.', 'Domain added but could not be loaded.') });
            }

            return res.json({
              message: pickLang(uiLang, 'Domen əlavə edildi. İndi DNS doğrulamasını edin.', 'Alan adı eklendi. Şimdi DNS doğrulamasını yapın.', 'Domain added. Complete DNS verification now.'),
              domain: buildCustomDomainPayload(row),
            });
          }
        );
      }
    );
  });
});

app.post('/api/domains/verify', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const domainId = Number.parseInt((req.body && req.body.domain_id) || '', 10);
  if (!Number.isInteger(domainId) || domainId <= 0) {
    return res.status(400).json({ error: pickLang(uiLang, 'Yanlış domen ID.', 'Geçersiz alan adı ID.', 'Invalid domain ID.') });
  }

  db.get(
    'SELECT id, user_id, domain, status, verification_token, created_at, verified_at, last_checked_at, routing_ok FROM custom_domains WHERE id = ? AND user_id = ?',
    [domainId, req.session.userId],
    (err, row) => {
      if (err || !row) {
        return res.status(404).json({ error: pickLang(uiLang, 'Domen tapılmadı.', 'Alan adı bulunamadı.', 'Domain not found.') });
      }

      (async () => {
        try {
          const result = await verifyCustomDomainDns(row.domain, row.verification_token);
          const now = new Date().toISOString();
          const status = !result.ownershipVerified
            ? 'pending_verification'
            : (result.routingReady ? 'active' : 'pending_routing');
          const verifiedAt = result.ownershipVerified ? (row.verified_at || now) : null;
          const routingOk = result.routingReady ? 1 : 0;

          db.run(
            'UPDATE custom_domains SET status = ?, verified_at = ?, last_checked_at = ?, routing_ok = ? WHERE id = ? AND user_id = ?',
            [status, verifiedAt, now, routingOk, domainId, req.session.userId],
            (updateErr) => {
              if (updateErr) {
                return res.status(500).json({ error: pickLang(uiLang, 'Doğrulama məlumatı yadda saxlanmadı.', 'Doğrulama sonucu kaydedilemedi.', 'Verification result could not be saved.') });
              }

              refreshCustomDomainCache();

              db.get(
                'SELECT id, domain, status, verification_token, created_at, verified_at, last_checked_at, routing_ok FROM custom_domains WHERE id = ?',
                [domainId],
                (fetchErr, updatedRow) => {
                  if (fetchErr || !updatedRow) {
                    return res.status(500).json({ error: pickLang(uiLang, 'Doğrulama tamamlandı, amma nəticə oxuna bilmədi.', 'Doğrulama tamamlandı ancak sonuç okunamadı.', 'Verification completed but result could not be loaded.') });
                  }

                  let message = '';
                  if (!result.ownershipVerified) {
                    message = pickLang(uiLang, 'TXT qeydi tapılmadı. Doğrulama tokenini DNS-ə əlavə edin.', 'TXT kaydı bulunamadı. Doğrulama tokenini DNS’e ekleyin.', 'TXT record not found. Add the verification token to DNS.');
                  } else if (!result.routingReady) {
                    message = pickLang(uiLang, 'Mülkiyyət doğrulandı, amma domen hələ yönləndirməyə hazır deyil. CNAME və ya A/AAAA qeydlərini yoxlayın.', 'Sahiplik doğrulandı ancak alan adı henüz yönlendirmeye hazır değil. CNAME veya A/AAAA kayıtlarını kontrol edin.', 'Ownership verified but routing is not ready yet. Check your CNAME or A/AAAA records.');
                  } else {
                    message = pickLang(uiLang, 'Domen aktiv edildi. Artıq qısa linklərdə istifadə edə bilərsiniz.', 'Alan adı aktif edildi. Artık kısa linklerde kullanabilirsiniz.', 'Domain is active and ready to use for short links.');
                  }

                  return res.json({
                    message,
                    domain: buildCustomDomainPayload(updatedRow),
                    dns: {
                      txt_host: result.txtHost,
                      txt_values: result.txtValues,
                      cname_values: result.cnameValues,
                      expected_cname: result.expectedTarget,
                      domain_ips: result.domainAddresses,
                      expected_target_ips: result.expectedTargetAddresses,
                    }
                  });
                }
              );
            }
          );
        } catch {
          return res.status(500).json({ error: pickLang(uiLang, 'DNS yoxlanışı zamanı xəta baş verdi.', 'DNS kontrolü sırasında hata oluştu.', 'DNS verification failed.') });
        }
      })();
    }
  );
});

app.post('/api/domains/delete', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const domainId = Number.parseInt((req.body && req.body.domain_id) || '', 10);
  if (!Number.isInteger(domainId) || domainId <= 0) {
    return res.status(400).json({ error: pickLang(uiLang, 'Yanlış domen ID.', 'Geçersiz alan adı ID.', 'Invalid domain ID.') });
  }

  db.get('SELECT domain FROM custom_domains WHERE id = ? AND user_id = ?', [domainId, req.session.userId], (err, row) => {
    if (err || !row) {
      return res.status(404).json({ error: pickLang(uiLang, 'Domen tapılmadı.', 'Alan adı bulunamadı.', 'Domain not found.') });
    }

    const domainHost = normalizeHostName(row.domain);
    db.run('UPDATE urls SET domain_host = NULL WHERE user_id = ? AND domain_host = ?', [req.session.userId, domainHost], function (updateErr) {
      if (updateErr) {
        return res.status(500).json({ error: pickLang(uiLang, 'Domen silinmədi.', 'Alan adı silinemedi.', 'Domain could not be deleted.') });
      }

      const detachedCount = this.changes || 0;
      db.run('DELETE FROM custom_domains WHERE id = ? AND user_id = ?', [domainId, req.session.userId], (deleteErr) => {
        if (deleteErr) {
          return res.status(500).json({ error: pickLang(uiLang, 'Domen silinmədi.', 'Alan adı silinemedi.', 'Domain could not be deleted.') });
        }

        refreshCustomDomainCache();
        return res.json({
          message: pickLang(uiLang, 'Domen silindi.', 'Alan adı silindi.', 'Domain deleted.'),
          detached_links: detachedCount,
        });
      });
    });
  });
});

// Kullanıcı ayarları (POST /api/user/settings)
app.post('/api/user/settings', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Giriş gerekli.' });
  }

  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const theme = (req.body && req.body.theme === 'dark') ? 'dark' : 'light';
  const toFlag = (v) => v === true || v === 'true' || v === '1' || v === 1 || v === 'on';
  const notifyReport = toFlag(req.body && req.body.notify_report) ? 1 : 0;
  const notifyLimit = toFlag(req.body && req.body.notify_limit) ? 1 : 0;
  const notifyDisabled = toFlag(req.body && req.body.notify_disabled) ? 1 : 0;

  db.run(
    'UPDATE users SET ui_lang = ?, ui_theme = ?, notify_report = ?, notify_limit = ?, notify_disabled = ? WHERE id = ?',
    [uiLang, theme, notifyReport, notifyLimit, notifyDisabled, req.session.userId],
    function (err) {
      if (err) return res.status(500).json({ error: pickLang(uiLang, 'Ayarlar yadda saxlanıla bilmədi.', 'Ayarlar kaydedilemedi.', 'Settings could not be saved.') });
      return res.json({ message: pickLang(uiLang, 'Ayarlar yadda saxlanıldı.', 'Ayarlar kaydedildi.', 'Settings saved.') });
    }
  );
});

// Şifre değiştirme (POST /api/user/password)
app.post('/api/user/password',
  authLimiter,
  (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Giriş gerekli.' });
  }

  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const currentPassword = (req.body && req.body.current_password) ? req.body.current_password.toString() : '';
  const newPassword = (req.body && req.body.new_password) ? req.body.new_password.toString() : '';
  const confirmPassword = (req.body && req.body.new_password_confirm) ? req.body.new_password_confirm.toString() : '';

  if (!newPassword || !confirmPassword) {
    return res.status(400).json({ error: pickLang(uiLang, 'Zəhmət olmasa bütün sahələri doldurun.', 'Lütfen tüm alanları doldurun.', 'Please fill in all fields.') });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ error: pickLang(uiLang, 'Yeni şifrə ən az 6 simvol olmalıdır.', 'Yeni şifre en az 6 karakter olmalıdır.', 'New password must be at least 6 characters.') });
  }

  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: pickLang(uiLang, 'Şifrələr uyğun gəlmir.', 'Şifreler eşleşmiyor.', 'Passwords do not match.') });
  }

  db.get('SELECT password, auth_provider FROM users WHERE id = ?', [req.session.userId], (err, row) => {
    if (err || !row) {
      return res.status(500).json({ error: pickLang(uiLang, 'Əməliyyat uğursuz oldu.', 'İşlem başarısız.', 'Operation failed.') });
    }

    const hasPassword = !!row.password;
    const continueWithHash = () => {
      bcrypt.hash(newPassword, 10, (hashErr, hashed) => {
        if (hashErr || !hashed) {
          return res.status(500).json({ error: pickLang(uiLang, 'Şifrə dəyişdirilə bilmədi.', 'Şifre değiştirilemedi.', 'Password could not be changed.') });
        }
        db.run('UPDATE users SET password = ? WHERE id = ?', [hashed, req.session.userId], (uErr) => {
          if (uErr) return res.status(500).json({ error: pickLang(uiLang, 'Şifrə dəyişdirilə bilmədi.', 'Şifre değiştirilemedi.', 'Password could not be changed.') });
          return res.json({ message: pickLang(uiLang, 'Şifrə yeniləndi.', 'Şifre güncellendi.', 'Password updated.') });
        });
      });
    };

    if (hasPassword) {
      if (!currentPassword) {
        return res.status(400).json({ error: pickLang(uiLang, 'Cari şifrə tələb olunur.', 'Mevcut şifre gerekli.', 'Current password is required.') });
      }
      return bcrypt.compare(currentPassword, row.password || '', (cmpErr, ok) => {
        if (cmpErr || !ok) {
          return res.status(400).json({ error: pickLang(uiLang, 'Cari şifrə yalnışdır.', 'Mevcut şifre yanlış.', 'Current password is incorrect.') });
        }
        return continueWithHash();
      });
    }
    return continueWithHash();
  });
});

// Sifre sifirlama istegi (POST /api/forgot-password)
app.post('/api/forgot-password',
  authLimiter,
  [
    body('email').isEmail().withMessage('Düzgün bir e-poçt ünvanı daxil edin.').normalizeEmail().trim(),
  ],
  (req, res) => {
    const uiLang = normalizeLang(req.body && req.body.lang, 'az');
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: pickLang(uiLang, 'Düzgün bir e-poçt ünvanı daxil edin.', 'Düzgün bir e-posta adresi girin.', 'Please enter a valid email address.') });
    }

    const email = (req.body && req.body.email ? req.body.email.toString().trim().toLowerCase() : '');

    db.get('SELECT id FROM users WHERE email = ?', [email], (err, user) => {
      const successMsg = pickLang(uiLang, 'E-poçt mövcuddursa sıfırlama linki göndərildi.', 'E-posta mevcutsa sıfırlama bağlantısı gönderildi.', 'If the email exists, a reset link has been sent.');

      if (err || !user) {
        return res.json({ message: successMsg });
      }

      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      const createdAt = new Date().toISOString();

      db.run(
        'INSERT INTO password_resets (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)',
        [user.id, tokenHash, expiresAt, createdAt],
        (insErr) => {
          if (insErr) return res.json({ message: successMsg });

          const resetUrl = buildAbsoluteUrl(req, `/reset-password?token=${encodeURIComponent(token)}`);
          sendPasswordResetEmail(email, resetUrl, uiLang)
            .then(() => res.json({ message: successMsg }))
            .catch(() => res.json({ message: successMsg }));
        }
      );
    });
  }
);

// Sifre sifirlama (POST /api/reset-password)
app.post('/api/reset-password',
  authLimiter,
  [
    body('token').isLength({ min: 64, max: 64 }).isHexadecimal().withMessage('Yanlış link.'),
    body('new_password').isLength({ min: 6, max: 128 }).withMessage('Şifrə ən az 6 simvol olmalıdır.'),
    body('new_password_confirm').isLength({ min: 6, max: 128 }).withMessage('Şifrə təsdiqi tələb olunur.'),
  ],
  (req, res) => {
    const uiLang = normalizeLang(req.body && req.body.lang, 'az');
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const first = errors.array()[0] || {};
      if (first.param === 'token') {
        return res.status(400).json({ error: pickLang(uiLang, 'Yanlış link.', 'Geçersiz bağlantı.', 'Invalid link.') });
      }
      if (first.param === 'new_password') {
        return res.status(400).json({ error: pickLang(uiLang, 'Şifrə ən az 6 simvol olmalıdır.', 'Şifre en az 6 karakter olmalıdır.', 'Password must be at least 6 characters.') });
      }
      return res.status(400).json({ error: pickLang(uiLang, 'Zəhmət olmasa bütün sahələri doldurun.', 'Lütfen tüm alanları doldurun.', 'Please fill in all fields.') });
    }

    const token = (req.body && req.body.token ? req.body.token.toString() : '');
    const newPassword = (req.body && req.body.new_password ? req.body.new_password.toString() : '');
    const confirmPassword = (req.body && req.body.new_password_confirm ? req.body.new_password_confirm.toString() : '');

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: pickLang(uiLang, 'Şifrələr uyğun gəlmir.', 'Şifreler eşleşmiyor.', 'Passwords do not match.') });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    db.get(
      'SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token_hash = ? ORDER BY id DESC LIMIT 1',
      [tokenHash],
      (err, row) => {
        if (err || !row) {
          return res.status(400).json({ error: pickLang(uiLang, 'Link etibarsızdır.', 'Bağlantı geçersiz.', 'Invalid link.') });
        }
        if (row.used_at) {
          return res.status(400).json({ error: pickLang(uiLang, 'Link artıq istifadə edilib.', 'Bağlantı zaten kullanıldı.', 'Link has already been used.') });
        }
        if (Date.parse(row.expires_at) <= Date.now()) {
          return res.status(400).json({ error: pickLang(uiLang, 'Linkin vaxtı bitib.', 'Bağlantının süresi doldu.', 'Link has expired.') });
        }

        bcrypt.hash(newPassword, 10, (hashErr, hashed) => {
          if (hashErr || !hashed) {
            return res.status(500).json({ error: pickLang(uiLang, 'Şifrə yenilənə bilmədi.', 'Şifre güncellenemedi.', 'Password could not be updated.') });
          }
          db.run('UPDATE users SET password = ? WHERE id = ?', [hashed, row.user_id], (uErr) => {
            if (uErr) return res.status(500).json({ error: pickLang(uiLang, 'Şifrə yenilənə bilmədi.', 'Şifre güncellenemedi.', 'Password could not be updated.') });

            db.run('UPDATE password_resets SET used_at = ? WHERE id = ?', [new Date().toISOString(), row.id], () => {});
            return res.json({ message: pickLang(uiLang, 'Şifrəniz yeniləndi.', 'Şifreniz güncellendi.', 'Your password has been updated.') });
          });
        });
      }
    );
  }
);

// Bildirimler (GET /api/notifications)
app.get('/api/notifications', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ notifications: [] });
  }

  db.all(
    'SELECT n.id, n.type, n.title_az, n.title_tr, n.title_en, n.body_az, n.body_tr, n.body_en, n.link_short, n.created_at, n.read_at, u.original AS original_url ' +
    'FROM notifications n ' +
    'LEFT JOIN urls u ON u.short = n.link_short ' +
    'WHERE n.user_id = ? ' +
    'ORDER BY datetime(n.created_at) DESC LIMIT 50',
    [req.session.userId],
    (err, rows) => {
      if (err) return res.status(500).json({ notifications: [] });
      return res.json({ notifications: rows || [] });
    }
  );
});

// Bildirimler (POST /api/notifications/mark-all)
app.post('/api/notifications/mark-all', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const status = (req.body && req.body.status) || 'read';
  if (status !== 'read' && status !== 'unread') {
    return res.status(400).json({ error: 'Invalid status' });
  }
  if (status === 'read') {
    const now = new Date().toISOString();
    db.run('UPDATE notifications SET read_at = ? WHERE user_id = ?', [now, req.session.userId], function (err) {
      if (err) return res.status(500).json({ error: 'Server error.' });
      return res.json({ updated: this.changes || 0 });
    });
    return;
  }
  db.run('UPDATE notifications SET read_at = NULL WHERE user_id = ?', [req.session.userId], function (err) {
    if (err) return res.status(500).json({ error: 'Server error.' });
    return res.json({ updated: this.changes || 0 });
  });
});

// Bildirimler (POST /api/notifications/delete-all)
app.post('/api/notifications/delete-all', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  db.run('DELETE FROM notifications WHERE user_id = ?', [req.session.userId], function (err) {
    if (err) return res.status(500).json({ error: 'Server error.' });
    return res.json({ deleted: this.changes || 0 });
  });
});

/* ----------------------
   LİNK İŞLEMLERİ (Kısaltma, Yönlendirme, Şifre Koruma, QR Kod)
------------------------- */

// URL kısaltma (POST /api/shorten)
// Eğer kullanıcı özel link girmişse (customLink) onu kullan, aksi halde random üret.
app.post('/api/shorten',
  shortenLimiter,
  [
    body('original')
      .isURL().withMessage('Zəhmət olmasa düzgün bir URL daxil edin.')
      .trim(),
    body('customLink')
      .optional({ checkFalsy: true })
      .matches(/^[a-zA-Z0-9_-]+$/).withMessage('Xüsusi link yalnız hərf, rəqəm, tire və alt xətt simvollarından ibarət ola bilər.')
      .isLength({ max: 50 }).withMessage('Xüsusi link ən çox 50 simvoldan ibarət ola bilər.')
      .trim()
      .escape(),
    body('custom_domain')
      .optional({ checkFalsy: true })
      .custom((value) => !!normalizeCustomDomainInput(value)).withMessage('Düzgün domen daxil edin.'),
    body('max_clicks')
      .optional({ checkFalsy: true })
      .isInt({ min: 1 }).withMessage('Maksimum klik sayı 1 və ya daha çox olmalıdır.')
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const uiLang = normalizeLang(req.body && req.body.lang, 'az');
      const err = errors.array()[0] || {};
      let msg = err.msg || pickLang(uiLang, 'Yanlış məlumat daxil edilib.', 'Geçersiz bilgi.', 'Invalid input.');
      if (err.param === 'original') {
        msg = pickLang(uiLang, 'Zəhmət olmasa düzgün bir URL daxil edin.', 'Lütfen geçerli bir URL girin.', 'Please enter a valid URL.');
      } else if (err.param === 'max_clicks') {
        msg = pickLang(uiLang, 'Maksimum klik sayı 1 və ya daha çox olmalıdır.', 'Maksimum tıklama 1 veya daha fazla olmalıdır.', 'Maximum clicks must be 1 or more.');
      } else if (err.param === 'customLink') {
        const raw = (err.msg || '').toString();
        if (raw.includes('50')) {
          msg = pickLang(uiLang, 'Xüsusi link ən çox 50 simvoldan ibarət ola bilər.', 'Özel link en fazla 50 karakter olabilir.', 'Custom link can be at most 50 characters.');
        } else {
          msg = pickLang(uiLang, 'Xüsusi link yalnız hərf, rəqəm, tire və alt xətt simvollarından ibarət ola bilər.', 'Özel link yalnızca harf, rakam, tire ve alt çizgi içerebilir.', 'Custom link can contain only letters, numbers, hyphens and underscores.');
        }
      } else if (err.param === 'custom_domain') {
        msg = pickLang(uiLang, 'Düzgün domen daxil edin.', 'Geçerli bir alan adı girin.', 'Please enter a valid domain.');
      }
      return res.status(400).json({ error: msg });
    }

    const uiLang = normalizeLang(req.body && req.body.lang, 'az');

    const isGuest = !req.session.userId;
    const ownerId = req.session.userId || null;

    const { original, link_password, customLink, custom_domain, expires_at, max_clicks } = req.body;
    const requestedDomain = normalizeCustomDomainInput(custom_domain);
    const originalAbs = ensureAbsoluteUrl(original);
    if (!originalAbs) {
      return res.status(400).json({ error: pickLang(uiLang, 'Zəhmət olmasa düzgün bir URL daxil edin.', 'Lütfen geçerli bir URL girin.', 'Please enter a valid URL.') });
    }

    const expiresValidation = normalizeFutureExpiryInput(expires_at);
    if (expiresValidation.error === 'invalid') {
      return res.status(400).json({ error: pickLang(uiLang, 'Bitmə tarixi etibarlı deyil.', 'Bitiş tarihi geçersiz.', 'Expiration date is invalid.') });
    }
    if (expiresValidation.error === 'past') {
      return res.status(400).json({ error: pickLang(uiLang, 'Bitmə tarixi gələcəkdə olmalıdır.', 'Bitiş tarihi gelecekte olmalıdır.', 'Expiration date must be in the future.') });
    }
    const expiresAtValue = expiresValidation.value;

    let maxClicksValue = null;
    if (max_clicks !== undefined && max_clicks !== null && `${max_clicks}`.trim() !== '') {
      const parsedMaxClicks = Number.parseInt(`${max_clicks}`, 10);
      if (!Number.isInteger(parsedMaxClicks) || parsedMaxClicks < 1) {
        return res.status(400).json({ error: pickLang(uiLang, 'Maksimum klik sayı 1 və ya daha çox olmalıdır.', 'Maksimum tıklama 1 veya daha fazla olmalıdır.', 'Maximum clicks must be 1 or more.') });
      }
      maxClicksValue = parsedMaxClicks;
    }

    let hostname = '';
    try { hostname = new URL(originalAbs).hostname.toLowerCase(); } catch { hostname = ''; }

    const limitMsg = pickLang(uiLang, 'Gündəlik limit dolub. Giriş etmədən maksimum 2 link yarada bilərsiniz.', 'Günlük limit doldu. Giriş yapmadan en fazla 2 link oluşturabilirsiniz.', 'Daily limit reached. You can create up to 2 links without logging in.');

    const checkGuestLimit = (cb) => {
      if (!isGuest) return cb(null, null);
      const dayKey = getTodayKey();
      const storeKey = buildGuestDailyLimitStoreKey(req, dayKey);

      if (redisClient && redisClient.isOpen) {
        return redisClient.get(storeKey)
          .then((rawCount) => {
            const count = Number.parseInt((rawCount || '0').toString(), 10);
            const safeCount = Number.isFinite(count) && count > 0 ? count : 0;
            if (safeCount >= 2) return cb(limitMsg, null);
            return cb(null, { storeKey, count: safeCount, redis: true });
          })
          .catch(() => {
            const fallbackMeta = guestLimitStore.get(storeKey) || { count: 0 };
            if (fallbackMeta.count >= 2) return cb(limitMsg, null);
            return cb(null, { storeKey, count: fallbackMeta.count, redis: false });
          });
      }

      const meta = guestLimitStore.get(storeKey) || { count: 0 };
      if (meta.count >= 2) return cb(limitMsg, null);
      return cb(null, { storeKey, count: meta.count, redis: false });
    };

    const bumpGuestLimit = (meta) => {
      if (!meta || !meta.storeKey) return;
      if (meta.redis && redisClient && redisClient.isOpen) {
        redisClient.multi()
          .incr(meta.storeKey)
          .expire(meta.storeKey, 2 * 24 * 60 * 60)
          .exec()
          .catch(() => {});
        return;
      }
      const nextCount = (meta.count || 0) + 1;
      guestLimitStore.set(meta.storeKey, { count: nextCount, updated_at: new Date().toISOString() });
    };

    // User ban check (prevents link creation while banned)
    const checkUserBan = (cb) => {
      if (isGuest || !ownerId) return cb(null);
      db.get('SELECT email, banned, ban_until, ban_reason, ui_lang, ui_theme, notify_report, notify_limit, notify_disabled FROM users WHERE id = ?', [ownerId], (uErr, uRow) => {
        if (uErr || !uRow) return cb(null);

        // Auto-clear expired temp bans
        if (uRow.banned == 1 && uRow.ban_until) {
          const untilMs = Date.parse(uRow.ban_until);
          if (!Number.isNaN(untilMs) && untilMs <= Date.now()) {
            db.run(
              'UPDATE users SET banned = 0, ban_until = NULL, ban_reason = NULL, ban_set_at = NULL, ban_set_by_admin_id = NULL WHERE id = ?',
              [req.session.userId],
              () => {}
            );
            uRow.banned = 0;
          }
        }

        const banActive = (uRow.banned == 1) && (!uRow.ban_until || (Date.parse(uRow.ban_until) > Date.now()));
        if (!banActive) return cb(null);

        const msg = buildBanMessage(uiLang, uRow.ban_until, uRow.ban_reason);
        return cb(msg);
      });
    };
    // Blocked domain check (prevents creating links for blocked destinations)
    const checkBlockedDomain = (cb) => {
      if (!hostname) return cb(null);
      db.get(
        "SELECT domain FROM blocked_domains WHERE ? = domain OR ? LIKE '%.' || domain LIMIT 1",
        [hostname, hostname],
        (err, row) => {
          if (err) return cb(null);
          return cb(row ? row.domain : null);
        }
      );
    };


const checkCustomDomain = (cb) => {
  if (!requestedDomain) return cb(null, '');
  if (isGuest || !ownerId) {
    return cb(pickLang(uiLang, 'Xüsusi domen yalnız giriş edən istifadəçilər üçündür.', 'Özel alan adı yalnız giriş yapan kullanıcılar içindir.', 'Custom domain is available only for signed-in users.'), '');
  }

  db.get(
    'SELECT id, domain, status FROM custom_domains WHERE user_id = ? AND domain = ?',
    [ownerId, requestedDomain],
    (domainErr, domainRow) => {
      if (domainErr) {
        return cb(pickLang(uiLang, 'Domen yoxlanışı uğursuz oldu.', 'Alan adı kontrolü başarısız oldu.', 'Domain validation failed.'), '');
      }
      if (!domainRow) {
        return cb(pickLang(uiLang, 'Bu domen hesabınıza bağlı deyil.', 'Bu alan adı hesabınıza bağlı değil.', 'This domain is not linked to your account.'), '');
      }
      if ((domainRow.status || '').toString() !== 'active') {
        return cb(pickLang(uiLang, 'Bu domen hələ aktiv deyil. Əvvəlcə DNS doğrulamasını tamamlayın.', 'Bu alan adı henüz aktif değil. Önce DNS doğrulamasını tamamlayın.', 'This domain is not active yet. Complete DNS verification first.'), '');
      }
      return cb(null, normalizeHostName(domainRow.domain));
    }
  );
};

    checkGuestLimit((limitErr, guestMeta) => {
      if (limitErr) {
        return res.status(429).json({ error: limitErr });
      }

      checkUserBan((banMsg) => {
      if (banMsg) {
        return res.status(403).json({ error: banMsg });
      }

      checkBlockedDomain((blockedDomain) => {
        if (blockedDomain) {
          return res.status(403).json({
            error: pickLang(uiLang, 'Bu domen bloklanıb. Bu linki qısaltmaq mümkün deyil.', 'Bu alan adı engellendi. Bu link kısaltılamaz.', 'This domain is blocked. This link cannot be shortened.')
          });
        }

        checkCustomDomain((domainErr, selectedDomain) => {
          if (domainErr) {
            return res.status(400).json({ error: domainErr });
          }

          let short = "";
          if (customLink && customLink.trim() !== "") {
            short = customLink.trim();

            if (isReservedShortAlias(short)) {
              return res.status(400).json({
                error: pickLang(
                  uiLang,
                  'Bu xüsusi alias sistem yolları üçün ayrılıb. Başqa alias seçin.',
                  'Bu özel alias sistem yolları için ayrılmış. Lütfen başka bir alias seçin.',
                  'This alias is reserved for system routes. Please choose another alias.'
                )
              });
            }

            // Özel link zaten kullanılmış mı kontrol et
            db.get('SELECT * FROM urls WHERE short = ?', [short], (err, row) => {
              if (row) {
                return res.status(400).json({ error: pickLang(uiLang, 'Bu xüsusi link istifadə olunub', 'Bu özel link zaten kullanılıyor', 'This custom link is already in use.') });
              } else {
                void insertLink(selectedDomain);
              }
            });
          } else {
            short = generateSafeShortCode();
            void insertLink(selectedDomain);
          }

          async function insertLink(selectedDomainHost) {
            const createdAt = new Date().toISOString();
            const linkPasswordRaw = (link_password || '').toString();
            const shortUrl = buildShortUrl(req, short, selectedDomainHost);
            const storedLinkPassword = linkPasswordRaw ? await hashLinkPassword(linkPasswordRaw) : '';
            if (linkPasswordRaw && !storedLinkPassword) {
              return res.status(500).json({ error: pickLang(uiLang, 'Link qısaldıla bilmədi.', 'Link kısaltılamadı.', 'Link could not be shortened.') });
            }
            db.run(
              'INSERT INTO urls (original, short, created_at, user_id, link_password, expires_at, max_clicks, domain_host) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
              [originalAbs, short, createdAt, ownerId, storedLinkPassword, expiresAtValue, maxClicksValue, selectedDomainHost || null],
              function (err) {
                if (err) return res.status(500).json({ error: pickLang(uiLang, 'Link qısaldıla bilmədi.', 'Link kısaltılamadı.', 'Link could not be shortened.') });

                bumpGuestLimit(guestMeta);

                if (ownerId) {
                  void enqueueWebhookEventForUser(ownerId, 'link.created', {
                    short,
                    short_url: shortUrl,
                    original_url: originalAbs,
                    domain: selectedDomainHost || null,
                    created_at: createdAt,
                  });
                }

                return res.json({
                  message: pickLang(uiLang, 'Qısaldılmış link: ' + shortUrl, 'Kısaltılmış link: ' + shortUrl, 'Short link: ' + shortUrl),
                  short: short,
                  shortUrl: shortUrl,
                  domain: selectedDomainHost || null,
                });
              }
            );
          }
        });
      });
    });
  });
  });

// 404 Xəta Səhifəsi
function send404(res) {
  const req = (res && res.req) ? res.req : null;
  const pathValue = req ? ((req.originalUrl || req.path || '/404').toString()) : '/404';
  const seo = req
    ? buildSeo(req, {
      path: pathValue,
      titleAz: 'Link tapılmadı - Ovlink',
      titleTr: 'Link bulunamadı - Ovlink',
      titleEn: 'Link not found - Ovlink',
      descAz: 'Axtardığınız link mövcud deyil, silinib və ya açıq deyil.',
      descTr: 'Aradığınız link mevcut değil, silinmiş ya da erişime kapalı.',
      descEn: 'The link you requested does not exist, was removed, or is unavailable.'
    })
    : {
      lang: 'en',
      title: 'Link not found - Ovlink',
      description: 'The link you requested does not exist, was removed, or is unavailable.',
      canonical: '',
      hreflangEn: '',
      hreflangAz: '',
      hreflangTr: '',
      hreflangXDefault: '',
      jsonLd: ''
    };

  seo.jsonLd = '';
  res.set('X-Robots-Tag', 'noindex,nofollow');
  return res.status(404).render('404', { csrfToken: res.locals._csrf, seo });
}

// Mərkəzləşdirilmiş Yönləndirmə Məntiqi
function handleRedirection(req, res, row, passwordVerified = false) {
  const short = row.short;
  const consentState = getRedirectConsentModeForRequest(req, short, 'redirect');
  const consentMode = consentState.mode;

  if (!consentMode) {
    return res.redirect(302, `/consent/redirect/${encodeURIComponent(short)}`);
  }

  // 1. Bitmə Tarixi Kontrolü
  if (isIsoTimeExpired(row.expires_at)) {
    return res.status(410).render('error-expired', { csrfToken: res.locals._csrf });
  }

  // 2. Maksimum Klik Kontrolü
  db.get('SELECT COUNT(*) as count FROM clicks WHERE url_id = ?', [row.id], (err, result) => {
    if (result && row.max_clicks && result.count >= row.max_clicks) {
      if (row.user_id) {
        createUserNotification(db, row.user_id, 'limit', {
          titleAz: 'Klik limiti doldu',
          titleTr: 'Tıklama limiti doldu',
          titleEn: 'Click limit reached',
          bodyAz: `Qısa link: ${row.short}. Maksimum klik limiti bitdi.`,
          bodyTr: `Kısa link: ${row.short}. Maksimum tıklama limiti doldu.`,
          bodyEn: `Short link: ${row.short}. Maximum click limit reached.`,
          linkShort: row.short,
          eventKey: `limit_${row.short}`,
        });
      }
      return res.status(410).render('error-max-clicks', { csrfToken: res.locals._csrf });
    }

    // 3. Şifrə Kontrolü
    if (row.link_password && !passwordVerified) {
      return res.redirect('/proceed/' + short);
    }

    // 4. Təhlükəli Link Kontrolü (yalnız 4+ şikayət olduqda)
    if ((row.reports || 0) >= 4 && !req.query.confirm) {
      const announcementHtml = buildAnnouncementHtml();
      const assetQuery = `?v=${encodeURIComponent(res.locals.assetVersion || ASSET_VERSION)}`;
      return res.send(`
        <html>
          <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title data-i18n="danger_title">Xəbərdarlıq</title>
            <link rel="icon" href="/logo.ico" />
            <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" />
            <link rel="stylesheet" href="/style.css${assetQuery}" />
          </head>
          <body class="home-page app-page">
${announcementHtml}
            <main class="container mt-5 text-center">
              <div class="card shadow-sm border-0 mx-auto p-4" style="max-width: 520px;">
                <i class="fa-solid fa-triangle-exclamation fa-4x text-warning mb-3"></i>
                <h2 class="fw-bold mb-2" data-i18n="danger_title">Xəbərdarlıq</h2>
                <p class="text-muted" data-i18n="danger_msg">Bu link çox sayda şikayət alıb. Davam etmək istəyirsiniz?</p>
                <div class="d-flex justify-content-center gap-2 mt-3">
                  <a href="/${short}?confirm=true" class="btn btn-warning" data-i18n="danger_continue">Davam et</a>
                  <a href="/" class="btn btn-outline-secondary" data-i18n="danger_back">Geri qayıt</a>
                </div>
              </div>
            </main>
            <script src="/lang.js${assetQuery}"></script>
            <script src="/script.js${assetQuery}"></script>
          </body>
        </html>
      `);
    }

    // 5. Tracking (Klik qeydiyyatı)
    recordClickEvent(req, row, consentMode);
    if (consentState.source === 'session') {
      clearRedirectConsentSession(req);
    }

    // 6. Final Yönlendirmə
    const targetUrl = ensureAbsoluteUrl(row.original);
    if (!targetUrl) return send404(res);
    res.redirect(targetUrl);
  });
}

app.get('/consent/redirect/:short', (req, res) => {
  const short = normalizeShortCode(req.params.short);
  if (!short) return send404(res);

  const nextAction = normalizeConsentNext(req.query.next);
  const consentView = ((req.query.view || '').toString().trim().toLowerCase() === 'declined') ? 'declined' : 'decision';

  const currentMode = getRedirectConsentMode(req);
  if (currentMode && consentView !== 'declined') {
    return res.redirect(303, getConsentResumePath(short, nextAction));
  }

  db.get('SELECT short, original, disabled, disabled_reason, domain_host FROM urls WHERE short = ?', [short], (err, row) => {
    if (err) return res.status(500).send('Server error.');
    if (!row) return send404(res);

    const reqHost = getRequestHostName(req);
    const hostAccess = getShortHostAccess(row, reqHost);
    if (!hostAccess.allowed) {
      if (hostAccess.redirectHost) {
        const query = new URLSearchParams({ next: nextAction });
        if (consentView === 'declined') query.set('view', 'declined');
        const redirectPath = '/consent/redirect/' + encodeURIComponent(short) + '?' + query.toString();
        const redirectUrl = buildAbsoluteUrlForHost(req, hostAccess.redirectHost, redirectPath);
        return res.redirect(302, redirectUrl);
      }
      return send404(res);
    }

    if (row.disabled == 1) {
      return res.status(410).render('error-disabled', { csrfToken: res.locals._csrf, reason: row.disabled_reason || '' });
    }

    const originalAbs = ensureAbsoluteUrl(row.original);
    if (!originalAbs) return send404(res);

    let targetHost = '';
    try {
      targetHost = new URL(originalAbs).hostname || '';
    } catch {
      targetHost = '';
    }

    const readyAt = Date.now() + REDIRECT_CONSENT_COUNTDOWN_MS;
    const readySig = consentView === 'decision'
      ? buildRedirectConsentSignature(short, nextAction, readyAt)
      : '';

    return res.render('redirect-consent', {
      csrfToken: res.locals._csrf,
      shortCode: short,
      nextAction,
      targetHost: targetHost || pickLang(req.defaultLang || 'az', 'naməlum', 'bilinmiyor', 'unknown'),
      consentView,
      tooEarly: req.query.too_early === '1',
      countdownReadyAt: readyAt,
      countdownReadySig: readySig,
      countdownDurationMs: REDIRECT_CONSENT_COUNTDOWN_MS,
    });
  });
});

app.post('/consent/redirect/:short', (req, res) => {
  const short = normalizeShortCode(req.params.short);
  if (!short) return send404(res);

  const nextAction = normalizeConsentNext(req.body && req.body.next);
  const decision = ((req.body && req.body.decision) || '').toString().trim().toLowerCase();

  if (decision === 'no') {
    clearRedirectConsentSession(req);
    clearRedirectConsentMode(res);
    const q = new URLSearchParams({ next: nextAction, view: 'declined' }).toString();
    return res.redirect(303, `/consent/redirect/${encodeURIComponent(short)}?${q}`);
  }

  if (decision !== 'continue') {
    const q = new URLSearchParams({ next: nextAction }).toString();
    return res.redirect(303, `/consent/redirect/${encodeURIComponent(short)}?${q}`);
  }

  const readyAt = Number.parseInt((req.body && req.body.ready_at) || '', 10);
  const readySig = (req.body && req.body.ready_sig) || '';
  const now = Date.now();
  const isSignatureValid = isRedirectConsentSignatureValid(short, nextAction, readyAt, readySig);
  const isTimestampValid = Number.isFinite(readyAt) && readyAt <= now && readyAt >= (now - REDIRECT_CONSENT_MAX_TOKEN_AGE_MS);
  if (!isSignatureValid || !isTimestampValid) {
    const q = new URLSearchParams({ next: nextAction, too_early: '1' }).toString();
    return res.redirect(303, `/consent/redirect/${encodeURIComponent(short)}?${q}`);
  }

  db.get('SELECT id, domain_host FROM urls WHERE short = ?', [short], (err, row) => {
    if (err) return res.status(500).send('Server error.');
    if (!row) return send404(res);

    const reqHost = getRequestHostName(req);
    const hostAccess = getShortHostAccess(row, reqHost);
    if (!hostAccess.allowed) {
      if (hostAccess.redirectHost) {
        const redirectPath = '/consent/redirect/' + encodeURIComponent(short) + '?' + new URLSearchParams({ next: nextAction }).toString();
        const redirectUrl = buildAbsoluteUrlForHost(req, hostAccess.redirectHost, redirectPath);
        return res.redirect(302, redirectUrl);
      }
      return send404(res);
    }

    setRedirectConsentSession(req, short, nextAction, REDIRECT_CONSENT_MODES.ANALYTICS);
    setRedirectConsentMode(res, REDIRECT_CONSENT_MODES.ANALYTICS);
    return res.redirect(303, getConsentResumePath(short, nextAction));
  });
});

app.get(/^\/AGENTS(\.md)?$/i, (_req, res) => {
  return res.status(404).type('text/plain').send('Not found.');
});

// Yönlendirme (GET /:short)
app.get('/:short', (req, res, next) => {
  const rawShort = (req.params.short || '').toString();
  if (rawShort === 'dashboard')
    return next();

  const short = normalizeShortCode(rawShort);
  if (!short) return send404(res);

  db.get('SELECT * FROM urls WHERE short = ?', [short], (err, row) => {
    if (err) return res.status(500).send('Server error.');
    if (!row) return send404(res);

    const reqHost = getRequestHostName(req);
    const hostAccess = getShortHostAccess(row, reqHost);
    if (!hostAccess.allowed) {
      if (hostAccess.redirectHost) {
        const redirectUrl = buildAbsoluteUrlForHost(req, hostAccess.redirectHost, '/' + encodeURIComponent(short));
        return res.redirect(302, redirectUrl);
      }
      return send404(res);
    }

    // Admin moderation controls: disabled links + blocked destination domains
    if (row.disabled == 1) {
      return res.status(410).render('error-disabled', { csrfToken: res.locals._csrf, reason: row.disabled_reason || '' });
    }

    const originalAbs = ensureAbsoluteUrl(row.original);
    if (!originalAbs) return send404(res);
    let hostname = '';
    try { hostname = new URL(originalAbs).hostname.toLowerCase(); } catch { hostname = ''; }

    if (!hostname) return handleRedirection(req, res, row);

    db.get("SELECT domain FROM blocked_domains WHERE ? = domain OR ? LIKE '%.' || domain LIMIT 1", [hostname, hostname], (blockErr, blockedRow) => {
      if (blockedRow) {
        return res.status(451).render('error-blocked', { csrfToken: res.locals._csrf });
      }
      return handleRedirection(req, res, row);
    });
  });
});

// Şifre korumalı linkler için (GET /proceed/:short)
app.get('/proceed/:short', (req, res) => {
  const short = normalizeShortCode(req.params.short);
  if (!short) return send404(res);
  db.get('SELECT * FROM urls WHERE short = ?', [short], (err, row) => {
    if (!row) return send404(res);

    const reqHost = getRequestHostName(req);
    const hostAccess = getShortHostAccess(row, reqHost);
    if (!hostAccess.allowed) {
      if (hostAccess.redirectHost) {
        const redirectUrl = buildAbsoluteUrlForHost(req, hostAccess.redirectHost, '/proceed/' + encodeURIComponent(short));
        return res.redirect(302, redirectUrl);
      }
      return send404(res);
    }

    const consentState = getRedirectConsentModeForRequest(req, short, 'proceed');
    const consentMode = consentState.mode;
    if (!consentMode) {
      const q = new URLSearchParams({ next: 'proceed' }).toString();
      return res.redirect(303, `/consent/redirect/${encodeURIComponent(short)}?${q}`);
    }
    if (row.link_password) {
      const seo = buildSeo(req, {
        path: `/proceed/${encodeURIComponent(short)}`,
        titleAz: 'Şifrə tələb olunur - Ovlink',
        titleTr: 'Şifre gerekli - Ovlink',
        titleEn: 'Password required - Ovlink',
        descAz: 'Bu qısa link şifrə ilə qorunur. Davam etmək üçün şifrəni daxil edin.',
        descTr: 'Bu kısa link şifre ile korunuyor. Devam etmek için şifre girin.',
        descEn: 'This short link is password-protected. Enter the password to continue.'
      });
      seo.jsonLd = '';
      return res.render('proceed', {
        csrfToken: res.locals._csrf,
        shortPath: encodeURIComponent((short || '').toString()),
        seo,
      });
    } else {
      recordClickEvent(req, row, consentMode);
      if (consentState.source === 'session') {
        clearRedirectConsentSession(req);
      }
      const targetUrl = ensureAbsoluteUrl(row.original);
      if (!targetUrl) return send404(res);
      res.redirect(targetUrl);
    }
  });
});

// Şifre doğrulama (POST /verify/:short)
app.post('/verify/:short', (req, res) => {
  const short = normalizeShortCode(req.params.short);
  const password = (req.body.password || '').toString();
  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  if (!short) return res.status(400).json({ error: pickLang(uiLang, 'Yanlış qısa kod.', 'Geçersiz kısa kod.', 'Invalid short code.') });

  db.get('SELECT * FROM urls WHERE short = ?', [short], (err, row) => {
    if (err || !row) {
      return res.status(404).json({ error: pickLang(uiLang, 'Link tapılmadı.', 'Link bulunamadı.', 'Link not found.') });
    }

    const reqHost = getRequestHostName(req);
    const hostAccess = getShortHostAccess(row, reqHost);
    if (!hostAccess.allowed) {
      return res.status(403).json({
        error: pickLang(uiLang, 'Bu link bu domen üzərindən açıla bilməz.', 'Bu link bu alan adı üzerinden açılamaz.', 'This link cannot be opened on this domain.')
      });
    }

    const consentState = getRedirectConsentModeForRequest(req, short, 'proceed');
    const consentMode = consentState.mode;
    if (!consentMode) {
      return res.status(403).json({
        error: pickLang(uiLang, 'Davam etməzdən əvvəl məxfilik seçimini tamamlayın.', 'Devam etmeden önce gizlilik seçimini tamamlayın.', 'Complete the privacy choice before continuing.')
      });
    }

    // Enforce admin moderation here too (avoid bypass via /proceed + /verify)
    if (row.disabled == 1) {
      return res.status(410).json({ error: pickLang(uiLang, 'Link deaktiv edilib.', 'Link devre dışı.', 'Link disabled.') });
    }

    const targetUrl = ensureAbsoluteUrl(row.original);
    if (!targetUrl) {
      return res.status(400).json({ error: pickLang(uiLang, 'Yanlış link.', 'Geçersiz link.', 'Invalid link.') });
    }
    let hostname = '';
    try { hostname = new URL(targetUrl).hostname.toLowerCase(); } catch { hostname = ''; }

    const checkBlockedDomain = (cb) => {
      if (!hostname) return cb(false);
      db.get(
        "SELECT domain FROM blocked_domains WHERE ? = domain OR ? LIKE '%.' || domain LIMIT 1",
        [hostname, hostname],
        (blockErr, blockedRow) => cb(!!blockedRow)
      );
    };

    checkBlockedDomain((isBlocked) => {
      if (isBlocked) {
        return res.status(451).json({
          error: pickLang(uiLang, 'Bu domen bloklanıb.', 'Bu alan adı engellenmiştir.', 'This domain is blocked.')
        });
      }

      // Expiry check
      if (isIsoTimeExpired(row.expires_at)) {
        return res.status(410).json({
          error: pickLang(uiLang, 'Bu linkin vaxtı bitib.', 'Bu linkin süresi doldu.', 'This link has expired.')
        });
      }

      // Max clicks check
      db.get('SELECT COUNT(*) as count FROM clicks WHERE url_id = ?', [row.id], async (countErr, result) => {
        const current = result ? (result.count || 0) : 0;
        if (row.max_clicks && current >= row.max_clicks) {
          return res.status(410).json({
            error: pickLang(uiLang, 'Bu link limitə çatıb.', 'Bu link maksimum tıklama limitine ulaştı.', 'This link has reached its click limit.')
          });
        }

        if (await verifyLinkPassword(row.link_password, password)) {
          if (!isBcryptHash(row.link_password)) {
            const migratedHash = await hashLinkPassword(password);
            if (migratedHash) {
              db.run('UPDATE urls SET link_password = ? WHERE id = ?', [migratedHash, row.id], () => {});
            }
          }
          // Tıklama kaydı ekle
          recordClickEvent(req, row, consentMode);
          if (consentState.source === 'session') {
            clearRedirectConsentSession(req);
          }

          return res.json({ success: true, redirect: targetUrl });
        }

        return res.status(401).json({ error: pickLang(uiLang, 'Yanlış şifrə.', 'Yanlış şifre.', 'Incorrect password.') });
      });
    });
  });
});

// QR Kod Oluşturma (GET /api/qrcode?short=xxx&colorDark=%23000000&colorLight=%23ffffff)
// Quick checks:
// valid:   /api/qrcode?short=1&colorDark=%23000000&colorLight=%23ffffff
// invalid: /api/qrcode?short=1&colorDark=../../../../etc/passwd
// invalid: /api/qrcode?short=1&colorDark=..%2f..%2f..%2f..%2fwindows%2fwin.ini
app.get('/api/qrcode', (req, res) => {
  const shortRaw = (req.query.short || '').toString().trim();
  const colorDark = (req.query.colorDark || '#000000').toString().trim();
  const colorLight = (req.query.colorLight || '#ffffff').toString().trim();

  const shortOk = /^(?:[A-Za-z0-9_-]{1,64})$/.test(shortRaw) || /^(?:0|1|true|false)$/i.test(shortRaw);
  if (!shortOk) return res.status(400).json({ error: 'Invalid short' });

  const isHex = (v) => /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v);
  if (!isHex(colorDark)) return res.status(400).json({ error: 'Invalid colorDark' });
  if (!isHex(colorLight)) return res.status(400).json({ error: 'Invalid colorLight' });

  db.get('SELECT * FROM urls WHERE short = ?', [shortRaw], (err, row) => {
    if (err || !row) return res.status(404).send('Belə Bir Link Tapılmadı');

    const fullUrl = buildShortUrl(req, shortRaw, row.domain_host || '');

    QRCode.toDataURL(fullUrl, {
      color: {
        dark: colorDark,
        light: colorLight
      }
    }, (err, url) => {
      if (err) return res.status(500).send('QR kod oluşturulamadı.');
      res.json({ qrCode: url });
    });
  });
});

// Raporlama (POST /api/report)
app.post('/api/report', reportLimiter, (req, res) => {
  const { short, reason, lang } = req.body || {};
  const uiLang = normalizeLang(lang, 'az');
  const safeShort = normalizeShortCode(short);

  if (!req.session.userId) {
    return res.status(401).json({ error: pickLang(uiLang, 'Şikayət göndərmək üçün giriş etməlisiniz.', 'Rapor göndermek için giriş yapmalısınız.', 'You must be logged in to submit a report.') });
  }

  if (!safeShort) return res.status(400).json({ error: pickLang(uiLang, 'Qısaldılmış link tələb olunur.', 'Kısaltılmış link gerekli.', 'Short link is required.') });

  const createdAt = new Date().toISOString();
  const cleanReason = (reason || '').toString().trim().slice(0, 500);

  db.get('SELECT email, banned, ban_until, ban_reason, ui_lang, ui_theme, notify_report, notify_limit, notify_disabled FROM users WHERE id = ?', [req.session.userId], (uErr, uRow) => {
    if (uErr || !uRow) return res.status(403).json({ error: pickLang(uiLang, 'Səlahiyyət yoxdur.', 'Yetkisiz istek.', 'Unauthorized request.') });

    // Auto-clear expired temp bans
    if (uRow.banned == 1 && uRow.ban_until) {
      const untilMs = Date.parse(uRow.ban_until);
      if (!Number.isNaN(untilMs) && untilMs <= Date.now()) {
        db.run(
          'UPDATE users SET banned = 0, ban_until = NULL, ban_reason = NULL, ban_set_at = NULL, ban_set_by_admin_id = NULL WHERE id = ?',
          [req.session.userId],
          () => {}
        );
        uRow.banned = 0;
      }
    }

    const banActive = (uRow.banned == 1) && (!uRow.ban_until || (Date.parse(uRow.ban_until) > Date.now()));
    if (banActive) {
      const msg = buildBanMessage(uiLang, uRow.ban_until, uRow.ban_reason);
      return res.status(403).json({ error: msg });
    }

    db.get(
      'SELECT id FROM reports WHERE short = ? AND user_id = ? AND resolved_at IS NULL',
      [safeShort, req.session.userId],
      (err, reportRow) => {
        if (err) return res.status(500).json({ error: 'Server error.' });

        if (reportRow) {
          return res.status(400).json({ error: pickLang(uiLang, 'Bu linki artıq şikayət etmisiniz.', 'Bu linki zaten raporladınız.', 'You have already reported this link.') });
        }

        db.get('SELECT id, user_id, reports FROM urls WHERE short = ?', [safeShort], (findErr, row) => {
          if (findErr || !row) {
            return res.status(404).json({ error: pickLang(uiLang, 'Link tapılmadı.', 'Link bulunamadı.', 'Link not found.') });
          }

          db.run(
            'INSERT INTO reports (short, created_at, reason, user_id) VALUES (?, ?, ?, ?)',
            [safeShort, createdAt, cleanReason, req.session.userId],
            function (insertErr) {
              if (insertErr) return res.status(500).json({ error: 'Server error.' });

              // Mark as potentially risky once reported.
              db.run('UPDATE urls SET reports = reports + 1, dangerous = CASE WHEN reports + 1 >= 4 THEN 1 ELSE dangerous END WHERE id = ?', [row.id], () => {
                db.get('SELECT reports, user_id FROM urls WHERE id = ?', [row.id], (cntErr, cntRow) => {
                  if (!cntErr && cntRow && cntRow.user_id && cntRow.user_id !== req.session.userId) {
                    if ((cntRow.reports || 0) >= 1) {
                      const reasonText = cleanReason ? (uiLang === 'tr' ? ` Sebep: ${cleanReason}` : (uiLang === 'en' ? ` Reason: ${cleanReason}` : ` Səbəb: ${cleanReason}`)) : '';
                      createUserNotification(db, cntRow.user_id, 'report', {
                        titleAz: 'Linkiniz şikayət edildi',
                        titleTr: 'Linkiniz raporlandı',
                        titleEn: 'Your link was reported',
                        bodyAz: `Qısa link: ${safeShort}.${reasonText}`,
                        bodyTr: `Kısa link: ${safeShort}.${reasonText}`,
                        bodyEn: `Short link: ${safeShort}.${reasonText}`,
                        linkShort: safeShort,
                        eventKey: `report_${safeShort}`,
                      });
                    }
                  }
                });
              });

              return res.json({ message: pickLang(uiLang, 'Şikayətiniz göndərildi.', 'Raporunuz gönderildi.', 'Your report has been submitted.') });
            }
          );
        });
      }
    );
  });
});

function handleStatsApiRequest(req, res, rawShort) {
  if (!req.session.userId) return res.status(401).json({ error: 'Giriş gerekli.' });
  const requestedShort = Array.isArray(rawShort) ? rawShort[0] : rawShort;
  const short = normalizeShortCode(requestedShort);
  if (!short) return res.status(400).json({ error: 'Geçersiz kısa kod.' });

  db.get('SELECT * FROM urls WHERE short = ? AND user_id = ?', [short, req.session.userId], (err, url) => {
    if (err || !url) return res.status(404).json({ error: 'Link bulunamadı veya yetkiniz yok.' });

    db.all('SELECT * FROM clicks WHERE url_id = ?', [url.id], (err, clicks) => {
      if (err) return res.status(500).json({ error: 'Veri alınamadı.' });

      const stats = {
        total_clicks: clicks.length,
        browsers: {},
        os: {},
        countries: {},
        clicks_over_time: {}
      };

      clicks.forEach(click => {
        const browserKey = click.browser === REDIRECT_CONSENT_MARKER ? REDIRECT_CONSENT_MARKER : getEssentialAnalyticsValue(click.browser);
        const osKey = click.os === REDIRECT_CONSENT_MARKER ? REDIRECT_CONSENT_MARKER : getEssentialAnalyticsValue(click.os);
        const countryKey = click.country === REDIRECT_CONSENT_MARKER ? REDIRECT_CONSENT_MARKER : getEssentialAnalyticsValue(click.country);

        // Browser
        stats.browsers[browserKey] = (stats.browsers[browserKey] || 0) + 1;
        // OS
        stats.os[osKey] = (stats.os[osKey] || 0) + 1;
        // Country
        stats.countries[countryKey] = (stats.countries[countryKey] || 0) + 1;
        // Time (hour bucket, UTC key). Client side local saatte gösterilir.
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
      const sortedTimeStats = {};
      sortedKeys.forEach(k => {
        sortedTimeStats[k] = stats.clicks_over_time[k];
      });
      stats.clicks_over_time = sortedTimeStats;

      res.json(stats);
    });
  });
}

// İstatistik API (GET /api/stats/:short)
app.get('/api/stats/:short', (req, res) => {
  return handleStatsApiRequest(req, res, req.params.short);
});

// Legacy uyumluluk: GET /api/stats?short=...
app.get('/api/stats', (req, res) => {
  return handleStatsApiRequest(req, res, req.query.short);
});

// İstatistik Sayfası (GET /stats-page/:short)
app.get('/stats-page/:short', (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  const short = normalizeShortCode(req.params.short);
  if (!short) return res.status(404).send('Link bulunamadı.');

  // Güvenlik: Sadece link sahibi görebilir
  db.get('SELECT user_id FROM urls WHERE short = ?', [short], (err, row) => {
    if (err || !row) return res.status(404).send('Link bulunamadı.');
    if (row.user_id !== req.session.userId) {
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
  });
});


// KULLANICI LINK SİLME (POST /api/user/delete)
app.post('/api/user/delete', (req, res) => {
  if (!req.session.userId) return res.status(401).send('Giriş yapmalısınız.');
  const safeShort = normalizeShortCode(req.body && req.body.short);
  if (!safeShort) return res.status(400).send('Geçersiz kısa kod.');
  db.get('SELECT short, original, domain_host FROM urls WHERE short = ? AND user_id = ?', [safeShort, req.session.userId], (findErr, foundRow) => {
    if (findErr) return res.status(500).send('Link silinemedi.');
    if (!foundRow) return res.status(404).send('Link tapılmadı və ya səlahiyyətiniz yoxdur.');

    db.run('DELETE FROM urls WHERE short = ? AND user_id = ?', [safeShort, req.session.userId], function (err) {
      if (err) return res.status(500).send('Link silinemedi.');
      if (this.changes === 0) return res.status(404).send('Link tapılmadı və ya səlahiyyətiniz yoxdur.');

      const shortUrl = buildShortUrl(req, foundRow.short || safeShort, foundRow.domain_host || '');
      void enqueueWebhookEventForUser(req.session.userId, 'link.deleted', {
        short: foundRow.short || safeShort,
        short_url: shortUrl,
        original_url: foundRow.original || '',
        domain: normalizeHostName(foundRow.domain_host || '') || null,
        deleted_at: new Date().toISOString(),
      });
      res.redirect('/dashboard');
    });
  });
});

// KULLANICI TOPLU LINK SİLME (POST /api/user/delete-bulk)
app.post('/api/user/delete-bulk',
  shortenLimiter,
  (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Giriş yapmalısınız.' });
  }

  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  let shorts = req.body && req.body.shorts;
  if (typeof shorts === 'string') shorts = [shorts];
  if (!Array.isArray(shorts)) shorts = [];

  shorts = shorts.map(s => (s || '').toString().trim()).filter(Boolean);
  shorts = Array.from(new Set(shorts));
  const valid = shorts.filter(s => SHORT_CODE_RE.test(s));

  if (!valid.length) {
    return res.status(400).json({
      error: pickLang(uiLang, 'Silmək üçün link seçin.', 'Silmek için link seçin.', 'Select a link to delete.')
    });
  }

  const MAX_DELETE_SHORTS = 100;
  if (valid.length > MAX_DELETE_SHORTS) {
    return res.status(400).json({
      error: pickLang(uiLang, `Bir dəfəyə maksimum ${MAX_DELETE_SHORTS} link silinə bilər.`, `Bir seferde en fazla ${MAX_DELETE_SHORTS} link silinebilir.`, `Maximum ${MAX_DELETE_SHORTS} links can be deleted at once.`)
    });
  }

  const placeholders = valid.map(() => '?').join(',');
  db.all(
    `SELECT short, original, domain_host FROM urls WHERE user_id = ? AND short IN (${placeholders})`,
    [req.session.userId, ...valid],
    (findErr, foundRows) => {
      if (findErr) return res.status(500).json({ error: 'Server error.' });

      db.run(
        `DELETE FROM urls WHERE user_id = ? AND short IN (${placeholders})`,
        [req.session.userId, ...valid],
        function (err) {
          if (err) return res.status(500).json({ error: 'Server error.' });

          const deletedRows = Array.isArray(foundRows) ? foundRows : [];
          deletedRows.forEach((row) => {
            const shortCode = (row && row.short) ? row.short : '';
            if (!shortCode) return;
            const shortUrl = buildShortUrl(req, shortCode, row.domain_host || '');
            void enqueueWebhookEventForUser(req.session.userId, 'link.deleted', {
              short: shortCode,
              short_url: shortUrl,
              original_url: row.original || '',
              domain: normalizeHostName(row.domain_host || '') || null,
              deleted_at: new Date().toISOString(),
            });
          });

          return res.json({ deleted: this.changes || 0 });
        }
      );
    }
  );
});


// KULLANICI LINK HEDEFİ GÜNCELLEME (POST /api/user/link/update)
app.post('/api/user/link/update', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const short = normalizeShortCode(req.body && req.body.short);
  const originalAbs = ensureAbsoluteUrl(req.body && req.body.original);

  if (!short || !originalAbs) {
    return res.status(400).json({
      error: pickLang(uiLang, 'Düzgün qısa kod və URL daxil edin.', 'Geçerli kısa kod ve URL girin.', 'Enter a valid short code and URL.')
    });
  }

  db.get('SELECT short, original, domain_host FROM urls WHERE short = ? AND user_id = ?', [short, req.session.userId], (findErr, currentRow) => {
    if (findErr) return res.status(500).json({ error: 'Server error.' });
    if (!currentRow) {
      return res.status(404).json({ error: pickLang(uiLang, 'Link tapılmadı.', 'Link bulunamadı.', 'Link not found.') });
    }

    let hostname = '';
    try { hostname = new URL(originalAbs).hostname.toLowerCase(); } catch { hostname = ''; }

    const updateRow = () => {
      db.run(
        'UPDATE urls SET original = ? WHERE short = ? AND user_id = ?',
        [originalAbs, short, req.session.userId],
        function (err) {
          if (err) {
            return res.status(500).json({ error: pickLang(uiLang, 'Link yenilənə bilmədi.', 'Link güncellenemedi.', 'Link could not be updated.') });
          }
          if ((this.changes || 0) === 0) {
            return res.status(404).json({ error: pickLang(uiLang, 'Link tapılmadı.', 'Link bulunamadı.', 'Link not found.') });
          }

          const shortUrl = buildShortUrl(req, short, currentRow.domain_host || '');
          void enqueueWebhookEventForUser(req.session.userId, 'link.updated', {
            short,
            short_url: shortUrl,
            original_url: originalAbs,
            previous_original_url: currentRow.original || '',
            domain: normalizeHostName(currentRow.domain_host || '') || null,
            updated_at: new Date().toISOString(),
          });

          return res.json({ message: pickLang(uiLang, 'Link hədəfi yeniləndi.', 'Link hedefi güncellendi.', 'Link destination updated.') });
        }
      );
    };

    if (!hostname) return updateRow();

    db.get(
      "SELECT domain FROM blocked_domains WHERE ? = domain OR ? LIKE '%.' || domain LIMIT 1",
      [hostname, hostname],
      (err, row) => {
        if (err) return res.status(500).json({ error: 'Server error.' });
        if (row) {
          return res.status(403).json({
            error: pickLang(uiLang, 'Bu domen bloklanıb.', 'Bu alan adı engellendi.', 'This domain is blocked.')
          });
        }
        return updateRow();
      }
    );
  });
});

// KULLANICI LINK METADATA GÜNCELLEME (POST /api/user/link/meta)
app.post('/api/user/link/meta', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const short = normalizeShortCode(req.body && req.body.short);
  if (!short) {
    return res.status(400).json({
      error: pickLang(uiLang, 'Yanlış qısa kod.', 'Geçersiz kısa kod.', 'Invalid short code.')
    });
  }

  const folderName = normalizeFolderName(req.body && req.body.folder_name);
  const tags = normalizeTagsInput(req.body && req.body.tags);
  const tagsJson = tags.length ? JSON.stringify(tags) : null;

  db.get(
    'SELECT short, original, domain_host, folder_name, tags_json FROM urls WHERE short = ? AND user_id = ?',
    [short, req.session.userId],
    (findErr, currentRow) => {
      if (findErr) {
        return res.status(500).json({ error: pickLang(uiLang, 'Metadata yenilənmədi.', 'Metadata güncellenemedi.', 'Metadata could not be updated.') });
      }
      if (!currentRow) {
        return res.status(404).json({ error: pickLang(uiLang, 'Link tapılmadı.', 'Link bulunamadı.', 'Link not found.') });
      }

      db.run(
        'UPDATE urls SET folder_name = ?, tags_json = ? WHERE short = ? AND user_id = ?',
        [folderName || null, tagsJson, short, req.session.userId],
        function (err) {
          if (err) {
            return res.status(500).json({ error: pickLang(uiLang, 'Metadata yenilənmədi.', 'Metadata güncellenemedi.', 'Metadata could not be updated.') });
          }
          if ((this.changes || 0) === 0) {
            return res.status(404).json({ error: pickLang(uiLang, 'Link tapılmadı.', 'Link bulunamadı.', 'Link not found.') });
          }

          const shortUrl = buildShortUrl(req, short, currentRow.domain_host || '');
          let previousTagsRaw = [];
          try {
            previousTagsRaw = currentRow.tags_json ? JSON.parse(currentRow.tags_json) : [];
          } catch {
            previousTagsRaw = [];
          }
          void enqueueWebhookEventForUser(req.session.userId, 'link.updated', {
            short,
            short_url: shortUrl,
            original_url: currentRow.original || '',
            domain: normalizeHostName(currentRow.domain_host || '') || null,
            folder_name: folderName || null,
            tags,
            previous_folder_name: currentRow.folder_name || null,
            previous_tags: normalizeTagsInput(previousTagsRaw),
            updated_at: new Date().toISOString(),
            update_kind: 'metadata',
          });

          return res.json({
            message: pickLang(uiLang, 'Link məlumatları yeniləndi.', 'Link bilgileri güncellendi.', 'Link metadata updated.'),
            folder_name: folderName,
            tags,
          });
        }
      );
    }
  );
});

// KULLANICI LINK EXPORT (GET /api/user/export?format=csv|xlsx)
app.get('/api/user/export', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const format = ((req.query && req.query.format) || 'csv').toString().toLowerCase();
  if (format !== 'csv' && format !== 'xlsx') {
    return res.status(400).json({ error: 'Invalid format.' });
  }

  db.all(
    `SELECT
      u.id,
      u.short,
      u.original,
      u.created_at,
      u.reports,
      u.link_password,
      u.expires_at,
      u.max_clicks,
      u.domain_host,
      u.folder_name,
      u.tags_json,
      COUNT(c.id) AS total_clicks
     FROM urls u
     LEFT JOIN clicks c ON c.url_id = u.id
     WHERE u.user_id = ?
     GROUP BY u.id
     ORDER BY u.created_at DESC`,
    [req.session.userId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Export failed.' });

      const exportRows = (rows || []).map((row) => {
        const tags = parseTagsJson(row.tags_json).join(', ');
        return {
          short_code: row.short || '',
          short_url: buildShortUrl(req, row.short || '', row.domain_host || ''),
          original_url: row.original || '',
          folder: row.folder_name || '',
          tags,
          reports: Number(row.reports || 0),
          total_clicks: Number(row.total_clicks || 0),
          max_clicks: row.max_clicks == null ? '' : Number(row.max_clicks),
          expires_at: row.expires_at || '',
          has_password: row.link_password ? 'yes' : 'no',
          custom_domain: row.domain_host || '',
          created_at: row.created_at || '',
        };
      });

      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
      const baseFile = `ovlink-links-${stamp}`;

      if (format === 'csv') {
        const columns = [
          'short_code',
          'short_url',
          'original_url',
          'folder',
          'tags',
          'reports',
          'total_clicks',
          'max_clicks',
          'expires_at',
          'has_password',
          'custom_domain',
          'created_at',
        ];

        const lines = [columns.map(escapeCsvCell).join(',')];
        exportRows.forEach((row) => {
          lines.push(columns.map((col) => escapeCsvCell(row[col])).join(','));
        });

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${baseFile}.csv"`);
        return res.send(lines.join('\n'));
      }

      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Links');
      const columns = [
        'short_code',
        'short_url',
        'original_url',
        'folder',
        'tags',
        'reports',
        'total_clicks',
        'max_clicks',
        'expires_at',
        'has_password',
        'custom_domain',
        'created_at',
      ];
      worksheet.columns = columns.map((col) => ({ header: col, key: col, width: 20 }));
      for (const row of exportRows) {
        worksheet.addRow(row);
      }
      return workbook.xlsx.writeBuffer()
        .then((buffer) => {
          res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
          res.setHeader('Content-Disposition', `attachment; filename="${baseFile}.xlsx"`);
          return res.send(Buffer.from(buffer));
        })
        .catch(() => {
          return res.status(500).json({ error: 'Export failed.' });
        });
    }
  );
});

// KULLANICI TOPLU LINK IMPORT (POST /api/user/import)
app.post('/api/user/import',
  shortenLimiter,
  (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const rawRows = (req.body && req.body.rows || '').toString();
  const lines = rawRows.split(/\r?\n/).map(v => v.trim()).filter(Boolean);

  if (!lines.length) {
    return res.status(400).json({
      error: pickLang(uiLang, 'Import üçün ən az bir URL daxil edin.', 'İçe aktarma için en az bir URL girin.', 'Enter at least one URL to import.')
    });
  }

  const candidates = lines.map(extractImportUrlCandidate).filter(Boolean);
  const urls = Array.from(new Set(candidates));

  if (!urls.length) {
    return res.status(400).json({
      error: pickLang(uiLang, 'Etibarlı URL tapılmadı.', 'Geçerli URL bulunamadı.', 'No valid URL found.')
    });
  }

  const MAX_IMPORT_ROWS = 1000;
  if (urls.length > MAX_IMPORT_ROWS) {
    return res.status(400).json({
      error: pickLang(uiLang, `Bir dəfəyə maksimum ${MAX_IMPORT_ROWS} URL idxal edilə bilər.`, `Bir seferde en fazla ${MAX_IMPORT_ROWS} URL içe aktarılabilir.`, `Maximum ${MAX_IMPORT_ROWS} URLs can be imported at once.`)
    });
  }

  let created = 0;
  let blocked = 0;
  let skipped = 0;
  const createdLinks = [];

  const createAndInsert = (originalAbs, done, retry = 0) => {
    if (retry > 7) {
      skipped += 1;
      return done();
    }

    const short = generateSafeShortCode();
    const createdAt = new Date().toISOString();

    db.run(
      'INSERT INTO urls (original, short, created_at, user_id, link_password, expires_at, max_clicks, domain_host) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [originalAbs, short, createdAt, req.session.userId, '', null, null, null],
      function (err) {
        if (!err) {
          created += 1;
          createdLinks.push({
            short,
            shortUrl: buildShortUrl(req, short, ''),
            original: originalAbs,
          });
          return done();
        }
        const msg = (err && err.message || '').toLowerCase();
        if (msg.includes('unique') && msg.includes('urls.short')) {
          return createAndInsert(originalAbs, done, retry + 1);
        }
        skipped += 1;
        return done();
      }
    );
  };

  const processAt = (index) => {
    if (index >= urls.length) {
      return res.json({
        created,
        blocked,
        skipped,
        total: urls.length,
        created_links: createdLinks,
        message: pickLang(
          uiLang,
          `Import tamamlandı. Yaradıldı: ${created}, bloklandı: ${blocked}, keçildi: ${skipped}.`,
          `İçe aktarma tamamlandı. Oluşturulan: ${created}, engellenen: ${blocked}, atlanan: ${skipped}.`,
          `Import completed. Created: ${created}, blocked: ${blocked}, skipped: ${skipped}.`
        )
      });
    }

    const originalAbs = urls[index];
    let hostname = '';
    try { hostname = new URL(originalAbs).hostname.toLowerCase(); } catch { hostname = ''; }

    if (!hostname) {
      skipped += 1;
      return processAt(index + 1);
    }

    db.get(
      "SELECT domain FROM blocked_domains WHERE ? = domain OR ? LIKE '%.' || domain LIMIT 1",
      [hostname, hostname],
      (err, row) => {
        if (err) {
          skipped += 1;
          return processAt(index + 1);
        }
        if (row) {
          blocked += 1;
          return processAt(index + 1);
        }

        createAndInsert(originalAbs, () => processAt(index + 1));
      }
    );
  };

  processAt(0);
});


// Kullanıcı Dashboard (GET /dashboard)
app.get('/dashboard', (req, res) => {
  if (!req.session.userId) return res.redirect('/');

  db.get('SELECT email, banned, ban_until, ban_reason, ui_lang, ui_theme, notify_report, notify_limit, notify_disabled FROM users WHERE id = ?', [req.session.userId], (uErr, uRow) => {
    if (uErr || !uRow) return res.redirect('/');

    // Auto-clear expired temp bans
    if (uRow.banned == 1 && uRow.ban_until) {
      const untilMs = Date.parse(uRow.ban_until);
      if (!Number.isNaN(untilMs) && untilMs <= Date.now()) {
        db.run(
          'UPDATE users SET banned = 0, ban_until = NULL, ban_reason = NULL, ban_set_at = NULL, ban_set_by_admin_id = NULL WHERE id = ?',
          [req.session.userId],
          () => {}
        );
        uRow.banned = 0;
      }
    }

    const banActive = (uRow.banned == 1) && (!uRow.ban_until || (Date.parse(uRow.ban_until) > Date.now()));
    if (banActive) {
      try { req.session.destroy(() => {}); } catch {}
      const banInfo = formatBanInfo(uRow.ban_until, 'az');
      return res.status(403).render('error-banned', {
        csrfToken: res.locals._csrf,
        until: banInfo.untilText || uRow.ban_until || '',
        untilIso: uRow.ban_until || '',
        remaining: banInfo.remainingText || '',
        reason: uRow.ban_reason || ''
      });
    }

    db.all('SELECT short, original, created_at, reports, link_password, disabled, domain_host, folder_name, tags_json FROM urls WHERE user_id = ? ORDER BY created_at DESC', [req.session.userId], (err, rows) => {
    if (err) return res.status(500).send('Veritabanı hatası.');

    // Özet İstatistikler Hesapla
    const totalLinks = rows.length;
    const totalReports = rows.reduce((acc, row) => acc + (row.reports || 0), 0);
    // Toplam tıklama sayısını hesaplamak için ayrı bir sorgu gerekir veya basitlik adına şimdilik pas geçebiliriz 
    // veya join ile alabiliriz. Şimdilik elimizdeki veriyi kullanalım.
    // Dashboard'a girildiğinde "Hoşgeldin X" ve Premium Tasarım

    const announcementHtml = buildAnnouncementHtml();
    const csrfTokenSafe = escapeHtml(res.locals._csrf || '');
    const assetQuery = `?v=${encodeURIComponent(res.locals.assetVersion || ASSET_VERSION)}`;
    let html = `
      <!doctype html>
      <html lang="az">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="csrf-token" content="${escapeHtml(res.locals._csrf || '')}">
          <title data-i18n="dashboard_title">Dashboard - URL Kısaltma</title>
          <link rel="icon" href="/logo.ico" />
          <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet" />
          <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" />
          <link rel="stylesheet" href="/style.css${assetQuery}" />
        </head>
        <body class="home-page app-page">
${announcementHtml}
          <!-- Navbar -->
          <nav class="navbar navbar-expand-lg navbar-light home-navbar shadow-sm">
            <div class="container">
              <a class="navbar-brand fw-bold d-flex align-items-center" href="/">
                <img src="/logo.png" alt="Ovlink" class="home-brand-logo" />
              </a>
              <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#dashboardNavbarContent" aria-controls="dashboardNavbarContent" aria-expanded="false" aria-label="Menu toggle">
                <span class="navbar-toggler-icon"></span>
              </button>
              <div class="collapse navbar-collapse" id="dashboardNavbarContent">
                <ul class="navbar-nav ms-auto align-items-lg-center">
                  <li class="nav-item" id="navAuthGuestLogin">
                    <a class="nav-link" href="/login"><i class="fa-solid fa-right-to-bracket"></i> <span data-i18n="nav_login">Giriş</span></a>
                  </li>
                  <li class="nav-item" id="navAuthGuestReg">
                    <a class="nav-link" href="/register"><i class="fa-solid fa-user-plus"></i> <span data-i18n="nav_register">Qeydiyyat</span></a>
                  </li>
                  <li class="nav-item" id="navPricingItem">
                    <a class="nav-link" href="/pricing"><i class="fa-solid fa-crown"></i> <span data-i18n="nav_pricing">Pro Plan</span></a>
                  </li>
                  <li class="nav-item dropdown nav-user-dropdown d-none" id="navAuthUser">
                    <a class="nav-link dropdown-toggle position-relative" href="#" role="button" data-bs-toggle="dropdown" aria-expanded="false">
                      <i class="fa-solid fa-user-circle me-1"></i>
                      <span id="navUserEmail" data-i18n="nav_my_account">Hesabım</span>
                      <span id="navNotifBadge" class="notif-badge d-none">0</span>
                    </a>
                    <ul class="dropdown-menu dropdown-menu-end">
                      <li><a class="dropdown-item" href="/"><i class="fa-solid fa-house me-2"></i><span data-i18n="nav_home">Ana Səhifə</span></a></li>
                      <li><a class="dropdown-item" href="/account"><i class="fa-solid fa-user-gear me-2"></i><span data-i18n="profile_settings_title">Profil Parametrləri</span></a></li>
                      <li>
                        <a class="dropdown-item d-flex align-items-center justify-content-between" href="/notifications">
                          <span><i class="fa-solid fa-bell me-2"></i><span data-i18n="notif_center_title">Bildiriş Mərkəzi</span></span>
                          <span id="navNotifBadgeMenu" class="notif-menu-badge d-none">0</span>
                        </a>
                      </li>
                      <li><hr class="dropdown-divider" /></li>
                      <li><a id="navLogoutBtn" class="dropdown-item" href="#"><i class="fa-solid fa-right-from-bracket me-2"></i><span data-i18n="nav_logout">Çıxış</span></a></li>
                    </ul>
                  </li>
                </ul>

                <div class="dropdown ms-2 me-2">
                  <button id="langToggleBtn" class="btn btn-sm fw-bold dropdown-toggle lang-pill" type="button" data-bs-toggle="dropdown" aria-expanded="false">AZ</button>
                  <ul class="dropdown-menu dropdown-menu-end">
                    <li><button class="dropdown-item lang-option" data-lang="az" type="button">AZ</button></li>
                    <li><button class="dropdown-item lang-option" data-lang="tr" type="button">TR</button></li>
                    <li><button class="dropdown-item lang-option" data-lang="en" type="button">EN</button></li>
                  </ul>
                </div>

                <button class="theme-toggle home-theme-btn" aria-label="Temayı Değiştir">
                  <i class="fa-solid fa-sun"></i>
                </button>
              </div>
            </div>
          </nav>

          <main class="app-main">
            <section class="container">
              <div class="app-shell" id="dashboardStats">
                <div class="policy-head">
                  <div class="badge hero-chip rounded-pill px-3 py-2 mb-3 shadow-sm fw-semibold">
                    <i class="fa-solid fa-chart-line me-1"></i><span data-i18n="hero_badge">Ovlink - Next-Gen Link Management</span>
                  </div>
                  <h1 class="policy-title" data-i18n="dashboard_title">Dashboard</h1>
                  <p class="hero-subtitle" data-i18n="dashboard_search_placeholder">Qısa / Orijinal Link</p>
                </div>
            <!-- İstatistik Kartları -->
            <div class="row mb-4">
              <div class="col-md-4">
                <div class="card app-card p-3 shadow-sm text-center border-0 border-primary border-start border-4 h-100">
                  <h6 class="text-muted" data-i18n="dashboard_total_links">Ümumi Link</h6>
                  <h2 class="fw-bold text-primary">${totalLinks}</h2>
                </div>
              </div>
              <div class="col-md-4">
                <div class="card app-card p-3 shadow-sm text-center border-0 border-danger border-start border-4 h-100">
                  <h6 class="text-muted" data-i18n="dashboard_total_reports">Ümumi Şikayət</h6>
                  <h2 class="fw-bold text-danger">${totalReports}</h2>
                </div>
              </div>
              <div class="col-md-4">
                 <!-- Buraya Toplam Tıklama gelebilir (şu an query yok, yer tutucu) -->
                 <div class="card app-card p-3 shadow-sm text-center border-0 border-success border-start border-4 h-100">
                  <h6 class="text-muted" data-i18n="dashboard_account_status">Hesab Vəziyyəti</h6>
                  <h2 class="fw-bold text-success" data-i18n="dashboard_active">Aktiv</h2>
                </div>
              </div>
            </div>

            <!-- Link Tablosu -->
            <div class="policy-card app-card shadow-sm border-0">
              <div class="card-header py-3 d-flex justify-content-between align-items-center">
                <h5 class="mb-0 fw-bold"><i class="fa-solid fa-list me-2"></i><span data-i18n="dashboard_my_links">Linklərim</span></h5>
                <div class="d-flex align-items-center gap-2 flex-wrap justify-content-end">
                  <a href="/api/user/export?format=csv" class="btn btn-outline-secondary btn-sm rounded-pill" data-i18n="dashboard_export_csv">CSV export</a>
                  <a href="/api/user/export?format=xlsx" class="btn btn-outline-secondary btn-sm rounded-pill" data-i18n="dashboard_export_xlsx">XLSX export</a>
                  <button id="bulkImportBtn" type="button" class="btn btn-outline-secondary btn-sm rounded-pill" data-i18n="dashboard_import_btn">Toplu import</button>
                  <button id="bulkDeleteBtn" type="button" class="btn btn-outline-danger btn-sm rounded-pill" data-i18n="bulk_delete_btn">Seçilənləri sil</button>
                  <a href="/" class="btn btn-primary btn-sm rounded-pill"><i class="fa-solid fa-plus"></i> <span data-i18n="dashboard_new_add">Yeni Əlavə Et</span></a>
                </div>
              </div>
              <div class="card-body border-bottom">
                <form class="row g-2 align-items-end" id="dashboardFilterForm" onsubmit="return false;">
                  <div class="col-12 col-md-5">
                    <label class="form-label small fw-bold text-muted" for="dashboardSearch" data-i18n="dashboard_search_label">Ara</label>
                    <input id="dashboardSearch" class="form-control form-control-sm" placeholder="Kısa / Orijinal Link" data-i18n="dashboard_search_placeholder" />
                  </div>
                  <div class="col-6 col-md-3">
                    <label class="form-label small fw-bold text-muted" for="dashboardFilter" data-i18n="dashboard_filter_label">Filtre</label>
                    <select id="dashboardFilter" class="form-select form-select-sm">
                      <option value="all" data-i18n="dashboard_filter_all">Hepsi</option>
                      <option value="reported" data-i18n="dashboard_filter_reported">Şikayetli</option>
                      <option value="password" data-i18n="dashboard_filter_password">Şifreli</option>
                      <option value="disabled" data-i18n="dashboard_filter_disabled">Devre dışı</option>
                    </select>
                  </div>
                  <div class="col-6 col-md-4">
                    <label class="form-label small fw-bold text-muted" for="dashboardSort" data-i18n="dashboard_sort_label">Sırala</label>
                    <select id="dashboardSort" class="form-select form-select-sm">
                      <option value="newest" data-i18n="dashboard_sort_newest">Yeni → Eski</option>
                      <option value="oldest" data-i18n="dashboard_sort_oldest">Eski → Yeni</option>
                      <option value="reports" data-i18n="dashboard_sort_reports">Şikayet Sayısı</option>
                    </select>
                  </div>
                </form>
              </div>
              <div class="card-body p-0">
                <div class="table-responsive app-table-wrap">
                  <table class="table table-hover align-middle mb-0 app-table">
                    <thead>
                      <tr>
                        <th class="ps-4"><input type="checkbox" id="bulkSelectAll" class="form-check-input" aria-label="Select all"></th>
                        <th data-i18n="th_short">Kısa Link</th>
                        <th data-i18n="th_original">Orijinal Link</th>
                        <th data-i18n="th_folder">Qovluq</th>
                        <th data-i18n="th_tags">Teqlər</th>
                        <th data-i18n="th_date">Tarih</th>
                        <th class="text-center" data-i18n="th_report">Şikayət</th>
                        <th class="text-end pe-4" data-i18n="th_actions">İşlemler</th>
                      </tr>
                    </thead>
                    <tbody id="dashboardTableBody">`;

    if (rows.length === 0) {
      html += `<tr><td colspan="8" class="text-center py-4 text-muted" data-i18n="empty_list">Hələ heç bir link yaratmamısınız.</td></tr>
                      <tr id="dashboardNoResults" class="d-none"><td colspan="8" class="text-center py-4 text-muted" data-i18n="dashboard_no_results">Nəticə tapılmadı.</td></tr>`;
    } else {
      rows.forEach(row => {
        const shortCode = (row.short || '').toString();
        const originalUrl = (row.original || '').toString();
        const shortUrl = buildShortUrl(req, shortCode, row.domain_host || '');
        const safeShort = escapeHtml(shortCode);
        const safeOriginal = escapeHtml(originalUrl);
        const safeShortUrl = escapeHtml(shortUrl);
        const safeCreatedAt = escapeHtml((row.created_at || '').toString());
        const safeCreatedDate = escapeHtml(row.created_at ? new Date(row.created_at).toLocaleDateString() : '');
        const safeStatsPath = '/stats-page/' + encodeURIComponent(shortCode);
        const safeOriginalEncoded = encodeURIComponent(originalUrl);
        const reportsCount = Number(row.reports || 0);
        const folderName = normalizeFolderName(row.folder_name || '');
        const tags = parseTagsJson(row.tags_json || '');
        const tagsJoined = tags.join(', ');
        const safeFolder = escapeHtml(folderName);
        const safeFolderSearch = escapeHtml(folderName.toLocaleLowerCase('en-US'));
        const safeTagsSearch = escapeHtml(tagsJoined.toLocaleLowerCase('en-US'));
        const safeTagsAttr = escapeHtml(JSON.stringify(tags));
        const folderHtml = safeFolder ? safeFolder : '<span class="text-muted small">-</span>';
        const tagsHtml = tags.length
          ? tags.map((tag) => `<span class="badge rounded-pill text-bg-light border me-1">${escapeHtml(tag)}</span>`).join('')
          : '<span class="text-muted small">-</span>';
        html += `
                      <tr data-short="${safeShort}" data-original="${safeOriginal}" data-folder="${safeFolderSearch}" data-tags="${safeTagsSearch}" data-folder-raw="${safeFolder}" data-tags-json="${safeTagsAttr}" data-reports="${reportsCount}" data-created="${safeCreatedAt}" data-password="${row.link_password ? 1 : 0}" data-disabled="${row.disabled ? 1 : 0}">
                        <td class="ps-4">
                          <input type="checkbox" class="form-check-input bulk-select" value="${safeShort}" aria-label="Select link">
                        </td>
                        <td class="fw-bold">
                           <a href="${safeShortUrl}" target="_blank" class="text-decoration-none">${safeShort}</a>
                        </td>
                        <td style="max-width: 300px;" class="text-truncate">${safeOriginal}</td>
                        <td class="small">${folderHtml}</td>
                        <td style="max-width: 220px;" class="text-truncate">${tagsHtml}</td>
                        <td class="small text-muted">${safeCreatedDate}</td>
                        <td class="text-center">
                          ${reportsCount > 0 ? '<span class="badge bg-danger">' + reportsCount + '</span>' : '<span class="badge bg-light text-dark">0</span>'}
                        </td>
                        <td class="text-end pe-4">
                          <div class="d-inline-flex align-items-center gap-1 flex-nowrap">
                            <button type="button" class="btn btn-sm btn-light border" data-edit-short="${safeShort}" data-edit-original="${safeOriginalEncoded}" data-i18n="edit_btn" aria-label="Edit"><i class="fa-solid fa-pen"></i></button>
                            <button type="button" class="btn btn-sm btn-light border d-inline-flex align-items-center gap-1" data-meta-short="${safeShort}" data-meta-folder="${safeFolder}" data-meta-tags="${safeTagsAttr}" aria-label="Metadata"><i class="fa-solid fa-tags"></i><span data-i18n="dashboard_meta_btn">Qovluq/Teq</span></button>
                            <button type="button" class="btn btn-sm btn-light border" data-copy-text="${safeShortUrl}" aria-label="Copy"><i class="fa-solid fa-copy"></i></button>
                            <a href="${safeStatsPath}" class="btn btn-sm btn-light border" aria-label="Stats"><i class="fa-solid fa-chart-bar"></i></a>
                            <form method="POST" action="/api/user/delete" class="d-inline-block m-0">
                              <input type="hidden" name="short" value="${safeShort}">
                              <input type="hidden" name="_csrf" value="${csrfTokenSafe}">
                              <button type="submit" class="btn btn-danger btn-sm" data-i18n="delete_btn">Sil</button>
                            </form>
                          </div>
                        </td>
                      </tr>`;
      });
    }

    html += `
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
              </div>
            </section>
          </main>

          <div class="modal fade" id="bulkImportModal" tabindex="-1" aria-hidden="true">
            <div class="modal-dialog modal-lg modal-dialog-centered">
              <div class="modal-content">
                <div class="modal-header">
                  <h5 class="modal-title" data-i18n="dashboard_import_title">Toplu link import</h5>
                  <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                </div>
                <div class="modal-body">
                  <p class="text-muted small mb-2" data-i18n="dashboard_import_help">Hər sətrə bir URL yazın və ya CSV yapışdırın. URL sütunu avtomatik oxunur.</p>
                  <textarea id="bulkImportInput" class="form-control" rows="10" data-i18n="dashboard_import_placeholder" placeholder="https://example.com/page-1
https://example.com/page-2"></textarea>
                  <div id="bulkImportMsg" class="small mt-2"></div>
                  <div id="bulkImportResults" class="mt-3 d-none">
                    <div class="d-flex align-items-center justify-content-between mb-2">
                      <strong data-i18n="dashboard_import_created_links">Yaradılan linklər</strong>
                      <button type="button" id="bulkImportCopyAll" class="btn btn-sm btn-outline-primary" data-i18n="dashboard_import_copy_all">Hamısını kopyala</button>
                    </div>
                    <div id="bulkImportLinks" class="list-group small"></div>
                  </div>
                </div>
                <div class="modal-footer">
                  <button type="button" class="btn btn-secondary" data-bs-dismiss="modal" data-i18n="cancel_btn">Ləğv et</button>
                  <button type="button" id="bulkImportSubmit" class="btn btn-primary" data-i18n="dashboard_import_submit">Import et</button>
                </div>
              </div>
            </div>
          </div>

          <!-- Footer Bölümü -->
          <footer class="site-footer mt-5">
            <div class="container text-center">
              <p class="mb-1" data-i18n="footer_text">&copy; 2026 · Developed & Powered by <span class="fw-bold">Ulvi Ahadov</span></p>
              <a href="/privacy" class="text-muted small text-decoration-none hover-primary" data-i18n="privacy_policy">Məxfilik Siyasəti</a>
              <span class="mx-2 text-muted small">·</span>
              <a href="/terms" class="text-muted small text-decoration-none hover-primary" data-i18n="terms_policy">İstifadə Şərtləri</a>
              <span class="mx-2 text-muted small">·</span>
              <a href="/cookie-policy" class="text-muted small text-decoration-none hover-primary" data-i18n="cookie_policy">Cookie Policy</a>
              <span class="mx-2 text-muted small">·</span>
              <a href="/about" class="text-muted small text-decoration-none hover-primary" data-i18n="about_policy">About</a>
              <span class="mx-2 text-muted small">·</span>
              <a href="/how-it-works" class="text-muted small text-decoration-none hover-primary" data-i18n="how_it_works_link">Necə işləyir?</a>
              <span class="mx-2 text-muted small">·</span>
              <a href="/why-ovlink" class="text-muted small text-decoration-none hover-primary" data-i18n="why_ovlink_link">Niyə Ovlink?</a>
              <span class="mx-2 text-muted small">·</span>
              <a href="/contact" class="text-muted small text-decoration-none hover-primary" data-i18n="contact_policy">Əlaqə</a>
              <span class="mx-2 text-muted small">·</span>
              <a href="/faq" class="text-muted small text-decoration-none hover-primary" data-i18n="faq_link">FAQ</a>
              <span class="mx-2 text-muted small">·</span>
              <a href="/help" class="text-muted small text-decoration-none hover-primary" data-i18n="help_link">Help</a>
              <span class="mx-2 text-muted small">·</span>
              <a href="/docs" class="text-muted small text-decoration-none hover-primary" data-i18n="docs_link">Docs</a>
              <span class="mx-2 text-muted small">·</span>
              <a href="/pricing" class="text-muted small text-decoration-none hover-primary" data-i18n="pricing_link">Pro Pricing</a>
              <span class="mx-2 text-muted small">·</span>
              <a href="/api-guide" class="text-muted small text-decoration-none hover-primary" data-i18n="api_guide_link">API Guide</a>
              <span class="mx-2 text-muted small">·</span>
              <a href="/abuse-safety" class="text-muted small text-decoration-none hover-primary" data-i18n="abuse_safety_link">Abuse & Safety</a>
              <span class="mx-2 text-muted small">·</span>
              <a href="/updates" class="text-muted small text-decoration-none hover-primary" data-i18n="updates_link">Updates</a>
            </div>
          </footer>
          <div id="floatingPricingBanner" class="floating-pricing-banner d-none">
            <button type="button" class="floating-pricing-banner-close" data-floating-pricing-close aria-label="Close pricing banner">&times;</button>
            <a class="floating-pricing-banner-link" href="/pricing" aria-label="Open Ovlink Pro pricing">
              <img class="floating-pricing-banner-image" src="/logo.webp" alt="Ovlink Pro" loading="lazy" decoding="async" />
              <div class="floating-pricing-banner-body">
                <span class="floating-pricing-banner-badge" data-i18n="floating_pricing_badge">PRO</span>
                <strong class="floating-pricing-banner-title" data-i18n="floating_pricing_title">Unlock Premium features</strong>
                <small class="floating-pricing-banner-text" data-i18n="floating_pricing_text">$2/mo · API + Webhooks</small>
              </div>
              <span class="floating-pricing-banner-arrow" aria-hidden="true"><i class="fa-solid fa-arrow-up-right-from-square"></i></span>
            </a>
          </div>

          <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
          <script src="/lang.js${assetQuery}"></script>
          <script src="/script.js${assetQuery}"></script>
        </body>
      </html>
    `;
    res.send(html);
  });
  });
});

// Diğer tüm isteklerde index.ejs render edilir (fallback)
app.get('*', (req, res) => {
  const seo = buildSeo(req, {
    path: req.path || '/',
    titleAz: 'Səhifə tapılmadı - Ovlink',
    titleTr: 'Sayfa bulunamadı - Ovlink',
    titleEn: 'Page not found - Ovlink',
    descAz: 'Axtardığınız səhifə mövcud deyil və ya daşınıb.',
    descTr: 'Aradığınız sayfa mevcut değil veya taşınmış.',
    descEn: 'The page you are looking for does not exist or was moved.'
  });
  seo.jsonLd = '';
  res.set('X-Robots-Tag', 'noindex,nofollow');
  res.status(404).render('404', { csrfToken: res.locals._csrf, seo });
});

// API hata yakalayıcı (özellikle CSRF ve JSON bekleyen istekler için)
app.use((err, req, res, next) => {
  if (!err) return next();
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
    let target = '/';

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

  if (wantsJson) {
    return res.status(status).json({ error: message });
  }
  return res.status(status).send(message);
});

if (require.main === module) {
  (async () => {
    await ensureRedisConnected();
    app.listen(PORT, () => {});
  })().catch((err) => {
    console.error('[startup] fatal error before listen', err && (err.message || err));
    process.exit(1);
  });
}

module.exports = {
  app,
  helpers: {
    ensureAbsoluteUrl,
    normalizeShortCode,
    isReservedShortAlias,
    normalizeCustomDomainInput,
    getRequestIp,
    maskIpForDisplay,
    buildNetworkFingerprintForDisplay,
    getPublicBaseUrl,
    buildAbsoluteUrl,
    normalizeConsentMode,
    normalizeConsentNext,
    normalizeFutureExpiryInput,
    isIsoTimeExpired,
    buildRedirectConsentSignature,
    isRedirectConsentSignatureValid,
    hasApiKeyAuthHeader,
    hashApiKeyValueLegacy,
    hashApiKeyValue,
    hashWebhookSecretValueV2,
    buildWebhookSignatureV2Key,
    isBlockedWebhookIp,
    isBlockedWebhookHostname,
    validateOutboundWebhookUrl,
  },
};



