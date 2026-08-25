require('dotenv').config();

const { app } = require('./src/app');

// Import startup helpers
const { ensureRedisConnected } = require('./src/config/redis');
const { ensureDbTables } = require('./src/db/migrate');
const { db } = require('./src/db/index');
const { syncThreatIntelligenceFeed, scheduleWeeklySafetyScan, THREAT_FEED_SYNC_INTERVAL_MS } = require('./src/lib/safety');
const { scheduleWebhookRecoveryWorker } = require('./src/lib/webhook');
const { initGoogleOidc } = require('./src/lib/google-auth');
const { refreshCustomDomainCache, validateBaseUrlConfiguration } = require('./src/lib/custom-domain');

// Export helpers for tests
const { ensureAbsoluteUrl, normalizeShortCode, isReservedShortAlias, normalizeCustomDomainInput } = require('./src/lib/url-helpers');
const { checkLiveThreat, checkUrlhausThreat, checkGoogleSafeBrowsingThreat, checkVirusTotalThreat, quarantineUrlByShort, scanUrlAsync, runWeeklySafetyScan } = require('./src/lib/safety');
const { getRequestIp, maskIpForDisplay, buildNetworkFingerprintForDisplay } = require('./src/lib/geo');
const { getPublicBaseUrl, buildAbsoluteUrl, hasApiKeyAuthHeader, hashApiKeyValueLegacy, hashApiKeyValue, hashWebhookSecretValueV2, buildWebhookSignatureV2Key } = require('./src/lib/security');
const { normalizeConsentMode, normalizeConsentNext, buildRedirectConsentSignature, isRedirectConsentSignatureValid } = require('./src/lib/consent');
const { normalizeFutureExpiryInput, isIsoTimeExpired } = require('./src/lib/plans');
const { isBlockedWebhookIp, isBlockedWebhookHostname, validateOutboundWebhookUrl } = require('./src/lib/url-validator');
const { resolveFinalRedirectUrl } = require('./src/routes/redirect');
const { dbRunAsync, dbGetAsync, dbAllAsync } = require('./src/db/helpers');
const { pool } = require('./src/db/pool');

const PORT = parseInt(process.env.PORT || '3000', 10);

if (require.main === module) {
  (async () => {
    validateBaseUrlConfiguration();
    await ensureRedisConnected();
    ensureDbTables();
    
    // Wait for DB migration queue to drain
    await new Promise(resolve => {
      const check = () => {
        if (!db._isSerializing && db._queue.length === 0 && !db._isProcessingQueue) resolve();
        else setTimeout(check, 50);
      };
      check();
    });

    await initGoogleOidc();
    refreshCustomDomainCache();
    syncThreatIntelligenceFeed();
    setInterval(syncThreatIntelligenceFeed, THREAT_FEED_SYNC_INTERVAL_MS).unref();
    scheduleWeeklySafetyScan();
    scheduleWebhookRecoveryWorker();

    app.listen(PORT, () => {
      console.log(`[ovlink] Server listening on port ${PORT}`);
    });
  })().catch(err => {
    console.error('[startup] fatal error before listen', err && (err.message || err));
    process.exit(1);
  });
}

module.exports = {
  app,
  helpers: {
    ensureAbsoluteUrl,
    normalizeShortCode,
    isReservedShortAlias,
    normalizeCustomDomainInput,
    syncThreatIntelligenceFeed,
    checkLiveThreat,
    checkUrlhausThreat,
    checkGoogleSafeBrowsingThreat,
    checkVirusTotalThreat,
    quarantineUrlByShort,
    scanUrlAsync,
    runWeeklySafetyScan,
    getRequestIp,
    maskIpForDisplay,
    buildNetworkFingerprintForDisplay,
    getPublicBaseUrl,
    buildAbsoluteUrl,
    normalizeConsentMode,
    normalizeConsentNext,
    normalizeFutureExpiryInput,
    isIsoTimeExpired,
    buildRedirectConsentSignature,
    isRedirectConsentSignatureValid,
    hasApiKeyAuthHeader,
    hashApiKeyValueLegacy,
    hashApiKeyValue,
    hashWebhookSecretValueV2,
    buildWebhookSignatureV2Key,
    isBlockedWebhookIp,
    isBlockedWebhookHostname,
    validateOutboundWebhookUrl,
    resolveFinalRedirectUrl,
    dbRunAsync,
    dbGetAsync,
    dbAllAsync,
    closeDbPool: () => pool.end(),
    isDbMigrationQueueDrained: () => !db._isSerializing && db._queue.length === 0 && !db._isProcessingQueue,
  },
};
