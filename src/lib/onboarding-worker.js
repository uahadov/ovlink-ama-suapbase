'use strict';

/**
 * Onboarding activation worker (A13).
 *
 * A user who registered three days ago, is still on the free plan and has not
 * dismissed the first-steps checklist gets exactly one "here is what Pro adds"
 * e-mail. `users.onboarding_nudged_at` is the once-only guard: it is stamped
 * before the send is awaited, so a failing SMTP call cannot re-queue the same
 * user on the next tick.
 *
 * Disabled by default. Set ENABLE_ONBOARDING_NUDGE=1 to opt in.
 */

const { beat } = require('./worker-heartbeat');
const { dbAllAsync, dbRunAsync } = require('../db/helpers');
// Required as a namespace so tests can substitute the sender without touching SMTP.
const emailLib = require('./email');
const { safeDecrypt } = require('../../utils/crypto');
const { normalizeLang } = require('./i18n');

const NUDGE_AFTER_DAYS = 3;
const NUDGE_BATCH_LIMIT = 200;
const NUDGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const NUDGE_START_DELAY_MS = 12 * 60 * 1000;

function isEnabled() {
  return process.env.ENABLE_ONBOARDING_NUDGE === '1'
    || String(process.env.ENABLE_ONBOARDING_NUDGE || '').toLowerCase() === 'true';
}

function daysAgoIso(now, days) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * One pass over the due cohort. Returns counters so tests and ops can inspect
 * the run without reading logs.
 */
async function runOnboardingNudges({ now = new Date(), limit = NUDGE_BATCH_LIMIT } = {}) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : NUDGE_BATCH_LIMIT;
  const cutoff = daysAgoIso(now, NUDGE_AFTER_DAYS);

  const candidates = await dbAllAsync(
    'SELECT id, email, ui_lang FROM users ' +
      "WHERE plan_tier = 'free' AND COALESCE(banned, 0) = 0 " +
      'AND COALESCE(email_verified, 0) = 1 ' +
      'AND onboarding_dismissed_at IS NULL AND onboarding_nudged_at IS NULL ' +
      'AND created_at IS NOT NULL AND created_at < ? ' +
      'ORDER BY id ASC LIMIT ?',
    [cutoff, safeLimit]
  ).catch(() => []);

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const user of candidates || []) {
    const address = safeDecrypt(user.email, '');
    if (!address || !address.includes('@')) {
      skipped += 1;
      continue;
    }

    // Claim the row first: a concurrent tick (or a retried send) must never
    // produce a second nudge for the same account.
    let claimed;
    try {
      claimed = await dbRunAsync(
        'UPDATE users SET onboarding_nudged_at = ? ' +
          'WHERE id = ? AND onboarding_nudged_at IS NULL',
        [now.toISOString(), user.id]
      );
    } catch (claimErr) {
      failed += 1;
      continue;
    }

    if (claimed && Number.isInteger(claimed.changes) && claimed.changes === 0) {
      skipped += 1;
      continue;
    }

    try {
      await emailLib.sendOnboardingNudgeEmail(address, normalizeLang(user.ui_lang, 'az'));
      sent += 1;
    } catch (sendErr) {
      failed += 1;
      console.warn('[onboarding] nudge failed', user.id, sendErr && (sendErr.message || sendErr));
    }
  }

  if (sent || failed) {
    console.log(`[onboarding] nudged=${sent} skipped=${skipped} failed=${failed} candidates=${(candidates || []).length}`);
  }
  return { sent, skipped, failed, candidates: (candidates || []).length };
}

function scheduleOnboardingNudge() {
  if (!isEnabled()) {
    console.log('[startup] Onboarding nudge disabled (ENABLE_ONBOARDING_NUDGE not set).');
    return null;
  }

  const run = () => {
    beat('onboarding-nudge');
    void runOnboardingNudges().catch((err) => {
      console.warn('[onboarding] run failed:', err && (err.message || err));
    });
  };

  const startTimer = setTimeout(run, NUDGE_START_DELAY_MS);
  if (typeof startTimer.unref === 'function') startTimer.unref();

  const interval = setInterval(run, NUDGE_INTERVAL_MS);
  if (typeof interval.unref === 'function') interval.unref();
  return interval;
}

module.exports = {
  NUDGE_AFTER_DAYS,
  NUDGE_BATCH_LIMIT,
  NUDGE_INTERVAL_MS,
  NUDGE_START_DELAY_MS,
  isEnabled,
  runOnboardingNudges,
  scheduleOnboardingNudge,
};
