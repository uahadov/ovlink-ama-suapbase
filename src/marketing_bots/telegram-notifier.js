require('dotenv').config();

/**
 * Telegram Notification Service for Ovlink Marketing Bots
 * Sends instant alerts when leads are discovered, emails are dispatched, or opportunities arise.
 */

async function sendTelegramAlert(text, options = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.ALERT_TG_CHAT_ID;

  if (!token || !chatId) {
    console.warn('[Telegram Notifier] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_ADMIN_CHAT_ID in .env');
    return false;
  }

  try {
    const payload = {
      chat_id: chatId,
      text: text.slice(0, 4000),
      parse_mode: 'HTML',
      disable_web_page_preview: false
    };

    if (options.keyboard) {
      payload.reply_markup = { inline_keyboard: options.keyboard };
    }

    let response = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    let data = await response.json();
    if (!data.ok) {
      if (payload.parse_mode && data.description && (data.description.includes("can't parse entities") || data.description.includes('entity'))) {
        console.warn('[Telegram Notifier] HTML entity error; retrying in plain text:', data.description);
        const plainPayload = {
          ...payload,
          parse_mode: undefined,
          text: text.replace(/<[^>]+>/g, '').slice(0, 4000)
        };
        const retryRes = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
          method: 'POST',
          signal: AbortSignal.timeout(10000),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(plainPayload)
        });
        const retryData = await retryRes.json();
        if (retryData.ok) return true;
        data = retryData;
      }
      console.error('[Telegram Notifier] Telegram API error:', data.description);
      return false;
    }

    return true;
  } catch (error) {
    console.error('[Telegram Notifier] Failed to send Telegram alert:', error.message);
    return false;
  }
}

module.exports = { sendTelegramAlert };
