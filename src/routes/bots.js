const express = require('express');
const router = express.Router();


const { dbGetAsync, dbRunAsync } = require('../db/helpers');
const { db } = require('../db/index');
const { TELEGRAM_WEBHOOK_SECRET_TOKEN, WEBHOOK_HASH_KEY_MATERIAL } = require('../config/index');
const crypto = require('crypto');


router.post('/api/bots/telegram/webhook', express.json(), async (req, res) => {
  if (!telegramBot || !telegramBot.isEnabled) return res.status(404).json({ error: 'Not found' });

  // Verify the request actually came from Telegram (or at least from
  // someone who knows our secret token) using constant-time comparison.
  // Without this, anyone who discovers the webhook URL could forge
  // "updates" impersonating any linked Telegram user.
  const providedToken = (req.get('X-Telegram-Bot-Api-Secret-Token') || '').toString();
  if (!providedToken || !tsscmp(providedToken, TELEGRAM_WEBHOOK_SECRET_TOKEN)) {
    console.error('[telegram-bot] Secret token verification failed or missing header.');
    return res.status(401).json({ error: 'invalid request token' });
  }

  try {
    await telegramBot.processUpdate(req.body);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[telegram-bot] webhook error:', err.message);
    return res.status(500).json({ error: 'webhook processing failed' });
  }
});

// Discord interactions endpoint (slash commands)
router.post('/api/bots/discord/interactions', async (req, res) => {
  if (!discordBot || !discordBot.isEnabled) return res.status(404).json({ error: 'Not found' });

  const signature = req.get('X-Signature-Ed25519');
  const timestamp = req.get('X-Signature-Timestamp');

  if (!signature || !timestamp || !discordBot.verifySignature(signature, timestamp, req.rawBody)) {
    console.error('[discord-bot] Signature verification failed or missing headers.');
    return res.status(401).end('invalid request signature');
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      console.error('[discord-bot] Failed to parse JSON body:', e.message);
      return res.status(400).json({ error: 'invalid json' });
    }
  }

  if (body && body.type === 1) {
    return res.json({ type: 1 });
  }

  const response = await discordBot.handleInteraction(body);
  res.json(response);
});



module.exports = router;
