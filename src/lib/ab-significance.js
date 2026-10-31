'use strict';

/**
 * A/B significance (no external dependency).
 *
 * Two tests are supported:
 *   - conversion rate (preferred): two-proportion z-test over
 *     conversions/clicks per variant;
 *   - traffic split (fallback when no conversion has been attributed to a
 *     variant yet): one-sample test of the A/B click split against 50/50.
 *
 * The fallback is labelled (`metric: 'traffic_split'`) so the UI never claims
 * that one variant converts better when it only received more traffic.
 */

// Abramowitz & Stegun 7.1.26 approximation; |error| < 1.5e-7, which is far
// below what a dashboard can display.
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const poly = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - poly * Math.exp(-ax * ax));
}

function normalCdf(z) {
  const value = Number(z);
  if (!Number.isFinite(value)) return 0.5;
  return 0.5 * (1 + erf(value / Math.SQRT2));
}

function toCount(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function round(value, decimals = 3) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  const factor = 10 ** decimals;
  return Math.round(num * factor) / factor;
}

/** Two-sided p-value for a z statistic. */
function pValueFromZ(z) {
  const value = Number(z);
  if (!Number.isFinite(value)) return 1;
  const p = 2 * (1 - normalCdf(Math.abs(value)));
  if (!Number.isFinite(p)) return 1;
  return Math.min(1, Math.max(0, p));
}

function leaderFor(aValue, bValue) {
  if (aValue > bValue) return 'a';
  if (bValue > aValue) return 'b';
  return 'tie';
}

/**
 * Two-proportion z-test. `z` is positive when B beats A.
 */
function twoProportionZTest({ aConverted, aTotal, bConverted, bTotal, minArmSample = 100 } = {}) {
  const aConv = toCount(aConverted);
  const aTot = toCount(aTotal);
  const bConv = toCount(bConverted);
  const bTot = toCount(bTotal);

  if (aTot <= 0 || bTot <= 0) {
    return {
      z: 0,
      p_value: 1,
      confidence: 0,
      leader: leaderFor(aConv, bConv),
      significant: false,
      lift_percent: null,
      insufficient_data: true,
    };
  }

  const aConvSafe = Math.min(aConv, aTot);
  const bConvSafe = Math.min(bConv, bTot);
  const rateA = aConvSafe / aTot;
  const rateB = bConvSafe / bTot;
  const pooled = (aConvSafe + bConvSafe) / (aTot + bTot);
  const standardError = Math.sqrt(pooled * (1 - pooled) * ((1 / aTot) + (1 / bTot)));

  const lift = rateA > 0 ? round(((rateB - rateA) / rateA) * 100, 1) : null;

  if (!(standardError > 0)) {
    return {
      z: 0,
      p_value: 1,
      confidence: 0,
      leader: leaderFor(rateA, rateB),
      significant: false,
      lift_percent: lift,
      insufficient_data: aTot < minArmSample || bTot < minArmSample,
    };
  }

  const z = (rateB - rateA) / standardError;
  const p = pValueFromZ(z);
  const insufficient = aTot < minArmSample || bTot < minArmSample;

  return {
    z: round(z, 3),
    p_value: round(p, 4),
    confidence: round((1 - p) * 100, 1),
    leader: leaderFor(rateA, rateB),
    significant: !insufficient && p < 0.05,
    lift_percent: lift,
    insufficient_data: insufficient,
  };
}

/**
 * One-sample test of the A/B click split against 50/50. Only answers "did one
 * variant receive significantly more traffic", never "which one converts".
 */
function trafficSplitTest({ aClicks, bClicks, minSample = 200 } = {}) {
  const a = toCount(aClicks);
  const b = toCount(bClicks);
  const total = a + b;
  if (total <= 0) {
    return {
      z: 0,
      p_value: 1,
      confidence: 0,
      leader: 'tie',
      significant: false,
      lift_percent: null,
      insufficient_data: true,
    };
  }

  const standardError = Math.sqrt(total * 0.25);
  const z = (a - total / 2) / standardError;
  const p = pValueFromZ(z);
  const lift = b > 0 ? round(((a - b) / b) * 100, 1) : null;

  return {
    z: round(z, 3),
    p_value: round(p, 4),
    confidence: round((1 - p) * 100, 1),
    leader: leaderFor(a, b),
    significant: total >= minSample && p < 0.05,
    lift_percent: lift,
    insufficient_data: total < minSample,
  };
}

/**
 * Builds the payload served by GET /api/stats/:short/ab-significance and shown
 * in the A/B panel.
 */
function summarizeAbTest({ aClicks, aConversions, bClicks, bConversions, minArmSample = 100 } = {}) {
  const aC = toCount(aClicks);
  const bC = toCount(bClicks);
  const aConv = toCount(aConversions);
  const bConv = toCount(bConversions);
  const hasConversions = (aConv + bConv) > 0;

  const rateA = aC > 0 ? round((aConv / aC) * 100, 1) : 0;
  const rateB = bC > 0 ? round((bConv / bC) * 100, 1) : 0;

  const result = hasConversions
    ? twoProportionZTest({ aConverted: aConv, aTotal: aC, bConverted: bConv, bTotal: bC, minArmSample })
    : trafficSplitTest({ aClicks: aC, bClicks: bC });

  return {
    available: (aC + bC) > 0,
    basis: hasConversions ? 'clicks_and_conversions' : 'clicks',
    metric: hasConversions ? 'conversion_rate' : 'traffic_split',
    a: { clicks: aC, conversions: aConv, rate: rateA },
    b: { clicks: bC, conversions: bConv, rate: rateB },
    z: result.z,
    p_value: result.p_value,
    confidence: result.confidence,
    leader: result.leader,
    significant: result.significant,
    lift_percent: result.lift_percent,
    insufficient_data: result.insufficient_data,
  };
}

module.exports = {
  erf,
  normalCdf,
  pValueFromZ,
  twoProportionZTest,
  trafficSplitTest,
  summarizeAbTest,
};
