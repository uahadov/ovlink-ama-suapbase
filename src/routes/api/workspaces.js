const express = require('express');
const router = express.Router();


const { dbGetAsync, dbRunAsync, dbAllAsync } = require('../../db/helpers');
const { requireSignedIn, requireProAccess } = require('../../middleware/auth');
const { pickLang, normalizeLang } = require('../../lib/i18n');
const { isProAccessActive, isIsoTimeExpired } = require('../../lib/plans');
const { db } = require('../../db/index');
const { sensitiveActionLimiter, mutationLimiter, authLimiter } = require('../../middleware/rate-limiter');
const { encryptAES256GCM, decryptAES256GCM, blindIndex } = require('../../../utils/crypto');
const {
  isPublicConsumerEmailDomain,
  createSignedRelayState,
  verifySignedRelayState,
  parseIdpMetadataXml,
  createWorkspaceSamlInstance,
  extractProfileEmail,
  extractAssertionId
} = require('../../../utils/sso');
const { logSecurityEvent, getPublicBaseUrl } = require('../../lib/security');
const { isProdRuntime } = require('../../config/index');
const crypto = require('crypto');

const WORKSPACE_ROLES = Object.freeze({
  OWNER: 'owner',
  ADMIN: 'admin',
  MEMBER: 'member',
});

function normalizeWorkspaceRole(raw) {
  const v = (raw || '').toString().trim().toLowerCase();
  if (v === 'admin') return WORKSPACE_ROLES.ADMIN;
  if (v === 'owner') return WORKSPACE_ROLES.OWNER;
  return WORKSPACE_ROLES.MEMBER;
}

function normalizeWorkspaceName(raw) {
  return (raw || '').toString().trim().slice(0, 50);
}

async function getWorkspaceById(id) {
  const wsId = Number.parseInt(id, 10);
  if (!Number.isInteger(wsId) || wsId <= 0) return null;
  return dbGetAsync('SELECT * FROM workspaces WHERE id = ?', [wsId]);
}

async function isWorkspaceProActive(ws) {
  if (!ws) return false;
  const ownerId = ws.owner_user_id || ws.owner_id;
  if (!ownerId) return false;
  const ownerUser = await dbGetAsync('SELECT * FROM users WHERE id = ?', [ownerId]);
  if (!ownerUser) return false;
  return isProAccessActive(ownerUser);
}

async function loadValidWorkspaceInvitation(token) {
  const rawToken = (token || '').toString().trim();
  if (!rawToken || rawToken.length > 200) return { error: 'invalid' };
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const invitation = await dbGetAsync('SELECT * FROM workspace_invitations WHERE token_hash = ?', [tokenHash]);
  if (!invitation) return { error: 'invalid' };
  if (invitation.revoked_at) return { error: 'revoked' };
  if (invitation.accepted_at) return { error: 'accepted', invitation };
  if (isIsoTimeExpired(invitation.expires_at)) return { error: 'expired', invitation };
  const workspace = await getWorkspaceById(invitation.workspace_id);
  if (!workspace) return { error: 'invalid' };
  return { invitation, workspace };
}

async function getUserWorkspaceMemberships(userId) {
  if (!userId) return [];
  return dbAllAsync(
    'SELECT w.id, w.name, w.owner_user_id, wm.role FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id WHERE wm.user_id = ? ORDER BY w.created_at ASC',
    [userId]
  );
}


