'use strict';

/**
 * P25 — Reusable Agency Report Templates (report-template-v1).
 *
 * Lets an agency define modular report templates (executive summary, campaign
 * comparison, top links, channel breakdown, conclusion note) once and reuse
 * them across any number of clients while keeping the Monolith visual baseline
 * (client logo is strictly decorative, never a full white-label theme hijack).
 */

const { dbGetAsync, dbRunAsync, dbAllAsync } = require('../db/helpers');

const REPORT_TEMPLATE_CONTRACT_VERSION = 'report-template-v1';
const ALLOWED_SECTIONS = [
  'executive_summary',
  'campaign_comparison',
  'top_links',
  'channel_breakdown',
  'conclusion_note',
];
const ALLOWED_LOCALES = new Set(['az', 'tr', 'en']);
const ALLOWED_PERIODS = new Set([7, 14, 30, 90]);

const LABELS = Object.freeze({
  az: {
    report_title: 'Kampaniya Hesabatı',
    client: 'Müştəri',
    period: 'Hesabat dövrü',
    executive_summary: 'İcmal',
    campaign_comparison: 'Kampaniya və kanal müqayisəsi',
    top_links: 'Ən yaxşı linklər',
    channel_breakdown: 'Kanal bölgüsü',
    conclusion_note: 'Nəticə və izah qeydi',
    clicks: 'Kliklər',
    uniques: 'Unikal ziyarətçilər',
    conversions: 'Konversiyalar',
    conversion_rate: 'Konversiya faizi',
    empty_data: 'Seçilmiş tarix aralığında qeydə alınmış klik və ya mənbə məlumatı yoxdur.',
    source_note: 'Mənbə və etibarlılıq',
    generated_at: 'Yaradılma tarixi (UTC)',
    last_data_at: 'Son məlumat tarixi (UTC)',
    snapshot_id: 'Hesabat nömrəsi',
  },
  tr: {
    report_title: 'Kampanya Raporu',
    client: 'Müşteri',
    period: 'Rapor dönemi',
    executive_summary: 'Özet',
    campaign_comparison: 'Kampanya ve kanal karşılaştırması',
    top_links: 'En iyi bağlantılar',
    channel_breakdown: 'Kanal dağılımı',
    conclusion_note: 'Sonuç ve açıklama notu',
    clicks: 'Tıklamalar',
    uniques: 'Tekil ziyaretçiler',
    conversions: 'Dönüşümler',
    conversion_rate: 'Dönüşüm oranı',
    empty_data: 'Seçilen tarih aralığında kaydedilmiş tıklama veya kaynak verisi bulunmuyor.',
    source_note: 'Kaynak ve doğruluk',
    generated_at: 'Oluşturulma tarihi (UTC)',
    last_data_at: 'Son veri tarihi (UTC)',
    snapshot_id: 'Rapor kimliği',
  },
  en: {
    report_title: 'Campaign Report',
    client: 'Client',
    period: 'Reporting period',
    executive_summary: 'Executive summary',
    campaign_comparison: 'Campaign & channel comparison',
    top_links: 'Top links',
    channel_breakdown: 'Channel breakdown',
    conclusion_note: 'Conclusion & commentary',
    clicks: 'Clicks',
    uniques: 'Unique visitors',
    conversions: 'Conversions',
    conversion_rate: 'Conversion rate',
    empty_data: 'No recorded click or source data is available for the selected period.',
    source_note: 'Source & provenance',
    generated_at: 'Generated at (UTC)',
    last_data_at: 'Last recorded data (UTC)',
    snapshot_id: 'Snapshot ID',
  },
});

let templatesTableReady = false;

function normalizeLocale(raw, fallback = 'az') {
  const s = String(raw || '').trim().toLowerCase().slice(0, 2);
  return ALLOWED_LOCALES.has(s) ? s : fallback;
}

