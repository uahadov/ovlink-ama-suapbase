const { getRequestIp } = require('../lib/geo');
const { logSecurityEvent } = require('../lib/security');
const { redisClient } = require('../config/redis');

// ============================================================
// DDoS KORUMA: IP Blacklist (bellek içi L1 + Redis L2)
// Kötü niyetli IP'leri geçici veya kalıcı olarak engeller
// ============================================================
const ipBlacklist = new Map(); // ip -> { blockedAt, expiresAt|null, reason }
const REDIS_BLOCK_PREFIX = 'ovlink:blocked_ip:';

function isIpBlacklisted(ip) {
  if (!ip) return false;
  const entry = ipBlacklist.get(ip);
  if (!entry) return false;
  if (entry.expiresAt && Date.now() > entry.expiresAt) {
    ipBlacklist.delete(ip);
    return false;
  }
  return true;
}

function blockIp(ip, durationMs, reason) {
  if (!ip) return;
  const entry = {
    blockedAt: Date.now(),
    expiresAt: durationMs ? Date.now() + durationMs : null,
    reason: reason || 'abuse',
  };
  ipBlacklist.set(ip, entry);

  if (redisClient && redisClient.isOpen) {
    const key = `${REDIS_BLOCK_PREFIX}${ip}`;
    const payload = JSON.stringify(entry);
    if (durationMs) {
      const ttlSec = Math.max(1, Math.ceil(durationMs / 1000));
      redisClient.set(key, payload, { EX: ttlSec }).catch(() => {});
    } else {
      redisClient.set(key, payload).catch(() => {});
    }
  }
}

function unblockIp(ip) {
  if (!ip) return;
  ipBlacklist.delete(ip);
  if (redisClient && redisClient.isOpen) {
    redisClient.del(`${REDIS_BLOCK_PREFIX}${ip}`).catch(() => {});
  }
}

async function ipBlacklistMiddleware(req, res, next) {
  const ip = getRequestIp(req);
  if (!ip) return next();

  if (isIpBlacklisted(ip)) {
    const entry = ipBlacklist.get(ip);
    logSecurityEvent(req, 'ddos.ip_blocked', 'blocked', { ip, reason: entry?.reason });
    return res.status(403).json({ error: 'Erişiminiz engellenmiştir.' });
  }

  // If not in local L1 cache and Redis is available, check Redis
  if (redisClient && redisClient.isOpen) {
    try {
      const redisEntryStr = await redisClient.get(`${REDIS_BLOCK_PREFIX}${ip}`);
      if (redisEntryStr) {
        const parsed = JSON.parse(redisEntryStr);
        ipBlacklist.set(ip, parsed);
        logSecurityEvent(req, 'ddos.ip_blocked', 'blocked', { ip, reason: parsed?.reason });
        return res.status(403).json({ error: 'Erişiminiz engellenmiştir.' });
      }
    } catch {}
  }

  next();
}

// ============================================================
// DDoS KORUMA: Slow-down (progressive delay)
// Yüksek trafikli IP'lere giderek artan gecikme uygular
// ============================================================
const ipRequestCounts = new Map(); // ip -> { count, windowStart }
const SLOWDOWN_WINDOW_MS = 60 * 1000; // 1 dakikalık pencere
const SLOWDOWN_THRESHHOLD = 50; // 50 istek sonrası yavaşlatmaya başla
const SLOWDOWN_MAX_DELAY_MS = 5000; // Maksimum 5 saniye gecikme

// Periyodik temizlik (her 5 dakikada eski kayıtları sil)
const ipRequestCountsCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of ipRequestCounts) {
    if (now - data.windowStart > SLOWDOWN_WINDOW_MS * 2) {
      ipRequestCounts.delete(ip);
    }
  }
}, 5 * 60 * 1000);
if (typeof ipRequestCountsCleanupTimer.unref === 'function') ipRequestCountsCleanupTimer.unref();

function slowdownMiddleware(req, res, next) {
  const ip = getRequestIp(req);
  if (!ip) return next();

  const now = Date.now();
  let data = ipRequestCounts.get(ip);

  if (!data || now - data.windowStart > SLOWDOWN_WINDOW_MS) {
    data = { count: 1, windowStart: now };
    ipRequestCounts.set(ip, data);
    return next();
  }

  data.count++;

  if (data.count > SLOWDOWN_THRESHHOLD) {
    const excess = data.count - SLOWDOWN_THRESHHOLD;
    const delay = Math.min(excess * 100, SLOWDOWN_MAX_DELAY_MS);
    res.set('X-Slowdown-Delay', String(delay));
    return setTimeout(() => next(), delay);
  }

  next();
}

function getBlockedIps() {
  const now = Date.now();
  const result = [];
  for (const [ip, entry] of ipBlacklist) {
    if (entry.expiresAt && now > entry.expiresAt) {
      ipBlacklist.delete(ip);
      continue;
    }
    result.push({ ip, ...entry });
  }
  return result;
}

module.exports = {
  ipBlacklist,
  isIpBlacklisted,
  blockIp,
  unblockIp,
  getBlockedIps,
  ipBlacklistMiddleware,
  ipRequestCounts,
  slowdownMiddleware,
};