router.post('/workspaces/accept', async (req, res) => {
  if (!req.session.userId) return res.redirect(`/workspaces/accept?token=${encodeURIComponent((req.body && req.body.token || '').toString())}`);
  const token = (req.body && req.body.token || '').toString();
  const loaded = await loadValidWorkspaceInvitation(token).catch(() => ({ error: 'invalid' }));
  if (loaded.error) return res.redirect(`/workspaces/accept?token=${encodeURIComponent(token)}`);

  const { invitation, workspace } = loaded;
  if (!(await isWorkspaceProActive(workspace))) return res.redirect(`/workspaces/accept?token=${encodeURIComponent(token)}`);

  const user = await dbGetAsync('SELECT id, email_hash, banned FROM users WHERE id = ?', [req.session.userId]);
  if (!user || user.email_hash !== invitation.email_hash) return res.redirect(`/workspaces/accept?token=${encodeURIComponent(token)}`);

  const existingMember = await dbGetAsync('SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [workspace.id, user.id]);
  if (!existingMember) {
    await dbRunAsync(
      'INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)',
      [workspace.id, user.id, normalizeWorkspaceRole(invitation.role) || WORKSPACE_ROLES.MEMBER, new Date().toISOString()]
    );
  }
  await dbRunAsync('UPDATE workspace_invitations SET accepted_at = ? WHERE id = ?', [new Date().toISOString(), invitation.id]);
  logSecurityEvent(req, 'workspace.invite.accepted', 'success', { workspace_id: workspace.id, invitation_id: invitation.id });
  return res.redirect(`/dashboard?ws=${workspace.id}`);
});

router.get('/api/workspaces', requireSignedIn, async (req, res) => {
  const memberships = await getUserWorkspaceMemberships(req.session.userId);
  const enriched = [];
  for (const m of memberships) {
    enriched.push({
      id: m.id,
      name: m.name,
      role: m.role,
      owner_user_id: m.owner_user_id,
      is_owner: m.owner_user_id === req.session.userId,
      pro_active: await isWorkspaceProActive(m),
    });
  }
  return res.json({ workspaces: enriched });
});

router.post('/api/workspaces',
  requireSignedIn,
  requireProAccess('workspaces'),
  async (req, res) => {
    const uiLang = normalizeLang(req.body && req.body.lang, 'az');
    const name = normalizeWorkspaceName(req.body && req.body.name);
    if (name.length < 3) {
      return res.status(400).json({ error: pickLang(uiLang, 'Workspace adâ”€â–’ â•”Ã–n azâ”€â–’ 3 simvol olmalâ”€â–’dâ”€â–’r.', 'Workspace adâ”€â–’ en az 3 karakter olmalâ”€â–’dâ”€â–’r.', 'Workspace name must be at least 3 characters.') });
    }
    const existing = await dbGetAsync('SELECT id, name FROM workspaces WHERE owner_user_id = ?', [req.session.userId]);
    if (existing) {
      return res.status(409).json({
        error: pickLang(uiLang, 'Sizin artâ”€â–’q bir workspace-iniz var.', 'Zaten bir workspace\'iniz var.', 'You already have a workspace.'),
        workspace: { id: existing.id, name: existing.name },
      });
    }
    const nowIso = new Date().toISOString();
    const inserted = await dbRunAsync(
      'INSERT INTO workspaces (name, owner_user_id, created_at) VALUES (?, ?, ?) RETURNING id',
      [name, req.session.userId, nowIso]
    );
    const workspaceId = inserted.lastID;
    await dbRunAsync(
      'INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)',
      [workspaceId, req.session.userId, WORKSPACE_ROLES.OWNER, nowIso]
    );
    logSecurityEvent(req, 'workspace.created', 'success', { workspace_id: workspaceId });
    return res.json({ id: workspaceId, name });
  });

async function requireWorkspaceMembership(req, res, minimumRole) {
  const workspace = await getWorkspaceById(req.params.id);
  if (!workspace) {
    res.status(404).json({ error: 'Workspace not found.' });
    return null;
  }
  const role = await getWorkspaceMemberRole(req.session.userId, workspace.id);
  if (!role || !workspaceRoleAtLeast(role, minimumRole)) {
    res.status(403).json({ error: 'Workspace access denied.' });
    return null;
  }
  return { workspace, role };
}

router.get('/api/workspaces/:id', requireSignedIn, async (req, res) => {
  const ctx = await requireWorkspaceMembership(req, res, WORKSPACE_ROLES.MEMBER);
  if (!ctx) return;
  const { workspace, role } = ctx;

  const memberRows = await dbAllAsync(
    `SELECT u.id AS user_id, u.email, wm.role, wm.created_at AS joined_at
     FROM workspace_members wm JOIN users u ON u.id = wm.user_id
     WHERE wm.workspace_id = ? ORDER BY wm.created_at ASC`,
    [workspace.id]
  );
  const members = memberRows.map((row) => ({
    user_id: row.user_id,
    email: (() => { try { return decryptAES256GCM(row.email); } catch { return ''; } })(),
    role: row.role,
    joined_at: row.joined_at,
  }));

  let invitations = [];
  let sso = null;
  if (workspaceRoleAtLeast(role, WORKSPACE_ROLES.ADMIN)) {
    const inviteRows = await dbAllAsync(
      'SELECT id, email_encrypted, role, expires_at, accepted_at, revoked_at, created_at FROM workspace_invitations WHERE workspace_id = ? ORDER BY created_at DESC',
      [workspace.id]
    );
    invitations = inviteRows.map((row) => ({
      id: row.id,
      email: (() => { try { return decryptAES256GCM(row.email_encrypted); } catch { return ''; } })(),
      role: row.role,
      expires_at: row.expires_at,
      accepted_at: row.accepted_at,
      revoked_at: row.revoked_at,
      created_at: row.created_at,
    }));
    const ssoRow = await dbGetAsync('SELECT id, idp_entity_id, idp_sso_url, enabled, created_at, updated_at FROM sso_connections WHERE workspace_id = ?', [workspace.id]);
    const baseUrl = getPublicBaseUrl(req).replace(/\/+$/, '');
    sso = {
      configured: !!ssoRow,
      enabled: ssoRow ? ssoRow.enabled == 1 : false,
      idp_entity_id: ssoRow ? ssoRow.idp_entity_id : '',
      idp_sso_url: ssoRow ? ssoRow.idp_sso_url : '',
      sp_entity_id: `${baseUrl}/sso/${workspace.id}/metadata`,
      acs_url: `${baseUrl}/sso/${workspace.id}/acs`,
      metadata_url: `${baseUrl}/sso/${workspace.id}/metadata`,
      login_url: `${baseUrl}/sso/${workspace.id}/login`,
    };
  }

  return res.json({
    id: workspace.id,
    name: workspace.name,
    owner_user_id: workspace.owner_user_id,
    created_at: workspace.created_at,
    my_role: role,
    pro_active: await isWorkspaceProActive(workspace),
    members,
    invitations,
    sso,
  });
});

router.patch('/api/workspaces/:id', requireSignedIn, async (req, res) => {
  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const ctx = await requireWorkspaceMembership(req, res, WORKSPACE_ROLES.OWNER);
  if (!ctx) return;
  const name = normalizeWorkspaceName(req.body && req.body.name);
  if (name.length < 3) {
    return res.status(400).json({ error: pickLang(uiLang, 'Workspace adâ”€â–’ â•”Ã–n azâ”€â–’ 3 simvol olmalâ”€â–’dâ”€â–’r.', 'Workspace adâ”€â–’ en az 3 karakter olmalâ”€â–’dâ”€â–’r.', 'Workspace name must be at least 3 characters.') });
  }
  await dbRunAsync('UPDATE workspaces SET name = ? WHERE id = ?', [name, ctx.workspace.id]);
  return res.json({ id: ctx.workspace.id, name });
});

router.delete('/api/workspaces/:id', requireSignedIn, async (req, res) => {
  const ctx = await requireWorkspaceMembership(req, res, WORKSPACE_ROLES.OWNER);
  if (!ctx) return;
  const workspaceId = ctx.workspace.id;
  // Workspace links fall back to their creator's personal scope; redirects
  // never break.
  try {
    await dbRunAsync('BEGIN');
    await dbRunAsync('UPDATE urls SET workspace_id = NULL WHERE workspace_id = ?', [workspaceId]);
    await dbRunAsync('DELETE FROM sso_connections WHERE workspace_id = ?', [workspaceId]);
    await dbRunAsync('DELETE FROM workspace_invitations WHERE workspace_id = ?', [workspaceId]);
    await dbRunAsync('DELETE FROM workspace_members WHERE workspace_id = ?', [workspaceId]);
    await dbRunAsync('DELETE FROM workspaces WHERE id = ?', [workspaceId]);
    await dbRunAsync('COMMIT');
  } catch (err) {
    await dbRunAsync('ROLLBACK').catch(() => {});
    throw err;
  }
  logSecurityEvent(req, 'workspace.deleted', 'success', { workspace_id: workspaceId });
  return res.json({ deleted: true });
});

router.post('/api/workspaces/:id/invitations',
  requireSignedIn,
  sensitiveActionLimiter,
  async (req, res) => {
    const uiLang = normalizeLang(req.body && req.body.lang, 'az');
    const ctx = await requireWorkspaceMembership(req, res, WORKSPACE_ROLES.ADMIN);
    if (!ctx) return;
    const { workspace, role: actorRole } = ctx;

    if (!(await isWorkspaceProActive(workspace))) {
      return res.status(403).json({ error: pickLang(uiLang, 'Workspace Pro aboneliyi aktiv deyil.', 'Workspace Pro aboneliâ”€ÅŸi aktif deâ”€ÅŸil.', 'Workspace Pro subscription is not active.') });
    }

    const email = (req.body && req.body.email || '').toString().trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return res.status(400).json({ error: pickLang(uiLang, 'Dâ”œâ•zgâ”œâ•n e-poâ”œÄŸt â”œâ•nvanâ”€â–’ daxil edin.', 'Geâ”œÄŸerli bir e-posta adresi girin.', 'Enter a valid email address.') });
    }
    const inviteRole = normalizeWorkspaceRole(req.body && req.body.role) || WORKSPACE_ROLES.MEMBER;
    if (inviteRole === WORKSPACE_ROLES.ADMIN && actorRole !== WORKSPACE_ROLES.OWNER) {
      return res.status(403).json({ error: pickLang(uiLang, 'Yalnâ”€â–’z sahib admin dâ•”Ã–vâ•”Ã–t edâ•”Ã– bilâ•”Ã–r.', 'Sadece sahip admin davet edebilir.', 'Only the owner can invite admins.') });
    }

    const existingMember = await dbGetAsync('SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = (SELECT id FROM users WHERE email_hash = ?)', [workspace.id, blindIndex(email)]);
    if (existingMember) {
      return res.status(409).json({ error: pickLang(uiLang, 'Bu istifadâ•”Ã–â”œÄŸi artâ”€â–’q â”œâ•zvdâ”œâ•r.', 'Bu kullanâ”€â–’câ”€â–’ zaten â”œâ•ye.', 'This user is already a member.') });
    }
    const memberCount = await dbGetAsync('SELECT COUNT(*)::int AS c FROM workspace_members WHERE workspace_id = ?', [workspace.id]);
    const pendingCount = await dbGetAsync("SELECT COUNT(*)::int AS c FROM workspace_invitations WHERE workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?", [workspace.id, new Date().toISOString()]);
    if (Number(memberCount.c) + Number(pendingCount.c) >= WORKSPACE_MAX_MEMBERS) {
      return res.status(409).json({ error: pickLang(uiLang, `Workspace â”œâ•zv limiti (${WORKSPACE_MAX_MEMBERS}) dolub.`, `Workspace â”œâ•ye limiti (${WORKSPACE_MAX_MEMBERS}) doldu.`, `Workspace member limit (${WORKSPACE_MAX_MEMBERS}) reached.`) });
    }

    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + WORKSPACE_INVITE_EXPIRY_MS).toISOString();
    const nowIso = new Date().toISOString();
    const inserted = await dbRunAsync(
      'INSERT INTO workspace_invitations (workspace_id, email_encrypted, email_hash, role, token_hash, invited_by_user_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
      [workspace.id, encryptAES256GCM(email), blindIndex(email), inviteRole, tokenHash, req.session.userId, expiresAt, nowIso]
    );

    const inviteUrl = buildAbsoluteUrl(req, `/workspaces/accept?token=${encodeURIComponent(rawToken)}`);
    sendWorkspaceInviteEmail(email, workspace.name, inviteUrl).catch(() => {});

    return res.json({
      invitation: { id: inserted.lastID, email, role: inviteRole, expires_at: expiresAt },
      invite_url: inviteUrl,
      email_sent: true,
    });
  });

