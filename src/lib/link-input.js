// Link input parsing / validation helpers (W4.2, move-only from
// src/routes/api/links.js). Behaviour is byte-identical; links.js re-exports
// every name so existing `require('./links')` consumers keep working.
const crypto = require('crypto');

const {
  ensureAbsoluteUrl,
  normalizeHostName,
  pickFirstInputValue,
} = require('./url-helpers');
const { safeJsonStringify } = require('./security');
const { API_KEY_HASH_KEY_MATERIAL } = require('../config/index');

// normalizeHostName() is a host:port normalizer, not a URL parser: handing it an
// absolute URL returns the scheme ("https"), which silently disabled every
// domain check that used it. Always extract the hostname from a parsed URL.
function getUrlHostname(rawUrl) {
  const value = (rawUrl || '').toString().trim();
  if (!value) return '';
  try {
    const absolute = ensureAbsoluteUrl(value);
    if (!absolute) return '';
    return normalizeHostName(new URL(absolute).hostname || '');
  } catch {
    return '';
  }
}

function normalizeIdempotencyKey(rawValue) {
  const value = (rawValue || '').toString().trim();
  if (!value) return '';
  if (value.length < 8 || value.length > 120) return '';
  if (!/^[\x21-\x7E]+$/.test(value)) return '';
  return value;
}

function hashApiIdempotencyKey(rawKey) {
  return crypto
    .createHmac('sha256', API_KEY_HASH_KEY_MATERIAL)
    .update(`ovlink:idempotency:${(rawKey || '').toString()}`)
    .digest('hex');
}

function buildShortenIdempotencyRequestHash(payload) {
  const compact = safeJsonStringify(payload, 3000);
  return crypto.createHash('sha256').update(compact).digest('hex');
}

function parseStoredJsonObject(raw, fallback = null) {
  try {
    const parsed = JSON.parse((raw || '').toString());
    return (parsed && typeof parsed === 'object') ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalizeFolderName(raw) {
  const text = (raw || '').toString().replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.slice(0, 80);
}

function parseTagsJson(jsonStr) {
  if (!jsonStr) return [];
  if (Array.isArray(jsonStr)) {
    return jsonStr.map(t => (t || '').toString().trim()).filter(Boolean);
  }
  try {
    const arr = JSON.parse(jsonStr);
    if (Array.isArray(arr)) {
      return arr.map(t => (t || '').toString().trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    }
    if (typeof arr === 'string') {
      return arr.split(/[,;\n]+/).map(t => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    }
  } catch {}
  if (typeof jsonStr === 'string') {
    return jsonStr.split(/[,;\n]+/).map(t => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  return [];
}

function escapeCsvCell(val) {
  if (val === null || val === undefined) return '""';
  let str = String(val);
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  return `"${str.replace(/"/g, '""')}"`;
}

function normalizeTagsInput(raw) {
  let items = [];
  if (Array.isArray(raw)) {
    items = raw;
  } else if (typeof raw === 'string') {
    const text = raw.trim();
    if (text) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) items = parsed;
        else if (typeof parsed === 'string') items = parsed.split(/[,;\n]+/);
        else items = text.split(/[,;\n]+/);
      } catch {
        items = text.split(/[,;\n]+/);
      }
    }
  }
  const clean = [];
  const seen = new Set();
  for (const item of items) {
    const tag = (item || '').toString().replace(/\s+/g, ' ').trim().replace(/^["']|["']$/g, '');
    if (!tag) continue;
    const safeTag = tag.slice(0, 32);
    const lower = safeTag.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    clean.push(safeTag);
    if (clean.length >= 8) break;
  }
  return clean;
}

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function extractImportUrlCandidate(rawLine) {
  const line = (rawLine || '').toString().trim();
  if (!line) return '';
  const parsed = parseCsvLine(line);
  if (parsed.length) {
    for (const item of parsed) {
      const candidate = (item || '').toString().trim().replace(/^[\s"'<]+|[\s"'>]+$/g, '');
      if (/^https?:\/\//i.test(candidate)) return candidate;
    }
  }
  const match = line.match(/https?:\/\/[^\s"'<>,]+/i);
  return match ? match[0] : '';
}

module.exports = {
  pickFirstInputValue,
  getUrlHostname,
  normalizeIdempotencyKey,
  hashApiIdempotencyKey,
  buildShortenIdempotencyRequestHash,
  parseStoredJsonObject,
  normalizeFolderName,
  parseTagsJson,
  escapeCsvCell,
  normalizeTagsInput,
  parseCsvLine,
  extractImportUrlCandidate,
};
