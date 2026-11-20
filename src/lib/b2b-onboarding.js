'use strict';

/**
 * P41 — First 15-Minute B2B Onboarding & Product Activation (b2b-onboarding-v1).
 *
 * Guides agencies and marketing teams from signup to first real value in <15m:
 *   - Short 2-field account_type + primary_goal selector (no long forms)
 *   - 5-step checklist computed strictly from real DB state (zero fake progress):
 *       1) workspace/organization created
 *       2) client portfolio or custom domain ready
 *       3) first campaign created
 *       4) >= 2 tracking links created
 *       5) first report snapshot / portal / export generated
 *   - Non-annoying Skip, Save & Resume controls + Help entrypoint
 *   - Event-based Time-to-Value (TTV <= 900s) & drop-off analytics
 */

const { dbGetAsync, dbAllAsync, dbRunAsync } = require('../db/helpers');

const B2B_ONBOARDING_CONTRACT_VERSION = 'b2b-onboarding-v1';
const TARGET_TTV_SECONDS = 900; // 15 minutes

const ALLOWED_ACCOUNT_TYPES = new Set(['agency', 'ecommerce', 'marketing_team', 'solo']);
const ALLOWED_PRIMARY_GOALS = new Set([
  'client_reporting',
  'campaign_conversion',
  'branded_links',
  'team_collaboration',
]);

const STEP_DEFINITIONS = Object.freeze([
  {
    key: 'organization_created',
    href: '/workspaces',
    labels: {
      az: '1. İş sahəsi (təşkilat) yarat',
      tr: '1. Çalışma alanı (organizasyon) oluştur',
      en: '1. Create workspace / organization',
    },
  },
  {
    key: 'client_or_domain_ready',
    href: '/account#customDomainSection',
    labels: {
      az: '2. İlk müştəri portfeli və ya özəl domen əlavə et',
      tr: '2. İlk müşteri portföyü veya özel alan adı ekle',
      en: '2. Add first client portfolio or custom domain',
    },
  },
  {
    key: 'campaign_created',
    href: '/campaigns',
    labels: {
      az: '3. İlk kampaniyanı başlat',
      tr: '3. İlk kampanyanı başlat',
      en: '3. Launch your first campaign',
    },
  },
  {
    key: 'two_tracking_links',
    href: '/dashboard#dashboardQuickCreateForm',
    labels: {
      az: '4. Ən azı 2 izləmə linki yarat',
      tr: '4. En az 2 takip linki oluştur',
      en: '4. Create at least 2 tracking links',
    },
  },
  {
    key: 'first_report_ready',
    href: '/campaigns',
    labels: {
      az: '5. İlk müştəri hesabatını (PDF / Portal) yarat',
      tr: '5. İlk müşteri raporunu (PDF / Portal) oluştur',
      en: '5. Generate your first report (PDF / Portal)',
    },
  },
]);

let b2bOnboardingTablesReady = false;

async function ensureB2bOnboardingTables(runFn = dbRunAsync) {
  if (b2bOnboardingTablesReady) return;
  await runFn(`CREATE TABLE IF NOT EXISTS user_onboarding_profiles (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL UNIQUE,
    account_type TEXT NOT NULL DEFAULT 'agency',
    primary_goal TEXT NOT NULL DEFAULT 'client_reporting',
    skipped_at TEXT,
    started_at TEXT NOT NULL,
    activated_at TEXT,
    updated_at TEXT NOT NULL
  )`);
  await runFn(`CREATE TABLE IF NOT EXISTS onboarding_events (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    step_key TEXT,
    metadata_json TEXT,
    created_at TEXT NOT NULL
  )`);
  b2bOnboardingTablesReady = true;
}

async function safeCount(sql, params) {
  try {
    const row = await dbGetAsync(sql, params);
    return Number(row && row.cnt) || 0;
  } catch {
    return 0;
  }
}

