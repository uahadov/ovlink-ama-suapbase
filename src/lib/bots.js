const { db } = require('../db/index');
const { buildShortUrl, ensureAbsoluteUrl, generateSafeShortCode } = require('./url-helpers');
const { isProAccessActive } = require('./plans');
const { normalizeLang, pickLang } = require('./i18n');
const { logSecurityEvent } = require('./security');
const { createTelegramBot } = require('../../bots/telegram');
const { createDiscordBot } = require('../../bots/discord');
const { TELEGRAM_WEBHOOK_SECRET_TOKEN, isEnabledEnv, isProdRuntime } = require('../config/index');

const botOptions = {
  buildShortUrl,
  ensureAbsoluteUrl,
  generateSafeShortCode,
  isProAccessActive,
  normalizeLang,
  pickLang,
  logSecurityEvent,
};

let telegramBot = null;
let discordBot = null;

try {
  telegramBot = createTelegramBot(db, botOptions);
  if (telegramBot && telegramBot.isEnabled) {
    console.log('[startup] Telegram bot enabled.');
  } else {
    console.log('[startup] Telegram bot disabled (no token).');
  }
} catch (err) {
  console.warn('[startup] Telegram bot init failed:', err.message);
}

try {
  discordBot = createDiscordBot(db, botOptions);
  if (discordBot && discordBot.isEnabled) {
    console.log('[startup] Discord bot enabled.');
  } else {
    console.log('[startup] Discord bot disabled (no token).');
  }
} catch (err) {
  console.warn('[startup] Discord bot init failed:', err.message);
}

async function initBots() {
  if (!telegramBot || !telegramBot.isEnabled || process.env.NODE_ENV === 'test') return;

  const useWebhook = (process.env.TELEGRAM_MODE || '').toLowerCase() === 'webhook';
  const usePolling = !useWebhook || isEnabledEnv('TELEGRAM_POLLING', true);
  if (usePolling) {
    telegramBot.startPolling();
    return;
  }

  const configuredBaseUrl = (process.env.PUBLIC_BASE_URL || process.env.BASE_URL || '').trim().replace(/\/+$/, '');
  if (!configuredBaseUrl) {
    console.error('[startup] Telegram webhook not set: PUBLIC_BASE_URL or BASE_URL is missing.');
    return;
  }

  let webhookUrl;
  try {
    const parsedBaseUrl = new URL(configuredBaseUrl);
    const allowInsecureHttp = isEnabledEnv('ALLOW_INSECURE_WEBHOOK_HTTP', false);
    if (parsedBaseUrl.protocol !== 'https:' && !(parsedBaseUrl.protocol === 'http:' && allowInsecureHttp && !isProdRuntime)) {
      throw new Error('webhook base URL must use HTTPS');
    }
    webhookUrl = `${parsedBaseUrl.toString().replace(/\/+$/, '')}/api/bots/telegram/webhook`;
  } catch (err) {
    console.error('[startup] Telegram webhook not set:', err.message);
    return;
  }

  try {
    const configured = await telegramBot.setWebhook(webhookUrl, TELEGRAM_WEBHOOK_SECRET_TOKEN);
    if (configured) {
      console.log('[startup] Telegram webhook set:', webhookUrl);
    } else {
      console.error('[startup] Telegram setWebhook was rejected:', webhookUrl);
    }
  } catch (err) {
    console.error('[startup] Telegram setWebhook failed:', err.message);
  }
}

module.exports = {
  telegramBot,
  discordBot,
  initBots,
};
