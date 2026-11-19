'use strict';

const crypto = require('crypto');
const { dbGetAsync, dbRunAsync } = require('../db/helpers');
const campaignLib = require('./campaigns');
const { recordCampaignAudit } = require('./campaign-model');

const MAX_WIZARD_CHANNELS = 12;
const MAX_WIZARD_LINKS = 20;
const CHANNEL_RE = /^[a-z0-9_-]{2,32}$/;
const SHORT_RE = /^[A-Za-z0-9_-]{3,40}$/;

const DEFAULT_CHANNELS = Object.freeze([
  'instagram',
  'whatsapp',
  'telegram',
  'facebook',
  'tiktok',
  'email',
  'print_qr',
  'web',
]);

function normalizeChannel(raw) {
  const value = String(raw == null ? '' : raw)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_-]/g, '');
  if (!CHANNEL_RE.test(value)) return null;
  return value;
}

function normalizeHttpUrl(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text || text.length > 2048) return null;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function appendCampaignUtm(rawUrl, { channel, campaignSlug, medium = 'campaign' } = {}) {
  const safeUrl = normalizeHttpUrl(rawUrl);
  if (!safeUrl) return null;
  const parsed = new URL(safeUrl);
  if (channel && !parsed.searchParams.has('utm_source')) {
    parsed.searchParams.set('utm_source', channel);
  }
  if (medium && !parsed.searchParams.has('utm_medium')) {
    parsed.searchParams.set('utm_medium', medium);
  }
  if (campaignSlug && !parsed.searchParams.has('utm_campaign')) {
    parsed.searchParams.set('utm_campaign', campaignSlug);
  }
  return parsed.toString();
}

function validateWizardDraft(payload = {}) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const errors = [];

  const cleanName = campaignLib.normalizeCampaignName(body.name || '');
  if (cleanName.length < 2) {
    errors.push({ field: 'name', code: 'invalid_name', message: 'Kampaniya adı ən az 2 simvol olmalıdır.' });
  }
  const slug = campaignLib.slugifyCampaignName(cleanName);

  const rawChannels = Array.isArray(body.channels) ? body.channels : [];
  const channels = [];
  const seenChannels = new Set();
  for (const ch of rawChannels.slice(0, MAX_WIZARD_CHANNELS)) {
    const normalized = normalizeChannel(ch);
    if (normalized && !seenChannels.has(normalized)) {
      seenChannels.add(normalized);
      channels.push(normalized);
    }
  }

  const rawLinks = Array.isArray(body.links) ? body.links : [];
  if (rawLinks.length > MAX_WIZARD_LINKS) {
    errors.push({
      field: 'links',
      code: 'too_many_links',
      message: `Bir dəfəyə maksimum ${MAX_WIZARD_LINKS} link əlavə edilə bilər.`,
    });
  }

  const previewLinks = rawLinks.slice(0, MAX_WIZARD_LINKS).map((item, idx) => {
    const entry = item && typeof item === 'object' ? item : {};
    const channel = normalizeChannel(entry.channel || channels[idx] || 'web') || 'web';
    const rawUrl = entry.url || entry.original || '';
    const taggedUrl = appendCampaignUtm(rawUrl, {
      channel,
      campaignSlug: slug || 'campaign',
      medium: entry.generate_qr ? 'qr' : 'campaign',
    });
    const customShort = entry.custom_short ? String(entry.custom_short).trim() : null;
    const shortValid = !customShort || SHORT_RE.test(customShort);

    return {
      index: idx,
      channel,
      label: String(entry.label || `${cleanName || 'Campaign'} — ${channel}`).trim().slice(0, 80),
      url: rawUrl,
      tagged_url: taggedUrl,
      custom_short: customShort,
      generate_qr: Boolean(entry.generate_qr),
      valid: Boolean(taggedUrl) && shortValid,
      error_code: !taggedUrl ? 'invalid_url' : (!shortValid ? 'invalid_short' : null),
    };
  });

  return {
    valid: errors.length === 0,
    errors,
    campaign_preview: {
      name: cleanName,
      slug: slug || '',
      goal: campaignLib.normalizeCampaignName(body.goal || ''),
      status: body.status === 'draft' ? 'draft' : 'active',
      starts_at: body.starts_at || null,
      ends_at: body.ends_at || null,
      budget_amount: body.budget_amount ?? null,
      budget_currency: body.budget_currency || null,
    },
    channels,
    links_preview: previewLinks,
  };
}

function generateShortCode() {
  return `c${crypto.randomBytes(4).toString('hex')}`;
}

function generateQrSlug() {
  return crypto.randomBytes(6).toString('hex');
}

/**
 * Orchestrates Campaign + Links + optional QR codes creation while explicitly
 * tracking per-asset outcomes so partial failures are transparent and recoverable.
 */
