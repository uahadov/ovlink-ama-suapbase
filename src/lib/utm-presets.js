'use strict';

const { dbGetAsync, dbRunAsync, dbAllAsync, withTransaction } = require('../db/helpers');
const { getWorkspaceMemberRole, getWorkspaceById } = require('../routes/api/workspaces');
const { canWorkspaceRole } = require('./link-access');
const {
  normalizeConvention,
  normalizeUtmValue,
  applyUtmPreset,
  buildChannelUtmPreview,
} = require('./utm');
const { recordCampaignAudit } = require('./campaign-model');

const MAX_PRESETS_PER_SCOPE = 100;
const PRESET_NAME_MAX = 80;

let utmTableReadyPromise = null;

async function ensureUtmPresetsTable() {
  if (utmTableReadyPromise) return utmTableReadyPromise;
  utmTableReadyPromise = (async () => {
    try {
      const existing = await dbGetAsync(
        "SELECT table_name FROM information_schema.tables WHERE table_name = 'utm_presets'",
        []
      );
      if (existing && existing.table_name === 'utm_presets') return;
    } catch {
      // Continue to idempotent creation
    }

    const statements = [
      `CREATE TABLE IF NOT EXISTS utm_presets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        workspace_id INTEGER,
        client_id TEXT,
        name TEXT NOT NULL,
        utm_source TEXT,
        utm_medium TEXT,
        utm_campaign TEXT,
        utm_term TEXT,
        utm_content TEXT,
        convention_json TEXT,
        created_at TEXT,
        updated_at TEXT
      )`,
      'CREATE INDEX IF NOT EXISTS idx_utm_presets_user ON utm_presets(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_utm_presets_workspace ON utm_presets(workspace_id, client_id)',
    ];

    try {
      await withTransaction(async (tx) => {
        await tx.run('SELECT pg_advisory_xact_lock(17172026)', []);
        for (const sql of statements) {
          await tx.run(sql, []);
        }
      });
    } catch {
      for (const sql of statements) {
        try { await dbRunAsync(sql, []); } catch {}
      }
    }
  })().catch(() => {
    utmTableReadyPromise = null;
  });
  return utmTableReadyPromise;
}