async function recordOnboardingEvent({ userId, eventType, stepKey = null, metadata = null } = {}, runFn = dbRunAsync) {
  await ensureB2bOnboardingTables(runFn);
  await runFn(
    `INSERT INTO onboarding_events (user_id, event_type, step_key, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      Number(userId),
      String(eventType || 'unknown').slice(0, 48),
      stepKey ? String(stepKey).slice(0, 48) : null,
      metadata ? JSON.stringify(metadata) : null,
      new Date().toISOString(),
    ]
  );
}

async function saveOnboardingProfile({ userId, accountType = 'agency', primaryGoal = 'client_reporting' } = {}) {
  const uid = Number.parseInt(userId, 10);
  if (!Number.isInteger(uid) || uid <= 0) return { error: 'invalid_user', statusCode: 400 };
  const safeType = ALLOWED_ACCOUNT_TYPES.has(String(accountType || '').toLowerCase())
    ? String(accountType).toLowerCase()
    : 'agency';
  const safeGoal = ALLOWED_PRIMARY_GOALS.has(String(primaryGoal || '').toLowerCase())
    ? String(primaryGoal).toLowerCase()
    : 'client_reporting';

  await ensureB2bOnboardingTables();
  const nowIso = new Date().toISOString();
  await dbRunAsync(
    `INSERT INTO user_onboarding_profiles (user_id, account_type, primary_goal, skipped_at, started_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       account_type = EXCLUDED.account_type,
       primary_goal = EXCLUDED.primary_goal,
       skipped_at = NULL,
       updated_at = EXCLUDED.updated_at`,
    [uid, safeType, safeGoal, nowIso, nowIso]
  );
  await recordOnboardingEvent({
    userId: uid,
    eventType: 'profile_saved',
    metadata: { account_type: safeType, primary_goal: safeGoal },
  });
  return { saved: true, user_id: uid, account_type: safeType, primary_goal: safeGoal };
}

async function setOnboardingSkipped({ userId, skipped = true } = {}) {
  const uid = Number.parseInt(userId, 10);
  if (!Number.isInteger(uid) || uid <= 0) return { error: 'invalid_user', statusCode: 400 };
  await ensureB2bOnboardingTables();
  const nowIso = new Date().toISOString();
  const skippedVal = skipped ? nowIso : null;
  await dbRunAsync(
    `INSERT INTO user_onboarding_profiles (user_id, account_type, primary_goal, skipped_at, started_at, updated_at)
     VALUES (?, 'agency', 'client_reporting', ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       skipped_at = EXCLUDED.skipped_at,
       updated_at = EXCLUDED.updated_at`,
    [uid, skippedVal, nowIso, nowIso]
  );
  await recordOnboardingEvent({
    userId: uid,
    eventType: skipped ? 'onboarding_skipped' : 'onboarding_resumed',
  });
  return { user_id: uid, skipped: Boolean(skipped), updated_at: nowIso };
}

/**
 * Computes real DB-backed 5-step B2B activation progress (zero fake completion).
 */
async function loadB2bOnboardingState({ userId, lang = 'az', now = new Date() } = {}) {
  const uid = Number.parseInt(userId, 10);
  const l = (lang === 'tr' || lang === 'en') ? lang : 'az';
  await ensureB2bOnboardingTables();

  const profile = await dbGetAsync('SELECT * FROM user_onboarding_profiles WHERE user_id = ?', [uid]);

  const [wsOwned, wsMember, clientsCount, domainsCount, campaignsCount, linksCount, snapshotsCount, portalsCount] =
    await Promise.all([
      safeCount('SELECT COUNT(*) AS cnt FROM workspaces WHERE owner_user_id = ?', [uid]),
      safeCount('SELECT COUNT(*) AS cnt FROM workspace_members WHERE user_id = ?', [uid]),
      safeCount('SELECT COUNT(*) AS cnt FROM organization_clients WHERE created_by_user_id = ?', [uid]),
      safeCount('SELECT COUNT(*) AS cnt FROM custom_domains WHERE user_id = ?', [uid]),
      safeCount('SELECT COUNT(*) AS cnt FROM campaigns WHERE user_id = ?', [uid]),
      safeCount('SELECT COUNT(*) AS cnt FROM urls WHERE user_id = ?', [uid]),
      safeCount('SELECT COUNT(*) AS cnt FROM report_snapshots WHERE owner_user_id = ? OR actor_user_id = ?', [uid, uid]),
      safeCount('SELECT COUNT(*) AS cnt FROM client_portal_shares WHERE created_by_user_id = ?', [uid]),
    ]);

  const completionMap = {
    organization_created: (wsOwned + wsMember) > 0,
    client_or_domain_ready: (clientsCount + domainsCount) > 0,
    campaign_created: campaignsCount > 0,
    two_tracking_links: linksCount >= 2,
    first_report_ready: (snapshotsCount + portalsCount) > 0,
  };

  const steps = STEP_DEFINITIONS.map((def) => ({
    key: def.key,
    label: def.labels[l],
    href: def.href,
    done: Boolean(completionMap[def.key]),
  }));

  const completedCount = steps.filter((s) => s.done).length;
  const allCompleted = completedCount === steps.length;
  const skipped = Boolean(profile && profile.skipped_at);

  let activatedAt = profile && profile.activated_at ? profile.activated_at : null;
  if (allCompleted && !activatedAt) {
    activatedAt = now.toISOString();
    const startedAt = (profile && profile.started_at) || activatedAt;
    await dbRunAsync(
      `INSERT INTO user_onboarding_profiles (user_id, account_type, primary_goal, skipped_at, started_at, activated_at, updated_at)
       VALUES (?, 'agency', 'client_reporting', NULL, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET
         activated_at = COALESCE(user_onboarding_profiles.activated_at, EXCLUDED.activated_at),
         updated_at = EXCLUDED.updated_at`,
      [uid, startedAt, activatedAt, activatedAt]
    );
    await recordOnboardingEvent({ userId: uid, eventType: 'onboarding_activated' });
  }

  let timeToValueSeconds = null;
  if (activatedAt && profile && profile.started_at) {
    const diffMs = new Date(activatedAt).getTime() - new Date(profile.started_at).getTime();
    if (!Number.isNaN(diffMs) && diffMs >= 0) {
      timeToValueSeconds = Math.round(diffMs / 1000);
    }
  }

  const nextStep = steps.find((s) => !s.done) || null;

  return {
    contract_version: B2B_ONBOARDING_CONTRACT_VERSION,
    user_id: uid,
    account_type: (profile && profile.account_type) || null,
    primary_goal: (profile && profile.primary_goal) || null,
    skipped,
    completed: allCompleted,
    show_banner: !skipped && !allCompleted,
    no_repeated_popups: true,
    progress_percent: Math.round((completedCount / steps.length) * 100),
    completed_steps: completedCount,
    total_steps: steps.length,
    next_step: nextStep,
    steps,
    time_to_value_seconds: timeToValueSeconds,
    within_15m_target: timeToValueSeconds !== null ? timeToValueSeconds <= TARGET_TTV_SECONDS : null,
    help_entrypoint: '/help',
    guide_entrypoint: '/l/agency-client-reporting',
  };
}

async function getOnboardingDropoffSummary() {
  await ensureB2bOnboardingTables();
  const rows = await dbAllAsync(
    'SELECT event_type, COUNT(*)::int AS total FROM onboarding_events GROUP BY event_type ORDER BY event_type ASC',
    []
  );
  const counts = {};
  for (const r of rows || []) counts[r.event_type] = Number(r.total) || 0;
  return {
    contract_version: B2B_ONBOARDING_CONTRACT_VERSION,
    target_ttv_seconds: TARGET_TTV_SECONDS,
    event_counts: counts,
  };
}

module.exports = {
  B2B_ONBOARDING_CONTRACT_VERSION,
  TARGET_TTV_SECONDS,
  STEP_DEFINITIONS,
  ensureB2bOnboardingTables,
  saveOnboardingProfile,
  setOnboardingSkipped,
  loadB2bOnboardingState,
  getOnboardingDropoffSummary,
};