function getTemplateLabels(lang = 'az') {
  return LABELS[normalizeLocale(lang, 'az')] || LABELS.az;
}

function cleanText(raw, maxLen = 120) {
  return String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function sanitizeLogoUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  try {
    const parsed = new URL(s);
    if (parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    return parsed.toString().slice(0, 500);
  } catch {
    return null;
  }
}

function normalizeSections(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [...ALLOWED_SECTIONS];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const key = String(item || '').trim().toLowerCase();
    if (ALLOWED_SECTIONS.includes(key) && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out.length > 0 ? out : [...ALLOWED_SECTIONS];
}

function normalizePeriodDays(raw) {
  const n = Number.parseInt(raw, 10);
  return ALLOWED_PERIODS.has(n) ? n : 30;
}

function escapeHtml(raw) {
  return String(raw == null ? '' : raw)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function ensureReportTemplatesTable(runFn = dbRunAsync) {
  if (templatesTableReady) return;
  await runFn(`CREATE TABLE IF NOT EXISTS report_templates (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    workspace_id INTEGER,
    client_id TEXT,
    name TEXT NOT NULL,
    client_name TEXT,
    logo_url TEXT,
    locale TEXT NOT NULL DEFAULT 'az',
    default_period_days INTEGER NOT NULL DEFAULT 30,
    sections_json TEXT NOT NULL,
    explanation_note TEXT,
    conclusion_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  await runFn(
    'CREATE INDEX IF NOT EXISTS idx_report_templates_user ON report_templates(user_id, client_id, id DESC)'
  ).catch(() => {});
  templatesTableReady = true;
}

function mapTemplateRow(row) {
  if (!row) return null;
  let sections = [...ALLOWED_SECTIONS];
  try {
    sections = normalizeSections(JSON.parse(row.sections_json || '[]'));
  } catch {
    sections = [...ALLOWED_SECTIONS];
  }
  return {
    id: Number(row.id),
    user_id: Number(row.user_id),
    workspace_id: row.workspace_id ? Number(row.workspace_id) : null,
    client_id: row.client_id || null,
    name: row.name,
    client_name: row.client_name || '',
    logo_url: row.logo_url || null,
    locale: normalizeLocale(row.locale, 'az'),
    default_period_days: normalizePeriodDays(row.default_period_days),
    sections,
    explanation_note: row.explanation_note || '',
    conclusion_note: row.conclusion_note || '',
    visual_baseline: 'monolith',
    logo_mode: 'decor_only',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function createReportTemplate({ userId, body = {}, dbRun = dbRunAsync } = {}) {
  await ensureReportTemplatesTable(dbRun);
  const name = cleanText(body.name, 80);
  if (name.length < 2) {
    return { error: 'invalid_name', statusCode: 400, message: 'Şablon adı ən az 2 simvol olmalıdır.' };
  }
  if (body.logo_url && !sanitizeLogoUrl(body.logo_url)) {
    return { error: 'invalid_logo_url', statusCode: 400, message: 'Logo URL yalnız etibarlı HTTPS ünvanı olmalıdır.' };
  }
  const nowIso = new Date().toISOString();
  const sections = normalizeSections(body.sections);
  const locale = normalizeLocale(body.locale, 'az');
  const periodDays = normalizePeriodDays(body.default_period_days);
  const clientName = cleanText(body.client_name, 80) || null;
  const clientId = cleanText(body.client_id, 64) || null;
  const workspaceId = body.workspace_id ? Number.parseInt(body.workspace_id, 10) || null : null;
  const logoUrl = sanitizeLogoUrl(body.logo_url);
  const explanationNote = cleanText(body.explanation_note, 600) || null;
  const conclusionNote = cleanText(body.conclusion_note, 600) || null;

  const inserted = await dbRun(
    `INSERT INTO report_templates
       (user_id, workspace_id, client_id, name, client_name, logo_url, locale,
        default_period_days, sections_json, explanation_note, conclusion_note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(userId),
      workspaceId,
      clientId,
      name,
      clientName,
      logoUrl,
      locale,
      periodDays,
      JSON.stringify(sections),
      explanationNote,
      conclusionNote,
      nowIso,
      nowIso,
    ]
  );
  return {
    template: mapTemplateRow({
      id: inserted.lastID,
      user_id: userId,
      workspace_id: workspaceId,
      client_id: clientId,
      name,
      client_name: clientName,
      logo_url: logoUrl,
      locale,
      default_period_days: periodDays,
      sections_json: JSON.stringify(sections),
      explanation_note: explanationNote,
      conclusion_note: conclusionNote,
      created_at: nowIso,
      updated_at: nowIso,
    }),
  };
}

async function listReportTemplates({ userId, clientId = null, dbAll = dbAllAsync, dbRun = dbRunAsync } = {}) {
  await ensureReportTemplatesTable(dbRun);
  const cleanClient = clientId ? cleanText(clientId, 64) : null;
  const rows = cleanClient
    ? await dbAll(
        'SELECT * FROM report_templates WHERE user_id = ? AND (client_id = ? OR client_id IS NULL) ORDER BY id DESC LIMIT 100',
        [Number(userId), cleanClient]
      )
    : await dbAll(
        'SELECT * FROM report_templates WHERE user_id = ? ORDER BY id DESC LIMIT 100',
        [Number(userId)]
      );
  return (rows || []).map(mapTemplateRow);
}

async function getReportTemplateForActor({ userId, templateId, dbGet = dbGetAsync, dbRun = dbRunAsync } = {}) {
  await ensureReportTemplatesTable(dbRun);
  const id = Number.parseInt(templateId, 10);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = await dbGet(
    'SELECT * FROM report_templates WHERE id = ? AND user_id = ? LIMIT 1',
    [id, Number(userId)]
  );
  return mapTemplateRow(row);
}

async function updateReportTemplate({ userId, templateId, body = {}, dbGet = dbGetAsync, dbRun = dbRunAsync } = {}) {
  const existing = await getReportTemplateForActor({ userId, templateId, dbGet, dbRun });
  if (!existing) return { error: 'not_found', statusCode: 404 };

  if (body.logo_url !== undefined && body.logo_url !== null && body.logo_url !== '' && !sanitizeLogoUrl(body.logo_url)) {
    return { error: 'invalid_logo_url', statusCode: 400, message: 'Logo URL yalnız etibarlı HTTPS ünvanı olmalıdır.' };
  }
  const nextName = body.name !== undefined ? cleanText(body.name, 80) : existing.name;
  if (nextName.length < 2) return { error: 'invalid_name', statusCode: 400 };
  const nextClientName = body.client_name !== undefined ? (cleanText(body.client_name, 80) || null) : existing.client_name;
  const nextClientId = body.client_id !== undefined ? (cleanText(body.client_id, 64) || null) : existing.client_id;
  const nextLogo = body.logo_url !== undefined ? sanitizeLogoUrl(body.logo_url) : existing.logo_url;
  const nextLocale = body.locale !== undefined ? normalizeLocale(body.locale, existing.locale) : existing.locale;
  const nextPeriod = body.default_period_days !== undefined ? normalizePeriodDays(body.default_period_days) : existing.default_period_days;
  const nextSections = body.sections !== undefined ? normalizeSections(body.sections) : existing.sections;
  const nextExpl = body.explanation_note !== undefined ? (cleanText(body.explanation_note, 600) || null) : existing.explanation_note;
  const nextConcl = body.conclusion_note !== undefined ? (cleanText(body.conclusion_note, 600) || null) : existing.conclusion_note;
  const nowIso = new Date().toISOString();

  await dbRun(
    `UPDATE report_templates
        SET name = ?, client_name = ?, client_id = ?, logo_url = ?, locale = ?,
            default_period_days = ?, sections_json = ?, explanation_note = ?, conclusion_note = ?, updated_at = ?
      WHERE id = ? AND user_id = ?`,
    [
      nextName,
      nextClientName,
      nextClientId,
      nextLogo,
      nextLocale,
      nextPeriod,
      JSON.stringify(nextSections),
      nextExpl,
      nextConcl,
      nowIso,
      existing.id,
      Number(userId),
    ]
  );
  return {
    template: {
      ...existing,
      name: nextName,
      client_name: nextClientName || '',
      client_id: nextClientId,
      logo_url: nextLogo,
      locale: nextLocale,
      default_period_days: nextPeriod,
      sections: nextSections,
      explanation_note: nextExpl || '',
      conclusion_note: nextConcl || '',
      updated_at: nowIso,
    },
  };
}

async function deleteReportTemplate({ userId, templateId, dbRun = dbRunAsync } = {}) {
  await ensureReportTemplatesTable(dbRun);
  const id = Number.parseInt(templateId, 10);
  if (!Number.isInteger(id) || id <= 0) return { error: 'not_found', statusCode: 404 };
  const res = await dbRun('DELETE FROM report_templates WHERE id = ? AND user_id = ?', [id, Number(userId)]);
  if (!res || !res.changes) return { error: 'not_found', statusCode: 404 };
  return { deleted: true, id };
}

/**
 * Renders a reusable agency report from a template + campaign stats/decision data.
 * Screen JSON and print HTML read from this exact same rendered model so numbers match 1:1.
 */
function renderCampaignReportFromTemplate({
  template,
  campaignStats,
  decisionReport = null,
  provenance = null,
  clientOverride = null,
  lang = null,
} = {}) {
  const safeTemplate = template || {
    id: null,
    name: 'Default Monolith Report',
    client_name: '',
    logo_url: null,
    locale: 'az',
    default_period_days: 30,
    sections: [...ALLOWED_SECTIONS],
    explanation_note: '',
    conclusion_note: '',
    visual_baseline: 'monolith',
    logo_mode: 'decor_only',
  };
  const locale = normalizeLocale(lang || safeTemplate.locale, 'az');
  const labels = getTemplateLabels(locale);

  const clicks = Number(campaignStats && campaignStats.clicks || 0);
  const uniques = Number(campaignStats && campaignStats.uniques || 0);
  const conversions = Number(campaignStats && campaignStats.conversions || 0);
  const conversionRate = Number(campaignStats && campaignStats.conversion_rate || 0);
  const topLinks = Array.isArray(campaignStats && campaignStats.top_links) ? campaignStats.top_links : [];
  const channels = Array.isArray(decisionReport && decisionReport.channel_comparison)
    ? decisionReport.channel_comparison
    : (Array.isArray(campaignStats && campaignStats.top_sources)
        ? campaignStats.top_sources.map((s) => ({ channel: s.name, clicks: Number(s.count || 0), attributed_conversions: 0 }))
        : []);

  const hasData = clicks > 0 || conversions > 0 || channels.length > 0;
  const clientName = cleanText(
    (clientOverride && clientOverride.name) || safeTemplate.client_name || (campaignStats && campaignStats.campaign && campaignStats.campaign.name) || '',
    80
  );
  const clientLogoUrl = sanitizeLogoUrl((clientOverride && clientOverride.logo_url) || safeTemplate.logo_url);

  return {
    contract_version: REPORT_TEMPLATE_CONTRACT_VERSION,
    visual_baseline: 'monolith',
    logo_mode: 'decor_only',
    locale,
    labels,
    template: {
      id: safeTemplate.id || null,
      name: safeTemplate.name,
      sections: normalizeSections(safeTemplate.sections),
    },
    header: {
      title: labels.report_title,
      client_name: clientName,
      client_logo_url: clientLogoUrl,
      campaign_name: (campaignStats && campaignStats.campaign && campaignStats.campaign.name) || '',
      period_days: (campaignStats && campaignStats.range && campaignStats.range.days) || safeTemplate.default_period_days,
      date_from_utc: (campaignStats && campaignStats.range && campaignStats.range.from) || null,
      date_to_utc: (campaignStats && campaignStats.range && campaignStats.range.to) || null,
    },
    empty_state: {
      is_empty: !hasData,
      message: !hasData ? labels.empty_data : null,
    },
    kpis: {
      clicks,
      uniques,
      conversions,
      conversion_rate_percent: conversionRate,
    },
    sections: {
      executive_summary: {
        enabled: normalizeSections(safeTemplate.sections).includes('executive_summary'),
        explanation_note: safeTemplate.explanation_note || '',
        kpis: { clicks, uniques, conversions, conversion_rate_percent: conversionRate },
      },
      campaign_comparison: {
        enabled: normalizeSections(safeTemplate.sections).includes('campaign_comparison'),
        channels,
      },
      top_links: {
        enabled: normalizeSections(safeTemplate.sections).includes('top_links'),
        items: topLinks,
      },
      conclusion_note: {
        enabled: normalizeSections(safeTemplate.sections).includes('conclusion_note'),
        text: safeTemplate.conclusion_note || '',
      },
    },
    provenance: provenance || null,
  };
}

/**
 * Generates Monolith-aligned print-ready HTML with exact 1:1 numeric parity to JSON.
 */
function renderTemplatePrintHtml(rendered) {
  const r = rendered || {};
  const l = r.labels || getTemplateLabels(r.locale || 'az');
  const h = r.header || {};
  const k = r.kpis || { clicks: 0, uniques: 0, conversions: 0, conversion_rate_percent: 0 };
  const prov = r.provenance || null;
  const logoHtml = h.client_logo_url
    ? `<img class="client-logo-decor" src="${escapeHtml(h.client_logo_url)}" alt="${escapeHtml(h.client_name)}" />`
    : '';
  const emptyBanner = r.empty_state && r.empty_state.is_empty
    ? `<p class="empty-state">${escapeHtml(r.empty_state.message)}</p>`
    : '';
  const channelRows = (r.sections && r.sections.campaign_comparison && r.sections.campaign_comparison.channels || [])
    .map((c) => `<tr><td>${escapeHtml(c.channel)}</td><td>${Number(c.clicks || 0)}</td><td>${Number(c.attributed_conversions || 0)}</td></tr>`)
    .join('');
  const linkRows = (r.sections && r.sections.top_links && r.sections.top_links.items || [])
    .map((item) => `<tr><td>${escapeHtml(item.short)}</td><td>${escapeHtml(item.original)}</td><td>${Number(item.clicks || 0)}</td></tr>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="${escapeHtml(r.locale || 'az')}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(h.title || l.report_title)} — ${escapeHtml(h.client_name || h.campaign_name)}</title>
<style>
  :root { --bg:#ffffff; --fg:#0f172a; --muted:#475569; --border:#e2e8f0; }
  * { box-sizing:border-box; }
  body { margin:0; padding:24px; font-family:system-ui,-apple-system,sans-serif; background:var(--bg); color:var(--fg); line-height:1.5; }
  .sheet { max-width:920px; margin:0 auto; }
  header { display:flex; justify-content:space-between; align-items:center; border-bottom:2px solid var(--fg); padding-bottom:12px; margin-bottom:20px; gap:16px; }
  .client-logo-decor { max-height:40px; max-width:160px; object-fit:contain; }
  .kpi-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; margin:16px 0; }
  .kpi { border:1px solid var(--border); padding:12px; border-radius:6px; }
  .kpi .label { font-size:12px; color:var(--muted); }
  .kpi .val { font-size:22px; font-weight:700; }
  table { width:100%; border-collapse:collapse; margin:12px 0 20px; font-size:14px; }
  th, td { border:1px solid var(--border); padding:8px; text-align:left; word-break:break-word; }
  th { background:#f8fafc; }
  .empty-state { padding:12px; border:1px dashed var(--border); color:var(--muted); }
  footer { margin-top:24px; padding-top:12px; border-top:1px solid var(--border); font-size:12px; color:var(--muted); }
  @media print { body { padding:0; } .sheet { max-width:100%; } }
  @media (prefers-reduced-motion: reduce) { * { transition:none !important; animation:none !important; } }
</style>
</head>
<body>
<main class="sheet">
  <header>
    <div>
      <h1>${escapeHtml(h.title || l.report_title)}</h1>
      <div><strong>${escapeHtml(l.client)}:</strong> ${escapeHtml(h.client_name || h.campaign_name)}</div>
      <div><strong>${escapeHtml(l.period)}:</strong> ${escapeHtml(String(h.period_days || 30))}d (${escapeHtml(h.date_from_utc || '—')} → ${escapeHtml(h.date_to_utc || '—')})</div>
    </div>
    ${logoHtml}
  </header>
  ${emptyBanner}
  <section class="kpi-grid" aria-label="${escapeHtml(l.executive_summary)}">
    <div class="kpi"><div class="label">${escapeHtml(l.clicks)}</div><div class="val" data-kpi="clicks">${k.clicks}</div></div>
    <div class="kpi"><div class="label">${escapeHtml(l.uniques)}</div><div class="val" data-kpi="uniques">${k.uniques}</div></div>
    <div class="kpi"><div class="label">${escapeHtml(l.conversions)}</div><div class="val" data-kpi="conversions">${k.conversions}</div></div>
    <div class="kpi"><div class="label">${escapeHtml(l.conversion_rate)}</div><div class="val" data-kpi="conversion_rate">${k.conversion_rate_percent}%</div></div>
  </section>
  ${r.sections && r.sections.executive_summary && r.sections.executive_summary.explanation_note ? `<p>${escapeHtml(r.sections.executive_summary.explanation_note)}</p>` : ''}
  ${channelRows ? `<h2>${escapeHtml(l.campaign_comparison)}</h2><table><thead><tr><th>Channel</th><th>${escapeHtml(l.clicks)}</th><th>${escapeHtml(l.conversions)}</th></tr></thead><tbody>${channelRows}</tbody></table>` : ''}
  ${linkRows ? `<h2>${escapeHtml(l.top_links)}</h2><table><thead><tr><th>Short</th><th>Destination</th><th>${escapeHtml(l.clicks)}</th></tr></thead><tbody>${linkRows}</tbody></table>` : ''}
  ${r.sections && r.sections.conclusion_note && r.sections.conclusion_note.text ? `<section><h2>${escapeHtml(l.conclusion_note)}</h2><p>${escapeHtml(r.sections.conclusion_note.text)}</p></section>` : ''}
  <footer>
    <div><strong>${escapeHtml(l.source_note)}:</strong> Ovlink Monolith Report · ${prov ? `${escapeHtml(l.snapshot_id)}: ${escapeHtml(prov.snapshot_id)} · ${escapeHtml(l.last_data_at)}: ${escapeHtml(prov.timestamps && prov.timestamps.last_data_at || '—')} · ${escapeHtml(l.generated_at)}: ${escapeHtml(prov.timestamps && prov.timestamps.generated_at || '—')}` : ''}</div>
  </footer>
</main>
</body>
</html>`;
}

module.exports = {
  REPORT_TEMPLATE_CONTRACT_VERSION,
  ALLOWED_SECTIONS,
  normalizeLocale,
  getTemplateLabels,
  sanitizeLogoUrl,
  normalizeSections,
  ensureReportTemplatesTable,
  createReportTemplate,
  listReportTemplates,
  getReportTemplateForActor,
  updateReportTemplate,
  deleteReportTemplate,
  renderCampaignReportFromTemplate,
  renderTemplatePrintHtml,
};
