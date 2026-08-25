const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const { db } = require('../../db/index');
const { dbGetAsync, dbRunAsync, dbAllAsync } = require('../../db/helpers');
const { requireSignedIn, requireProAccess } = require('../../middleware/auth');
const { proWriteLimiter, proReadLimiter, proKeyCreateLimiter } = require('../../middleware/rate-limiter');
const { pickLang, normalizeLang } = require('../../lib/i18n');
const { getEffectivePlanForUser } = require('../../lib/plans');
const {
  logSecurityEvent,
  normalizeApiKeyScopes,
  toApiKeyScopesStorage,
  DEFAULT_API_KEY_SCOPES,
  hashApiKeyValue,
  buildApiKeyValue,
  getApiKeyPrefix,
  getApiKeyLast4,
  PRO_API_KEY_MAX_ACTIVE
} = require('../../lib/security');

// Fallback loader if plans overview is requested
async function loadProOverviewPayload(userId, planPayload) {
  const readLimit = 600;
  const writeLimit = 120;
  const payload = {
    plan: planPayload,
    limits: {
      api_keys_max_active: PRO_API_KEY_MAX_ACTIVE,
      webhooks_max_active: 10,
      webhook_retry_attempts: 5,
      security_log_retention_days: 30,
      api_read_window_seconds: 60,
      api_write_window_seconds: 60,
      api_read_limit_per_window: readLimit,
      api_write_limit_per_window: writeLimit,
    },
    api_usage: {
      read_limit_per_window: readLimit,
      write_limit_per_window: writeLimit,
      window_seconds: 60,
      read_window_seconds: 60,
      write_window_seconds: 60,
      read_used_current_window: 0,
      write_used_current_window: 0,
      read_remaining_current_window: readLimit,
      write_remaining_current_window: writeLimit,
      last_24h_total: 0,
      last_24h_errors: 0,
      error_types: [],
      status_codes: [],
    },
    api_keys: [],
    webhooks: [],
    deliveries: [],
  };

  try {
    const apiKeys = await dbAllAsync(
      'SELECT id, name, scopes, key_prefix, last4, created_at, last_used_at, revoked_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC LIMIT 50',
      [userId]
    ).catch(() => []);

    payload.api_keys = (apiKeys || []).map((row) => ({
      id: row.id,
      name: row.name || 'API key',
      scopes: normalizeApiKeyScopes(row.scopes || '', DEFAULT_API_KEY_SCOPES),
      key_prefix: row.key_prefix || '',
      last4: row.last4 || '',
      created_at: row.created_at || null,
      last_used_at: row.last_used_at || null,
      revoked_at: row.revoked_at || null,
    }));
  } catch {}

  return payload;
}

router.get('/api/pro/overview', requireSignedIn, proReadLimiter, async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  try {
    const plan = await getEffectivePlanForUser(req.session.userId);
    const payload = await loadProOverviewPayload(req.session.userId, plan);
    return res.json(payload);
  } catch {
    return res.status(500).json({ error: 'Server error.' });
  }
});

router.post('/api/pro/api-keys/create', requireSignedIn, proKeyCreateLimiter, requireProAccess('api_keys.create'), async (req, res) => {
  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const name = ((req.body && req.body.name) || '').toString().trim().slice(0, 60) || 'Primary key';
  const requestedScopes = normalizeApiKeyScopes(req.body && req.body.scopes, DEFAULT_API_KEY_SCOPES);
  const scopesStorage = toApiKeyScopesStorage(requestedScopes, DEFAULT_API_KEY_SCOPES);

  try {
    const countRow = await dbGetAsync(
      'SELECT COUNT(*) AS cnt FROM api_keys WHERE user_id = ? AND revoked_at IS NULL',
      [req.session.userId]
    );
    const activeCount = Number(countRow && countRow.cnt ? countRow.cnt : 0);
    if (activeCount >= PRO_API_KEY_MAX_ACTIVE) {
      return res.status(409).json({
        error: pickLang(
          uiLang,
          `Aktiv API açar limiti dolub (${PRO_API_KEY_MAX_ACTIVE}).`,
          `Aktif API anahtarı limiti doldu (${PRO_API_KEY_MAX_ACTIVE}).`,
          `Active API key limit reached (${PRO_API_KEY_MAX_ACTIVE}).`
        ),
      });
    }

    const rawKey = buildApiKeyValue();
    const now = new Date().toISOString();
    await dbRunAsync(
      'INSERT INTO api_keys (user_id, name, scopes, key_hash, hash_version, key_prefix, last4, created_at) VALUES (?, ?, ?, ?, 2, ?, ?, ?)',
      [req.session.userId, name, scopesStorage, hashApiKeyValue(rawKey), getApiKeyPrefix(rawKey), getApiKeyLast4(rawKey), now]
    );
    logSecurityEvent(req, 'api.key.create', 'success', { user_id: req.session.userId, key_name: name });
    return res.json({
      message: pickLang(uiLang, 'API açarı yaradıldı.', 'API anahtarı oluşturuldu.', 'API key created.'),
      api_key: rawKey,
      scopes: requestedScopes,
    });
  } catch {
    logSecurityEvent(req, 'api.key.create', 'failure', { user_id: req.session.userId });
    return res.status(500).json({ error: pickLang(uiLang, 'API açarı yaradıla bilmədi.', 'API anahtarı oluşturulamadı.', 'API key could not be created.') });
  }
});

