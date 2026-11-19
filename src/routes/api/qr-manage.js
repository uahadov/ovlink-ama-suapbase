const crypto = require('crypto');
const express = require('express');
const router = express.Router();

const { dbGetAsync, dbRunAsync, dbAllAsync } = require('../../db/helpers');
const { buildAbsoluteUrl } = require('../../lib/security');
const {
  evaluateQrContrast,
  normalizeExportOptions,
  renderPrintQr,
  buildLifecycleNotice,
  buildQrMetricsPayload,
  LOGO_SAFE_ZONE,
} = require('../../lib/qr-assets');

const SHORT_RE = /^(?:[A-Za-z0-9_-]{1,64})$/;
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const MAX_LABEL = 80;
const MAX_QRS_PER_USER = 200;

const ERROR_MESSAGES = {
  unauthorized: 'Giriş gerekli.',
  invalid_short: 'Keçid kodu düzgün deyil.',
  invalid_color: 'Rəng formatı düzgün deyil.',
  not_found: 'QR kod tapılmadı.',
  limit: 'QR kod limitinə çatdınız.',
  db_error: 'Əməliyyat alınmadı.',
};

function currentUserId(req) {
  if (!req.session || !req.session.userId) return 0;
  const id = Number.parseInt(req.session.userId, 10);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

function readLang(req) {
  const raw = (req.query && req.query.lang) || (req.body && req.body.lang) || req.headers['accept-language'] || 'az';
  return String(raw).trim().toLowerCase().slice(0, 2);
}

function readColor(value, fallback) {
  const raw = (value == null ? '' : value).toString().trim();
  if (!raw) return fallback;
  return HEX_RE.test(raw) ? raw : null;
}

function readLabel(value) {
  return (value == null ? '' : value).toString().trim().slice(0, MAX_LABEL) || null;
}

function generateSlug() {
  return crypto.randomBytes(6).toString('hex');
}

function serializeRow(row, req) {
  const colorDark = row.color_dark || '#000000';
  const colorLight = row.color_light || '#ffffff';
  const contrast = evaluateQrContrast(colorDark, colorLight, readLang(req));
  const scanUrl = row.deleted_at
    ? null
    : buildAbsoluteUrl(req, `/q/${encodeURIComponent(String(row.slug || row.id))}`);

  return {
    id: row.id,
    short: row.short,
    slug: row.slug,
    label: row.label || '',
    colorDark,
    colorLight,
    scans: Number(row.scans) || 0,
    linkClicks: row.link_clicks != null ? Number(row.link_clicks) || 0 : 0,
    destinationUrl: row.destination_url || null,
    campaignId: row.campaign_id != null ? Number(row.campaign_id) : null,
    campaignName: row.campaign_name || null,
    contrastRatio: contrast.contrast_ratio,
    printReady: contrast.print_ready,
    logoSafeZone: LOGO_SAFE_ZONE,
    createdAt: row.created_at,
    scanUrl,
    exportUrls: row.deleted_at
      ? null
      : {
          svg: `/api/qr/${row.id}/export?format=svg&size=1024&ecc=H`,
          png: `/api/qr/${row.id}/export?format=png&size=1024&ecc=H`,
        },
  };
}

async function findOwnedQr(userId, id) {
  const qrId = Number.parseInt(id, 10);
  if (!Number.isInteger(qrId) || qrId <= 0) return null;
  return dbGetAsync(
    `SELECT q.*,
            u.original AS destination_url,
            COALESCE((SELECT COUNT(*) FROM clicks cl WHERE cl.url_id = q.url_id), 0) AS link_clicks,
            u.campaign_id AS campaign_id,
            c.name AS campaign_name
       FROM qr_codes q
       LEFT JOIN urls u ON u.id = q.url_id
       LEFT JOIN campaigns c ON c.id = u.campaign_id
      WHERE q.id = ? AND q.created_by = ? AND q.deleted_at IS NULL`,
    [qrId, userId]
  );
}

// GET /api/qr -> the caller's QR codes (optional ?campaign_id= filter)
router.get('/api/qr', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });

  const rawCampaignId = req.query && req.query.campaign_id;
  let campaignId = null;
  if (rawCampaignId !== undefined && rawCampaignId !== '') {
    campaignId = Number.parseInt(rawCampaignId, 10);
    if (!Number.isInteger(campaignId) || campaignId <= 0) {
      return res.status(400).json({ error: 'Kampaniya ID düzgün deyil.' });
    }
  }

  try {
    const sql = campaignId
      ? `SELECT q.*,
                u.original AS destination_url,
                COALESCE((SELECT COUNT(*) FROM clicks cl WHERE cl.url_id = q.url_id), 0) AS link_clicks,
                u.campaign_id AS campaign_id,
                c.name AS campaign_name
           FROM qr_codes q
           LEFT JOIN urls u ON u.id = q.url_id
           LEFT JOIN campaigns c ON c.id = u.campaign_id
          WHERE q.created_by = ? AND q.deleted_at IS NULL AND u.campaign_id = ?
          ORDER BY q.created_at DESC, q.id DESC
          LIMIT 200`
      : `SELECT q.*,
                u.original AS destination_url,
                COALESCE((SELECT COUNT(*) FROM clicks cl WHERE cl.url_id = q.url_id), 0) AS link_clicks,
                u.campaign_id AS campaign_id,
                c.name AS campaign_name
           FROM qr_codes q
           LEFT JOIN urls u ON u.id = q.url_id
           LEFT JOIN campaigns c ON c.id = u.campaign_id
          WHERE q.created_by = ? AND q.deleted_at IS NULL
          ORDER BY q.created_at DESC, q.id DESC
          LIMIT 200`;

    const params = campaignId ? [userId, campaignId] : [userId];
    const rows = await dbAllAsync(sql, params);
    return res.json({ qrCodes: (rows || []).map((row) => serializeRow(row, req)) });
  } catch (err) {
    return res.status(500).json({ error: ERROR_MESSAGES.db_error });
  }
});

