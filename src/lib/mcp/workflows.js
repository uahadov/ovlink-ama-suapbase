'use strict';

/**
 * P31 — MCP Agency Business Workflows (mcp-workflows-v1).
 *
 * Two high-value, human-in-the-loop agency workflows built on top of existing
 * Ovlink primitives (campaign-wizard, decision-analytics, report-provenance):
 *   1. Campaign Launch Workflow: `prepare_campaign` (dry-run + asset validation +
 *      confirmation_token + trace_id) -> `launch_campaign` (requires human
 *      confirmation + idempotency_key + tenant scope).
 *   2. Grounded Report Summary Workflow: `summarize_report` (tenant-scoped,
 *      provenance-backed, and explicitly says "unknown / insufficient data"
 *      when no recorded data exists rather than fabricating insights).
 */

const crypto = require('crypto');
const { dbGetAsync, dbRunAsync } = require('../../db/helpers');
const campaignWizard = require('../campaign-wizard');
const campaignLib = require('../campaigns');
const decisionAnalytics = require('../decision-analytics');
const reportProvenance = require('../report-provenance');

const MCP_WORKFLOW_CONTRACT_VERSION = 'mcp-workflows-v1';
const CONFIRMATION_TTL_MINUTES = 30;

let workflowTableReady = false;

function generateTraceId() {
  return 'trc_' + crypto.randomBytes(8).toString('hex');
}

function generateConfirmationToken() {
  return 'cfm_' + crypto.randomBytes(12).toString('hex');
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw || '')).digest('hex');
}