router.post('/api/pro/api-keys/revoke', requireSignedIn, proWriteLimiter, requireProAccess('api_keys.revoke'), async (req, res) => {
  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const keyId = Number.parseInt((req.body && req.body.key_id) || '', 10);
  if (!Number.isInteger(keyId) || keyId <= 0) {
    return res.status(400).json({ error: pickLang(uiLang, 'Yanlış açar ID.', 'Geçersiz anahtar ID.', 'Invalid key id.') });
  }

  try {
    const now = new Date().toISOString();
    const result = await dbRunAsync(
      'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
      [now, keyId, req.session.userId]
    );
    if (!result || !result.changes) {
      return res.status(404).json({ error: pickLang(uiLang, 'Açar tapılmadı.', 'Anahtar bulunamadı.', 'Key not found.') });
    }
    logSecurityEvent(req, 'api.key.revoke', 'success', { user_id: req.session.userId, api_key_id: keyId });
    return res.json({ message: pickLang(uiLang, 'API açarı ləğv edildi.', 'API anahtarı iptal edildi.', 'API key revoked.') });
  } catch {
    logSecurityEvent(req, 'api.key.revoke', 'failure', { user_id: req.session.userId, api_key_id: keyId });
    return res.status(500).json({ error: pickLang(uiLang, 'Açar ləğv edilə bilmədi.', 'Anahtar iptal edilemedi.', 'Key could not be revoked.') });
  }
});

router.post('/api/pro/api-keys/rotate', requireSignedIn, proWriteLimiter, requireProAccess('api_keys.rotate'), async (req, res) => {
  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const keyId = Number.parseInt((req.body && req.body.key_id) || '', 10);
  if (!Number.isInteger(keyId) || keyId <= 0) {
    return res.status(400).json({ error: pickLang(uiLang, 'Yanlış açar ID.', 'Geçersiz anahtar ID.', 'Invalid key id.') });
  }

  try {
    const row = await dbGetAsync(
      'SELECT id FROM api_keys WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
      [keyId, req.session.userId]
    );
    if (!row) {
      return res.status(404).json({ error: pickLang(uiLang, 'Açar tapılmadı.', 'Anahtar bulunamadı.', 'Key not found.') });
    }

    const rawKey = buildApiKeyValue();
    const now = new Date().toISOString();
    await dbRunAsync(
      'UPDATE api_keys SET key_hash = ?, hash_version = 2, key_prefix = ?, last4 = ?, last_used_at = NULL, created_at = ? WHERE id = ? AND user_id = ?',
      [hashApiKeyValue(rawKey), getApiKeyPrefix(rawKey), getApiKeyLast4(rawKey), now, keyId, req.session.userId]
    );
    logSecurityEvent(req, 'api.key.rotate', 'success', { user_id: req.session.userId, api_key_id: keyId });
    return res.json({
      message: pickLang(uiLang, 'API açarı yeniləndi.', 'API anahtarı yenilendi.', 'API key rotated.'),
      api_key: rawKey,
    });
  } catch {
    logSecurityEvent(req, 'api.key.rotate', 'failure', { user_id: req.session.userId, api_key_id: keyId });
    return res.status(500).json({ error: pickLang(uiLang, 'Açar yenilənmədi.', 'Anahtar yenilenemedi.', 'Key could not be rotated.') });
  }
});

router.post('/api/pro/api-keys/scopes', requireSignedIn, proWriteLimiter, requireProAccess('api_keys.scopes'), async (req, res) => {
  const uiLang = normalizeLang(req.body && req.body.lang, 'az');
  const keyId = Number.parseInt((req.body && req.body.key_id) || '', 10);
  if (!Number.isInteger(keyId) || keyId <= 0) {
    return res.status(400).json({ error: pickLang(uiLang, 'Yanlış açar ID.', 'Geçersiz anahtar ID.', 'Invalid key id.') });
  }

  const scopes = normalizeApiKeyScopes(req.body && req.body.scopes, DEFAULT_API_KEY_SCOPES);
  const scopesStorage = toApiKeyScopesStorage(scopes, DEFAULT_API_KEY_SCOPES);

  try {
    const row = await dbGetAsync(
      'SELECT id FROM api_keys WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
      [keyId, req.session.userId]
    );
    if (!row) {
      return res.status(404).json({ error: pickLang(uiLang, 'Açar tapılmadı.', 'Anahtar bulunamadı.', 'Key not found.') });
    }

    await dbRunAsync(
      'UPDATE api_keys SET scopes = ? WHERE id = ? AND user_id = ?',
      [scopesStorage, keyId, req.session.userId]
    );
    logSecurityEvent(req, 'api.key.scopes.update', 'success', { user_id: req.session.userId, api_key_id: keyId });
    return res.json({
      message: pickLang(uiLang, 'API açarı icazələri yeniləndi.', 'API anahtarı izinleri güncellendi.', 'API key scopes updated.'),
      scopes,
    });
  } catch {
    logSecurityEvent(req, 'api.key.scopes.update', 'failure', { user_id: req.session.userId, api_key_id: keyId });
    return res.status(500).json({ error: pickLang(uiLang, 'İcazələr yenilənmədi.', 'İzinler güncellenemedi.', 'Scopes could not be updated.') });
  }
});

module.exports = router;