// POST /api/qr { short, label?, colorDark?, colorLight? }
router.post('/api/qr', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const short = (body.short || '').toString().trim();
  if (!SHORT_RE.test(short)) {
    return res.status(400).json({ error: ERROR_MESSAGES.invalid_short });
  }

  const colorDark = readColor(body.colorDark, '#000000');
  const colorLight = readColor(body.colorLight, '#ffffff');
  if (colorDark === null || colorLight === null) {
    return res.status(400).json({ error: ERROR_MESSAGES.invalid_color });
  }

  const contrast = evaluateQrContrast(colorDark, colorLight, readLang(req));
  if (!contrast.valid) {
    return res.status(400).json({
      error: contrast.message || ERROR_MESSAGES.invalid_color,
      code: contrast.code,
      contrast,
    });
  }

  const label = readLabel(body.label);

  try {
    const link = await dbGetAsync(
      `SELECT u.id, u.short, u.original AS destination_url,
              COALESCE((SELECT COUNT(*) FROM clicks cl WHERE cl.url_id = u.id), 0) AS link_clicks,
              u.campaign_id, c.name AS campaign_name
         FROM urls u
         LEFT JOIN campaigns c ON c.id = u.campaign_id
        WHERE u.short = ? AND u.user_id = ?`,
      [short, userId]
    );
    if (!link) return res.status(404).json({ error: ERROR_MESSAGES.not_found });

    const counted = await dbGetAsync(
      'SELECT COUNT(*) AS total FROM qr_codes WHERE created_by = ? AND deleted_at IS NULL',
      [userId]
    );
    if (counted && Number(counted.total) >= MAX_QRS_PER_USER) {
      return res.status(409).json({ error: ERROR_MESSAGES.limit });
    }

    // Retry a couple of times in the unlikely event of a slug collision.
    let inserted = null;
    for (let attempt = 0; attempt < 3 && !inserted; attempt += 1) {
      try {
        inserted = await dbGetAsync(
          `INSERT INTO qr_codes (url_id, short, slug, label, color_dark, color_light, scans, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
           RETURNING id, url_id, short, slug, label, color_dark, color_light, scans, created_at, deleted_at`,
          [link.id, short, generateSlug(), label, colorDark, colorLight, userId, new Date().toISOString()]
        );
      } catch (insertErr) {
        if (attempt === 2) throw insertErr;
      }
    }

    const enriched = {
      ...inserted,
      destination_url: link.destination_url,
      link_clicks: link.link_clicks,
      campaign_id: link.campaign_id,
      campaign_name: link.campaign_name,
    };
    return res.status(201).json({ qrCode: serializeRow(enriched, req) });
  } catch (err) {
    return res.status(500).json({ error: ERROR_MESSAGES.db_error });
  }
});

// PATCH /api/qr/:id { label?, colorDark?, colorLight?, short? }
// Dynamic QR semantics: allows re-pointing `short` to another owned link while keeping `/q/:slug` immutable.
router.patch('/api/qr/:id', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });

  try {
    const existing = await findOwnedQr(userId, req.params.id);
    if (!existing) return res.status(404).json({ error: ERROR_MESSAGES.not_found });

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const colorDark = body.colorDark === undefined ? existing.color_dark : readColor(body.colorDark, existing.color_dark);
    const colorLight = body.colorLight === undefined ? existing.color_light : readColor(body.colorLight, existing.color_light);
    if (colorDark === null || colorLight === null) {
      return res.status(400).json({ error: ERROR_MESSAGES.invalid_color });
    }

    const contrast = evaluateQrContrast(colorDark, colorLight, readLang(req));
    if (!contrast.valid) {
      return res.status(400).json({
        error: contrast.message || ERROR_MESSAGES.invalid_color,
        code: contrast.code,
        contrast,
      });
    }

    const label = body.label === undefined ? existing.label : readLabel(body.label);
    let nextUrlId = existing.url_id;
    let nextShort = existing.short;

    if (body.short !== undefined) {
      const requestedShort = String(body.short || '').trim();
      if (!SHORT_RE.test(requestedShort)) {
        return res.status(400).json({ error: ERROR_MESSAGES.invalid_short });
      }
      const targetLink = await dbGetAsync(
        'SELECT id, short FROM urls WHERE short = ? AND user_id = ?',
        [requestedShort, userId]
      );
      if (!targetLink) {
        return res.status(404).json({ error: ERROR_MESSAGES.not_found });
      }
      nextUrlId = targetLink.id;
      nextShort = targetLink.short;
    }

    const updated = await dbGetAsync(
      `UPDATE qr_codes SET url_id = ?, short = ?, label = ?, color_dark = ?, color_light = ?
        WHERE id = ? AND created_by = ? AND deleted_at IS NULL
        RETURNING id`,
      [nextUrlId, nextShort, label, colorDark, colorLight, existing.id, userId]
    );
    if (!updated) return res.status(404).json({ error: ERROR_MESSAGES.not_found });

    const enriched = await findOwnedQr(userId, existing.id);
    return res.json({ qrCode: serializeRow(enriched, req) });
  } catch (err) {
    return res.status(500).json({ error: ERROR_MESSAGES.db_error });
  }
});