router.delete('/api/workspaces/:id/invitations/:invitationId', requireSignedIn, async (req, res) => {
  const ctx = await requireWorkspaceMembership(req, res, WORKSPACE_ROLES.ADMIN);
  if (!ctx) return;
  const invitationId = Number.parseInt(req.params.invitationId, 10);
  if (!Number.isInteger(invitationId) || invitationId <= 0) return res.status(400).json({ error: 'Invalid invitation id.' });
  const result = await dbRunAsync(
    'UPDATE workspace_invitations SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL',
    [new Date().toISOString(), invitationId, ctx.workspace.id]
  );
  if (!result.changes) return res.status(404).json({ error: 'Invitation not found.' });
  return res.json({ revoked: true });
});

router.delete('/api/workspaces/:id/members/:userId', requireSignedIn, async (req, res) => {
  let targetUserId;
  if (req.params.userId === 'me') {
    targetUserId = req.session.userId;
  } else {
    targetUserId = Number.parseInt(req.params.userId, 10);
    if (!Number.isInteger(targetUserId) || targetUserId <= 0) return res.status(400).json({ error: 'Invalid user id.' });
  }

  const isSelf = (req.session.userId === targetUserId);
  const requiredRole = isSelf ? WORKSPACE_ROLES.MEMBER : WORKSPACE_ROLES.ADMIN;

  const ctx = await requireWorkspaceMembership(req, res, requiredRole);
  if (!ctx) return;

  const target = await dbGetAsync('SELECT user_id, role FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [ctx.workspace.id, targetUserId]);
  if (!target) return res.status(404).json({ error: 'Member not found.' });
  if (target.role === WORKSPACE_ROLES.OWNER) {
    return res.status(403).json({ error: 'The workspace owner cannot be removed.' });
  }
  if (target.role === WORKSPACE_ROLES.ADMIN && ctx.role !== WORKSPACE_ROLES.OWNER) {
    return res.status(403).json({ error: 'Only the owner can remove admins.' });
  }
  await dbRunAsync('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [ctx.workspace.id, targetUserId]);
  logSecurityEvent(req, 'workspace.member.removed', 'success', { workspace_id: ctx.workspace.id, target_user_id: targetUserId });
  return res.json({ removed: true });
});

router.patch('/api/workspaces/:id/members/:userId', requireSignedIn, async (req, res) => {
  const ctx = await requireWorkspaceMembership(req, res, WORKSPACE_ROLES.OWNER);
  if (!ctx) return;
  const targetUserId = Number.parseInt(req.params.userId, 10);
  if (!Number.isInteger(targetUserId) || targetUserId <= 0) return res.status(400).json({ error: 'Invalid user id.' });
  const newRole = normalizeWorkspaceRole(req.body && req.body.role);
  if (!newRole) return res.status(400).json({ error: 'Role must be "admin" or "member".' });

  const target = await dbGetAsync('SELECT user_id, role FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [ctx.workspace.id, targetUserId]);
  if (!target) return res.status(404).json({ error: 'Member not found.' });
  if (target.role === WORKSPACE_ROLES.OWNER) return res.status(403).json({ error: 'The owner role cannot be changed.' });

  await dbRunAsync('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?', [newRole, ctx.workspace.id, targetUserId]);
  return res.json({ updated: true, role: newRole });
});


router.get('/api/workspaces/:id/sso', requireSignedIn, async (req, res) => {
  const ctx = await requireWorkspaceMembership(req, res, WORKSPACE_ROLES.ADMIN);
  if (!ctx) return;
  const ssoRow = await dbGetAsync('SELECT idp_entity_id, idp_sso_url, enabled FROM sso_connections WHERE workspace_id = ?', [ctx.workspace.id]);
  const baseUrl = getPublicBaseUrl(req).replace(/\/+$/, '');
  return res.json({
    configured: !!ssoRow,
    enabled: ssoRow ? ssoRow.enabled == 1 : false,
    idp_entity_id: ssoRow ? ssoRow.idp_entity_id : '',
    idp_sso_url: ssoRow ? ssoRow.idp_sso_url : '',
    sp_entity_id: `${baseUrl}/sso/${ctx.workspace.id}/metadata`,
    acs_url: `${baseUrl}/sso/${ctx.workspace.id}/acs`,
    metadata_url: `${baseUrl}/sso/${ctx.workspace.id}/metadata`,
    login_url: `${baseUrl}/sso/${ctx.workspace.id}/login`,
  });
});

router.put('/api/workspaces/:id/sso',
  requireSignedIn,
  sensitiveActionLimiter,
  async (req, res) => {
    const uiLang = normalizeLang(req.body && req.body.lang, 'az');
    const ctx = await requireWorkspaceMembership(req, res, WORKSPACE_ROLES.OWNER);
    if (!ctx) return;
    if (!(await isWorkspaceProActive(ctx.workspace))) {
      return res.status(403).json({ error: pickLang(uiLang, 'Workspace Pro aboneliyi aktiv deyil.', 'Workspace Pro aboneliâ”€ÅŸi aktif deâ”€ÅŸil.', 'Workspace Pro subscription is not active.') });
    }

    const metadataXml = (req.body && req.body.metadataXml || '').toString();
    let parsed;
    try {
      parsed = await parseIdpMetadataXml(metadataXml);
    } catch (err) {
      return res.status(400).json({ error: (err && err.message || 'Invalid metadata.').toString().slice(0, 200) });
    }

    const nowIso = new Date().toISOString();
    const existing = await dbGetAsync('SELECT id FROM sso_connections WHERE workspace_id = ?', [ctx.workspace.id]);
    if (existing) {
      await dbRunAsync(
        'UPDATE sso_connections SET idp_entity_id = ?, idp_sso_url = ?, idp_certificate = ?, metadata_xml = ?, enabled = 1, updated_at = ? WHERE workspace_id = ?',
        [parsed.entityId, parsed.ssoLoginUrl, parsed.certificate, metadataXml, nowIso, ctx.workspace.id]
      );
    } else {
      await dbRunAsync(
        'INSERT INTO sso_connections (workspace_id, idp_entity_id, idp_sso_url, idp_certificate, metadata_xml, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
        [ctx.workspace.id, parsed.entityId, parsed.ssoLoginUrl, parsed.certificate, metadataXml, nowIso]
      );
    }
    logSecurityEvent(req, 'workspace.sso.configured', 'success', { workspace_id: ctx.workspace.id, idp_entity_id: parsed.entityId.slice(0, 128) });
    return res.json({ configured: true, enabled: true, idp_entity_id: parsed.entityId, idp_sso_url: parsed.ssoLoginUrl });
  });

router.delete('/api/workspaces/:id/sso', requireSignedIn, async (req, res) => {
  const ctx = await requireWorkspaceMembership(req, res, WORKSPACE_ROLES.OWNER);
  if (!ctx) return;
  await dbRunAsync('DELETE FROM sso_connections WHERE workspace_id = ?', [ctx.workspace.id]);
  logSecurityEvent(req, 'workspace.sso.removed', 'success', { workspace_id: ctx.workspace.id });
  return res.json({ removed: true });
});

// Resolve the SSO connection for login/ACS/metadata flows: the workspace must
// exist, its owner must be on an active Pro plan and SSO must be configured
// and enabled.
async function loadActiveWorkspaceSso(workspaceId) {
  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace) return null;
  if (!(await isWorkspaceProActive(workspace))) return null;
  const ssoRow = await dbGetAsync(
    'SELECT idp_entity_id, idp_sso_url, idp_certificate, enabled FROM sso_connections WHERE workspace_id = ?',
    [workspace.id]
  );
  if (!ssoRow || ssoRow.enabled != 1) return null;
  return { workspace, sso: ssoRow };
}

router.get('/sso/:workspaceId/metadata', async (req, res) => {
  const loaded = await loadActiveWorkspaceSso(req.params.workspaceId).catch(() => null);
  if (!loaded) return res.status(404).send('SSO is not configured for this workspace.');
  try {
    const saml = createWorkspaceSamlInstance({
      baseUrl: getPublicBaseUrl(req),
      workspaceId: loaded.workspace.id,
      entityId: loaded.sso.idp_entity_id,
      ssoLoginUrl: loaded.sso.idp_sso_url,
      certificate: loaded.sso.idp_certificate,
    });
    const metadata = saml.generateServiceProviderMetadata();
    res.set('Content-Type', 'application/samlmetadata+xml');
    res.set('Cache-Control', 'public, max-age=3600');
    return res.send(metadata);
  } catch (err) {
    console.error('[sso] metadata generation failed:', err && err.message);
    return res.status(500).send('SSO metadata error.');
  }
});

router.post('/api/auth/realm-lookup', authLimiter, async (req, res) => {
  try {
    const rawInput = (req.body && (req.body.email || req.body.domain || req.body.workspace)) || '';
    const trimmed = rawInput.toString().trim().toLowerCase();
    if (!trimmed || trimmed.length > 255) {
      return res.json({ ssoAvailable: false });
    }

    if (isPublicConsumerEmailDomain(trimmed)) {
      return res.json({ ssoAvailable: false });
    }

    const searchDomain = trimmed.includes('@') ? trimmed.split('@').pop() : trimmed;
    const numericWsId = parseInt(searchDomain, 10);

    let matchedWs = null;

    const rows = await dbAllAsync(
      `SELECT w.id, w.name, s.idp_entity_id, s.idp_sso_url, s.enabled, u.email, u.plan_tier, u.plan_status, u.pro_expires_at, w.owner_user_id
       FROM workspaces w
       JOIN sso_connections s ON s.workspace_id = w.id
       JOIN users u ON u.id = w.owner_user_id
       WHERE s.enabled = 1`
    ).catch(() => []);

    const verifiedCustomDomainOwners = new Set();
    if (searchDomain && rows.length > 0) {
      try {
        const cdRows = await dbAllAsync(
          "SELECT user_id FROM custom_domains WHERE LOWER(domain) = ? AND (status = 'active' OR status = 'verified' OR verified_at IS NOT NULL)",
          [searchDomain.toLowerCase()]
        ).catch(() => []);
        for (const cd of cdRows) {
          if (cd && cd.user_id) verifiedCustomDomainOwners.add(cd.user_id);
        }
      } catch {}
    }

    for (const r of rows) {
      if (!isProAccessActive(r)) continue;
      let ownerDomain = '';
      try {
        if (r.email) {
          const dec = decryptAES256GCM(r.email);
          if (dec && dec.includes('@')) {
            ownerDomain = dec.split('@').pop().toLowerCase();
          }
        }
      } catch {}

      const hasCustomDomain = verifiedCustomDomainOwners.has(r.owner_user_id);

      if (
        (ownerDomain && ownerDomain === searchDomain) ||
        hasCustomDomain ||
        (numericWsId && numericWsId === r.id)
      ) {
        matchedWs = { id: r.id, name: r.name };
        break;
      }
    }

    if (!matchedWs) {
      return res.json({ ssoAvailable: false });
    }

    return res.json({
      ssoAvailable: true,
      workspaceId: matchedWs.id,
      workspaceName: matchedWs.name,
      ssoLoginUrl: `/sso/${matchedWs.id}/login`
    });
  } catch (err) {
    console.error('[sso] realm-lookup error:', err && err.message);
    return res.json({ ssoAvailable: false });
  }
});

router.get('/sso/:workspaceId/login', async (req, res) => {
  const loaded = await loadActiveWorkspaceSso(req.params.workspaceId).catch(() => null);
  if (!loaded) return res.redirect('/login?sso=error');
  try {
    const returnTo = req.query.returnTo || '/dashboard';
    const relayState = createSignedRelayState(loaded.workspace.id, returnTo, process.env.SESSION_SECRET);
    
    // Bind RelayState to browser via HttpOnly cookie (F-03)
    res.cookie(`sso_relay_${loaded.workspace.id}`, relayState, {
      httpOnly: true,
      secure: isProdRuntime,
      sameSite: isProdRuntime ? 'none' : 'lax',
      maxAge: 10 * 60 * 1000,
      path: `/sso/${loaded.workspace.id}/acs`,
    });

    const saml = createWorkspaceSamlInstance({
      baseUrl: getPublicBaseUrl(req),
      workspaceId: loaded.workspace.id,
      entityId: loaded.sso.idp_entity_id,
      ssoLoginUrl: loaded.sso.idp_sso_url,
      certificate: loaded.sso.idp_certificate,
    });
    const authorizeUrl = await saml.getAuthorizeUrlAsync({
      ...req,
      headers: req.headers,
      query: { RelayState: relayState }
    });
    logSecurityEvent(req, 'sso.login.initiated', 'success', { workspace_id: loaded.workspace.id });
    return res.redirect(authorizeUrl);
  } catch (err) {
    console.error('[sso] login request failed:', err && err.message);
    logSecurityEvent(req, 'sso.login.initiated', 'failure', { workspace_id: loaded.workspace.id, detail: (err && err.message || '').slice(0, 128) });
    return res.redirect('/login?sso=error');
  }
});

router.post('/sso/:workspaceId/acs', async (req, res) => {
  const redirectError = (reason = 'error') => res.redirect(`/login?sso=${encodeURIComponent(reason)}`);
  const loaded = await loadActiveWorkspaceSso(req.params.workspaceId).catch(() => null);
  if (!loaded) return redirectError('error');

  const samlResponse = req.body && req.body.SAMLResponse;
  if (!samlResponse || typeof samlResponse !== 'string') {
    logSecurityEvent(req, 'sso.acs', 'failure', { reason: 'missing_response', workspace_id: loaded.workspace.id });
    return redirectError('error');
  }

  // Verify HMAC-signed RelayState
  const rawRelayState = req.body && req.body.RelayState;
  const { valid: isRelayValid, returnTo: safeDestination } = verifySignedRelayState(rawRelayState, loaded.workspace.id, process.env.SESSION_SECRET);
  if (!isRelayValid) {
    logSecurityEvent(req, 'sso.acs', 'blocked', { reason: 'invalid_relay_state', workspace_id: loaded.workspace.id });
    return redirectError('invalid_relay');
  }

  // Browser-bound RelayState validation (F-03)
  const cookieRelayState = getCookieValue(req, `sso_relay_${loaded.workspace.id}`);
  res.clearCookie(`sso_relay_${loaded.workspace.id}`, { path: `/sso/${loaded.workspace.id}/acs` });
  if (cookieRelayState && rawRelayState) {
    const bufA = Buffer.from(cookieRelayState);
    const bufB = Buffer.from(rawRelayState);
    if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
      logSecurityEvent(req, 'sso.acs', 'blocked', { reason: 'relay_state_browser_mismatch', workspace_id: loaded.workspace.id });
      return redirectError('invalid_relay');
    }
  }

  let profile;
  try {
    const saml = createWorkspaceSamlInstance({
      baseUrl: getPublicBaseUrl(req),
      workspaceId: loaded.workspace.id,
      entityId: loaded.sso.idp_entity_id,
      ssoLoginUrl: loaded.sso.idp_sso_url,
      certificate: loaded.sso.idp_certificate,
    });
    profile = await saml.validatePostResponseAsync({ SAMLResponse: samlResponse });
  } catch (err) {
    logSecurityEvent(req, 'sso.acs', 'failure', { reason: 'invalid_assertion', workspace_id: loaded.workspace.id, detail: (err && err.message || '').slice(0, 128) });
    return redirectError('error');
  }

  // Replay Attack Protection: Check assertion ID with fail-closed behavior (F-05)
  const assertionId = extractAssertionId(profile);
  if (assertionId) {
    try {
      const existingReplay = await dbGetAsync('SELECT assertion_id FROM sso_replay_cache WHERE assertion_id = ?', [assertionId]);
      if (existingReplay) {
        logSecurityEvent(req, 'sso.acs', 'blocked', { reason: 'replay_detected', workspace_id: loaded.workspace.id, assertion_id: assertionId });
        return redirectError('replay');
      }
      const expiryIso = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      await dbRunAsync(
        'INSERT INTO sso_replay_cache (assertion_id, workspace_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
        [assertionId, loaded.workspace.id, expiryIso, new Date().toISOString()]
      );
    } catch (replayErr) {
      console.error('[sso] replay cache error (failing closed):', replayErr && replayErr.message);
      logSecurityEvent(req, 'sso.acs', 'failure', { reason: 'replay_cache_error', workspace_id: loaded.workspace.id, detail: (replayErr && replayErr.message || '').slice(0, 128) });
      return redirectError('error');
    }
  }

  const email = extractProfileEmail(profile);
  if (!email || !email.includes('@')) {
    logSecurityEvent(req, 'sso.acs', 'failure', { reason: 'no_email_in_assertion', workspace_id: loaded.workspace.id });
    return redirectError('error');
  }

  const emailDomain = email.split('@').pop().toLowerCase();
  if (isPublicConsumerEmailDomain(emailDomain)) {
    logSecurityEvent(req, 'sso.acs', 'blocked', { reason: 'public_consumer_domain', domain: emailDomain, workspace_id: loaded.workspace.id });
    return redirectError('invalid_domain');
  }

  let user = await dbGetAsync('SELECT * FROM users WHERE email_hash = ? ORDER BY id DESC', [blindIndex(email)]);
  if (user && user.banned == 1 && (!user.ban_until || Date.parse(user.ban_until) > Date.now())) {
    logSecurityEvent(req, 'sso.acs', 'blocked', { reason: 'banned', workspace_id: loaded.workspace.id });
    return redirectError('error');
  }

  if (user) {
    // If the user is already a member of this workspace, allow SSO sign-in.
    const isMember = await dbGetAsync(
      'SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
      [loaded.workspace.id, user.id]
    );
    if (!isMember) {
      // Check if the workspace owner has a verified custom domain matching this email domain
      const wsOwner = await dbGetAsync('SELECT owner_user_id FROM workspaces WHERE id = ?', [loaded.workspace.id]);
      const ownerVerifiedDomain = wsOwner ? await dbGetAsync(
        "SELECT id FROM custom_domains WHERE user_id = ? AND domain = ? AND status = 'active'",
        [wsOwner.owner_user_id, emailDomain]
      ) : null;

      // Prevent untrusted workspaces from taking over accounts from other workspaces/domains (F-02)
      if (!ownerVerifiedDomain) {
        logSecurityEvent(req, 'sso.acs', 'blocked', { reason: 'cross_tenant_sso_blocked', workspace_id: loaded.workspace.id, email_domain: emailDomain });
        return redirectError('unauthorized_domain');
      }

      await dbRunAsync(
        'INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)',
        [loaded.workspace.id, user.id, WORKSPACE_ROLES.MEMBER, new Date().toISOString()]
      );
    }
  } else {
    // JIT provisioning: the corporate IdP vouches for the email address, so
    // the account starts verified with a random local password (SSO-only).
    const hashedPassword = await bcrypt.hash(crypto.randomBytes(32).toString('base64url'), 12);
    const inserted = await dbRunAsync(
      "INSERT INTO users (email, email_hash, password, email_verified, auth_provider, created_at, ui_lang, ui_theme, notify_report, notify_limit, notify_disabled, plan_tier, plan_status) VALUES (?, ?, ?, 1, 'sso', ?, 'az', 'light', 1, 1, 1, 'free', 'active') RETURNING id",
      [encryptAES256GCM(email), blindIndex(email), hashedPassword, new Date().toISOString()]
    );
    user = { id: inserted.lastID, email_verified: 1 };
    await dbRunAsync(
      'INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)',
      [loaded.workspace.id, user.id, WORKSPACE_ROLES.MEMBER, new Date().toISOString()]
    );
  }

  return req.session.regenerate((regenErr) => {
    if (regenErr) return redirectError('error');
    req.session.userId = user.id;
    req.session.username = email;
    dbRunAsync('UPDATE users SET last_login_at = ? WHERE id = ?', [new Date().toISOString(), user.id]).catch(() => {});
    return upsertUserSessionRecord(req, user.id, { loginMethod: 'sso' }, () => {
      return req.session.save(() => {
        logSecurityEvent(req, 'sso.acs', 'success', { workspace_id: loaded.workspace.id, user_id: user.id });
        return res.redirect(safeDestination || '/dashboard');
      });
    });
  });
});


module.exports = router;