async function launchCampaignWizard({ userId, payload }) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const preview = validateWizardDraft(body);
  if (!preview.valid) {
    return {
      statusCode: 400,
      body: {
        error: preview.errors[0].message,
        errors: preview.errors,
      },
    };
  }

  const createdCampaign = await campaignLib.createCampaign({
    userId,
    name: body.name,
    goal: body.goal,
    goalClicks: body.goal_clicks,
    goalConversions: body.goal_conversions,
    workspaceId: body.workspace_id || null,
    status: body.status || 'active',
    startsAt: body.starts_at || null,
    endsAt: body.ends_at || null,
    budgetAmount: body.budget_amount,
    budgetCurrency: body.budget_currency,
  });

  if (createdCampaign.error) {
    const code = createdCampaign.error;
    const statusCode = code === 'duplicate' ? 409 :
      (['workspace_forbidden', 'workspace_inactive'].includes(code) ? 403 :
      (code === 'workspace_not_found' ? 404 :
      (code === 'db_error' ? 500 : 400)));
    return { statusCode, error: code };
  }

  const campaign = createdCampaign.campaign;
  const assets = [];
  const failures = [];
  let createdLinks = 0;
  let createdQrs = 0;

  for (const item of preview.links_preview) {
    if (!item.valid) {
      failures.push({
        index: item.index,
        channel: item.channel,
        url: item.url,
        status: 'failed',
        error_code: item.error_code || 'invalid_asset',
        error: item.error_code === 'invalid_short'
          ? 'Qısa kod 3-40 simvol arası (A-Z, 0-9, _, -) olmalıdır.'
          : 'Keçərli http/https URL daxil edin.',
      });
      continue;
    }

    const shortCode = item.custom_short || generateShortCode();
    try {
      const clash = await dbGetAsync('SELECT id FROM urls WHERE short = ? LIMIT 1', [shortCode]);
      if (clash) {
        failures.push({
          index: item.index,
          channel: item.channel,
          url: item.url,
          short: shortCode,
          status: 'failed',
          error_code: 'short_taken',
          error: `"${shortCode}" qısa kodu artıq istifadə olunur.`,
        });
        continue;
      }

      const nowIso = new Date().toISOString();
      const insertedLink = await dbGetAsync(
        `INSERT INTO urls (short, original, user_id, workspace_id, campaign_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         RETURNING id, short, original`,
        [
          shortCode,
          item.tagged_url,
          Number(userId),
          campaign.workspace_id || null,
          campaign.id,
          nowIso,
        ]
      );

      createdLinks += 1;
      let qrAsset = null;
      let qrError = null;

      if (item.generate_qr && insertedLink) {
        try {
          const insertedQr = await dbGetAsync(
            `INSERT INTO qr_codes (url_id, short, slug, label, color_dark, color_light, scans, created_by, created_at)
             VALUES (?, ?, ?, ?, '#000000', '#ffffff', 0, ?, ?)
             RETURNING id, slug, short, label`,
            [insertedLink.id, insertedLink.short, generateQrSlug(), item.label, Number(userId), nowIso]
          );
          if (insertedQr) {
            createdQrs += 1;
            qrAsset = {
              id: Number(insertedQr.id),
              slug: insertedQr.slug,
              scan_path: `/q/${insertedQr.slug}`,
              label: insertedQr.label,
            };
          }
        } catch {
          qrError = 'qr_create_failed';
        }
      }

      assets.push({
        index: item.index,
        channel: item.channel,
        status: qrError ? 'partial_qr_failed' : 'created',
        link: {
          id: Number(insertedLink.id),
          short: insertedLink.short,
          original: insertedLink.original,
        },
        qr: qrAsset,
        warning: qrError,
      });
    } catch {
      failures.push({
        index: item.index,
        channel: item.channel,
        url: item.url,
        short: shortCode,
        status: 'failed',
        error_code: 'link_insert_failed',
        error: 'Link yaradılarkən xəta baş verdi.',
      });
    }
  }

  const launchStatus = failures.length === 0 ? 'completed' : 'partial';
  await recordCampaignAudit(dbRunAsync, {
    userId,
    action: 'campaign.wizard_launched',
    campaignId: campaign.id,
    metadata: {
      event_id: campaign.event_id,
      launch_status: launchStatus,
      channels: preview.channels,
      requested_links: preview.links_preview.length,
      created_links: createdLinks,
      created_qrs: createdQrs,
      failed_count: failures.length,
    },
  });

  return {
    statusCode: launchStatus === 'completed' ? 201 : 207,
    body: {
      launch_status: launchStatus,
      campaign,
      channels: preview.channels,
      summary: {
        requested_links: preview.links_preview.length,
        created_links: createdLinks,
        created_qrs: createdQrs,
        failed_count: failures.length,
      },
      assets,
      failures,
    },
  };
}

module.exports = {
  DEFAULT_CHANNELS,
  MAX_WIZARD_CHANNELS,
  MAX_WIZARD_LINKS,
  normalizeChannel,
  normalizeHttpUrl,
  appendCampaignUtm,
  validateWizardDraft,
  launchCampaignWizard,
};
