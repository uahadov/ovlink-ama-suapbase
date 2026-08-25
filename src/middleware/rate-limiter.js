const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { redisClient, createRateLimitStore } = require('../config/redis');
const { getRequestIp } = require('../lib/geo');

const PRO_API_READ_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const PRO_API_READ_RATE_LIMIT_MAX = 120;
const PRO_API_WRITE_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const PRO_API_WRITE_RATE_LIMIT_MAX = 35;
const PRO_API_KEY_CREATE_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const PRO_API_KEY_CREATE_RATE_LIMIT_MAX = 8;

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

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 250,
  message: { error: 'Çok fazla istek gönderdiniz. Lütfen 1 dakika sonra tekrar deneyin.' },
  ...(redisClient ? { store: createRateLimitStore('general') } : {}),
  keyGenerator: (req) => buildRateLimitKey(req, 'general'),
  standardHeaders: true,
  legacyHeaders: false
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
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

const shortenLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 25,
  message: { error: 'Çok fazla link oluşturdunuz. Lütfen 5 dakika sonra tekrar deneyin.' },
  ...(redisClient ? { store: createRateLimitStore('shorten') } : {}),
  keyGenerator: (req) => buildRateLimitKey(req, 'shorten'),
  standardHeaders: true,
  legacyHeaders: false
});

const reportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { error: 'Çok fazla şikayet gönderdiniz. Lütfen 15 dakika sonra tekrar deneyin.' },
  ...(redisClient ? { store: createRateLimitStore('report') } : {}),
  keyGenerator: (req) => buildRateLimitKey(req, 'report'),
  standardHeaders: true,
  legacyHeaders: false
});

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

const mutationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Çok fazla istek gönderdiniz. Lütfen bir dakika sonra tekrar deneyin.' },
  ...(redisClient ? { store: createRateLimitStore('mutation') } : {}),
  keyGenerator: (req) => buildRateLimitKey(req, 'mutation'),
  standardHeaders: true,
  legacyHeaders: false,
});

const sensitiveActionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Çok fazla deneme. Lütfen 15 dakika sonra tekrar deneyin.' },
  ...(redisClient ? { store: createRateLimitStore('sensitive') } : {}),
  keyGenerator: (req) => buildRateLimitKey(req, 'sensitive'),
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  generalLimiter,
  authLimiter,
  shortenLimiter,
  reportLimiter,
  proReadLimiter,
  proWriteLimiter,
  proKeyCreateLimiter,
  mutationLimiter,
  sensitiveActionLimiter,
  getApiKeyHintFromRequest,
  buildRateLimitKey,
  PRO_API_READ_RATE_LIMIT_WINDOW_MS,
  PRO_API_READ_RATE_LIMIT_MAX,
  PRO_API_WRITE_RATE_LIMIT_WINDOW_MS,
  PRO_API_WRITE_RATE_LIMIT_MAX,
  PRO_API_KEY_CREATE_RATE_LIMIT_WINDOW_MS,
  PRO_API_KEY_CREATE_RATE_LIMIT_MAX
};
