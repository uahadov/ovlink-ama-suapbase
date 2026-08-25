const { db } = require('../db/index');
const { sendOpsAlert } = require('./alerts');
const { logSecurityEvent } = require('./security');

const threatUrlSet = new Set();
const threatHostSet = new Set();
let lastThreatFeedSync = 0;
const THREAT_FEED_SYNC_INTERVAL_MS = 2 * 60 * 60 * 1000;

const threatCache = new Map();
const THREAT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const THREAT_CACHE_MAX_ENTRIES = 5000;

async function syncThreatIntelligenceFeed() {
  try {
    const res = await fetch('https://urlhaus.abuse.ch/downloads/text_online/', {
      signal: AbortSignal.timeout(10000)
    });
    if (res.ok) {
      const text = await res.text();
      const lines = text.split('\n');
      const newUrls = new Set();
      const newHosts = new Set();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        newUrls.add(trimmed.toLowerCase());
        try {
          const u = new URL(trimmed);
          if (u.hostname) newHosts.add(u.hostname.toLowerCase());
        } catch {}
      }
      if (newUrls.size > 0) {
        threatUrlSet.clear();
        threatHostSet.clear();
        for (const u of newUrls) threatUrlSet.add(u);
        for (const h of newHosts) threatHostSet.add(h);
        lastThreatFeedSync = Date.now();
        console.log(`[threat-intel] Successfully synced ${threatUrlSet.size} active malware URLs from URLhaus.`);
      }
    }
  } catch (err) {
    console.warn('[threat-intel] Feed sync warning:', err && err.message);
  }
}

async function checkUrlhausThreat(targetUrl) {
  const authKey = (process.env.URLHAUS_AUTH_KEY || process.env.URLHAUS_API_KEY || '').trim();
  try {
    const body = new URLSearchParams({ url: targetUrl });
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (authKey) headers['Auth-Key'] = authKey;

    const res = await fetch('https://urlhaus-api.abuse.ch/v1/url/', {
      method: 'POST',
      headers,
      body: body.toString(),
      signal: AbortSignal.timeout(4000)
    });
    if (!res.ok) return { threat: false };
    const data = await res.json();
    if (data && data.query_status === 'ok') {
      const threatType = (data.threat || 'malware_url').toString();
      const status = (data.url_status || 'online').toString();
      return { threat: true, reason: `urlhaus_${threatType}_${status}`, provider: 'urlhaus_api' };
    }
    return { threat: false };
  } catch {
    return { threat: false };
  }
}

async function checkGoogleSafeBrowsingThreat(targetUrl) {
  const apiKey = (process.env.GOOGLE_SAFE_BROWSING_KEY || process.env.SAFE_BROWSING_API_KEY || '').trim();
  if (!apiKey) return { threat: false };
  try {
    const payload = {
      client: { clientId: 'ovlink-url-shortener', clientVersion: '1.0.0' },
      threatInfo: {
        threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
        platformTypes: ['ANY_PLATFORM'],
        threatEntryTypes: ['URL'],
        threatEntries: [{ url: targetUrl }]
      }
    };
    const res = await fetch(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(4000)
    });
    if (!res.ok) return { threat: false };
    const data = await res.json();
    if (data && Array.isArray(data.matches) && data.matches.length > 0) {
      const match = data.matches[0];
      return { threat: true, reason: `google_${(match.threatType || 'threat').toLowerCase()}`, provider: 'google_safebrowsing' };
    }
    return { threat: false };
  } catch {
    return { threat: false };
  }
}