function serializePreset(row) {
  if (!row) return null;
  let convention = normalizeConvention(null);
  if (row.convention_json) {
    try {
      convention = normalizeConvention(JSON.parse(row.convention_json));
    } catch {}
  }
  return {
    id: Number(row.id),
    user_id: Number(row.user_id),
    workspace_id: row.workspace_id ? Number(row.workspace_id) : null,
    client_id: row.client_id || null,
    name: row.name || '',
    utm_source: row.utm_source || '',
    utm_medium: row.utm_medium || '',
    utm_campaign: row.utm_campaign || '',
    utm_term: row.utm_term || '',
    utm_content: row.utm_content || '',
    convention,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

async function listUtmPresets({ userId, workspaceId = null, clientId = null } = {}) {
  const uid = Number.parseInt(userId, 10);
  if (!Number.isInteger(uid) || uid <= 0) return [];
  await ensureUtmPresetsTable();

  const params = [uid, uid];
  let filterSql = '';
  if (workspaceId !== null && workspaceId !== undefined && workspaceId !== '') {
    const wsId = Number.parseInt(workspaceId, 10);
    if (Number.isInteger(wsId) && wsId > 0) {
      filterSql += ' AND p.workspace_id = ?';
      params.push(wsId);
    }
  }
  if (clientId !== null && clientId !== undefined && String(clientId).trim() !== '') {
    filterSql += ' AND p.client_id = ?';
    params.push(String(clientId).trim().slice(0, 64));
  }

  const rows = await dbAllAsync(
    `SELECT p.*
       FROM utm_presets p
      WHERE (
        (p.workspace_id IS NULL AND p.user_id = ?) OR
        (p.workspace_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM workspace_members wm
           WHERE wm.workspace_id = p.workspace_id AND wm.user_id = ?
        ))
      )${filterSql}
      ORDER BY p.id DESC
      LIMIT ${MAX_PRESETS_PER_SCOPE}`,
    params
  );
  return (rows || []).map(serializePreset);
}

async function getUtmPresetForActor({ userId, presetId, write = false } = {}) {
  const uid = Number.parseInt(userId, 10);
  const id = Number.parseInt(presetId, 10);
  if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(id) || id <= 0) return null;
  await ensureUtmPresetsTable();

  const roleClause = write ? " AND wm.role IN ('owner', 'admin')" : '';
  const row = await dbGetAsync(
    `SELECT p.*
       FROM utm_presets p
      WHERE p.id = ? AND (
        (p.workspace_id IS NULL AND p.user_id = ?) OR
        (p.workspace_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM workspace_members wm
           WHERE wm.workspace_id = p.workspace_id AND wm.user_id = ?${roleClause}
        ))
      )
      LIMIT 1`,
    [id, uid, uid]
  );
  return serializePreset(row);
}

async function createUtmPreset({ userId, body = {} } = {}) {
  const uid = Number.parseInt(userId, 10);
  if (!Number.isInteger(uid) || uid <= 0) return { error: 'unauthorized', statusCode: 401 };
  await ensureUtmPresetsTable();

  const name = String(body.name || '').trim().slice(0, PRESET_NAME_MAX);
  if (name.length < 2) return { error: 'invalid_name', statusCode: 400 };

  let ownerId = uid;
  let scopedWorkspaceId = null;
  if (body.workspace_id !== null && body.workspace_id !== undefined && body.workspace_id !== '') {
    const wsId = Number.parseInt(body.workspace_id, 10);
    if (!Number.isInteger(wsId) || wsId <= 0) return { error: 'invalid_workspace', statusCode: 400 };
    const ws = await getWorkspaceById(wsId);
    if (!ws) return { error: 'workspace_not_found', statusCode: 404 };
    const role = await getWorkspaceMemberRole(uid, wsId);
    if (!canWorkspaceRole(role, 'campaign.create')) return { error: 'workspace_forbidden', statusCode: 403 };
    ownerId = Number(ws.owner_user_id);
    scopedWorkspaceId = wsId;
  }

  const clientId = body.client_id ? String(body.client_id).trim().slice(0, 64) : null;
  const convention = normalizeConvention(body.convention);
  const utmSource = normalizeUtmValue(body.utm_source, convention);
  const utmMedium = normalizeUtmValue(body.utm_medium, convention);
  const utmCampaign = normalizeUtmValue(body.utm_campaign, convention);
  const utmTerm = normalizeUtmValue(body.utm_term, convention);
  const utmContent = normalizeUtmValue(body.utm_content, convention);

  if (!utmSource && !utmMedium && !utmCampaign && !utmTerm && !utmContent) {
    return { error: 'empty_utm', statusCode: 400 };
  }

  const nowIso = new Date().toISOString();
  const inserted = await dbGetAsync(
    `INSERT INTO utm_presets
       (user_id, workspace_id, client_id, name, utm_source, utm_medium, utm_campaign, utm_term, utm_content, convention_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING *`,
    [
      ownerId,
      scopedWorkspaceId,
      clientId,
      name,
      utmSource || null,
      utmMedium || null,
      utmCampaign || null,
      utmTerm || null,
      utmContent || null,
      JSON.stringify(convention),
      nowIso,
      nowIso,
    ]
  );

  const preset = serializePreset(inserted);
  await recordCampaignAudit(dbRunAsync, {
    userId: uid,
    action: 'utm_preset.created',
    campaignId: null,
    metadata: {
      preset_id: preset.id,
      workspace_id: scopedWorkspaceId,
      client_id: clientId,
      convention,
    },
  });
  return { preset };
}

async function updateUtmPreset({ userId, presetId, body = {} } = {}) {
  const existing = await getUtmPresetForActor({ userId, presetId, write: true });
  if (!existing) return { error: 'not_found', statusCode: 404 };

  const convention = body.convention !== undefined
    ? normalizeConvention(body.convention)
    : existing.convention;

  const nextName = body.name !== undefined ? String(body.name || '').trim().slice(0, PRESET_NAME_MAX) : existing.name;
  if (nextName.length < 2) return { error: 'invalid_name', statusCode: 400 };

  const nextSource = body.utm_source !== undefined ? normalizeUtmValue(body.utm_source, convention) : existing.utm_source;
  const nextMedium = body.utm_medium !== undefined ? normalizeUtmValue(body.utm_medium, convention) : existing.utm_medium;
  const nextCampaign = body.utm_campaign !== undefined ? normalizeUtmValue(body.utm_campaign, convention) : existing.utm_campaign;
  const nextTerm = body.utm_term !== undefined ? normalizeUtmValue(body.utm_term, convention) : existing.utm_term;
  const nextContent = body.utm_content !== undefined ? normalizeUtmValue(body.utm_content, convention) : existing.utm_content;

  const updated = await dbGetAsync(
    `UPDATE utm_presets
        SET name = ?, utm_source = ?, utm_medium = ?, utm_campaign = ?, utm_term = ?, utm_content = ?, convention_json = ?, updated_at = ?
      WHERE id = ?
      RETURNING *`,
    [
      nextName,
      nextSource || null,
      nextMedium || null,
      nextCampaign || null,
      nextTerm || null,
      nextContent || null,
      JSON.stringify(convention),
      new Date().toISOString(),
      existing.id,
    ]
  );

  const preset = serializePreset(updated);
  await recordCampaignAudit(dbRunAsync, {
    userId,
    action: 'utm_preset.updated',
    campaignId: null,
    metadata: {
      preset_id: preset.id,
      changed_fields: Object.keys(body || {}),
      convention,
    },
  });
  return { preset };
}

async function deleteUtmPreset({ userId, presetId } = {}) {
  const existing = await getUtmPresetForActor({ userId, presetId, write: true });
  if (!existing) return { error: 'not_found', statusCode: 404 };

  await dbRunAsync('DELETE FROM utm_presets WHERE id = ?', [existing.id]);
  await recordCampaignAudit(dbRunAsync, {
    userId,
    action: 'utm_preset.deleted',
    campaignId: null,
    metadata: { preset_id: existing.id, name: existing.name },
  });
  return { deleted: true, id: existing.id };
}

module.exports = {
  ensureUtmPresetsTable,
  listUtmPresets,
  getUtmPresetForActor,
  createUtmPreset,
  updateUtmPreset,
  deleteUtmPreset,
  applyUtmPreset,
  buildChannelUtmPreview,
};
