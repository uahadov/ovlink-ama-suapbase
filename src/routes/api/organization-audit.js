'use strict';
/**
 * P11 Organization Business Audit Log API (default-OFF, gated by ENABLE_ORGANIZATION_AUDIT_V1=1).
 * Restricted to Owner & Admin via centralized P08 `audit.read` policy.
 * CSV exports are fail-closed: an audit record MUST commit before CSV bytes are returned.
 */
const express = require('express');
const { withTransaction } = require('../../db/helpers');
const { requireSignedIn } = require('../../middleware/auth');
const { generalLimiter } = require('../../middleware/rate-limiter');
const { organizationAuditEnabled } = require('../../db/organization-model');
const { checkAccess } = require('../../lib/organization-access-context');
const {
  CRITICAL_AUDIT_ACTIONS,
  extractRequestId,
  recordBusinessAudit,
  queryBusinessAudit,
} = require('../../lib/organization-audit');

const router = express.Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function guard(req, res, next) {
  if (!organizationAuditEnabled()) return res.status(404).json({ error: 'Not found' });
  return next();
}

function uid(req) {
  const n = Number(req.session?.userId);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function csvCell(v) {
  const raw = String(v ?? '');
  const safe = /^[\s\uFEFF\u200B]*[=+@-]/.test(raw) ? "'" + raw : raw;
  return '"' + safe.replace(/"/g, '""') + '"';
}

router.get('/api/organizations/:id/audit-log', guard, generalLimiter, requireSignedIn, async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
  try {
    const payload = await withTransaction(async (tx) => {
      const allowed = await checkAccess({ tx, organizationId: req.params.id, userId: uid(req), mutation: true }, 'audit.read');
      if (!allowed) return null;
      const org = await tx.get("SELECT id, display_name FROM organizations WHERE id=? AND state='active' FOR SHARE", [req.params.id]);
      if (!org) return null;
      const data = await queryBusinessAudit(tx, req.params.id, req.query || {});
      return { organization: { id: org.id, display_name: org.display_name }, actions_catalog: CRITICAL_AUDIT_ACTIONS, ...data };
    });
    if (!payload) return res.status(404).json({ error: 'Not found' });
    res.set('Cache-Control', 'no-store');
    return res.json(payload);
  } catch (_e) {
    return res.status(500).json({ error: 'Audit log unavailable' });
  }
});

router.get('/api/organizations/:id/audit-log.csv', guard, generalLimiter, requireSignedIn, async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
  try {
    const reqId = extractRequestId(req);
    const outcome = await withTransaction(async (tx) => {
      const actor = uid(req);
      const allowed = await checkAccess({ tx, organizationId: req.params.id, userId: actor, mutation: true }, 'audit.read');
      if (!allowed) return null;
      const org = await tx.get("SELECT id, display_name FROM organizations WHERE id=? AND state='active' FOR SHARE", [req.params.id]);
      if (!org) return null;
      const data = await queryBusinessAudit(tx, req.params.id, { ...(req.query || {}), limit: 200 });
      // Fail-closed: audit export receipt MUST persist in the same transaction before CSV is delivered.
      await recordBusinessAudit(tx, {
        organizationId: req.params.id,
        actorUserId: actor,
        action: 'organization.audit.exported',
        resourceType: 'audit_log',
        resourceId: req.params.id,
        requestId: reqId,
        result: 'success',
        summary: { exported_rows: data.events.length, filter_action: req.query?.action || null },
      });
      return { org, events: data.events };
    });
    if (!outcome) return res.status(404).json({ error: 'Not found' });

    const lines = [
      ['ID', 'Timestamp (UTC)', 'Actor User ID', 'Action', 'Resource Type', 'Resource ID', 'Result', 'Request ID', 'Summary'],
      ...outcome.events.map((e) => [
        e.id,
        e.created_at instanceof Date ? e.created_at.toISOString() : String(e.created_at || ''),
        e.actor_user_id ?? '',
        e.action,
        e.resource_type || '',
        e.resource_id || '',
        e.result,
        e.request_id || '',
        JSON.stringify(e.summary || {}),
      ]),
    ];
    res.set('Cache-Control', 'private, no-store, max-age=0');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="ovlink-organization-audit.csv"');
    return res.send('\uFEFF' + lines.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n');
  } catch (_e) {
    return res.status(503).json({ error: 'Audit export unavailable' });
  }
});

module.exports = router;
