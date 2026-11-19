'use strict';
/**
 * P11 Centralized Business Audit Helper.
 * Keeps operational audit strictly separate from analytics_audit_log,
 * scrubs secrets/tokens/PII, prevents oversized snapshots, and supports
 * fail-closed transactional recording for critical actions and exports.
 */
const crypto = require('node:crypto');

const CRITICAL_AUDIT_ACTIONS = Object.freeze([
  'organization.created',
  'organization.display_name.changed',
  'organization.invitation.created',
  'organization.invitation.reissued',
  'organization.invitation.revoked',
  'organization.invitation.accepted',
  'organization.member.role_changed',
  'organization.member.removed',
  'organization.owner.transferred',
  'organization.client.created',
  'organization.client.updated',
  'organization.client.archive',
  'organization.client.restore',
  'organization.client.campaign_created',
  'organization.client.link_attached',
  'organization.client.link_detached',
  'organization.client.report_exported',
  'organization.webhook.created',
  'organization.webhook.deleted',
  'organization.billing.updated',
  'organization.audit.exported',
]);

const RETENTION_DAYS = 365;
const MAX_SUMMARY_KEYS = 20;
const MAX_STRING_LEN = 200;
const SENSITIVE_KEY_RE = /(pass(word)?|secret|token|cookie|auth(orization)?|api[_-]?key|email|hash|bearer|session|private[_-]?key|credential|signature)/i;
const VALID_RESULTS = new Set(['success', 'denied', 'failed']);

function sanitizeValue(val, depth = 0) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'boolean' || typeof val === 'number') {
    return Number.isFinite(val) || typeof val === 'boolean' ? val : null;
  }
  if (typeof val === 'string') {
    return val.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, MAX_STRING_LEN);
  }
  if (depth >= 2) return '[truncated]';
  if (Array.isArray(val)) {
    return val.slice(0, 10).map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof val === 'object') {
    const out = {};
    let count = 0;
    for (const [k, v] of Object.entries(val)) {
      if (count >= MAX_SUMMARY_KEYS) break;
      const key = String(k).slice(0, 64);
      if (SENSITIVE_KEY_RE.test(key)) continue;
      out[key] = sanitizeValue(v, depth + 1);
      count += 1;
    }
    return out;
  }
  return null;
}

function sanitizeAuditSummary(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return {};
  return sanitizeValue(summary, 0) || {};
}

function extractRequestId(req) {
  const raw = (req && (req.id || req.headers?.['x-request-id'])) || '';
  const clean = String(raw).trim().replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 64);
  return clean || crypto.randomUUID();
}

async function recordBusinessAudit(tx, {
  organizationId,
  actorUserId = null,
  action,
  resourceType = null,
  resourceId = null,
  workspaceId = null,
  requestId = null,
  result = 'success',
  summary = {},
}) {
  if (!tx || typeof tx.run !== 'function') throw new Error('Audit requires DB transaction');
  const cleanAction = String(action || '').trim().slice(0, 100);
  if (!cleanAction) throw new Error('Audit action is required');
  const cleanResult = VALID_RESULTS.has(result) ? result : 'success';
  const cleanSummary = sanitizeAuditSummary(summary);
  const cleanResType = resourceType ? String(resourceType).trim().slice(0, 64) : null;
  const cleanResId = resourceId !== null && resourceId !== undefined ? String(resourceId).trim().slice(0, 128) : null;
  const cleanWs = Number.isSafeInteger(Number(workspaceId)) && Number(workspaceId) > 0 ? Number(workspaceId) : null;
  const cleanReqId = requestId ? String(requestId).trim().slice(0, 64) : crypto.randomUUID();
  const eventKey = `${cleanAction}.${crypto.randomUUID()}`;
  const metaJson = JSON.stringify({ kind: cleanAction, ...cleanSummary });
  const sumJson = JSON.stringify(cleanSummary);

  const hasP11Cols = await tx.get(
    `SELECT 1 AS ok FROM information_schema.columns
      WHERE table_schema='public' AND table_name='organization_audit_log' AND column_name='action' LIMIT 1`
  );
  if (hasP11Cols) {
    await tx.run(
      `INSERT INTO organization_audit_log
         (organization_id, event_key, actor_user_id, action, resource_type, resource_id, workspace_id, request_id, result, summary_json, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb)`,
      [organizationId, eventKey, actorUserId, cleanAction, cleanResType, cleanResId, cleanWs, cleanReqId, cleanResult, sumJson, metaJson]
    );
  } else {
    await tx.run(
      'INSERT INTO organization_audit_log(organization_id, event_key, actor_user_id, metadata_json) VALUES (?, ?, ?, ?::jsonb)',
      [organizationId, eventKey, actorUserId, metaJson]
    );
  }
  return { event_key: eventKey, action: cleanAction, request_id: cleanReqId, result: cleanResult };
}