async function checkVirusTotalThreat(targetUrl) {
  const apiKey = (process.env.VIRUSTOTAL_API_KEY || '').trim();
  if (!apiKey) return { threat: false };
  try {
    const urlId = Buffer.from(targetUrl).toString('base64url');
    const res = await fetch(`https://www.virustotal.com/api/v3/urls/${urlId}`, {
      method: 'GET',
      headers: { 'x-apikey': apiKey },
      signal: AbortSignal.timeout(4000)
    });
    if (!res.ok) return { threat: false };
    const data = await res.json();
    const stats = data && data.data && data.data.attributes && data.data.attributes.last_analysis_stats;
    if (stats && (stats.malicious >= 1 || (stats.malicious + stats.suspicious) >= 2)) {
      return { threat: true, reason: `virustotal_malicious_${stats.malicious}`, provider: 'virustotal' };
    }
    return { threat: false };
  } catch {
    return { threat: false };
  }
}

async function checkLiveThreat(targetUrl) {
  if (!targetUrl) return { threat: false };

  const normalized = targetUrl.trim().toLowerCase();
  let targetHostname = '';
  try {
    targetHostname = new URL(targetUrl).hostname.toLowerCase();
  } catch {}

  if (threatUrlSet.has(normalized) || (targetHostname && threatHostSet.has(targetHostname))) {
    return { threat: true, reason: 'urlhaus_active_malware', provider: 'urlhaus_live_feed' };
  }

  const cached = threatCache.get(targetUrl);
  if (cached && (Date.now() - cached.checkedAt < THREAT_CACHE_TTL_MS)) {
    return cached;
  }

  const uhResult = await checkUrlhausThreat(targetUrl);
  if (uhResult && uhResult.threat) {
    if (threatCache.size >= THREAT_CACHE_MAX_ENTRIES) {
      const oldestKey = threatCache.keys().next().value;
      if (oldestKey) threatCache.delete(oldestKey);
    }
    threatCache.set(targetUrl, { ...uhResult, checkedAt: Date.now() });
    return uhResult;
  }

  const gsbResult = await checkGoogleSafeBrowsingThreat(targetUrl);
  if (gsbResult && gsbResult.threat) {
    if (threatCache.size >= THREAT_CACHE_MAX_ENTRIES) {
      const oldestKey = threatCache.keys().next().value;
      if (oldestKey) threatCache.delete(oldestKey);
    }
    threatCache.set(targetUrl, { ...gsbResult, checkedAt: Date.now() });
    return gsbResult;
  }

  const vtResult = await checkVirusTotalThreat(targetUrl);
  if (vtResult && vtResult.threat) {
    if (threatCache.size >= THREAT_CACHE_MAX_ENTRIES) {
      const oldestKey = threatCache.keys().next().value;
      if (oldestKey) threatCache.delete(oldestKey);
    }
    threatCache.set(targetUrl, { ...vtResult, checkedAt: Date.now() });
    return vtResult;
  }

  const finalResult = { threat: false, provider: 'none' };

  if (threatCache.size >= THREAT_CACHE_MAX_ENTRIES) {
    const oldestKey = threatCache.keys().next().value;
    if (oldestKey) threatCache.delete(oldestKey);
  }
  threatCache.set(targetUrl, { ...finalResult, checkedAt: Date.now() });
  return finalResult;
}

