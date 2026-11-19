'use strict';
const express = require('express');
const { randomUUID } = require('node:crypto');
const { withTransaction, dbAllAsync } = require('../../db/helpers');
const { requireSignedIn, requireProAccess } = require('../../middleware/auth');
const { generalLimiter, mutationLimiter } = require('../../middleware/rate-limiter');
const { organizationFeatureEnabled } = require('../../db/organization-model');
const { can } = require('../../lib/organization-permissions');
const { checkAccess } = require('../../lib/organization-access-context');
const router = express.Router();

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

module.exports = router;
