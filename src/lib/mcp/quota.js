'use strict';

const { dbGetAsync, dbRunAsync } = require('../../db/helpers');
const { redisClient } = require('../../config/redis');

const MCP_MONTHLY_TOOL_QUOTA = 20000;

function getCurrentYearMonth() {
  const d = new Date();
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Checks and increments the monthly tool call quota for a given Pro user.
 * Returns { allowed: boolean, current: number, limit: number, remaining: number }
 */
async function checkAndIncrementMcpQuota(userId, quotaLimit = MCP_MONTHLY_TOOL_QUOTA) {
  const uid = Number.parseInt(userId, 10);
  if (!Number.isInteger(uid) || uid <= 0) {
    return { allowed: false, current: 0, limit: quotaLimit, remaining: 0 };
  }

  const yearMonth = getCurrentYearMonth();
  const nowIso = new Date().toISOString();

  // 1. Try Redis first if connected
  if (redisClient && redisClient.isOpen) {
    try {
      const redisKey = `ovlink:mcp:quota:${uid}:${yearMonth}`;
      const current = await redisClient.incr(redisKey);
      if (current === 1) {
        // Expire in 35 days
        await redisClient.expire(redisKey, 35 * 86400);
      }

      // Sync asynchronously to DB
      dbRunAsync(
        'INSERT INTO mcp_usage_monthly (user_id, year_month, call_count, updated_at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(user_id, year_month) DO UPDATE SET call_count = ?, updated_at = ?',
        [uid, yearMonth, current, nowIso, current, nowIso]
      ).catch(() => {});

      const allowed = current <= quotaLimit;
      const remaining = Math.max(0, quotaLimit - current);
      return { allowed, current, limit: quotaLimit, remaining };
    } catch (redisErr) {
      console.warn('[mcp-quota] Redis quota increment error, falling back to database:', redisErr.message);
    }
  }

  // 2. Database fallback
  try {
    const existing = await dbGetAsync(
      'SELECT call_count FROM mcp_usage_monthly WHERE user_id = ? AND year_month = ?',
      [uid, yearMonth]
    );

    const currentCount = existing ? Number(existing.call_count || 0) : 0;
    if (currentCount >= quotaLimit) {
      return { allowed: false, current: currentCount, limit: quotaLimit, remaining: 0 };
    }

    const nextCount = currentCount + 1;
    await dbRunAsync(
      'INSERT INTO mcp_usage_monthly (user_id, year_month, call_count, updated_at) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(user_id, year_month) DO UPDATE SET call_count = call_count + 1, updated_at = ?',
      [uid, yearMonth, nextCount, nowIso, nowIso]
    );

    return {
      allowed: true,
      current: nextCount,
      limit: quotaLimit,
      remaining: Math.max(0, quotaLimit - nextCount),
    };
  } catch (dbErr) {
    console.error('[mcp-quota] database quota check error:', dbErr.message);
    // In case of DB failure, allow through but log
    return { allowed: true, current: 1, limit: quotaLimit, remaining: quotaLimit - 1 };
  }
}

/**
 * Retrieves the current quota consumption status for a user without incrementing.
 */
async function getMcpQuotaStatus(userId, quotaLimit = MCP_MONTHLY_TOOL_QUOTA) {
  const uid = Number.parseInt(userId, 10);
  if (!Number.isInteger(uid) || uid <= 0) {
    return { used: 0, limit: quotaLimit, remaining: quotaLimit, yearMonth: getCurrentYearMonth() };
  }

  const yearMonth = getCurrentYearMonth();

  // Try Redis first
  if (redisClient && redisClient.isOpen) {
    try {
      const redisKey = `ovlink:mcp:quota:${uid}:${yearMonth}`;
      const val = await redisClient.get(redisKey);
      if (val !== null && val !== undefined) {
        const used = Number.parseInt(val, 10) || 0;
        return {
          used,
          limit: quotaLimit,
          remaining: Math.max(0, quotaLimit - used),
          yearMonth,
        };
      }
    } catch {}
  }

  // Database query
  try {
    const row = await dbGetAsync(
      'SELECT call_count FROM mcp_usage_monthly WHERE user_id = ? AND year_month = ?',
      [uid, yearMonth]
    );
    const used = row ? Number(row.call_count || 0) : 0;
    return {
      used,
      limit: quotaLimit,
      remaining: Math.max(0, quotaLimit - used),
      yearMonth,
    };
  } catch {
    return { used: 0, limit: quotaLimit, remaining: quotaLimit, yearMonth };
  }
}

module.exports = {
  MCP_MONTHLY_TOOL_QUOTA,
  MCP_MONTHLY_LIMIT: MCP_MONTHLY_TOOL_QUOTA,
  checkAndIncrementMcpQuota,
  getMcpQuotaStatus,
  getCurrentYearMonth,
};
