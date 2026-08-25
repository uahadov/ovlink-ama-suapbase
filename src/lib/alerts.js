// extracted from server.js
const OPS_ALERT_RATE_LIMIT_MS = 10 * 60 * 1000;
const opsAlertSentAt = new Map();
function sendOpsAlert(key, title, details = '') {
  if (process.env.NODE_ENV === 'test') return; // test runs share this process env via dotenv; never page real channels from tests
  const url = (process.env.ALERT_WEBHOOK_URL || '').toString().trim();
  if (!url) return;
  const now = Date.now();
  const last = opsAlertSentAt.get(key) || 0;
  if (now - last < OPS_ALERT_RATE_LIMIT_MS) return;
  opsAlertSentAt.set(key, now);
  if (opsAlertSentAt.size > 100) {
    const oldestKey = opsAlertSentAt.keys().next().value;
    opsAlertSentAt.delete(oldestKey);
  }

  const text = `[ovlink ALERT] ${title}${details ? `\n${String(details).slice(0, 1200)}` : ''}`;
  const payload = url.includes('api.telegram.org')
    ? { chat_id: (process.env.ALERT_TG_CHAT_ID || '').toString().trim(), text }
    : { text, title, details: String(details).slice(0, 1500), timestamp: new Date().toISOString() };

  (async () => {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        console.error('[ops-alert] destination responded', response.status);
      }
    } catch (err) {
      console.error('[ops-alert] delivery failed:', err && (err.message || err));
    }
  })();
}
module.exports = { sendOpsAlert };