function quarantineUrlByShort(shortCode, reason, triggerSource = 'safety_scanner') {
  if (!shortCode) return;
  db.get('SELECT id, short, original, user_id, disabled FROM urls WHERE short = ?', [shortCode], (err, row) => {
    if (err || !row) return;
    if (row.disabled == 1) return;

    const disabledReason = reason || 'security_threat';
    const nowIso = new Date().toISOString();

    db.run(
      'UPDATE urls SET disabled = 1, dangerous = 1, disabled_reason = ?, disabled_at = ? WHERE id = ? AND (disabled = 0 OR disabled IS NULL)',
      [disabledReason, nowIso, row.id],
      function (updateErr) {
        if (updateErr) {
          console.error('[safety-scanner] Failed to quarantine URL:', shortCode, updateErr.message);
          return;
        }
        if ((this.changes || 0) === 0) return;

        console.warn(`[safety-scanner] URL "${shortCode}" quarantined due to: ${disabledReason} (source: ${triggerSource})`);

        if (row.user_id) {
          const eventKey = `quarantine_${shortCode}_${Date.now()}`;
          const titleAz = '⚠️ Təhlükəsizlik Xəbərdarlığı';
          const titleTr = '⚠️ Güvenlik Uyarısı';
          const titleEn = '⚠️ Security Alert';

          const bodyAz = `"${shortCode}" qısa linkinizin hədəf ünvanı təhlükəsizlik qaydalarına zidd (${disabledReason}) olduğu üçün karantinə alındı və yönləndirmə dayandırıldı.`;
          const bodyTr = `"${shortCode}" kısa linkinizin hedef adresi güvenlik riski (${disabledReason}) nedeniyle karantinaya alındı ve yönlendirme durduruldu.`;
          const bodyEn = `The destination URL of short link "${shortCode}" was flagged as unsafe (${disabledReason}) and quarantined.`;

          db.run(
            'INSERT OR IGNORE INTO notifications (user_id, type, title_az, title_tr, title_en, body_az, body_tr, body_en, link_short, event_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [row.user_id, 'security_alert', titleAz, titleTr, titleEn, bodyAz, bodyTr, bodyEn, shortCode, eventKey, nowIso],
            () => {}
          );
        }

        try {
          logSecurityEvent(null, 'quarantine_threat', 'quarantined', {
            target_short: shortCode,
            reason: disabledReason,
            source: triggerSource,
            original: row.original,
            user_id: row.user_id || null
          });
        } catch {}

        sendOpsAlert('quarantine:' + shortCode, 'Link Quarantined', `Short: ${shortCode}\nReason: ${disabledReason}\nOriginal: ${row.original}`);
      }
    );
  });
}

function scanUrlAsync(shortCode, originalUrl, userId) {
  if (!shortCode || !originalUrl) return;
  setImmediate(async () => {
    try {
      const check = await checkLiveThreat(originalUrl);
      if (check && check.threat) {
        quarantineUrlByShort(shortCode, check.reason || 'threat_detected', check.provider || 'async_creation_scan');
      }
    } catch (err) {
      console.warn('[safety-scanner] Async scan error:', err && (err.message || err));
    }
  });
}

function runWeeklySafetyScan() {
  console.log('[safety-scanner] Starting weekly background safety sweep...');
  let lastId = 0;
  const batchSize = 50;
  const intervalMs = 2000;

  const fetchNextBatch = () => {
    db.all(
      'SELECT id, short, original, user_id FROM urls WHERE id > ? AND (disabled = 0 OR disabled IS NULL) ORDER BY id ASC LIMIT ?',
      [lastId, batchSize],
      async (err, rows) => {
        if (err || !Array.isArray(rows) || rows.length === 0) {
          console.log('[safety-scanner] Weekly safety sweep complete.');
          return;
        }

        for (const item of rows) {
          lastId = Math.max(lastId, item.id);
          if (!item.original) continue;
          try {
            const check = await checkLiveThreat(item.original);
            if (check && check.threat) {
              quarantineUrlByShort(item.short, check.reason || 'periodic_safety_scan', check.provider || 'weekly_cron');
            }
          } catch {}
        }

        setTimeout(fetchNextBatch, intervalMs);
      }
    );
  };

  fetchNextBatch();
}

function scheduleWeeklySafetyScan() {
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const timer = setTimeout(() => {
    runWeeklySafetyScan();
    const interval = setInterval(runWeeklySafetyScan, WEEK_MS);
    if (interval && interval.unref) interval.unref();
  }, 5 * 60 * 1000);
  if (timer && timer.unref) timer.unref();
}

module.exports = {
  scanUrlAsync,
  runWeeklySafetyScan,
  scheduleWeeklySafetyScan,
  syncThreatIntelligenceFeed,
  checkLiveThreat,
  checkUrlhausThreat,
  checkGoogleSafeBrowsingThreat,
  checkVirusTotalThreat,
  quarantineUrlByShort,
  THREAT_FEED_SYNC_INTERVAL_MS
};
