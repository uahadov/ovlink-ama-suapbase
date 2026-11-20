'use strict';

/**
 * P40 — Pricing Matrix, 5-Step Interactive Synthetic Demo, Book-a-Demo Lead Capture
 *       & CTA Attribution Funnel (demo-funnel-v1).
 *
 * Guarantees:
 *   - Pricing tiers & limits pull directly from real PLAN_ENTITLEMENT_MATRIX +
 *     PLAN_MONTHLY_REVENUE_USD (no unimplemented features sold)
 *   - 5-step interactive demo uses explicitly labeled synthetic data so visitors
 *     see real value before signing up into an empty account
 *   - Book-a-Demo lead form enforces explicit consent & honeypot spam rejection
 *   - CTA attribution funnel tracks pricing views, demo steps, and bookings
 */

const crypto = require('node:crypto');
const { dbAllAsync, dbRunAsync } = require('../db/helpers');
const { PLAN_ENTITLEMENT_MATRIX, EXISTING_LINKS_POLICY } = require('./plan-entitlements');
const { PLAN_MONTHLY_REVENUE_USD, PLAN_WORST_CASE_CAPS } = require('./unit-economics');

const DEMO_FUNNEL_CONTRACT_VERSION = 'demo-funnel-v1';
const ALLOWED_PLAN_INTEREST = new Set(['free', 'starter', 'business', 'agency', 'enterprise']);
const ALLOWED_FUNNEL_EVENTS = new Set([
  'pricing_view',
  'demo_step_view',
  'demo_completed',
  'cta_trial_click',
  'cta_demo_submit',
]);

const INTERACTIVE_DEMO_STEPS = Object.freeze([
  {
    step: 1,
    key: 'campaign_link',
    title: {
      az: '1. Brend kampaniya linki və UTM şablonu',
      tr: '1. Markalı kampanya linki ve UTM şablonu',
      en: '1. Branded campaign link & UTM preset',
    },
    detail: {
      az: 'go.demo-agency.az/yaz-2026 · Instagram & TikTok kanalları üçün vahid UTM standartı.',
      tr: 'go.demo-agency.az/bahar-2026 · Instagram ve TikTok kanalları için tek tip UTM standardı.',
      en: 'go.demo-agency.az/spring-2026 · Standardized UTMs for Instagram and TikTok channels.',
    },
    metric: 'UTM preset · 0 manual typo',
  },
  {
    step: 2,
    key: 'dynamic_qr',
    title: {
      az: '2. Çapa hazır dinamik QR kod',
      tr: '2. Baskıya hazır dinamik QR kod',
      en: '2. Print-safe dynamic QR code',
    },
    detail: {
      az: 'WCAG kontrast yoxlaması, SVG/PNG 2048px ixracı və skanların kliklərdən ayrı sayılması.',
      tr: 'WCAG kontrast kontrolü, SVG/PNG 2048px dışa aktarım ve taramaların tıklamalardan ayrı sayımı.',
      en: 'WCAG contrast check, 2048px SVG/PNG export, and separate QR scan vs link click counts.',
    },
    metric: '1,920 synthetic scans · ECC H',
  },
  {
    step: 3,
    key: 'decision_analytics',
    title: {
      az: '3. Bot-filtrli qərar analitikası',
      tr: '3. Bot filtreli karar analitiği',
      en: '3. Bot-filtered decision analytics',
    },
    detail: {
      az: '14,820 insan kliki, 11,340 unikal ziyarətçi, 232 sifariş (valyutalar ayrı, uydurma ROI yoxdur).',
      tr: '14.820 insan tıklama, 11.340 tekil ziyaretçi, 232 sipariş (para birimleri ayrı, yapay ROI yok).',
      en: '14,820 human clicks, 11,340 unique visitors, 232 orders (currencies separated, zero fake ROI).',
    },
    metric: '7-day last-touch · Synthetic demo',
  },
  {
    step: 4,
    key: 'client_portal',
    title: {
      az: '4. Yalnız baxış üçün müştəri portalı',
      tr: '4. Salt okunur müşteri portalı',
      en: '4. Revocable read-only client portal',
    },
    detail: {
      az: 'Müştəri əlavə ödənişsiz və parolsuz təhlükəsiz linklə nəticəyə baxır; siz istənilən vaxt ləğv edirsiniz.',
      tr: 'Müşteri ek ücret olmadan güvenli bağlantı ile raporu görür; siz dilediğiniz an iptal edersiniz.',
      en: 'Clients view live results via a revocable token link at no extra seat fee.',
    },
    metric: 'Snapshot #rev-4 · Read-only',
  },
  {
    step: 5,
    key: 'scheduled_pdf',
    title: {
      az: '5. Avtomatik A4 PDF hesabat və göndəriş',
      tr: '5. Otomatik A4 PDF rapor ve gönderim',
      en: '5. Scheduled A4 PDF report & delivery',
    },
    detail: {
      az: 'Hər ayın 1-i CSV ilə 1:1 eyni rəqəmli, sübut ID-li A4 PDF avtomatik hazırlanır.',
      tr: 'Her ayın 1’inde CSV ile 1:1 uyumlu, kanıt ID’li A4 PDF otomatik oluşturulur.',
      en: 'Every month, a 1:1 CSV-verified A4 PDF with provenance snapshot ID is generated automatically.',
    },
    metric: '<10ms PDF · 1:1 CSV parity',
  },
]);

