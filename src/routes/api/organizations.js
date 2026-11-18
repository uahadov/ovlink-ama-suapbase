'use strict';
const express = require('express');
const { withTransaction, dbAllAsync, dbGetAsync } = require('../../db/helpers');
const { requireSignedIn, requireProAccess } = require('../../middleware/auth');
const { generalLimiter, mutationLimiter } = require('../../middleware/rate-limiter');
const { organizationFeatureEnabled } = require('../../db/organization-model');
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

router.get('/api/organizations', guard, generalLimiter, requireSignedIn, async (req, res) => {
  try {
    const rows = await dbAllAsync(
      `SELECT o.id,o.display_name,o.state,
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
    return res.json({ organizations: rows });
  } catch (error) {
    return res.status(500).json({ error: 'Could not list organizations' });
  }
});

router.get('/api/organizations/:id', guard, generalLimiter, requireSignedIn, async (req, res) => {
  if (!uuid.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
  try {
    const row = await dbGetAsync(
      `SELECT o.id,o.display_name,o.state,
              CASE WHEN o.legacy_workspace_id IS NOT NULL THEN wm.role ELSE om.role END AS role,
              o.created_at,ob.billing_mode
         FROM organizations o
         LEFT JOIN organization_members om ON om.organization_id=o.id AND om.user_id=?
         LEFT JOIN workspace_members wm ON wm.workspace_id=o.legacy_workspace_id AND wm.user_id=?
         JOIN organization_billing ob ON ob.organization_id=o.id
        WHERE o.id=? AND o.state='active' AND
          ((o.legacy_workspace_id IS NULL AND om.user_id IS NOT NULL)
           OR (o.legacy_workspace_id IS NOT NULL AND wm.user_id IS NOT NULL))`,
      [userId(req), userId(req), req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    const workspaces = await dbAllAsync(
      `SELECT w.id,w.name,wm.role
         FROM organization_workspaces ow
         JOIN workspaces w ON w.id=ow.workspace_id
         JOIN workspace_members wm ON wm.workspace_id=w.id
        WHERE ow.organization_id=? AND wm.user_id=?
        ORDER BY w.id ASC`,
      [row.id, userId(req)]
    );
    res.set('Cache-Control', 'no-store');
    return res.json({ organization: row, workspaces });
  } catch (error) {
    return res.status(500).json({ error: 'Could not load organization' });
  }
});

// Creating an organization does not alter any legacy workspace, link,
// campaign or provider subscription. P08 will add more membership mutations.
router.post('/api/organizations',
  guard, mutationLimiter, requireSignedIn, requireProAccess('workspaces'),
  async (req, res) => {
    const raw = req.body && req.body.name;
    if (typeof raw !== 'string') return res.status(400).json({ error: 'Invalid name' });
    const name = raw.trim();
    if (name.length < 3 || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) {
      return res.status(400).json({ error: 'Invalid name' });
    }
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
