'use strict';

/**
 * Onboarding checklist state (A13).
 *
 * Pure function: it turns the bounded probes the dashboard already runs into
 * the three-step model the view renders. Keeping it here means the state can be
 * unit tested without a database, and the same rule decides both "show the
 * panel" and "hide the panel when everything is done".
 */

const STEPS = Object.freeze([
  { key: 'link', field: 'hasLink', cta: 'onboard_cta_link', href: '#dashboardQuickCreateForm' },
  { key: 'qr', field: 'hasQr', cta: 'onboard_cta_qr', href: '#qrCodesSection' },
  { key: 'click', field: 'hasFirstClick', cta: 'onboard_cta_stats', href: '/dashboard' },
]);

function buildOnboardingState({ userRow, totalLinks = 0, qrCount = 0, hasFirstClick = false, onFreePlan = true } = {}) {
  const linkCount = Number.parseInt(totalLinks, 10) || 0;
  const qrTotal = Number.parseInt(qrCount, 10) || 0;

  const state = {
    dismissed: !!(userRow && userRow.onboarding_dismissed_at),
    hasLink: linkCount > 0,
    hasQr: qrTotal > 0,
    hasFirstClick: !!hasFirstClick,
  };

  state.completed = state.hasLink && state.hasQr && state.hasFirstClick;
  state.visible = !state.dismissed && !state.completed;
  state.steps = STEPS.map((step) => ({
    key: step.key,
    i18nKey: `onboard_step_${step.key}`,
    ctaKey: step.cta,
    href: step.href,
    done: state[step.field] === true,
  }));

  // Day-3 activation mail targets accounts that have not done the first step:
  // an empty free account is the cohort that needs the nudge.
  state.nudgeEligible = onFreePlan && !state.dismissed && !state.hasLink;
  return state;
}

module.exports = { buildOnboardingState, ONBOARDING_STEPS: STEPS };