let funnelTablesReady = false;

async function ensureDemoFunnelTables(runFn = dbRunAsync) {
  if (funnelTablesReady) return;
  await runFn(`CREATE TABLE IF NOT EXISTS demo_leads (
    id SERIAL PRIMARY KEY,
    booking_ref TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    email_hash TEXT NOT NULL,
    company TEXT,
    plan_interest TEXT NOT NULL,
    source_cta TEXT,
    utm_source TEXT,
    utm_campaign TEXT,
    consent_given BOOLEAN NOT NULL DEFAULT TRUE,
    status TEXT NOT NULL DEFAULT 'requested',
    created_at TEXT NOT NULL
  )`);
  await runFn(`CREATE TABLE IF NOT EXISTS funnel_events (
    id SERIAL PRIMARY KEY,
    event_type TEXT NOT NULL,
    plan_code TEXT,
    source_cta TEXT,
    utm_source TEXT,
    utm_campaign TEXT,
    created_at TEXT NOT NULL
  )`);
  funnelTablesReady = true;
}

function getPublicPricingCatalog(lang = 'az') {
  const l = (lang === 'tr' || lang === 'en') ? lang : 'az';
  const tiers = ['free', 'starter', 'business', 'agency', 'enterprise'].map((code) => ({
    plan_code: code,
    monthly_usd: PLAN_MONTHLY_REVENUE_USD[code],
    indicative_azn: Math.round(PLAN_MONTHLY_REVENUE_USD[code] * 1.7),
    annual_monthly_usd: PLAN_MONTHLY_REVENUE_USD[code] > 0
      ? Math.round((PLAN_MONTHLY_REVENUE_USD[code] * 10 / 12) * 100) / 100
      : 0,
    limits: PLAN_ENTITLEMENT_MATRIX[code],
    monthly_clicks_cap: PLAN_WORST_CASE_CAPS[code].redirects,
  }));

  return {
    contract_version: DEMO_FUNNEL_CONTRACT_VERSION,
    synthetic_demo_disclaimer: l === 'tr'
      ? 'İnteraktif demo sentetik örnek verilerle çalışır; gerçek müşteri verisi değildir.'
      : l === 'en'
        ? 'Interactive demo uses synthetic sample data, not live customer records.'
        : 'İnteraktiv demo sintetik nümunə məlumatları ilə işləyir; real müştəri məlumatı deyil.',
    trial_terms: {
      trial_days_options: [7, 14],
      cancel_anytime: true,
      no_card_for_free: true,
      annual_months_free: 2,
      legacy_pro_preserved: true,
    },
    existing_links_policy: EXISTING_LINKS_POLICY,
    tiers,
    demo_steps: INTERACTIVE_DEMO_STEPS.map((s) => ({
      step: s.step,
      key: s.key,
      title: s.title[l],
      detail: s.detail[l],
      metric: s.metric,
    })),
  };
}

