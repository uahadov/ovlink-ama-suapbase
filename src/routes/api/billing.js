const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { db } = require('../../db/index');
const { dbGetAsync, dbRunAsync } = require('../../db/helpers');
const { requireSignedIn } = require('../../middleware/auth');
const { isProdRuntime } = require('../../config/index');
const { verifyPolarWebhook, resolvePolarProductPolicy } = require('../../../utils/polar');
const { blindIndex, encryptAES256GCM, decryptAES256GCM } = require('../../../utils/crypto');
const { getPublicBaseUrl } = require('../../lib/security');
const { sendOpsAlert } = require('../../lib/alerts');

router.post('/api/polar/create-checkout', async (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'unauthorized', code: 'not_logged_in' });
  }

  const expectedPriceId = process.env.POLAR_PRODUCT_PRICE_ID || '';
  if (!expectedPriceId) {
    console.error('[polar] POLAR_PRODUCT_PRICE_ID is missing from environment variables.');
    return res.status(500).json({ error: 'Checkout configuration missing on server.' });
  }

  if (!process.env.POLAR_ACCESS_TOKEN) {
    console.error('[polar] POLAR_ACCESS_TOKEN is missing from environment variables.');
    return res.status(500).json({ error: 'Checkout configuration missing on server.' });
  }

  try {
    const user = await new Promise((resolve, reject) => {
      db.get('SELECT email, trial_used_at FROM users WHERE id = ?', [req.session.userId], (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });

    if (!user) {
      return res.status(401).json({ error: 'unauthorized', code: 'user_not_found' });
    }

    // users.email is stored encrypted; Polar needs the real address.
    const customerEmail = decryptAES256GCM(user.email).toString().trim();
    if (!customerEmail || !customerEmail.includes('@')) {
      console.error('[polar] Could not decrypt a usable email for user', req.session.userId, '; refusing checkout.');
      return res.status(500).json({ error: 'Account email is unavailable. Please contact support.' });
    }

    const payload = {
      product_price_id: expectedPriceId,
      success_url: `${getPublicBaseUrl(req)}/pro`,
      customer_email: customerEmail,
      customer_metadata: {
        user_id: req.session.userId.toString()
      }
    };
    // One trial per account: once trial_used_at is set, disable the trial
    // period for this checkout even when the product configures one.
    if (user.trial_used_at) {
      payload.allow_trial = false;
    }

    const response = await fetch('https://api.polar.sh/v1/checkouts/', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.POLAR_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      console.error('[polar] Checkout session creation failed:', response.status, errData);
      return res.status(502).json({ error: 'Failed to create checkout session with payment provider.' });
    }

    const sessionData = await response.json();
    return res.json({ url: sessionData.url });
  } catch (err) {
    console.error('[polar] Checkout session error:', err);
    return res.status(500).json({ error: 'Internal server error during checkout creation.' });
  }
});

