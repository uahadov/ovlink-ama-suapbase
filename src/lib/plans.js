const { dbGetAsync, dbRunAsync } = require('../db/helpers');
const { db } = require('../db/index');

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
  workspaces: true,
});

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
  if (!userRow.pro_expires_at) return true;
  const expiresMs = parseIsoTimeMs(userRow.pro_expires_at);
  if (!Number.isFinite(expiresMs)) return false;
  return expiresMs > nowMs;
}

function isProExpired(userRow, nowMs = Date.now()) {
  if (!userRow) return false;
  if (normalizePlanTier(userRow.plan_tier) !== PLAN_TIERS.PRO) return false;
  if (!userRow.pro_expires_at) return false;
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
    polar_linked: !!(userRow && userRow.polar_customer_id),
    features: active ? { ...PRO_FEATURES } : { api: false, webhooks: false, ip_security: false, workspaces: false },
  };
}

async function loadUserPlanRow(userId) {
  if (!Number.isInteger(userId) || userId <= 0) return null;
  return dbGetAsync(
    'SELECT id, plan_tier, plan_status, pro_expires_at, pro_paused_at, polar_customer_id FROM users WHERE id = ?',
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

module.exports = {
  PLAN_TIERS,
  PLAN_STATUS,
  PRO_FEATURES,
  getEffectivePlanForUser,
  isProAccessActive,
  isProExpired,
  buildPlanPayload,
  downgradeExpiredProIfNeeded,
  normalizeFutureExpiryInput,
  isIsoTimeExpired,
  parseIsoTimeMs
};
