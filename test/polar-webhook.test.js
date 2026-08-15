const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

// Set env vars BEFORE requiring server so that dotenv doesn't override them,
// but actually the handler reads live from process.env anyway.
process.env.POLAR_WEBHOOK_SECRET = 'whsec_test_secret_for_regression';
process.env.POLAR_PRODUCT_ID = 'test_pro_product_id';
process.env.SESSION_SECRET = 'test_session_secret_for_tests_only_very_long_string_must_be_64_bytes_12345678901234567890123456789012';
process.env.NODE_ENV = 'test';
process.env.PORT = '0'; // random port

const { app, helpers } = require('../server');
const { blindIndex } = require('../utils/crypto');

const createdTestUserIds = [];

test.before(async () => {
  const migrationDrainDeadline = Date.now() + 5000;
  while (!helpers.isDbMigrationQueueDrained() && Date.now() < migrationDrainDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

test.after(async () => {
  for (const userId of createdTestUserIds) {
    try {
      await helpers.dbRunAsync('DELETE FROM polar_events WHERE user_id = ?', [userId]);
      await helpers.dbRunAsync('DELETE FROM notifications WHERE user_id = ?', [userId]);
      await helpers.dbRunAsync('DELETE FROM users WHERE id = ?', [userId]);
    } catch {}
  }
  const migrationDrainDeadline = Date.now() + 5000;
  while (!helpers.isDbMigrationQueueDrained() && Date.now() < migrationDrainDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    await helpers.closeDbPool();
  } catch {}
});

function signPayload(payloadObj, secret) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const msgId = `evt_${Date.now()}`;
  const rawBody = JSON.stringify(payloadObj);
  const keyBuffer = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const toSign = `${msgId}.${timestamp}.${rawBody}`;
  const computedSignature = crypto.createHmac('sha256', keyBuffer).update(toSign).digest('base64');
  return {
    rawBody,
    headers: {
      'content-type': 'application/json',
      'webhook-id': msgId,
      'webhook-timestamp': timestamp,
      'webhook-signature': `v1,${computedSignature}`
    }
  };
}

test('Polar webhook regression tests', async (t) => {
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const sendWebhook = async (payloadObj, secret = process.env.POLAR_WEBHOOK_SECRET) => {
    const { rawBody, headers } = signPayload(payloadObj, secret);
    const res = await fetch(`${baseUrl}/api/polar/webhook`, {
      method: 'POST',
      headers,
      body: rawBody
    });
    return { status: res.status, body: await res.json() };
  };

  await t.test('1. Product ID Validation Blocks Other Products', async () => {
    const res = await sendWebhook({
      type: 'subscription.created',
      data: {
        product_id: 'wrong_product_id',
        status: 'active',
        customer: { email: 'nonexistent@example.com' }
      }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ignored, 'wrong_product');
  });

  await t.test('2. Refunds and Payment Failures Downgrade Pro', async () => {
    const email = `refund-test-${Date.now()}@example.com`;
    const eHash = blindIndex(email);
    await helpers.dbRunAsync(
      "INSERT INTO users (email, email_hash, password, plan_tier, plan_status, pro_expires_at, polar_subscription_id) VALUES (?, ?, ?, 'pro', 'active', ?, 'sub_123')",
      [email, eHash, 'x', new Date(Date.now() + 86400000).toISOString()]
    );
    const user = await helpers.dbGetAsync('SELECT id FROM users WHERE email = ?', [email]);
    createdTestUserIds.push(user.id);

    const res = await sendWebhook({
      type: 'order.refunded',
      data: {
        product_id: process.env.POLAR_PRODUCT_ID,
        customer: { email },
        subscription: { id: 'sub_123' }
      }
    });
    
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    const updated = await helpers.dbGetAsync('SELECT plan_tier, plan_status, pro_expires_at, polar_subscription_id FROM users WHERE id = ?', [user.id]);
    assert.equal(updated.plan_tier, 'free');
    assert.equal(updated.plan_status, 'revoked');
    assert.equal(updated.pro_expires_at, null);
    assert.equal(updated.polar_subscription_id, null);

    // Billing history: the event must be durably logged with its outcome.
    const ev = await helpers.dbGetAsync('SELECT outcome, user_id FROM polar_events WHERE user_id = ? ORDER BY id DESC LIMIT 1', [user.id]);
    assert.ok(ev, 'polar_events row must exist');
    assert.equal(ev.outcome, 'revoked');
  });

  await t.test('3. Cancellation Clears Subscription ID (No stuck state)', async () => {
    const email = `cancel-test-${Date.now()}@example.com`;
    const eHash = blindIndex(email);
    await helpers.dbRunAsync(
      "INSERT INTO users (email, email_hash, password, plan_tier, plan_status, pro_expires_at, polar_subscription_id) VALUES (?, ?, ?, 'pro', 'active', ?, 'sub_cancel')",
      [email, eHash, 'x', new Date(Date.now() + 86400000).toISOString()]
    );
    const user = await helpers.dbGetAsync('SELECT id FROM users WHERE email = ?', [email]);
    createdTestUserIds.push(user.id);

    const res = await sendWebhook({
      type: 'subscription.canceled',
      data: {
        id: 'sub_cancel',
        product_id: process.env.POLAR_PRODUCT_ID,
        customer: { email }
      }
    });
    
    assert.equal(res.status, 200);

    const updated = await helpers.dbGetAsync('SELECT plan_status, polar_subscription_id, pro_expires_at FROM users WHERE id = ?', [user.id]);
    assert.equal(updated.plan_status, 'canceled');
    assert.equal(updated.polar_subscription_id, null);
    assert.notEqual(updated.pro_expires_at, null); // retains time remaining
  });

  await t.test('4. Empty Secret Blocks Webhook', async () => {
    // Send a webhook with empty secret
    const oldSecret = process.env.POLAR_WEBHOOK_SECRET;
    process.env.POLAR_WEBHOOK_SECRET = '';

    const res = await sendWebhook({ type: 'test' }, ''); // Can't even sign properly but we just care about 403

    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'invalid signature');

    process.env.POLAR_WEBHOOK_SECRET = oldSecret;
  });

  // --- C4: order events must map subscription_id, never store the order id ---

  await t.test('5. order.paid activates and stores the SUBSCRIPTION id, not the order id (C4)', async () => {
    const email = `orderpaid-c4-${Date.now()}@example.com`;
    await helpers.dbRunAsync(
      "INSERT INTO users (email, email_hash, password, plan_tier, plan_status) VALUES (?, ?, ?, 'free', 'none')",
      [email, blindIndex(email), 'x']
    );
    const user = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [blindIndex(email)]);
    createdTestUserIds.push(user.id);

    const res = await sendWebhook({
      type: 'order.paid',
      data: {
        id: 'ord_777',
        subscription_id: 'sub_paid_1',
        status: 'paid',
        billing_reason: 'subscription_create',
        product_id: process.env.POLAR_PRODUCT_ID,
        customer: { email }
      }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    const updated = await helpers.dbGetAsync('SELECT plan_tier, plan_status, polar_subscription_id FROM users WHERE id = ?', [user.id]);
    assert.equal(updated.plan_tier, 'pro');
    assert.equal(updated.plan_status, 'active');
    assert.equal(updated.polar_subscription_id, 'sub_paid_1', 'order id must never be stored as the subscription id');
  });

  await t.test('6. order.created (possibly pending/unpaid) does not grant entitlement', async () => {
    const email = `ordercreated-${Date.now()}@example.com`;
    await helpers.dbRunAsync(
      "INSERT INTO users (email, email_hash, password, plan_tier, plan_status) VALUES (?, ?, ?, 'free', 'none')",
      [email, blindIndex(email), 'x']
    );
    const user = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [blindIndex(email)]);
    createdTestUserIds.push(user.id);

    const res = await sendWebhook({
      type: 'order.created',
      data: {
        id: 'ord_778',
        subscription_id: 'sub_maybe_unpaid',
        status: 'pending',
        product_id: process.env.POLAR_PRODUCT_ID,
        customer: { email }
      }
    });
    assert.equal(res.status, 200);

    const updated = await helpers.dbGetAsync('SELECT plan_tier, polar_subscription_id FROM users WHERE id = ?', [user.id]);
    assert.equal(updated.plan_tier, 'free', 'unpaid orders must not activate Pro');
  });

  await t.test('7. subscription.updated with past_due status does not activate (L2)', async () => {
    const email = `pastdue-upd-${Date.now()}@example.com`;
    await helpers.dbRunAsync(
      "INSERT INTO users (email, email_hash, password, plan_tier, plan_status) VALUES (?, ?, ?, 'free', 'none')",
      [email, blindIndex(email), 'x']
    );
    const user = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [blindIndex(email)]);
    createdTestUserIds.push(user.id);

    const res = await sendWebhook({
      type: 'subscription.updated',
      data: {
        id: 'sub_pd',
        status: 'past_due',
        current_period_end: new Date(Date.now() + 30 * 86400000).toISOString(),
        product_id: process.env.POLAR_PRODUCT_ID,
        customer: { email }
      }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ignored, 'inactive_status');

    const updated = await helpers.dbGetAsync('SELECT plan_tier FROM users WHERE id = ?', [user.id]);
    assert.equal(updated.plan_tier, 'free');
  });

  await t.test('8. refund of an OLD subscription does not revoke the current one (L1)', async () => {
    const email = `refund-old-${Date.now()}@example.com`;
    const futureExpiry = new Date(Date.now() + 20 * 86400000).toISOString();
    await helpers.dbRunAsync(
      "INSERT INTO users (email, email_hash, password, plan_tier, plan_status, pro_expires_at, polar_subscription_id) VALUES (?, ?, ?, 'pro', 'active', ?, 'sub_current')",
      [email, blindIndex(email), 'x', futureExpiry]
    );
    const user = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [blindIndex(email)]);
    createdTestUserIds.push(user.id);

    const res = await sendWebhook({
      type: 'order.updated',
      data: {
        id: 'ord_old',
        subscription_id: 'sub_old',
        status: 'refunded',
        product_id: process.env.POLAR_PRODUCT_ID,
        customer: { email }
      }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ignored, 'mismatched_sub_id');

    const updated = await helpers.dbGetAsync('SELECT plan_tier, plan_status, pro_expires_at, polar_subscription_id FROM users WHERE id = ?', [user.id]);
    assert.equal(updated.plan_tier, 'pro');
    assert.equal(updated.plan_status, 'active');
    assert.equal(updated.polar_subscription_id, 'sub_current');
  });

  await t.test('9. refund of the CURRENT subscription revokes it', async () => {
    const email = `refund-cur-${Date.now()}@example.com`;
    await helpers.dbRunAsync(
      "INSERT INTO users (email, email_hash, password, plan_tier, plan_status, pro_expires_at, polar_subscription_id) VALUES (?, ?, ?, 'pro', 'active', ?, 'sub_cur_r')",
      [email, blindIndex(email), 'x', new Date(Date.now() + 86400000).toISOString()]
    );
    const user = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [blindIndex(email)]);
    createdTestUserIds.push(user.id);

    const res = await sendWebhook({
      type: 'order.updated',
      data: {
        id: 'ord_cur',
        subscription_id: 'sub_cur_r',
        status: 'refunded',
        product_id: process.env.POLAR_PRODUCT_ID,
        customer: { email }
      }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    const updated = await helpers.dbGetAsync('SELECT plan_tier, plan_status, polar_subscription_id FROM users WHERE id = ?', [user.id]);
    assert.equal(updated.plan_tier, 'free');
    assert.equal(updated.plan_status, 'revoked');
    assert.equal(updated.polar_subscription_id, null);
  });

  // --- L3: one trial per account ---

  await t.test('10. first trial activates and records trial_used_at', async () => {
    const email = `trial-first-${Date.now()}@example.com`;
    await helpers.dbRunAsync(
      "INSERT INTO users (email, email_hash, password, plan_tier, plan_status) VALUES (?, ?, ?, 'free', 'none')",
      [email, blindIndex(email), 'x']
    );
    const user = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [blindIndex(email)]);
    createdTestUserIds.push(user.id);

    const trialEnd = new Date(Date.now() + 3 * 86400000).toISOString();
    const res = await sendWebhook({
      type: 'subscription.created',
      data: {
        id: 'sub_trial_1',
        status: 'trialing',
        trial_end: trialEnd,
        current_period_end: trialEnd,
        product_id: process.env.POLAR_PRODUCT_ID,
        customer: { email }
      }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);

    const updated = await helpers.dbGetAsync('SELECT plan_tier, plan_status, polar_subscription_id, trial_used_at FROM users WHERE id = ?', [user.id]);
    assert.equal(updated.plan_tier, 'pro');
    assert.equal(updated.plan_status, 'active');
    assert.equal(updated.polar_subscription_id, 'sub_trial_1');
    assert.ok(updated.trial_used_at, 'trial must be recorded');
  });

  await t.test('11. a repeat trial on a different subscription is ignored', async () => {
    const email = `trial-repeat-${Date.now()}@example.com`;
    await helpers.dbRunAsync(
      "INSERT INTO users (email, email_hash, password, plan_tier, plan_status, trial_used_at) VALUES (?, ?, ?, 'free', 'none', ?)",
      [email, blindIndex(email), 'x', new Date('2025-06-01T00:00:00Z').toISOString()]
    );
    const user = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [blindIndex(email)]);
    createdTestUserIds.push(user.id);

    const trialEnd = new Date(Date.now() + 3 * 86400000).toISOString();
    const res = await sendWebhook({
      type: 'subscription.created',
      data: {
        id: 'sub_trial_2',
        status: 'trialing',
        trial_end: trialEnd,
        current_period_end: trialEnd,
        product_id: process.env.POLAR_PRODUCT_ID,
        customer: { email }
      }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ignored, 'trial_already_used');

    const updated = await helpers.dbGetAsync('SELECT plan_tier, polar_subscription_id FROM users WHERE id = ?', [user.id]);
    assert.equal(updated.plan_tier, 'free', 'repeat trials must not grant entitlement');
    assert.equal(updated.polar_subscription_id, null);
  });

  await t.test('12. order.paid after subscription.created keeps the subscription id and never shrinks expiry (C4 event ordering)', async () => {
    const email = `ordering-c4-${Date.now()}@example.com`;
    await helpers.dbRunAsync(
      "INSERT INTO users (email, email_hash, password, plan_tier, plan_status) VALUES (?, ?, ?, 'free', 'none')",
      [email, blindIndex(email), 'x']
    );
    const user = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [blindIndex(email)]);
    createdTestUserIds.push(user.id);

    const longExpiry = new Date(Date.now() + 40 * 86400000).toISOString();
    const first = await sendWebhook({
      type: 'subscription.created',
      data: {
        id: 'sub_5',
        status: 'active',
        current_period_end: longExpiry,
        product_id: process.env.POLAR_PRODUCT_ID,
        customer: { email }
      }
    });
    assert.equal(first.body.success, true);

    // A later order.paid (renewal) must not be treated as a foreign subscription.
    const second = await sendWebhook({
      type: 'order.paid',
      data: {
        id: 'ord_after_sub5',
        subscription_id: 'sub_5',
        status: 'paid',
        billing_reason: 'subscription_cycle',
        product_id: process.env.POLAR_PRODUCT_ID,
        customer: { email }
      }
    });
    assert.equal(second.body.success, true);

    const updated = await helpers.dbGetAsync('SELECT plan_tier, plan_status, polar_subscription_id, pro_expires_at FROM users WHERE id = ?', [user.id]);
    assert.equal(updated.plan_tier, 'pro');
    assert.equal(updated.polar_subscription_id, 'sub_5', 'subscription id must survive order events');
    assert.equal(Date.parse(updated.pro_expires_at), Date.parse(longExpiry), 'a later order event must not shrink the paid period');
  });

  await new Promise((resolve) => server.close(resolve));
});