function validateDemoBookingInput(input = {}) {
  // Honeypot anti-spam check
  if (String(input.website_url || '').trim().length > 0) {
    return { error: 'spam_detected', statusCode: 400 };
  }
  const name = String(input.name || '').trim();
  const email = String(input.email || '').trim().toLowerCase();
  const company = String(input.company || '').trim().slice(0, 120);
  const planInterest = String(input.plan_interest || 'business').trim().toLowerCase();
  const consent = input.consent_given === true || input.consent_given === 'true' || input.consent_given === 'on';

  if (name.length < 2 || name.length > 100) {
    return { error: 'invalid_name', statusCode: 400 };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 180) {
    return { error: 'invalid_email', statusCode: 400 };
  }
  if (!consent) {
    return { error: 'consent_required', statusCode: 400 };
  }
  const safePlan = ALLOWED_PLAN_INTEREST.has(planInterest) ? planInterest : 'business';
  return {
    ok: true,
    name,
    emailHash: crypto.createHash('sha256').update(email).digest('hex'),
    company: company || null,
    planInterest: safePlan,
    sourceCta: String(input.source_cta || 'pricing_demo_form').trim().slice(0, 64),
    utmSource: String(input.utm_source || '').trim().slice(0, 64) || null,
    utmCampaign: String(input.utm_campaign || '').trim().slice(0, 64) || null,
  };
}

async function createDemoBooking(input = {}, runFn = dbRunAsync) {
  const checked = validateDemoBookingInput(input);
  if (checked.error) return checked;

  await ensureDemoFunnelTables(runFn);
  const nowIso = new Date().toISOString();
  const bookingRef = `DEMO-${nowIso.slice(0, 4)}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

  await runFn(
    `INSERT INTO demo_leads (booking_ref, name, email_hash, company, plan_interest, source_cta, utm_source, utm_campaign, consent_given, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, TRUE, 'requested', ?)`,
    [
      bookingRef,
      checked.name,
      checked.emailHash,
      checked.company,
      checked.planInterest,
      checked.sourceCta,
      checked.utmSource,
      checked.utmCampaign,
      nowIso,
    ]
  );

  await recordFunnelEvent({
    eventType: 'cta_demo_submit',
    planCode: checked.planInterest,
    sourceCta: checked.sourceCta,
    utmSource: checked.utmSource,
    utmCampaign: checked.utmCampaign,
  }, runFn);

  return {
    contract_version: DEMO_FUNNEL_CONTRACT_VERSION,
    booking_ref: bookingRef,
    status: 'requested',
    plan_interest: checked.planInterest,
    consent_recorded: true,
    created_at: nowIso,
  };
}

async function recordFunnelEvent({
  eventType,
  planCode = null,
  sourceCta = null,
  utmSource = null,
  utmCampaign = null,
} = {}, runFn = dbRunAsync) {
  const ev = String(eventType || '').trim().toLowerCase();
  if (!ALLOWED_FUNNEL_EVENTS.has(ev)) {
    return { error: 'invalid_funnel_event', statusCode: 400 };
  }
  await ensureDemoFunnelTables(runFn);
  const nowIso = new Date().toISOString();
  await runFn(
    `INSERT INTO funnel_events (event_type, plan_code, source_cta, utm_source, utm_campaign, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      ev,
      planCode ? String(planCode).slice(0, 32) : null,
      sourceCta ? String(sourceCta).slice(0, 64) : null,
      utmSource ? String(utmSource).slice(0, 64) : null,
      utmCampaign ? String(utmCampaign).slice(0, 64) : null,
      nowIso,
    ]
  );
  return { recorded: true, event_type: ev, created_at: nowIso };
}

async function getFunnelSummary(allFn = dbAllAsync) {
  await ensureDemoFunnelTables();
  const rows = await allFn(
    'SELECT event_type, COUNT(*)::int AS total FROM funnel_events GROUP BY event_type ORDER BY event_type ASC',
    []
  );
  const counts = {};
  for (const r of rows || []) {
    counts[r.event_type] = Number(r.total) || 0;
  }
  return {
    contract_version: DEMO_FUNNEL_CONTRACT_VERSION,
    counts,
  };
}

module.exports = {
  DEMO_FUNNEL_CONTRACT_VERSION,
  INTERACTIVE_DEMO_STEPS,
  ensureDemoFunnelTables,
  getPublicPricingCatalog,
  validateDemoBookingInput,
  createDemoBooking,
  recordFunnelEvent,
  getFunnelSummary,
};
