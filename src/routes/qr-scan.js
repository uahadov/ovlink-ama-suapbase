/**
 * GET /q/:slug — a scanned QR code.
 *
 * Scan counting stays OUT of the `clicks` table: the redirect below hands the
 * visitor to the normal `/:short` pipeline, which records exactly one click
 * (consent gate, bot detection, A/B split all apply unchanged). The QR itself
 * only owns a per-day counter and a lifetime total.
 */
'use strict';

const express = require('express');
const { dbGetAsync, dbRunAsync } = require('../db/helpers');

const router = express.Router();

const SLUG_RE = /^(?:[A-Za-z0-9_-]{1,64})$/;

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

router.get('/q/:slug', async (req, res, next) => {
  const raw = (req.params.slug || '').toString().trim();
  if (!SLUG_RE.test(raw)) return next();

  try {
    const numeric = /^\d{1,10}$/.test(raw) ? Number.parseInt(raw, 10) : null;
    const row = numeric
      ? await dbGetAsync(
          `SELECT q.id, q.short, q.deleted_at FROM qr_codes q WHERE q.id = ? LIMIT 1`,
          [numeric]
        )
      : await dbGetAsync(
          `SELECT q.id, q.short, q.deleted_at FROM qr_codes q WHERE q.slug = ? LIMIT 1`,
          [raw]
        );

    if (!row || row.deleted_at) return next();

    // Fire-and-forget: a counter failure must never block the redirect.
    const day = todayKey();
    Promise.resolve()
      .then(() => dbRunAsync('UPDATE qr_codes SET scans = scans + 1 WHERE id = ?', [row.id]))
      .catch(() => {});
    Promise.resolve()
      .then(() => dbRunAsync(
        `INSERT INTO qr_scan_daily (qr_id, day, scans) VALUES (?, ?, 1)
         ON CONFLICT (qr_id, day) DO UPDATE SET scans = qr_scan_daily.scans + 1`,
        [row.id, day]
      ))
      .catch(() => {});

    return res.redirect(302, `/${encodeURIComponent(row.short)}`);
  } catch (err) {
    return next();
  }
});

module.exports = router;
