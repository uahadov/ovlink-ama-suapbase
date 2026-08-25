const session = require('express-session');
const { RedisStore: SessionRedisStore } = require('connect-redis');
const { RedisStore: RateLimitRedisStore } = require('rate-limit-redis');
const { createClient } = require('redis');
const { isEnabledEnv, isProdRuntime } = require('./index');
const { pool } = require('../db/pool');
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
  // Initiate connection immediately so rate limiters can queue commands
  redisClient.connect().catch((err) => {
    console.error('[redis] immediate connection failed', err && (err.message || err));
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
  : (process.env.NODE_ENV === 'test' && (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('127.0.0.1'))
    ? new session.MemoryStore()
    : new pgSession({
      pool: pool,
      tableName: 'express_sessions',
      createTableIfMissing: true,
    }));

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

module.exports = {
  redisClient,
  sessionStore,
  createRateLimitStore,
  ensureRedisConnected,
  requireRedisInProd
};
