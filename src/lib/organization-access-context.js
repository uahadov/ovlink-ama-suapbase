'use strict';
/**
 * P08 isolated DB-sourced access context. No live route uses this module yet.
 * Call with a transaction-bound db.get (not arbitrary session role claims).
 * Mutations require one transaction enclosing load + authorization + write.
 */
const { authorize } = require('./organization-permissions');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validUser = value => Number.isSafeInteger(value) && value > 0;
const validWorkspace = value => Number.isSafeInteger(value) && value > 0;

async function loadContext({ tx, organizationId, userId, workspaceId = null, mutation = false }) {
  if (!tx || typeof tx.get !== 'function' || !UUID.test(organizationId || '') || !validUser(userId) ||
    (workspaceId !== null && !validWorkspace(workspaceId))) return null;
  // Lock the organization on writes. The caller must retain the SAME tx for
  // its eventual mutation; otherwise concurrent revoke / deletion can race.
  const org = await tx.get(`SELECT id, state, legacy_workspace_id FROM organizations WHERE id=? ${mutation ? 'FOR SHARE' : ''}`,[organizationId]);
  if (!org || org.state !== 'active') return null;
  let role;
  const legacy = org.legacy_workspace_id !== null && org.legacy_workspace_id !== undefined;
  if (legacy) {
    const member = await tx.get(`SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=? ${mutation ? 'FOR SHARE' : ''}`,
      [org.legacy_workspace_id,userId]);
    if (!member) return null;
    role = member.role;
  } else {
    const member = await tx.get(`SELECT role FROM organization_members WHERE organization_id=? AND user_id=? ${mutation ? 'FOR SHARE' : ''}`,
      [organizationId,userId]);
    if (!member) return null;
    role = member.role;
  }
  if (workspaceId !== null) {
    const workspace = await tx.get(`SELECT ow.workspace_id FROM organization_workspaces ow
      JOIN workspace_members wm ON wm.workspace_id=ow.workspace_id
      WHERE ow.organization_id=? AND ow.workspace_id=? AND wm.user_id=? ${mutation ? 'FOR SHARE OF ow, wm' : ''}`,
    [organizationId,workspaceId,userId]);
    if (!workspace) return null;
  }
  return {
    active:true, membershipActive:true, role, legacy,
    organizationId:org.id, requestedOrganizationId:organizationId,
    workspaceBound:workspaceId !== null,
    workspaceMembershipActive:workspaceId !== null,
    workspaceId, requestedWorkspaceId:workspaceId,
  };
}

async function checkAccess(args, action) {
  const context=await loadContext(args);
  return authorize(context,action);
}

module.exports = { loadContext, checkAccess };
