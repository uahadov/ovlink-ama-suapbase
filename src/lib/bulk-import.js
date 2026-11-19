'use strict';

const crypto = require('crypto');
const { dbGetAsync, dbRunAsync, withTransaction } = require('../db/helpers');
const { appendUtmParams, applyUtmPreset } = require('./utm');
const { recordCampaignAudit } = require('./campaign-model');

const MAX_BULK_ROWS_PRO = 100;
const MAX_BULK_ROWS_FREE = 10;
const DEFAULT_PREVIEW_WINDOW = 50;
const MAX_PREVIEW_WINDOW = 100;
const SHORT_RE = /^[A-Za-z0-9_-]{3,40}$/;
const PRIVATE_HOST_RE = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|10\.\d+\.\d+\.\d+|169\.254\.\d+\.\d+|192\.168\.\d+\.\d+|\[::1\]|::1)$/i;

let bulkTableReadyPromise = null;

async function ensureBulkImportTable() {
  if (bulkTableReadyPromise) return bulkTableReadyPromise;
  bulkTableReadyPromise = (async () => {
    try {
      const existing = await dbGetAsync(
        "SELECT table_name FROM information_schema.tables WHERE table_name = 'bulk_import_jobs'",
        []
      );
      if (existing && existing.table_name === 'bulk_import_jobs') return;
    } catch {}

    const statements = [
      `CREATE TABLE IF NOT EXISTS bulk_import_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        summary_json TEXT,
        report_json TEXT,
        created_at TEXT,
        UNIQUE (user_id, idempotency_key)
      )`,
      'CREATE INDEX IF NOT EXISTS idx_bulk_import_jobs_user ON bulk_import_jobs(user_id, created_at)',
    ];

    try {
      await withTransaction(async (tx) => {
        await tx.run('SELECT pg_advisory_xact_lock(18182026)', []);
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
    bulkTableReadyPromise = null;
  });
  return bulkTableReadyPromise;
}

/** Neutralizes CSV spreadsheet formula injection (=, +, -, @, tab, CR). */
function escapeCsvCell(value) {
  const text = String(value == null ? '' : value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** RFC-4180 lightweight CSV line parser (handles quoted commas & escaped quotes). */
function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseBulkCsv(csvText, mapping = {}) {
  const rawLines = String(csvText || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!rawLines.length) return [];

  const firstCells = splitCsvLine(rawLines[0]);
  const lowerHeaders = firstCells.map((h) => h.toLowerCase());
  const looksLikeHeader = lowerHeaders.some((h) =>
    ['url', 'original', 'link', 'target', 'custom_short', 'short', 'utm_source', 'utm_medium', 'utm_campaign'].includes(h)
  );

  const headers = looksLikeHeader ? lowerHeaders : ['url', 'custom_short', 'utm_source', 'utm_medium', 'utm_campaign'];
  const startIdx = looksLikeHeader ? 1 : 0;
  const map = mapping && typeof mapping === 'object' ? mapping : {};

  const colIndex = (logicalName, fallbacks) => {
    const explicit = map[logicalName] ? String(map[logicalName]).toLowerCase() : null;
    if (explicit) {
      const idx = headers.indexOf(explicit);
      if (idx !== -1) return idx;
    }
    for (const candidate of fallbacks) {
      const idx = headers.indexOf(candidate);
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const urlIdx = colIndex('url', ['url', 'original', 'link', 'target']);
  const shortIdx = colIndex('custom_short', ['custom_short', 'short', 'slug']);
  const srcIdx = colIndex('utm_source', ['utm_source', 'source']);
  const medIdx = colIndex('utm_medium', ['utm_medium', 'medium']);
  const cmpIdx = colIndex('utm_campaign', ['utm_campaign', 'campaign']);
  const termIdx = colIndex('utm_term', ['utm_term', 'term']);
  const contentIdx = colIndex('utm_content', ['utm_content', 'content']);

  const rows = [];
  for (let i = startIdx; i < rawLines.length; i += 1) {
    const cells = splitCsvLine(rawLines[i]);
    const url = urlIdx >= 0 ? (cells[urlIdx] || '') : (cells[0] || '');
    rows.push({
      row_number: rows.length + 1,
      url,
      custom_short: shortIdx >= 0 ? (cells[shortIdx] || '') : '',
      utm_source: srcIdx >= 0 ? (cells[srcIdx] || '') : '',
      utm_medium: medIdx >= 0 ? (cells[medIdx] || '') : '',
      utm_campaign: cmpIdx >= 0 ? (cells[cmpIdx] || '') : '',
      utm_term: termIdx >= 0 ? (cells[termIdx] || '') : '',
      utm_content: contentIdx >= 0 ? (cells[contentIdx] || '') : '',
    });
  }
  return rows;
}

function validateBulkUrl(rawUrl) {
  const text = String(rawUrl == null ? '' : rawUrl).trim();
  if (!text || text.length > 2048) return { error_code: 'invalid_url', error: 'URL boş və ya 2048 simvoldan uzundur.' };
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return { error_code: 'invalid_url', error: 'Keçərli http/https URL daxil edin.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error_code: 'invalid_protocol', error: 'Yalnız http və https protokollarına icazə verilir.' };
  }
  if (PRIVATE_HOST_RE.test(parsed.hostname)) {
    return { error_code: 'blocked_host', error: 'Daxili/lokal host ünvanlarına icazə verilmir.' };
  }
  return { url: parsed.toString() };
}

function normalizeInputRows({ rows, csv, mapping }) {
  if (Array.isArray(rows) && rows.length) {
    return rows.map((r, idx) => {
      const obj = r && typeof r === 'object' ? r : { url: String(r || '') };
      return {
        row_number: idx + 1,
        url: String(obj.url || obj.original || '').trim(),
        custom_short: String(obj.custom_short || obj.short || '').trim(),
        utm_source: String(obj.utm_source || '').trim(),
        utm_medium: String(obj.utm_medium || '').trim(),
        utm_campaign: String(obj.utm_campaign || '').trim(),
        utm_term: String(obj.utm_term || '').trim(),
        utm_content: String(obj.utm_content || '').trim(),
      };
    });
  }
  if (typeof csv === 'string' && csv.trim()) {
    return parseBulkCsv(csv, mapping);
  }
  return [];
}

function previewBulkImport({
  rows,
  csv,
  mapping,
  utmPreset = null,
  maxRows = MAX_BULK_ROWS_PRO,
  windowLimit = DEFAULT_PREVIEW_WINDOW,
} = {}) {
  const rawList = normalizeInputRows({ rows, csv, mapping });
  const safeWindow = Math.min(MAX_PREVIEW_WINDOW, Math.max(1, Number.parseInt(windowLimit, 10) || DEFAULT_PREVIEW_WINDOW));
  const capped = rawList.slice(0, maxRows);
  const seenShorts = new Set();
  const seenUrls = new Set();

  let validCount = 0;
  let invalidCount = 0;
  let duplicateUrlCount = 0;

  const evaluated = capped.map((item) => {
    const urlCheck = validateBulkUrl(item.url);
    if (urlCheck.error_code) {
      invalidCount += 1;
      return {
        row_number: item.row_number,
        valid: false,
        url: item.url,
        tagged_url: null,
        custom_short: item.custom_short || null,
        error_code: urlCheck.error_code,
        error: urlCheck.error,
        warning: null,
      };
    }

    if (item.custom_short) {
      if (!SHORT_RE.test(item.custom_short)) {
        invalidCount += 1;
        return {
          row_number: item.row_number,
          valid: false,
          url: item.url,
          tagged_url: null,
          custom_short: item.custom_short,
          error_code: 'invalid_short',
          error: 'Qısa kod 3-40 simvol arası (A-Z, 0-9, _, -) olmalıdır.',
          warning: null,
        };
      }
      const lowerShort = item.custom_short.toLowerCase();
      if (seenShorts.has(lowerShort)) {
        invalidCount += 1;
        return {
          row_number: item.row_number,
          valid: false,
          url: item.url,
          tagged_url: null,
          custom_short: item.custom_short,
          error_code: 'duplicate_short_in_batch',
          error: `"${item.custom_short}" qısa kodu faylda təkrarlanır.`,
          warning: null,
        };
      }
      seenShorts.add(lowerShort);
    }

    const utmOverrides = {
      utm_source: item.utm_source,
      utm_medium: item.utm_medium,
      utm_campaign: item.utm_campaign,
      utm_term: item.utm_term,
      utm_content: item.utm_content,
    };
    const taggedUrl = utmPreset
      ? applyUtmPreset(urlCheck.url, utmPreset, utmOverrides)
      : appendUtmParams(urlCheck.url, utmOverrides);

    let warning = null;
    if (seenUrls.has(taggedUrl)) {
      duplicateUrlCount += 1;
      warning = 'duplicate_url_in_batch';
    } else {
      seenUrls.add(taggedUrl);
    }

    validCount += 1;
    return {
      row_number: item.row_number,
      valid: true,
      url: urlCheck.url,
      tagged_url: taggedUrl,
      custom_short: item.custom_short || null,
      error_code: null,
      error: null,
      warning,
    };
  });

  return {
    total_input_rows: rawList.length,
    processed_rows: evaluated.length,
    truncated_input: rawList.length > maxRows,
    max_rows_allowed: maxRows,
    valid_count: validCount,
    invalid_count: invalidCount,
    duplicate_url_count: duplicateUrlCount,
    window_limit: safeWindow,
    rows_window: evaluated.slice(0, safeWindow),
    evaluated_rows: evaluated,
  };
}

function buildBulkReportCsv(results = []) {
  const header = 'row_number,status,short,original_url,tagged_url,error_code,error';
  const lines = (results || []).map((r) => [
    r.row_number,
    r.status,
    r.short || '',
    r.original || '',
    r.tagged_url || '',
    r.error_code || '',
    r.error || '',
  ].map(escapeCsvCell).join(','));
  return [header, ...lines].join('\n');
}

function generateBulkShortCode() {
  return `b${crypto.randomBytes(4).toString('hex')}`;
}

function hashBulkRequest(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

async function executeBulkImport({
  userId,
  rows,
  csv,
  mapping,
  idempotencyKey,
  campaignId = null,
  workspaceId = null,
  utmPreset = null,
  isPro = true,
} = {}) {
  const uid = Number.parseInt(userId, 10);
  if (!Number.isInteger(uid) || uid <= 0) return { statusCode: 401, error: 'unauthorized' };

  await ensureBulkImportTable();

  const maxRows = isPro ? MAX_BULK_ROWS_PRO : MAX_BULK_ROWS_FREE;
  const preview = previewBulkImport({ rows, csv, mapping, utmPreset, maxRows });
  if (!preview.processed_rows) {
    return { statusCode: 400, error: 'empty_batch', message: 'Import üçün ən azı 1 sətir göndərin.' };
  }

  const cleanKey = String(idempotencyKey || '').trim().slice(0, 128) || `auto_${crypto.randomBytes(8).toString('hex')}`;
  const reqHash = hashBulkRequest({
    campaignId: campaignId || null,
    workspaceId: workspaceId || null,
    rows: preview.evaluated_rows.map((r) => ({
      n: r.row_number,
      u: r.url,
      t: r.tagged_url,
      s: r.custom_short,
    })),
  });

  // Strict idempotency check: re-submitting the same file + key returns cached result with 0 duplicates.
  const existingJob = await dbGetAsync(
    'SELECT * FROM bulk_import_jobs WHERE user_id = ? AND idempotency_key = ? LIMIT 1',
    [uid, cleanKey]
  );
  if (existingJob) {
    if (existingJob.request_hash !== reqHash) {
      return {
        statusCode: 409,
        error: 'idempotency_key_conflict',
        message: 'Bu Idempotency-Key başqa məzmunla artıq istifadə olunub.',
      };
    }
    const summary = JSON.parse(existingJob.summary_json || '{}');
    const results = JSON.parse(existingJob.report_json || '[]');
    return {
      statusCode: 200,
      body: {
        job_id: Number(existingJob.id),
        idempotency_key: cleanKey,
        idempotent_replay: true,
        status: existingJob.status,
        summary,
        results,
        report_csv: buildBulkReportCsv(results),
      },
    };
  }

  const results = [];
  let createdCount = 0;
  let failedCount = 0;

  for (const item of preview.evaluated_rows) {
    if (!item.valid) {
      failedCount += 1;
      results.push({
        row_number: item.row_number,
        status: 'failed',
        short: item.custom_short || null,
        original: item.url,
        tagged_url: null,
        error_code: item.error_code,
        error: item.error,
      });
      continue;
    }

    const shortCode = item.custom_short || generateBulkShortCode();
    try {
      const clash = await dbGetAsync('SELECT id FROM urls WHERE short = ? LIMIT 1', [shortCode]);
      if (clash) {
        failedCount += 1;
        results.push({
          row_number: item.row_number,
          status: 'failed',
          short: shortCode,
          original: item.url,
          tagged_url: item.tagged_url,
          error_code: 'short_taken',
          error: `"${shortCode}" qısa kodu artıq istifadə olunur.`,
        });
        continue;
      }

      await dbRunAsync(
        'INSERT INTO urls (short, original, user_id, workspace_id, campaign_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [shortCode, item.tagged_url, uid, workspaceId || null, campaignId || null, new Date().toISOString()]
      );
      createdCount += 1;
      results.push({
        row_number: item.row_number,
        status: 'created',
        short: shortCode,
        original: item.url,
        tagged_url: item.tagged_url,
        error_code: null,
        error: null,
      });
    } catch {
      failedCount += 1;
      results.push({
        row_number: item.row_number,
        status: 'failed',
        short: shortCode,
        original: item.url,
        tagged_url: item.tagged_url,
        error_code: 'insert_failed',
        error: 'Link saxlanılarkən xəta baş verdi.',
      });
    }
  }

  const finalStatus = failedCount === 0 ? 'completed' : (createdCount > 0 ? 'partial' : 'failed');
  const summary = {
    total: results.length,
    created: createdCount,
    failed: failedCount,
    truncated_input: preview.truncated_input,
  };

  const savedJob = await dbGetAsync(
    `INSERT INTO bulk_import_jobs (user_id, idempotency_key, request_hash, status, summary_json, report_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
    [
      uid,
      cleanKey,
      reqHash,
      finalStatus,
      JSON.stringify(summary),
      JSON.stringify(results),
      new Date().toISOString(),
    ]
  );

  await recordCampaignAudit(dbRunAsync, {
    userId: uid,
    action: `bulk_import.${finalStatus}`,
    campaignId: campaignId || null,
    metadata: {
      job_id: savedJob ? Number(savedJob.id) : null,
      idempotency_key: cleanKey,
      ...summary,
    },
  });

  return {
    statusCode: finalStatus === 'completed' ? 201 : (finalStatus === 'partial' ? 207 : 400),
    body: {
      job_id: savedJob ? Number(savedJob.id) : null,
      idempotency_key: cleanKey,
      idempotent_replay: false,
      status: finalStatus,
      summary,
      results,
      report_csv: buildBulkReportCsv(results),
    },
  };
}

async function getBulkJobReportCsv({ userId, jobId }) {
  const uid = Number.parseInt(userId, 10);
  const id = Number.parseInt(jobId, 10);
  if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(id) || id <= 0) return null;
  await ensureBulkImportTable();
  const row = await dbGetAsync(
    'SELECT id, status, report_json FROM bulk_import_jobs WHERE id = ? AND user_id = ? LIMIT 1',
    [id, uid]
  );
  if (!row) return null;
  const results = JSON.parse(row.report_json || '[]');
  return {
    id: Number(row.id),
    status: row.status,
    csv: buildBulkReportCsv(results),
  };
}

module.exports = {
  MAX_BULK_ROWS_PRO,
  MAX_BULK_ROWS_FREE,
  DEFAULT_PREVIEW_WINDOW,
  MAX_PREVIEW_WINDOW,
  escapeCsvCell,
  parseBulkCsv,
  validateBulkUrl,
  previewBulkImport,
  buildBulkReportCsv,
  executeBulkImport,
  getBulkJobReportCsv,
};
