'use strict';
/**
 * P08 isolated authorization policy proposal. NOT active in routes until the
 * P05->P06->P07 business/release gates and DB-backed authorization tests pass.
 * Server is the sole authority; UI may only use this for presentation hints.
 */
const ACTIONS = Object.freeze([
  'organization.read','organization.update','organization.delete',
  'member.read','member.invite','member.change_role','member.remove',
  'workspace.read','workspace.create','workspace.update','workspace.delete',
  'campaign.read','campaign.create','campaign.update','campaign.delete',
  'link.read','link.create','link.update','link.delete',
  'analytics.read','analytics.export',
  'report.read','report.create','report.schedule',
  'billing.read','billing.manage',
  'integration.read','integration.manage',
  'audit.read',
]);

const ROLE_GRANTS = Object.freeze({
  owner: ACTIONS,
  admin: ACTIONS.filter(a=>!['organization.delete','billing.manage','member.change_role'].includes(a)),
  manager: ACTIONS.filter(a=>[
    'organization.read','member.read','member.invite',
    'workspace.read','workspace.create','workspace.update',
    'campaign.read','campaign.create','campaign.update','campaign.delete',
    'link.read','link.create','link.update','link.delete',
    'analytics.read','analytics.export',
    'report.read','report.create','report.schedule',
    'integration.read'
  ].includes(a)),
  analyst: ACTIONS.filter(a=>[
    'organization.read','workspace.read','campaign.read','link.read',
    'analytics.read','analytics.export','report.read','report.create'
  ].includes(a)),
  client_viewer: ACTIONS.filter(a=>[
    'workspace.read','campaign.read','link.read','analytics.read','report.read'
  ].includes(a)),
});

const GRANTS = Object.freeze(Object.fromEntries(Object.entries(ROLE_GRANTS).map(
  ([role,actions])=>[role,Object.freeze(new Set(actions))]
)));

// Existing workspace `member` was not a five-role permission. Use a
// conservative read-only mapping; do not silently expand old member rights.
const LEGACY_ROLE = Object.freeze({ owner:'owner', admin:'admin', member:'analyst' });
function resolveRole(role, { legacy = false } = {}) {
  if (typeof role !== 'string') return null;
  if (legacy) return LEGACY_ROLE[role] || null;
  return Object.hasOwn(GRANTS, role) ? role : null;
}

function can(role, action, { legacy = false } = {}) {
  const canonical = resolveRole(role,{legacy});
  return Boolean(canonical && typeof action==='string' && GRANTS[canonical].has(action));
}

/**
 * This context MUST come from a fresh scoped DB query for every request,
 * not a session/JWT claim or caller-supplied role. Unknown states fail shut.
 */
function authorize(context, action) {
  if (!context || context.active !== true || context.membershipActive !== true) return false;
  if (!context.organizationId || !context.requestedOrganizationId ||
      context.organizationId !== context.requestedOrganizationId) return false;
  if (context.workspaceBound === true && context.workspaceMembershipActive !== true) return false;
  if (context.workspaceBound === true && context.workspaceId !== context.requestedWorkspaceId) return false;
  return can(context.role, action, { legacy: context.legacy === true });
}

module.exports = { ACTIONS, ROLE_GRANTS, resolveRole, can, authorize };