async function ensureMcpWorkflowRunsTable(runFn = dbRunAsync) {
  if (workflowTableReady) return;
  await runFn(`CREATE TABLE IF NOT EXISTS mcp_workflow_runs (
    id SERIAL PRIMARY KEY,
    trace_id TEXT NOT NULL UNIQUE,
    workflow_name TEXT NOT NULL,
    owner_user_id INTEGER NOT NULL,
    workspace_id INTEGER,
    idempotency_key TEXT UNIQUE,
    confirmation_hash TEXT,
    confirmation_expires_at TEXT,
    status TEXT NOT NULL DEFAULT 'awaiting_confirmation',
    preview_json TEXT NOT NULL,
    result_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  await runFn('CREATE INDEX IF NOT EXISTS idx_mcp_workflow_owner ON mcp_workflow_runs(owner_user_id, id DESC)').catch(() => {});
  workflowTableReady = true;
}

/**
 * Step 1 of Workflow 1: Dry-run `prepare_campaign` + `validate_assets` + `preview_changes`.
 * Performs ZERO writes to campaigns/urls; persists only a traceable dry-run plan
 * awaiting explicit human confirmation.
 */
async function prepareCampaignWorkflow({ userId, workspaceId = null, payload = {}, dbRun = dbRunAsync } = {}) {
  await ensureMcpWorkflowRunsTable(dbRun);
  const validation = campaignWizard.validateWizardDraft(payload);
  if (!validation.valid) {
    return {
      error: 'validation_failed',
      statusCode: 400,
      issues: validation.errors || validation.issues || [],
      preview: validation,
    };
  }

  const traceId = generateTraceId();
  const confirmationToken = generateConfirmationToken();
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + CONFIRMATION_TTL_MINUTES * 60000).toISOString();

  const previewRecord = {
    draft_payload: payload,
    validated_preview: validation,
    planned_actions: ['create_campaign', 'create_utm_links', 'optional_qr_assets'],
    requires_human_confirmation: true,
  };

  await dbRun(
    `INSERT INTO mcp_workflow_runs
       (trace_id, workflow_name, owner_user_id, workspace_id, confirmation_hash,
        confirmation_expires_at, status, preview_json, created_at, updated_at)
     VALUES (?, 'campaign_launch', ?, ?, ?, ?, 'awaiting_confirmation', ?, ?, ?)`,
    [
      traceId,
      Number(userId),
      workspaceId ? Number(workspaceId) : null,
      hashToken(confirmationToken),
      expiresAt,
      JSON.stringify(previewRecord),
      nowIso,
      nowIso,
    ]
  );

  return {
    contract_version: MCP_WORKFLOW_CONTRACT_VERSION,
    trace_id: traceId,
    status: 'awaiting_confirmation',
    requires_human_confirmation: true,
    confirmation_token: confirmationToken,
    confirmation_expires_at: expiresAt,
    preview: validation,
  };
}

/**
 * Step 2 of Workflow 1: `launch_campaign`.
 * Strictly requires valid `confirmation_token`, matching `owner_user_id`, and
 * supports `idempotency_key` so repeated calls never create duplicate campaigns.
 */
async function launchCampaignWorkflow({
  userId,
  traceId,
  confirmationToken,
  idempotencyKey = null,
  dbGet = dbGetAsync,
  dbRun = dbRunAsync,
} = {}) {
  await ensureMcpWorkflowRunsTable(dbRun);
  const cleanTrace = String(traceId || '').trim();
  const cleanIdem = idempotencyKey ? String(idempotencyKey).trim().slice(0, 120) : null;

  if (cleanIdem) {
    const prior = await dbGet(
      'SELECT * FROM mcp_workflow_runs WHERE idempotency_key = ? AND owner_user_id = ? LIMIT 1',
      [cleanIdem, Number(userId)]
    );
    if (prior && prior.status === 'completed' && prior.result_json) {
      return {
        contract_version: MCP_WORKFLOW_CONTRACT_VERSION,
        trace_id: prior.trace_id,
        status: 'completed',
        deduplicated: true,
        result: JSON.parse(prior.result_json),
      };
    }
  }

  const run = await dbGet(
    'SELECT * FROM mcp_workflow_runs WHERE trace_id = ? AND owner_user_id = ? LIMIT 1',
    [cleanTrace, Number(userId)]
  );
  if (!run) {
    return { error: 'workflow_not_found', statusCode: 404, message: 'Workflow tapılmadı və ya icazəniz yoxdur.' };
  }
  if (run.status === 'completed' && run.result_json) {
    return {
      contract_version: MCP_WORKFLOW_CONTRACT_VERSION,
      trace_id: run.trace_id,
      status: 'completed',
      deduplicated: true,
      result: JSON.parse(run.result_json),
    };
  }

  if (!confirmationToken || hashToken(confirmationToken) !== run.confirmation_hash) {
    return {
      error: 'human_confirmation_required',
      statusCode: 403,
      message: 'Riskli əməliyyat insan təsdiq kodu (confirmation_token) olmadan icra edilə bilməz.',
    };
  }
  if (run.confirmation_expires_at && new Date(run.confirmation_expires_at).getTime() <= Date.now()) {
    return { error: 'confirmation_expired', statusCode: 410, message: 'Təsdiq müddəti bitib, yenidən dry-run edin.' };
  }

  const previewData = JSON.parse(run.preview_json || '{}');
  const launched = await campaignWizard.launchCampaignWizard({
    userId: Number(userId),
    payload: previewData.draft_payload || {},
  });
  if (launched.error) {
    return { error: launched.error, statusCode: launched.statusCode || 400 };
  }

  const nowIso = new Date().toISOString();
  const resultBody = launched.body || launched;
  await dbRun(
    `UPDATE mcp_workflow_runs
        SET status = 'completed', idempotency_key = COALESCE(idempotency_key, ?),
            result_json = ?, updated_at = ?
      WHERE id = ?`,
    [cleanIdem, JSON.stringify(resultBody), nowIso, Number(run.id)]
  );

  return {
    contract_version: MCP_WORKFLOW_CONTRACT_VERSION,
    trace_id: run.trace_id,
    status: 'completed',
    deduplicated: false,
    result: resultBody,
  };
}

/**
 * Workflow 2: `summarize_report` — Data-grounded report summary with provenance.
 * Explicitly returns `unknown_no_data` ("bilmirəm") when no data is recorded.
 */
async function summarizeCampaignReportWorkflow({ userId, campaignId, query = {} } = {}) {
  const campaign = await campaignLib.getCampaignForActor({ userId: Number(userId), campaignId });
  if (!campaign) {
    return { error: 'not_found', statusCode: 404, message: 'Kampaniya tapılmadı və ya icazəniz yoxdur.' };
  }

  const traceId = generateTraceId();
  const [stats, decision] = await Promise.all([
    campaignLib.loadCampaignStats({ campaign, query: { days: query.days || 30, bots: 'exclude' } }),
    decisionAnalytics.loadCampaignDecisionAnalytics({ campaign, query: { days: query.days || 30, bots: 'exclude' } }).catch(() => null),
  ]);

  const provenance = reportProvenance.buildReportProvenance({
    campaign,
    actorUserId: Number(userId),
    surface: 'json',
    reportType: 'mcp_report_summary',
    dateRange: stats.range,
    filters: { bots: 'exclude' },
    lastDataAt: stats.last_recorded_click_at,
    generatedAt: stats.generated_at,
    payloadForHash: { clicks: stats.clicks, uniques: stats.uniques, conversions: stats.conversions },
  });

  const hasData = Number(stats.clicks || 0) > 0 || Number(stats.conversions || 0) > 0;
  if (!hasData) {
    return {
      contract_version: MCP_WORKFLOW_CONTRACT_VERSION,
      trace_id: traceId,
      campaign_id: Number(campaign.id),
      answer_status: 'unknown_no_data',
      data_sufficiency: 'insufficient_data',
      summary_text: 'Kifayət qədər data yoxdur — bu dövr üçün nəticə çıxarmaq mümkün deyil (bilmirəm).',
      metrics: { clicks: 0, uniques: 0, conversions: 0, conversion_rate: 0 },
      roi: null,
      provenance,
    };
  }

  return {
    contract_version: MCP_WORKFLOW_CONTRACT_VERSION,
    trace_id: traceId,
    campaign_id: Number(campaign.id),
    answer_status: 'grounded',
    data_sufficiency: 'sufficient',
    summary_text: `${campaign.name}: ${stats.clicks} klik, ${stats.uniques} unikal ziyarətçi, ${stats.conversions} konversiya (${stats.conversion_rate}%).`,
    metrics: {
      clicks: stats.clicks,
      uniques: stats.uniques,
      conversions: stats.conversions,
      conversion_rate: stats.conversion_rate,
    },
    top_channel: decision && decision.decision_summary ? decision.decision_summary.top_by_clicks : null,
    roi: null,
    provenance,
  };
}

module.exports = {
  MCP_WORKFLOW_CONTRACT_VERSION,
  ensureMcpWorkflowRunsTable,
  prepareCampaignWorkflow,
  launchCampaignWorkflow,
  summarizeCampaignReportWorkflow,
};
