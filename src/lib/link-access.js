// Link ownership / workspace-role guards (W4.2, move-only from
// src/routes/api/links.js). The SQL fragments are the authorization surface for
// every link mutation, so they live in one place and links.js re-exports them.
const {
  WORKSPACE_ROLES,
  getWorkspaceById,
  isWorkspaceProActive,
  getWorkspaceMemberRole,
} = require('../routes/api/workspaces');
const { can } = require('./organization-permissions');

// Unified P08 policy adapter for legacy 3-role workspaces (owner/admin/member).
function canWorkspaceRole(role, action) {
  return can(role, action, { legacy: true });
}

// Read scope: anything in the user's own or a joined workspace.
const WORKSPACE_SCOPED_LINK_OWNERSHIP_SQL = '(user_id = ? OR workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ?))';

// Write scope: own links, or links in a workspace where the user is owner/admin.
const WORKSPACE_LINK_MUTATION_SQL = `(user_id = ? OR (workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = ? AND role IN ('${WORKSPACE_ROLES.OWNER}', '${WORKSPACE_ROLES.ADMIN}'))))`;

module.exports = {
  WORKSPACE_ROLES,
  WORKSPACE_SCOPED_LINK_OWNERSHIP_SQL,
  WORKSPACE_LINK_MUTATION_SQL,
  canWorkspaceRole,
  getWorkspaceById,
  isWorkspaceProActive,
  getWorkspaceMemberRole,
};
