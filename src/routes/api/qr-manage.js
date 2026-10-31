const crypto = require('crypto');
const express = require('express');
const router = express.Router();

const { dbGetAsync, dbRunAsync, dbAllAsync } = require('../../db/helpers');
const { buildShortUrl } = require('../../lib/url-helpers');

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
  return {
    id: row.id,
    short: row.short,
    slug: row.slug,
    label: row.label || '',
    colorDark: row.color_dark || '#000000',
    colorLight: row.color_light || '#ffffff',
    scans: Number(row.scans) || 0,
    createdAt: row.created_at,
    scanUrl: row.deleted_at ? null : buildShortUrl(req, `q/${row.slug || row.id}`, ''),
  };
}

async function findOwnedQr(userId, id) {
  const qrId = Number.parseInt(id, 10);
  if (!Number.isInteger(qrId) || qrId <= 0) return null;
  return dbGetAsync(
    'SELECT * FROM qr_codes WHERE id = ? AND created_by = ? AND deleted_at IS NULL',
    [qrId, userId]
  );
}

// GET /api/qr -> the caller's QR codes
router.get('/api/qr', async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).json({ error: ERROR_MESSAGES.unauthorized });

  try {
    const rows = await dbAllAsync(
      `SELECT * FROM qr_codes
        WHERE created_by = ? AND deleted_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT 200`,
      [userId]
    );
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
  const label = readLabel(body.label);

  try {
    const link = await dbGetAsync(
      'SELECT id, short FROM urls WHERE short = ? AND user_id = ?',
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

    return res.status(201).json({ qrCode: serializeRow(inserted, req) });
  } catch (err) {
    return res.status(500).json({ error: ERROR_MESSAGES.db_error });
  }
});

// PATCH /api/qr/:id { label?, colorDark?, colorLight? }
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
    const label = body.label === undefined ? existing.label : readLabel(body.label);

    const updated = await dbGetAsync(
      `UPDATE qr_codes SET label = ?, color_dark = ?, color_light = ?
        WHERE id = ? AND created_by = ? AND deleted_at IS NULL
        RETURNING id, url_id, short, slug, label, color_dark, color_light, scans, created_at, deleted_at`,
      [label, colorDark, colorLight, existing.id, userId]
    );
    if (!updated) return res.status(404).json({ error: ERROR_MESSAGES.not_found });
    return res.json({ qrCode: serializeRow(updated, req) });
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
    return res.json({ deleted: true, id: existing.id });
  } catch (err) {
    return res.status(500).json({ error: ERROR_MESSAGES.db_error });
  }
});

module.exports = router;