async function queryBusinessAudit(tx, organizationId, filters = {}) {
  const where = ['organization_id = ?'];
  const params = [organizationId];

  if (filters.action && typeof filters.action === 'string' && filters.action.trim()) {
    where.push("COALESCE(action, metadata_json->>'kind', event_key) = ?");
    params.push(filters.action.trim().slice(0, 100));
  }
  if (filters.resource_type && typeof filters.resource_type === 'string' && filters.resource_type.trim()) {
    where.push('resource_type = ?');
    params.push(filters.resource_type.trim().slice(0, 64));
  }
  if (filters.result && VALID_RESULTS.has(String(filters.result))) {
    where.push('result = ?');
    params.push(String(filters.result));
  }
  if (filters.actor_user_id !== undefined && filters.actor_user_id !== '' && filters.actor_user_id !== null) {
    const actor = Number(filters.actor_user_id);
    if (Number.isSafeInteger(actor) && actor > 0) {
      where.push('actor_user_id = ?');
      params.push(actor);
    }
  }
  if (filters.from && /^\d{4}-\d{2}-\d{2}/.test(String(filters.from))) {
    where.push('created_at >= ?::timestamptz');
    params.push(String(filters.from).slice(0, 32));
  }
  if (filters.to && /^\d{4}-\d{2}-\d{2}/.test(String(filters.to))) {
    where.push('created_at <= ?::timestamptz');
    params.push(String(filters.to).slice(0, 32));
  }
  if (filters.before_id !== undefined && filters.before_id !== '' && filters.before_id !== null) {
    const bid = Number(filters.before_id);
    if (Number.isSafeInteger(bid) && bid > 0) {
      where.push('id < ?');
      params.push(bid);
    }
  }

  const requestedLimit = Number.parseInt(filters.limit, 10);
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(200, requestedLimit) : 50;
  params.push(limit + 1);

  const rows = await tx.all(
    `SELECT id, organization_id, actor_user_id,
            COALESCE(action, metadata_json->>'kind', event_key) AS action,
            resource_type, resource_id, workspace_id, request_id,
            COALESCE(result, 'success') AS result,
            CASE WHEN summary_json IS NOT NULL AND summary_json <> '{}'::jsonb THEN summary_json ELSE metadata_json END AS summary,
            created_at
       FROM organization_audit_log
      WHERE ${where.join(' AND ')}
      ORDER BY id DESC
      LIMIT ?`,
    params
  );

  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  return {
    events: slice.map((r) => ({
      id: Number(r.id),
      actor_user_id: r.actor_user_id === null ? null : Number(r.actor_user_id),
      action: r.action,
      resource_type: r.resource_type || null,
      resource_id: r.resource_id || null,
      workspace_id: r.workspace_id === null ? null : Number(r.workspace_id),
      request_id: r.request_id || null,
      result: r.result || 'success',
      summary: sanitizeAuditSummary(r.summary),
      created_at: r.created_at,
    })),
    next_before_id: hasMore && slice.length ? Number(slice[slice.length - 1].id) : null,
    retention_days: RETENTION_DAYS,
  };
}

module.exports = {
  CRITICAL_AUDIT_ACTIONS,
  RETENTION_DAYS,
  sanitizeAuditSummary,
  extractRequestId,
  recordBusinessAudit,
  queryBusinessAudit,
};
