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

    const response = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!data.ok) {
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
