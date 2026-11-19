'use strict';
const express = require('express');
const crypto = require('node:crypto');
const { randomUUID } = crypto;
const { withTransaction, dbAllAsync } = require('../../db/helpers');
const { requireSignedIn, requireProAccess } = require('../../middleware/auth');
const { generalLimiter, mutationLimiter } = require('../../middleware/rate-limiter');
const { organizationFeatureEnabled, organizationRbacV2Enabled } = require('../../db/organization-model');
const { can } = require('../../lib/organization-permissions');
const { checkAccess } = require('../../lib/organization-access-context');
const { hashWebhookSecretValueV2, buildWebhookSignatureV2Key } = require('../../lib/security');
const { normalizeWebhookEvents, normalizeWebhookMessageLocale } = require('../../lib/webhook');
const { validateOutboundWebhookUrl } = require('../../lib/url-validator');
const router = express.Router();

const ORG_WEBHOOK_MAX = 10;
function rbacV2Guard(req, res, next) {
  if (!organizationRbacV2Enabled()) return res.status(404).json({ error: 'Not found' });
  return next();
}

function guard(req, res, next) {
  if (!organizationFeatureEnabled()) return res.status(404).json({ error: 'Not found' });
  return next();
}
function userId(req) {
  const id = Number(req.session && req.session.userId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validName = name => typeof name === 'string' && name.trim().length >= 3 && name.trim().length <= 100 && !/[\u0000-\u001f\u007f]/.test(name);

router.get('/api/organizations', guard, generalLimiter, requireSignedIn, async (req, res) => {
  try {
    const rows = await dbAllAsync(
      `SELECT o.id,o.display_name,o.state,o.legacy_workspace_id,
              CASE WHEN o.legacy_workspace_id IS NOT NULL THEN wm.role ELSE om.role END AS role,
              o.created_at,ob.billing_mode,
              (SELECT count(*)::integer FROM organization_workspaces ow
                WHERE ow.organization_id=o.id) AS workspace_count
         FROM organizations o
         LEFT JOIN organization_members om ON om.organization_id=o.id AND om.user_id=?
         LEFT JOIN workspace_members wm ON wm.workspace_id=o.legacy_workspace_id AND wm.user_id=?
         JOIN organization_billing ob ON ob.organization_id=o.id
        WHERE o.state='active' AND
          ((o.legacy_workspace_id IS NULL AND om.user_id IS NOT NULL)
           OR (o.legacy_workspace_id IS NOT NULL AND wm.user_id IS NOT NULL))
        ORDER BY o.created_at ASC, o.id ASC`, [userId(req),userId(req)]
    );
    res.set('Cache-Control', 'no-store');
    // The SQL membership join limits candidates; the same centralized P08
    // policy additionally denies unknown roles (and client_viewer metadata).
    const readable = rows.filter(row => can(row.role, 'organization.read', {legacy: row.legacy_workspace_id !== null})).map(({legacy_workspace_id, ...row})=>row);
    return res.json({ organizations: readable });
  } catch (error) {
    return res.status(500).json({ error: 'Could not list organizations' });
  }
});

router.get('/api/organizations/:id', guard, generalLimiter, requireSignedIn, async (req, res) => {
  if (!uuid.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
  try {
    // Keep authorization and response reads on one DB transaction. Lock the
    // membership row to prevent a concurrent revocation before data is read.
    const result = await withTransaction(async tx => {
      const allowed = await checkAccess({tx,organizationId:req.params.id,userId:userId(req),mutation:true},'organization.read');
      if (!allowed) return null;
      const row = await tx.get(
        `SELECT o.id,o.display_name,o.state,
                CASE WHEN o.legacy_workspace_id IS NOT NULL THEN wm.role ELSE om.role END AS role,
                o.created_at,ob.billing_mode
           FROM organizations o
           LEFT JOIN organization_members om ON om.organization_id=o.id AND om.user_id=?
           LEFT JOIN workspace_members wm ON wm.workspace_id=o.legacy_workspace_id AND wm.user_id=?
           JOIN organization_billing ob ON ob.organization_id=o.id
          WHERE o.id=? AND o.state='active'`,
        [userId(req),userId(req),req.params.id]
      );
      if (!row) return null;
      const workspaces = await tx.all(
        `SELECT w.id,w.name,wm.role
           FROM organization_workspaces ow
           JOIN workspaces w ON w.id=ow.workspace_id
           JOIN workspace_members wm ON wm.workspace_id=w.id
          WHERE ow.organization_id=? AND wm.user_id=?
          ORDER BY w.id ASC`,
        [row.id,userId(req)]
      );
      return {organization:row,workspaces};
    });
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.set('Cache-Control', 'no-store');
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: 'Could not load organization' });
  }
});

// Only standalone (not legacy-shadow) organization display names are mutable.
// The live workspace is the sole name authority for a legacy organization.
// Authorization and mutation share the same transaction with DB membership locks.
router.patch('/api/organizations/:id', guard, mutationLimiter, requireSignedIn, async (req, res) => {
  if (!uuid.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
  if (!req.body || Array.isArray(req.body) || typeof req.body !== 'object' ||
      Object.keys(req.body).length !== 1 || !Object.hasOwn(req.body, 'name') ||
      !validName(req.body.name)) return res.status(400).json({ error: 'Invalid name' });
  const name = req.body.name.trim();
  try {
    const outcome = await withTransaction(async tx => {
      const user = userId(req);
      const allowed = await checkAccess({tx, organizationId:req.params.id, userId:user, mutation:true}, 'organization.update');
      if (!allowed) return {status:404};
      const current = await tx.get('SELECT display_name,legacy_workspace_id FROM organizations WHERE id=? FOR SHARE', [req.params.id]);
      if (!current) return {status:404};
      // Do not create name drift between old workspaces and their shadow orgs.
      if (current.legacy_workspace_id !== null) return {status:409};
      if (current.display_name === name) return {status:200,name};
      const changed = await tx.get(
        "UPDATE organizations SET display_name=? WHERE id=? AND state='active' AND legacy_workspace_id IS NULL RETURNING display_name",
        [name,req.params.id]
      );
      if (!changed) return {status:404};
      await tx.run(
        'INSERT INTO organization_audit_log(organization_id,event_key,actor_user_id,metadata_json) VALUES (?,?,?,?::jsonb)',
        [req.params.id, 'organization.renamed.' + randomUUID(), user,
          JSON.stringify({kind:'organization.display_name.changed', previous_name:current.display_name, new_name:name})]
      );
      return {status:200,name:changed.display_name};
    });
    res.set('Cache-Control', 'no-store');
    if (outcome.status===404) return res.status(404).json({error:'Not found'});
    if (outcome.status===409) return res.status(409).json({error:'Legacy workspace name must be changed using workspace settings'});
    return res.json({organization:{id:req.params.id,display_name:outcome.name}});
  } catch (error) {
    return res.status(500).json({error:'Could not update organization'});
  }
});

// Creating an organization does not alter any legacy workspace, link,
// campaign or provider subscription. P08 will add more membership mutations.
router.post('/api/organizations',
  guard, mutationLimiter, requireSignedIn, requireProAccess('workspaces'),
  async (req, res) => {
    const raw = req.body && req.body.name;
    if (!validName(raw)) return res.status(400).json({ error: 'Invalid name' });
    const name = raw.trim();
    try {
      const id = await withTransaction(async tx => {
        const user = userId(req);
        const created = await tx.get(
          'INSERT INTO organizations(display_name,owner_user_id) VALUES (?,?) RETURNING id',
          [name, user]
        );
        await tx.run(
          "INSERT INTO organization_members(organization_id,user_id,role) VALUES (?,?,'owner')",
          [created.id, user]
        );
        await tx.run('INSERT INTO organization_settings(organization_id) VALUES (?)', [created.id]);
        await tx.run('INSERT INTO organization_billing(organization_id,billing_owner_user_id) VALUES (?,?)',
          [created.id,user]
        );
        await tx.run(
          "INSERT INTO organization_audit_log(organization_id,event_key,actor_user_id,metadata_json) VALUES (?,'organization.created',?,?::jsonb)",
          [created.id,user,JSON.stringify({ source:'p07_opt_in_api' })]
        );
        return created.id;
      });
      res.set('Cache-Control', 'no-store');
      return res.status(201).json({ organization: { id, display_name: name, role: 'owner', billing_mode: 'legacy_user_pro' } });
    } catch (error) {
      return res.status(500).json({ error: 'Could not create organization' });
    }
  }
);

// P08 RBAC-unified organization webhooks: Owner/Admin manage (integration.manage),
// Manager reads (integration.read), Analyst/Client Viewer/Outsider denied (404).
router.get('/api/organizations/:id/webhooks', rbacV2Guard, generalLimiter, requireSignedIn, async (req, res) => {
  if (!uuid.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
  try {
    const rows = await withTransaction(async tx => {
      const allowed = await checkAccess({ tx, organizationId: req.params.id, userId: userId(req), mutation: true }, 'integration.read');
      if (!allowed) return null;
      const org = await tx.get("SELECT legacy_workspace_id FROM organizations WHERE id=? AND state='active' FOR SHARE", [req.params.id]);
      if (!org || org.legacy_workspace_id !== null) return null;
      return tx.all(
        `SELECT w.id, w.url, w.events, w.message_locale, w.is_active, w.created_at, w.updated_at
           FROM organization_webhooks ow
           JOIN webhooks w ON w.id = ow.webhook_id
          WHERE ow.organization_id = ?
          ORDER BY ow.created_at DESC, w.id DESC`,
        [req.params.id]
      );
    });
    if (!rows) return res.status(404).json({ error: 'Not found' });
    res.set('Cache-Control', 'no-store');
    return res.json({ webhooks: rows });
  } catch (_e) {
    return res.status(500).json({ error: 'Could not load organization webhooks' });
  }
});

router.post('/api/organizations/:id/webhooks', rbacV2Guard, mutationLimiter, requireSignedIn, async (req, res) => {
  if (!uuid.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
  if (!body || !body.url || Object.keys(body).some(k => !['url', 'events', 'message_locale'].includes(k))) {
    return res.status(400).json({ error: 'Invalid webhook payload' });
  }
  try {
    const validation = await validateOutboundWebhookUrl(body.url);
    if (!validation || !validation.ok) return res.status(400).json({ error: 'Invalid webhook URL' });
    const events = normalizeWebhookEvents(body.events || '');
    const messageLocale = normalizeWebhookMessageLocale(body.message_locale, 'auto');
    const rawSecret = `whsec_${crypto.randomBytes(32).toString('base64url')}`;
    const secretHash = hashWebhookSecretValueV2(`wh|${rawSecret}`);
    const signatureV2Key = buildWebhookSignatureV2Key(rawSecret);
    const now = new Date().toISOString();

    const outcome = await withTransaction(async tx => {
      const actor = userId(req);
      const allowed = await checkAccess({ tx, organizationId: req.params.id, userId: actor, mutation: true }, 'integration.manage');
      if (!allowed) return { status: 404 };
      const org = await tx.get("SELECT owner_user_id, legacy_workspace_id FROM organizations WHERE id=? AND state='active' FOR UPDATE", [req.params.id]);
      if (!org || org.legacy_workspace_id !== null) return { status: 404 };
      const cnt = await tx.get('SELECT COUNT(*)::int AS c FROM organization_webhooks WHERE organization_id=?', [req.params.id]);
      if (Number(cnt.c) >= ORG_WEBHOOK_MAX) return { status: 409 };
      const inserted = await tx.get(
        `INSERT INTO webhooks (user_id, url, secret_hash, secret_hash_version, signature_v2_key, signature_v2_enabled, events, message_locale, message_template, is_active, created_at, updated_at)
         VALUES (?, ?, ?, 2, ?, 1, ?, ?, NULL, 1, ?, ?)
         RETURNING id, url, events, message_locale, is_active, created_at`,
        [org.owner_user_id, validation.normalizedUrl, secretHash, signatureV2Key, events.join(','), messageLocale, now, now]
      );
      await tx.run(
        'INSERT INTO organization_webhooks (organization_id, webhook_id, created_by_user_id) VALUES (?, ?, ?)',
        [req.params.id, inserted.id, actor]
      );
      await tx.run(
        'INSERT INTO organization_audit_log(organization_id,event_key,actor_user_id,metadata_json) VALUES (?,?,?,?::jsonb)',
        [req.params.id, 'organization.webhook.created.' + randomUUID(), actor, JSON.stringify({ kind: 'organization.webhook.created', webhook_id: inserted.id })]
      );
      return { status: 201, webhook: inserted };
    });
    res.set('Cache-Control', 'no-store');
    if (outcome.status === 404) return res.status(404).json({ error: 'Not found' });
    if (outcome.status === 409) return res.status(409).json({ error: 'Webhook limit reached' });
    return res.status(201).json({ webhook: outcome.webhook, webhook_secret: rawSecret });
  } catch (_e) {
    return res.status(500).json({ error: 'Could not create organization webhook' });
  }
});

router.delete('/api/organizations/:id/webhooks/:webhookId', rbacV2Guard, mutationLimiter, requireSignedIn, async (req, res) => {
  const webhookId = Number(req.params.webhookId);
  if (!uuid.test(req.params.id) || !Number.isSafeInteger(webhookId) || webhookId < 1) {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const deleted = await withTransaction(async tx => {
      const actor = userId(req);
      const allowed = await checkAccess({ tx, organizationId: req.params.id, userId: actor, mutation: true }, 'integration.manage');
      if (!allowed) return false;
      const org = await tx.get("SELECT legacy_workspace_id FROM organizations WHERE id=? AND state='active' FOR SHARE", [req.params.id]);
      if (!org || org.legacy_workspace_id !== null) return false;
      const link = await tx.get('DELETE FROM organization_webhooks WHERE organization_id=? AND webhook_id=? RETURNING webhook_id', [req.params.id, webhookId]);
      if (!link) return false;
      await tx.run('DELETE FROM webhooks WHERE id=?', [webhookId]);
      await tx.run("UPDATE webhook_deliveries SET status='cancelled', updated_at=? WHERE webhook_id=? AND status IN ('queued','retry_scheduled')", [new Date().toISOString(), webhookId]).catch(() => {});
      await tx.run(
        'INSERT INTO organization_audit_log(organization_id,event_key,actor_user_id,metadata_json) VALUES (?,?,?,?::jsonb)',
        [req.params.id, 'organization.webhook.deleted.' + randomUUID(), actor, JSON.stringify({ kind: 'organization.webhook.deleted', webhook_id: webhookId })]
      );
      return true;
    });
    res.set('Cache-Control', 'no-store');
    return deleted ? res.json({ deleted: true }) : res.status(404).json({ error: 'Not found' });
  } catch (_e) {
    return res.status(500).json({ error: 'Could not delete organization webhook' });
  }
});

module.exports = router;