// Polar Customer Portal session: lets a signed-in customer manage their
// subscription (cancel, renew/uncancel, update payment method, invoices) on
// Polar's hosted portal via a short-lived pre-authenticated link.
router.post('/api/polar/portal-session', async (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'unauthorized', code: 'not_logged_in' });
  }
  if (!process.env.POLAR_ACCESS_TOKEN) {
    console.error('[polar] POLAR_ACCESS_TOKEN is missing from environment variables.');
    return res.status(500).json({ error: 'Polar configuration missing on server.' });
  }
  try {
    const user = await new Promise((resolve, reject) => {
      db.get('SELECT polar_customer_id FROM users WHERE id = ?', [req.session.userId], (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });
    if (!user) {
      return res.status(401).json({ error: 'unauthorized', code: 'user_not_found' });
    }
    if (!user.polar_customer_id) {
      return res.status(400).json({ error: 'no_subscription', code: 'polar_customer_not_linked' });
    }

    const response = await fetch('https://api.polar.sh/v1/customer-sessions/', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.POLAR_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        customer_id: user.polar_customer_id,
        return_url: `${getPublicBaseUrl(req)}/account`
      })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      console.error('[polar] Customer session creation failed:', response.status, errData);
      return res.status(502).json({ error: 'Failed to create customer portal session.' });
    }

    const sessionData = await response.json();
    const portalUrl = sessionData.customer_portal_url || sessionData.customerPortalUrl || sessionData.url;
    if (!portalUrl) {
      console.error('[polar] Portal URL missing from response:', sessionData);
      return res.status(502).json({ error: 'Failed to create customer portal session.' });
    }
    return res.json({ url: portalUrl });
  } catch (err) {
    console.error('[polar] Customer session error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// Polar.sh Webhook Endpoint for automated subscriptions & orders
let polarProductAllowlistWarned = false;
router.post('/api/polar/webhook', async (req, res) => {
  const secret = (process.env.POLAR_WEBHOOK_SECRET || '').toString().trim();
  const verified = verifyPolarWebhook(req.rawBody, req.headers, secret);
  if (!verified) {
    const hasWebhookHeaders = !!(
      (req.headers['webhook-id'] || req.headers['Webhook-Id']) &&
      (req.headers['webhook-timestamp'] || req.headers['Webhook-Timestamp']) &&
      (req.headers['webhook-signature'] || req.headers['Webhook-Signature'])
    );
    const eventTs = parseInt((req.headers['webhook-timestamp'] || req.headers['Webhook-Timestamp'] || '0'), 10);
    const ageSec = Number.isFinite(eventTs) && eventTs > 0 ? Math.abs(Math.floor(Date.now() / 1000) - eventTs) : null;
    let reason;
    let advice;
    if (!hasWebhookHeaders) {
      reason = ' (request carries no Standard Webhooks headers ÔÇö not a Polar delivery; likely a probe or malformed request)';
      advice = 'Not a Polar delivery (missing webhook headers) ÔÇö no action needed.';
    } else if (ageSec !== null && ageSec > 300) {
      reason = ' (stale event: ' + ageSec + 's old ÔÇö replay protection rejected it; expected for Polar retries/redeliveries of old events)';
      advice = 'Stale event (' + ageSec + 's old, replay protection) ÔÇö not an error if secret is correct.';
    } else {
      reason = ' (signature mismatch: secret len=' + secret.length + ', whsec_prefix=' + secret.startsWith('whsec_') + ', event age=' + (ageSec === null ? 'n/a' : ageSec + 's') + ')';
      advice = 'Signature mismatch ÔÇö copy the current secret from the Polar endpoint into POLAR_WEBHOOK_SECRET and restart (running secret len=' + secret.length + ').';
    }
    console.error('[polar-webhook] Signature verification failed' + reason);
    sendOpsAlert('polar_signature', 'Polar webhook rejected', ('Event rejected. ' + advice));
    return res.status(403).json({ error: 'invalid signature' });
  }

  let event;
  try {
    event = typeof req.body === 'object' && req.body !== null ? req.body : JSON.parse(req.rawBody ? req.rawBody.toString() : '{}');
  } catch (err) {
    console.error('[polar-webhook] JSON parse error:', err.message);
    return res.status(400).json({ error: 'invalid payload' });
  }

  const eventType = (event.type || '').toString();
  const data = event.data || {};
  console.log(`[polar-webhook] Received event: ${eventType}`);

  // Durable billing history (surfaced in the admin panel, purged after 90d).
  const polarWebhookId = (req.headers['webhook-id'] || req.headers['Webhook-Id'] || '').toString();
  if (polarWebhookId) {
    try {
      const alreadyProcessed = await dbGetAsync('SELECT webhook_id FROM polar_processed_webhooks WHERE webhook_id = ?', [polarWebhookId]);
      if (alreadyProcessed) {
        console.log(`[polar-webhook] Duplicate webhook ${polarWebhookId} ignored.`);
        return res.status(200).json({ received: true, deduplicated: true });
      }
      await dbRunAsync('INSERT INTO polar_processed_webhooks (webhook_id, event_type, processed_at) VALUES (?, ?, ?)', [polarWebhookId, eventType, new Date().toISOString()]);
    } catch (dedupErr) {
      console.warn('[polar-webhook] deduplication check warning:', dedupErr && dedupErr.message);
    }
  }

  const logPolarEvent = (outcome, detail, userId) => {
    db.run(
      'INSERT INTO polar_events (webhook_id, event_type, product_id, user_id, outcome, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [polarWebhookId, eventType, ((data.product_id || (data.product && data.product.id)) || '').toString(), userId || null, outcome, String(detail || '').slice(0, 300), new Date().toISOString()],
      () => {}
    );
  };

  // Product ID Validation. An unconfigured allowlist must never silently
  // accept every product in the organization: fail closed in production.
  const productPolicy = resolvePolarProductPolicy(process.env.POLAR_PRODUCT_ID, isProdRuntime);
  if (productPolicy.mode === 'fail_closed') {
    console.error('[polar-webhook] POLAR_PRODUCT_ID is not configured; refusing to process events (fail closed).');
    return res.status(500).json({ error: 'webhook product validation not configured' });
  }
  if (productPolicy.mode === 'enforce') {
    const productId = data.product_id || (data.product && data.product.id) || null;
    if (productId !== productPolicy.expectedProductId) {
      console.warn(`[polar-webhook] Ignoring event for product ${productId} (expected ${productPolicy.expectedProductId})`);
      logPolarEvent('ignored:wrong_product', `product=${productId}`);
      return res.status(200).json({ received: true, ignored: 'wrong_product' });
    }
  } else if (!polarProductAllowlistWarned) {
    polarProductAllowlistWarned = true;
    console.warn('[polar-webhook] POLAR_PRODUCT_ID not set (non-production); product allowlist disabled.');
  }

  try {
    const customerEmail = (data.customer && data.customer.email) || data.customer_email || data.email || '';
    // Prevent email-binding attack if we eventually implement server-side checkout sessions:
    // (We still resolve by user_id metadata first)
    const userIdRaw = (data.custom_field_data && data.custom_field_data.user_id) ||
      (data.metadata && data.metadata.user_id) ||
      (data.user_metadata && data.user_metadata.user_id) ||
      (data.customer_metadata && data.customer_metadata.user_id) ||
      (data.customer && data.customer.metadata && data.customer.metadata.user_id) ||
      null;
    const userId = userIdRaw ? parseInt(userIdRaw, 10) : null;
    // Orders reference their subscription via `subscription_id`; `data.id` on
    // an order event is the ORDER id and must never be persisted as a
    // subscription id (it breaks every later subscription-id comparison).
    const isOrderEvent = eventType.startsWith('order.');
    const polarSubId = isOrderEvent
      ? ((data.subscription_id != null && data.subscription_id !== '') ? String(data.subscription_id) : ((data.subscription && data.subscription.id) || null))
      : ((data.id != null && data.id !== '') ? String(data.id) : ((data.subscription && data.subscription.id) || null));
    const polarCustomerId = (data.customer && data.customer.id) || data.customer_id || null;

    const findUser = () => new Promise((resolve, reject) => {
      // Narrowed query to avoid fetching sensitive data
      const q = 'SELECT id, plan_tier, plan_status, pro_expires_at, polar_subscription_id, polar_customer_id, trial_used_at FROM users WHERE ';
      if (Number.isInteger(userId) && userId > 0) {
        db.get(q + 'id = ?', [userId], (err, row) => {
          if (err) return reject(err);
          if (row) return resolve(row);
          if (customerEmail) {
            db.get(q + 'email_hash = ? ORDER BY id DESC', [blindIndex(customerEmail)], (e2, r2) => {
              if (e2) return reject(e2);
              resolve(r2 || null);
            });
          } else {
            resolve(null);
          }
        });
      } else if (customerEmail) {
        db.get(q + 'email_hash = ? ORDER BY id DESC', [blindIndex(customerEmail)], (err, row) => {
          if (err) return reject(err);
          resolve(row || null);
        });
      } else {
        resolve(null);
      }
    });

    const targetUser = await findUser();
    if (!targetUser) {
      console.warn(`[polar-webhook] No matching user found for email=${customerEmail} userId=${userId}`);
      logPolarEvent('no_user_match', `email=${customerEmail} user_id=${userId}`);
      return res.status(200).json({ received: true, matched: false });
    }

    const nowIso = new Date().toISOString();
    const msgId = req.headers['webhook-id'] || req.headers['Webhook-Id'] || `evt_${Date.now()}`;

    const parseIsoTimeMs = (raw) => {
      if (!raw) return Number.NaN;
      const ms = Date.parse(raw);
      return Number.isFinite(ms) ? ms : Number.NaN;
    };
    const isCurrentlyPro = targetUser.plan_tier === 'pro' && targetUser.plan_status === 'active' && parseIsoTimeMs(targetUser.pro_expires_at) > Date.now();

    if (
      eventType.startsWith('subscription.created') ||
      eventType.startsWith('subscription.updated') ||
      eventType.startsWith('subscription.active') ||
      eventType.startsWith('subscription.cycled') ||
      eventType.startsWith('subscription.uncanceled') ||
      eventType.startsWith('subscription.resumed') ||
      eventType.startsWith('order.paid')
    ) {
      // Polar subscription statuses: incomplete, incomplete_expired, trialing,
      // active, past_due, canceled, unpaid, paused. Orders carry
      // draft/pending/paid/refunded/... Only genuinely paid or trialing states
      // grant/extend entitlement; other states are handled by their dedicated
      // lifecycle events (revoke/cancel branches below).
      const status = (data.status != null && data.status !== '' ? data.status : (isOrderEvent ? 'paid' : 'active')).toString().toLowerCase();
      const isPaidActivationState = status === 'active' || status === 'trialing' || (isOrderEvent && status === 'paid');
      if (!isPaidActivationState) {
        console.log(`[polar-webhook] Ignoring ${eventType} with status=${status} (not an activation state).`);
        logPolarEvent('ignored:inactive_status', `status=${status}`, targetUser.id);
        return res.status(200).json({ received: true, ignored: 'inactive_status', status });
      }

      // Prevent Downgrade/Overwrite Attack
      if (isCurrentlyPro && targetUser.polar_subscription_id && polarSubId && targetUser.polar_subscription_id !== polarSubId) {
        console.warn(`[polar-webhook] User ${targetUser.id} already has active sub ${targetUser.polar_subscription_id}. Ignoring new sub ${polarSubId}`);
        logPolarEvent('ignored:active_sub_mismatch', `stored=${targetUser.polar_subscription_id} event=${polarSubId}`, targetUser.id);
        return res.status(200).json({ received: true, ignored: 'active_sub_mismatch' });
      }

      // Trial detection per the Polar schema: status === 'trialing' and/or a
      // trial_end in the future. (There is no `is_free_trial` field.)
      const trialEndMs = parseIsoTimeMs(data.trial_end);
      const isTrial = status === 'trialing' || (Number.isFinite(trialEndMs) && trialEndMs > Date.now());
      // One trial per account: a trial on a different subscription than the
      // one that is (or was) recorded means the account already consumed its
      // trial; do not grant entitlement for it.
      if (isTrial && targetUser.trial_used_at && targetUser.polar_subscription_id !== polarSubId) {
        console.warn(`[polar-webhook] User ${targetUser.id} already used the trial; ignoring repeat trial on sub ${polarSubId}.`);
        logPolarEvent('ignored:trial_already_used', `sub=${polarSubId}`, targetUser.id);
        return res.status(200).json({ received: true, ignored: 'trial_already_used' });
      }

      let expiresAt = data.current_period_end ? new Date(data.current_period_end).toISOString() : null;
      if (!expiresAt || Number.isNaN(Date.parse(expiresAt))) {
        // Fix Replay Drift Attack
        const fallbackBase = data.created_at ? new Date(data.created_at) : new Date();
        fallbackBase.setDate(fallbackBase.getDate() + 32);
        expiresAt = fallbackBase.toISOString();
      }
      // Event ordering must never shrink an already-paid period of the same
      // subscription (e.g. order.paid arriving after subscription.updated).
      if (polarSubId && targetUser.polar_subscription_id === polarSubId) {
        const existingExpiryMs = parseIsoTimeMs(targetUser.pro_expires_at);
        if (Number.isFinite(existingExpiryMs) && existingExpiryMs > Date.parse(expiresAt)) {
          expiresAt = targetUser.pro_expires_at;
        }
      }

      let trialUsedAt = targetUser.trial_used_at;
      if (isTrial && !trialUsedAt) {
        trialUsedAt = nowIso;
      }

      await new Promise((resolve, reject) => {
        db.run(
          'UPDATE users SET plan_tier = ?, plan_status = ?, pro_expires_at = ?, polar_subscription_id = ?, polar_customer_id = ?, trial_used_at = ?, pro_updated_at = ? WHERE id = ?',
          ['pro', 'active', expiresAt, polarSubId || targetUser.polar_subscription_id, polarCustomerId || targetUser.polar_customer_id, trialUsedAt, nowIso, targetUser.id],
          (err) => (err ? reject(err) : resolve())
        );
      });

      // Add notification for the user
      const notifEventKey = `polar_pro_${msgId}`;
      db.run(
        'INSERT OR IGNORE INTO notifications (user_id, type, title_az, title_tr, title_en, body_az, body_tr, body_en, event_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          targetUser.id,
          'system',
          'Ovlink Pro Aktiv Edildi! ­şææ',
          'Ovlink Pro Aktif Edildi! ­şææ',
          'Ovlink Pro Activated! ­şææ',
          'Pro abunəliyiniz uğurla aktivləşdirildi. Bütün limitsiz imkanlardan dərhal istifadə edə bilərsiniz.',
          'Pro üyeliğiniz başarıyla aktifleştirildi. Tüm sınırsız özelliklerden hemen yararlanabilirsiniz.',
          'Your Pro subscription has been successfully activated. Enjoy full access to all premium features.',
          notifEventKey,
          nowIso
        ],
        () => {}
      );

      console.log(`[polar-webhook] User id=${targetUser.id} upgraded to PRO until ${expiresAt}`);
      logPolarEvent('activated', `sub=${polarSubId} expires=${expiresAt}`, targetUser.id);
    } else if (
      eventType.startsWith('order.refunded') ||   // legacy alias kept for older integrations
      eventType.startsWith('order.updated') ||
      eventType.startsWith('subscription.revoked') ||
      eventType.startsWith('subscription.past_due') ||
      eventType.startsWith('subscription.expired') // defensive: not in the current Polar event list
    ) {
      // Refunds are delivered today as order.updated with status
      // refunded / partially_refunded. Only a full refund revokes.
      if (eventType.startsWith('order.updated')) {
        const orderStatus = (data.status != null && data.status !== '' ? data.status : 'paid').toString().toLowerCase();
        if (orderStatus === 'partially_refunded') {
          logPolarEvent('ignored:partial_refund', '', targetUser.id);
          return res.status(200).json({ received: true, ignored: 'partial_refund' });
        }
        if (orderStatus !== 'refunded') {
          logPolarEvent('ignored:non_refund_update', `status=${orderStatus}`, targetUser.id);
          return res.status(200).json({ received: true, ignored: 'non_refund_update' });
        }
      }
      // A revoke/refund event that belongs to a historical subscription must
      // not revoke the currently active one.
      if (targetUser.polar_subscription_id && polarSubId && targetUser.polar_subscription_id !== polarSubId) {
        console.warn(`[polar-webhook] User ${targetUser.id} revoke event for sub ${polarSubId} ignored; active sub is ${targetUser.polar_subscription_id}`);
        logPolarEvent('ignored:mismatched_sub_id', `stored=${targetUser.polar_subscription_id} event=${polarSubId}`, targetUser.id);
        return res.status(200).json({ received: true, ignored: 'mismatched_sub_id' });
      }

      // Revoke Pro immediately on refund, revocation or payment failure
      await new Promise((resolve, reject) => {
        db.run(
          'UPDATE users SET plan_tier = ?, plan_status = ?, pro_expires_at = NULL, polar_subscription_id = NULL, pro_updated_at = ? WHERE id = ?',
          ['free', 'revoked', nowIso, targetUser.id],
          (err) => (err ? reject(err) : resolve())
        );
      });
      console.log(`[polar-webhook] User id=${targetUser.id} subscription completely revoked (event: ${eventType})`);
      logPolarEvent('revoked', eventType, targetUser.id);

      // Tell the user immediately and point them at the manage/repair flow.
      db.run(
        'INSERT OR IGNORE INTO notifications (user_id, type, title_az, title_tr, title_en, body_az, body_tr, body_en, link_short, event_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          targetUser.id,
          'system',
          'Pro abunəliyi dayandırıldı',
          'Pro aboneliği durduruldu',
          'Pro subscription stopped',
          'Ödəniş alınmadı və ya geri ödəniş edildi. Pro imkanları deaktivdir. Kartınızı yeniləyib yenidən başlaya bilərsiniz.',
          'Ödeme alınamadı veya geri ödeme yapıldı. Pro özellikleri devre dışı. Kartınızı güncelleyip yeniden başlayabilirsiniz.',
          'Payment failed or was refunded. Pro features are disabled. You can update your card and restart anytime.',
          '/pro',
          `polar_revoked_${msgId}`,
          nowIso
        ],
        () => {}
      );
    } else if (eventType.startsWith('subscription.canceled')) {
      // Prevent Downgrade Attack
      if (targetUser.polar_subscription_id && polarSubId && targetUser.polar_subscription_id !== polarSubId) {
        console.warn(`[polar-webhook] User ${targetUser.id} canceling sub ${polarSubId} ignored because active sub is ${targetUser.polar_subscription_id}`);
        return res.status(200).json({ received: true, ignored: 'mismatched_sub_id' });
      }

      await new Promise((resolve, reject) => {
        // Fix: clear polar_subscription_id to avoid stuck re-subscribe state
        db.run(
          'UPDATE users SET plan_status = ?, polar_subscription_id = NULL, pro_updated_at = ? WHERE id = ?',
          ['canceled', nowIso, targetUser.id],
          (err) => (err ? reject(err) : resolve())
        );
      });
      console.log(`[polar-webhook] User id=${targetUser.id} subscription marked as canceled`);
      logPolarEvent('canceled', `sub=${polarSubId}`, targetUser.id);

      db.run(
        'INSERT OR IGNORE INTO notifications (user_id, type, title_az, title_tr, title_en, body_az, body_tr, body_en, link_short, event_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          targetUser.id,
          'system',
          'Abunəlik ləğv edildi',
          'Abonelik iptal edildi',
          'Subscription canceled',
          `Abunəliyiniz ödənilmiş dövrün sonunadək aktiv qalacaq${targetUser.pro_expires_at ? ` (${targetUser.pro_expires_at.slice(0, 10)})` : ''}. Fikrinizi dəyişsəniz, /pro səhifəsindən yenidən aktivləşdirə bilərsiniz.`,
          `Aboneliğiniz ödenen dönemin sonuna kadar aktif kalacak${targetUser.pro_expires_at ? ` (${targetUser.pro_expires_at.slice(0, 10)})` : ''}. Fikrinizi değiştirirseniz /pro sayfasından yeniden etkinleştirebilirsiniz.`,
          `Your subscription stays active until the end of the paid period${targetUser.pro_expires_at ? ` (${targetUser.pro_expires_at.slice(0, 10)})` : ''}. If you change your mind, you can reactivate it from the /pro page.`,
          '/pro',
          `polar_canceled_${msgId}`,
          nowIso
        ],
        () => {}
      );
    } else {
      logPolarEvent('unhandled_type', '', targetUser.id);
    }

    return res.status(200).json({ received: true, success: true });
  } catch (handlerErr) {
    console.error('[polar-webhook] Processing error:', handlerErr);
    sendOpsAlert('polar_processing', 'Polar webhook processing error', (handlerErr && handlerErr.message) || String(handlerErr));
    return res.status(500).json({ error: 'internal error' });
  }
});


module.exports = router;