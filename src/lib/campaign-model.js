'use strict';

const crypto = require('crypto');
const { withTransaction } = require('../db/helpers');

const CAMPAIGN_STATUSES = Object.freeze(['draft', 'active', 'paused', 'completed', 'archived']);
const VALID_BUDGET_CURRENCIES = Object.freeze(['AZN', 'USD', 'EUR', 'TRY', 'GBP']);
const MAX_BUDGET_AMOUNT = 1000000000;

const ALLOWED_STATUS_TRANSITIONS = Object.freeze({
  draft: Object.freeze(['active', 'archived']),
  active: Object.freeze(['paused', 'completed', 'archived']),
  paused: Object.freeze(['active', 'completed', 'archived']),
  completed: Object.freeze(['active', 'archived']),
  archived: Object.freeze(['active', 'paused', 'draft']),
});

function generateCampaignEventId() {
  return `cmp_${crypto.randomBytes(6).toString('hex')}`;
}

function normalizeCampaignStatus(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const value = String(raw).trim().toLowerCase();
  return CAMPAIGN_STATUSES.includes(value) ? value : null;
}

function resolveEffectiveStatus(row) {
  if (!row) return 'active';
  if (row.archived_at) return 'archived';
  const normalized = normalizeCampaignStatus(row.status);
  return normalized || 'active';
}

function evaluateStatusTransition(currentStatus, nextStatus) {
  const from = normalizeCampaignStatus(currentStatus) || 'active';
  const to = normalizeCampaignStatus(nextStatus);
  if (!to) {
    return {
      allowed: false,
      changed: false,
      code: 'invalid_status',
      from,
      to: String(nextStatus || ''),
      allowed_next: ALLOWED_STATUS_TRANSITIONS[from] || [],
    };
  }
  // Idempotent: re-applying the current status is always a safe no-op.
  if (from === to) {
    return {
      allowed: true,
      changed: false,
      from,
      status: to,
    };
  }
  const allowedNext = ALLOWED_STATUS_TRANSITIONS[from] || [];
  if (!allowedNext.includes(to)) {
    return {
      allowed: false,
      changed: false,
      code: 'invalid_status_transition',
      from,
      to,
      allowed_next: allowedNext,
    };
  }
  return {
    allowed: true,
    changed: true,
    from,
    status: to,
  };
}

function normalizeUtcTimestamp(raw) {
  if (raw === null || raw === undefined || raw === '') return { value: null };
  const text = String(raw).trim();
  if (!text) return { value: null };
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return { error: 'invalid_datetime' };
  return { value: new Date(ms).toISOString() };
}

function validateUtcInterval(rawStartsAt, rawEndsAt) {
  const starts = normalizeUtcTimestamp(rawStartsAt);
  if (starts.error) return { error: 'invalid_datetime' };
  const ends = normalizeUtcTimestamp(rawEndsAt);
  if (ends.error) return { error: 'invalid_datetime' };
  if (starts.value && ends.value && Date.parse(ends.value) < Date.parse(starts.value)) {
    return { error: 'invalid_interval' };
  }
  return { starts_at: starts.value, ends_at: ends.value };
}

/**
 * Budget must always be a real user-supplied non-negative number (never derived
 * or estimated). Passing null/empty clears the budget.
 */
function normalizeBudget(rawAmount, rawCurrency) {
  const emptyAmount = rawAmount === null || rawAmount === undefined || rawAmount === '';
  if (emptyAmount) {
    return { budget_amount: null, budget_currency: null };
  }
  const numeric = typeof rawAmount === 'number' ? rawAmount : Number(String(rawAmount).trim());
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > MAX_BUDGET_AMOUNT) {
    return { error: 'invalid_budget' };
  }
  const rounded = Math.round(numeric * 100) / 100;
  const currencyRaw = rawCurrency === null || rawCurrency === undefined || rawCurrency === ''
    ? 'AZN'
    : String(rawCurrency).trim().toUpperCase();
  if (!VALID_BUDGET_CURRENCIES.includes(currencyRaw)) {
    return { error: 'invalid_currency' };
  }
  return { budget_amount: rounded, budget_currency: currencyRaw };
}

let schemaReadyPromise = null;

async function ensureCampaignModelColumns(dbRunAsync, dbGetAsync = null) {
  if (schemaReadyPromise) return schemaReadyPromise;
  schemaReadyPromise = (async () => {
    if (typeof dbGetAsync === 'function') {
      try {
        const existing = await dbGetAsync(
          "SELECT column_name FROM information_schema.columns WHERE table_name = 'campaigns' AND column_name = 'event_id'",
          []
        );
        if (existing && existing.column_name === 'event_id') return;
      } catch {
        // Proceed with idempotent DDL below
      }
    }

    const statements = [
      "ALTER TABLE campaigns ADD COLUMN status TEXT DEFAULT 'active'",
      'ALTER TABLE campaigns ADD COLUMN starts_at TEXT',
      'ALTER TABLE campaigns ADD COLUMN ends_at TEXT',
      'ALTER TABLE campaigns ADD COLUMN budget_amount REAL',
      'ALTER TABLE campaigns ADD COLUMN budget_currency TEXT',
      'ALTER TABLE campaigns ADD COLUMN event_id TEXT',
      'CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status)',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_campaigns_event_id ON campaigns(event_id) WHERE event_id IS NOT NULL',
      "UPDATE campaigns SET status = CASE WHEN archived_at IS NOT NULL THEN 'archived' ELSE 'active' END WHERE status IS NULL",
    ];

    try {
      await withTransaction(async (tx) => {
        await tx.run('SELECT pg_advisory_xact_lock(15152026)', []);
        for (const sql of statements) {
          await tx.run(sql, []);
        }
      });
    } catch {
      // Fallback for non-transactional or non-PG test mocks
      for (const sql of statements) {
        try {
          await dbRunAsync(sql, []);
        } catch {}
      }
    }
  })().catch(() => {
    schemaReadyPromise = null;
  });
  return schemaReadyPromise;
}

async function recordCampaignAudit(dbRunAsync, { userId, action, campaignId, metadata = {} }) {
  try {
    await dbRunAsync(
      'INSERT INTO analytics_audit_log (created_at, user_id, url_id, short, action, metadata_json) VALUES (?, ?, NULL, NULL, ?, ?)',
      [
        new Date().toISOString(),
        Number(userId) || null,
        String(action || 'campaign.updated').slice(0, 64),
        JSON.stringify({
          campaign_id: Number(campaignId) || null,
          ...metadata,
        }),
      ]
    );
  } catch {
    // Non-blocking for non-export mutations so legacy minimal test schemas stay safe.
  }
}

module.exports = {
  CAMPAIGN_STATUSES,
  VALID_BUDGET_CURRENCIES,
  ALLOWED_STATUS_TRANSITIONS,
  MAX_BUDGET_AMOUNT,
  generateCampaignEventId,
  normalizeCampaignStatus,
  resolveEffectiveStatus,
  evaluateStatusTransition,
  normalizeUtcTimestamp,
  validateUtcInterval,
  normalizeBudget,
  ensureCampaignModelColumns,
  recordCampaignAudit,
};
