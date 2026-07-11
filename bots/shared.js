const crypto = require('crypto');

function createBotShared(db, options = {}) {
  const { buildShortUrl, ensureAbsoluteUrl, generateSafeShortCode, isProAccessActive, normalizeLang, pickLang, logSecurityEvent } = options;

  function normalizeUrl(raw) {
    const url = (raw || '').toString().trim();
    if (!url) return '';
    if (!/^https?:\/\//i.test(url)) return 'https://' + url;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      return parsed.toString();
    } catch { return ''; }
  }

  function normalizeAlias(raw) {
    const alias = (raw || '').toString().trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!alias || alias.length < 3 || alias.length > 50) return '';
    return alias;
  }

  async function getBotUser(platform, platformUserId) {
    return new Promise((resolve) => {
      db.get(
        'SELECT bu.*, u.plan_tier, u.plan_status, u.pro_expires_at FROM bot_users bu JOIN users u ON u.id = bu.user_id WHERE bu.platform = ? AND bu.platform_user_id = ?',
        [platform, String(platformUserId)],
        (err, row) => resolve(err ? null : row)
      );
    });
  }

  async function linkBotUser(platform, platformUserId, platformUsername, ovlinkUserId) {
    return new Promise((resolve) => {
      db.run(
        `INSERT INTO bot_users (platform, platform_user_id, platform_username, user_id, linked_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(platform, platform_user_id) DO UPDATE SET
           platform_username = excluded.platform_username,
           user_id = excluded.user_id,
           linked_at = excluded.linked_at`,
        [platform, String(platformUserId), platformUsername || '', ovlinkUserId, new Date().toISOString()],
        function (err) { resolve(!err); }
      );
    });
  }

  async function unlinkBotUser(platform, platformUserId) {
    return new Promise((resolve) => {
      db.run(
        'DELETE FROM bot_users WHERE platform = ? AND platform_user_id = ?',
        [platform, String(platformUserId)],
        function (err) { resolve(!err); }
      );
    });
  }

  // Deep-link auth: bot creates a short auth code, embeds it in a URL.
  // User clicks → web page auto-links their account. No manual token copy.
  async function generateAuthCode(platform, platformUserId, platformUsername) {
    const code = crypto.randomBytes(8).toString('base64url');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    return new Promise((resolve) => {
      db.run(
        `INSERT INTO bot_auth_codes (code, platform, platform_user_id, platform_username, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
        [code, platform, String(platformUserId), platformUsername || '', expiresAt],
        function (err) { resolve(err ? null : code); }
      );
    });
  }

  async function redeemAuthCode(code) {
    return new Promise((resolve) => {
      db.get(
        'SELECT platform, platform_user_id, platform_username FROM bot_auth_codes WHERE code = ? AND expires_at > ?',
        [code, new Date().toISOString()],
        (err, row) => {
          if (err || !row) return resolve(null);
          db.run('DELETE FROM bot_auth_codes WHERE code = ?', [code], () => {});
          resolve(row);
        }
      );
    });
  }

  async function createShortLink(userId, originalUrl, customAlias, maxClicks) {
    const original = normalizeUrl(originalUrl);
    if (!original) return { error: 'invalid_url' };

    let short = '';
    if (customAlias) {
      const alias = normalizeAlias(customAlias);
      if (!alias) return { error: 'invalid_alias' };
      const exists = await new Promise((resolve) => {
        db.get('SELECT id FROM urls WHERE short = ?', [alias], (err, row) => resolve(!!row));
      });
      if (exists) return { error: 'alias_taken' };
      short = alias;
    } else {
      short = generateSafeShortCode();
    }

    const createdAt = new Date().toISOString();
    return new Promise((resolve) => {
      db.run(
        'INSERT INTO urls (original, short, created_at, user_id, link_password, expires_at, max_clicks, domain_host) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [original, short, createdAt, userId || null, '', null, maxClicks || null, null],
        function (err) {
          if (err) {
            const msg = (err.message || '').toLowerCase();
            if (msg.includes('unique')) return resolve({ error: 'alias_taken' });
            return resolve({ error: 'db_error' });
          }
          resolve({ short, original, created_at: createdAt });
        }
      );
    });
  }

  async function getDailyLinkCount(userId) {
    if (!userId) return 0;
    const today = new Date().toISOString().slice(0, 10);
    return new Promise((resolve) => {
      db.get(
        'SELECT COUNT(*) as cnt FROM urls WHERE user_id = ? AND created_at >= ?',
        [userId, today + 'T00:00:00.000Z'],
        (err, row) => resolve(err ? 0 : (row?.cnt || 0))
      );
    });
  }

  async function getLinkStats(userId, shortCode) {
    return new Promise((resolve) => {
      db.get('SELECT * FROM urls WHERE short = ? AND user_id = ?', [shortCode, userId], (err, url) => {
        if (err || !url) return resolve(null);
        db.get('SELECT COUNT(*) as total FROM clicks WHERE url_id = ?', [url.id], (cErr, cRow) => {
          resolve({
            short: url.short,
            original: url.original,
            total_clicks: cRow?.total || 0,
            created_at: url.created_at,
            reports: url.reports || 0,
            domain_host: url.domain_host || '',
          });
        });
      });
    });
  }

  function getTierLimits(userRow) {
    if (!userRow) return { dailyLinks: 10, maxLinks: 200, customAlias: false, batchMax: 1 };
    const isPro = isProAccessActive(userRow);
    if (isPro) return { dailyLinks: 100, maxLinks: 5000, customAlias: true, batchMax: 25 };
    return { dailyLinks: 10, maxLinks: 200, customAlias: false, batchMax: 1 };
  }

  async function getBotLanguage(platform, platformUserId) {
    return new Promise((resolve) => {
      db.get(
        'SELECT language FROM bot_settings WHERE platform = ? AND platform_user_id = ?',
        [platform, String(platformUserId)],
        (err, row) => resolve(err ? 'en' : (row?.language || 'en'))
      );
    });
  }

  async function setBotLanguage(platform, platformUserId, lang) {
    return new Promise((resolve) => {
      db.run(
        `INSERT INTO bot_settings (platform, platform_user_id, language)
         VALUES (?, ?, ?)
         ON CONFLICT(platform, platform_user_id) DO UPDATE SET
           language = excluded.language`,
        [platform, String(platformUserId), lang],
        function (err) { resolve(!err); }
      );
    });
  }

  return {
    normalizeUrl,
    normalizeAlias,
    getBotUser,
    linkBotUser,
    unlinkBotUser,
    generateAuthCode,
    redeemAuthCode,
    createShortLink,
    getDailyLinkCount,
    getLinkStats,
    getTierLimits,
    getBotLanguage,
    setBotLanguage,
  };
}

module.exports = { createBotShared };