// GET /api/qr/:id/export?format=svg|png&size=256|512|1024|2048&ecc=M|Q|H&margin=4
router.get('/api/qr/:id/export', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });

  const opts = normalizeExportOptions(req.query);
  if (opts.error) {
    return res.status(400).json({ error: opts.error, code: opts.code });
  }

  try {
    const existing = await findOwnedQr(userId, req.params.id);
    if (!existing) return res.status(404).json({ error: ERROR_MESSAGES.not_found });

    const colorDark = existing.color_dark || '#000000';
    const colorLight = existing.color_light || '#ffffff';
    const contrast = evaluateQrContrast(colorDark, colorLight, readLang(req));
    if (!contrast.valid) {
      return res.status(400).json({ error: contrast.message, code: contrast.code, contrast });
    }

    const scanUrl = buildAbsoluteUrl(req, `/q/${encodeURIComponent(String(existing.slug || existing.id))}`);
    const rendered = await renderPrintQr({
      url: scanUrl,
      format: opts.format,
      size: opts.size,
      ecc: opts.ecc,
      margin: opts.margin,
      colorDark,
      colorLight,
    });

    const safeSlug = String(existing.slug || existing.id).replace(/[^A-Za-z0-9_-]/g, '');
    res.setHeader('Content-Type', rendered.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="ovlink-qr-${safeSlug}-${opts.size}.${rendered.ext}"`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-QR-ECC', opts.ecc);
    res.setHeader('X-QR-Quiet-Zone', String(opts.margin));
    res.setHeader('X-QR-Contrast-Ratio', String(contrast.contrast_ratio));
    return res.status(200).send(rendered.body);
  } catch (err) {
    return res.status(500).json({ error: ERROR_MESSAGES.db_error });
  }
});

// GET /api/qr/:id/stats?days=30 -> separates QR scans from canonical link clicks
router.get('/api/qr/:id/stats', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });

  const rawDays = req.query && req.query.days;
  const days = Math.min(365, Math.max(1, Number.parseInt(rawDays, 10) || 30));

  try {
    const existing = await findOwnedQr(userId, req.params.id);
    if (!existing) return res.status(404).json({ error: ERROR_MESSAGES.not_found });

    const since = new Date(Date.now() - (days - 1) * 86400 * 1000).toISOString().slice(0, 10);
    const dailyRows = await dbAllAsync(
      `SELECT day, scans
         FROM qr_scan_daily
        WHERE qr_id = ? AND day >= ?
        ORDER BY day ASC`,
      [existing.id, since]
    );

    const scanUrl = buildAbsoluteUrl(req, `/q/${encodeURIComponent(String(existing.slug || existing.id))}`);
    const campaign = existing.campaign_id
      ? { id: Number(existing.campaign_id), name: existing.campaign_name || '' }
      : null;

    return res.json(
      buildQrMetricsPayload({
        qrRow: existing,
        dailyRows,
        linkClicks: existing.link_clicks,
        scanUrl,
        campaign,
        lang: readLang(req),
      })
    );
  } catch (err) {
    return res.status(500).json({ error: ERROR_MESSAGES.db_error });
  }
});

// DELETE /api/qr/:id -> soft delete so historical scan counters stay auditable
router.delete('/api/qr/:id', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });

  try {
    const existing = await findOwnedQr(userId, req.params.id);
    if (!existing) return res.status(404).json({ error: ERROR_MESSAGES.not_found });

    await dbRunAsync(
      'UPDATE qr_codes SET deleted_at = ? WHERE id = ? AND created_by = ?',
      [new Date().toISOString(), existing.id, userId]
    );
    return res.json({
      deleted: true,
      id: existing.id,
      historical_scans_preserved: true,
      link_preserved: true,
      notice: buildLifecycleNotice('soft_deleted', readLang(req)),
    });
  } catch (err) {
    return res.status(500).json({ error: ERROR_MESSAGES.db_error });
  }
});

module.exports = router;
