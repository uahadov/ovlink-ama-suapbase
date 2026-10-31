const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const utm = require('../src/lib/utm');
const ab = require('../src/lib/ab-significance');
const funnel = require('../src/lib/funnel');
const thresholds = require('../src/lib/alert-thresholds');
const segments = require('../src/lib/segments');
const visitorSplit = require('../src/lib/visitor-split');
const audit = require('../src/lib/analytics-audit');

// ---------------------------------------------------------------------------
// UTM builder (F5)
// ---------------------------------------------------------------------------

test('UX-01: UTM values are normalised and bounded', () => {
  assert.equal(utm.normalizeUtmValue('  Summer Sale  '), 'summer-sale');
  assert.equal(utm.normalizeUtmValue('LinkedIn'), 'linkedin');
  assert.equal(utm.normalizeUtmValue(''), '');
  assert.equal(utm.normalizeUtmValue(null), '');
  assert.equal(utm.normalizeUtmValue('x'.repeat(200)).length, utm.UTM_VALUE_MAX);
});

test('UX-02: appendUtmParams merges, replaces and is idempotent', () => {
  const url = 'https://example.com/landing?ref=newsletter#top';
  const first = utm.appendUtmParams(url, { source: 'LinkedIn', medium: 'Social', campaign: 'Spring Sale' });

  assert.ok(first.startsWith('https://example.com/landing?'));
  assert.ok(first.includes('ref=newsletter'), 'existing query parameters must survive');
  assert.ok(first.includes('utm_source=linkedin'));
  assert.ok(first.includes('utm_medium=social'));
  assert.ok(first.includes('utm_campaign=spring-sale'));
  assert.ok(first.endsWith('#top'), 'the fragment must survive');

  const twice = utm.appendUtmParams(first, { source: 'linkedin', medium: 'social', campaign: 'spring-sale' });
  assert.equal(twice, first, 'applying the same UTM twice must not duplicate parameters');

  const replaced = utm.appendUtmParams(first, { source: 'twitter' });
  assert.ok(replaced.includes('utm_source=twitter'));
  assert.equal((replaced.match(/utm_source=/g) || []).length, 1, 'utm_source must be replaced, not appended');
});

test('UX-03: appendUtmParams is a safe no-op for bad input', () => {
  assert.equal(utm.appendUtmParams('', { source: 'a' }), '');
  assert.equal(utm.appendUtmParams('not a url', { source: 'a' }), 'not a url');
  assert.equal(utm.appendUtmParams('mailto:someone@example.com', { source: 'a' }), 'mailto:someone@example.com');
  assert.equal(utm.appendUtmParams('https://example.com/x', {}), 'https://example.com/x');
  assert.equal(utm.appendUtmParams('https://example.com/x', { source: '   ' }), 'https://example.com/x');

  const longBase = `https://example.com/${'a'.repeat(2030)}`;
  assert.equal(utm.appendUtmParams(longBase, { source: 'x' }), longBase, 'over-long URLs stay untouched');
});

test('UX-04: readUtmFields accepts flat and nested bodies', () => {
  const flat = utm.readUtmFields({ utm_source: 'News', utm_campaign: 'Q4 Launch' });
  assert.equal(flat.source, 'news');
  assert.equal(flat.campaign, 'q4-launch');

  const nested = utm.readUtmFields({ utm: { source: 'Mail', term: 'promo', content: 'hero' } });
  assert.equal(nested.source, 'mail');
  assert.equal(nested.term, 'promo');
  assert.equal(nested.content, 'hero');

  assert.equal(utm.readUtmFields(null).source, '');
});

// ---------------------------------------------------------------------------
// A/B significance (F7)
// ---------------------------------------------------------------------------

test('AB-01: two-proportion z-test matches a textbook case', () => {
  const result = ab.twoProportionZTest({ aConverted: 100, aTotal: 1000, bConverted: 130, bTotal: 1000 });

  assert.ok(result.z > 2.05 && result.z < 2.15, `z was ${result.z}`);
  assert.ok(result.p_value > 0.03 && result.p_value < 0.04, `p was ${result.p_value}`);
  assert.ok(result.confidence > 96 && result.confidence < 97, `confidence was ${result.confidence}`);
  assert.equal(result.leader, 'b');
  assert.equal(result.significant, true);
  assert.equal(result.lift_percent, 30);
  assert.equal(result.insufficient_data, false);
});

test('AB-02: equal arms and empty arms are not "significant"', () => {
  const equal = ab.twoProportionZTest({ aConverted: 100, aTotal: 1000, bConverted: 100, bTotal: 1000 });
  assert.equal(equal.leader, 'tie');
  assert.equal(equal.significant, false);
  assert.equal(equal.z, 0);

  const empty = ab.twoProportionZTest({ aConverted: 0, aTotal: 0, bConverted: 0, bTotal: 0 });
  assert.equal(empty.significant, false);
  assert.equal(empty.insufficient_data, true);
  assert.equal(empty.p_value, 1);
});

test('AB-03: small samples are reported as insufficient', () => {
  const result = ab.twoProportionZTest({ aConverted: 10, aTotal: 50, bConverted: 20, bTotal: 50 });
  assert.equal(result.insufficient_data, true);
  assert.equal(result.significant, false);
});

test('AB-04: summarizeAbTest prefers conversions and labels the fallback', () => {
  const withConversions = ab.summarizeAbTest({ aClicks: 1000, aConversions: 50, bClicks: 1000, bConversions: 90 });
  assert.equal(withConversions.basis, 'clicks_and_conversions');
  assert.equal(withConversions.metric, 'conversion_rate');
  assert.equal(withConversions.a.rate, 5);
  assert.equal(withConversions.b.rate, 9);
  assert.equal(withConversions.leader, 'b');

  const clicksOnly = ab.summarizeAbTest({ aClicks: 600, aConversions: 0, bClicks: 400, bConversions: 0 });
  assert.equal(clicksOnly.basis, 'clicks');
  assert.equal(clicksOnly.metric, 'traffic_split');
  assert.equal(clicksOnly.leader, 'a');
  assert.equal(clicksOnly.significant, true);

  const empty = ab.summarizeAbTest({});
  assert.equal(empty.available, false);
});

// ---------------------------------------------------------------------------
// Funnel (F2)
// ---------------------------------------------------------------------------

test('FN-01: step numbers are bounded', () => {
  assert.equal(funnel.normalizeStep(1), 1);
  assert.equal(funnel.normalizeStep('5'), 5);
  assert.equal(funnel.normalizeStep(20), 20);
  assert.equal(funnel.normalizeStep(0), null);
  assert.equal(funnel.normalizeStep(21), null);
  assert.equal(funnel.normalizeStep('abc'), null);
  assert.equal(funnel.normalizeStep(null), null);
});

test('FN-02: funnel series computes percentages and drop-off', () => {
  const series = funnel.buildFunnelSeries({ baseVisitors: 100, counts: { 1: 100, 2: 40, 3: 10 } });

  assert.equal(series.length, 3);
  assert.deepEqual(series[0], { step: 1, visitors: 100, percent_of_base: 100, drop_from_previous: null });
  assert.deepEqual(series[1], { step: 2, visitors: 40, percent_of_base: 40, drop_from_previous: 60 });
  assert.deepEqual(series[2], { step: 3, visitors: 10, percent_of_base: 10, drop_from_previous: 30 });

  const empty = funnel.buildFunnelSeries({ baseVisitors: 0, counts: {} });
  assert.deepEqual(empty, []);
});

// ---------------------------------------------------------------------------
// Alert thresholds (F3)
// ---------------------------------------------------------------------------

test('TH-01: thresholds are validated and clamped', () => {
  const result = thresholds.sanitizeThresholds({
    spike_multiplier: 10,
    spike_min_clicks: 0,
    health_enabled: 'true',
    unknown_field: 5,
  });

  assert.equal(result.values.spikeMultiplier, 10);
  assert.equal(result.values.spikeMinClicks, 1, 'below-minimum values are clamped');
  assert.equal(result.values.healthEnabled, true);
  assert.equal(result.provided.unknown_field, undefined);
  assert.equal(result.provided.spikeMultiplier, true);
  assert.ok(Array.isArray(result.errors));

  const invalid = thresholds.sanitizeThresholds({ drop_multiplier: 'abc' });
  assert.equal(invalid.values.dropMultiplier, undefined);
  assert.ok(invalid.errors.length > 0);
});

test('TH-02: precedence is env < user < link', () => {
  const env = { spikeMultiplier: 3, spikeMinClicks: 25, dropMultiplier: 0.3, dropMinBaselineAvg: 10, healthEnabled: true };
  const userRow = { alert_spike_multiplier: 5, alert_spike_min_clicks: null, alert_health_enabled: 0 };
  const linkRow = { alert_spike_multiplier: 8, alert_spike_min_clicks: 50 };

  const merged = thresholds.mergeAlertSettings(env, userRow, linkRow);
  assert.equal(merged.spikeMultiplier, 8, 'link wins over user');
  assert.equal(merged.spikeMinClicks, 50, 'link wins when both exist');
  assert.equal(merged.healthEnabled, false, 'user row wins over env');
  assert.equal(merged.dropMultiplier, 0.3, 'untouched values fall back to env');

  const described = thresholds.describeThresholds(env, userRow, linkRow);
  assert.equal(described.spikeMultiplier.source, 'link');
  assert.equal(described.dropMultiplier.source, 'default');
});

// ---------------------------------------------------------------------------
// Saved segments (F10)
// ---------------------------------------------------------------------------

test('SG-01: segment filters are whitelisted and clamped', () => {
  const filters = segments.normalizeFilters({
    days: '7',
    bots: 'exclude',
    country: 'az',
    device: 'Mobile',
    junk: 'drop-me',
  });

  assert.equal(filters.days, 7);
  assert.equal(filters.bots, 'exclude');
  assert.equal(filters.country, 'AZ');
  assert.equal(filters.device, 'Mobile');
  assert.equal(filters.junk, undefined);

  assert.equal(segments.normalizeFilters({ days: 'all' }).days, 'all');
  assert.equal(segments.normalizeFilters({ days: '9999' }).days, 365);
  assert.equal(segments.normalizeFilters({}).days, 30);
  assert.equal(segments.normalizeFilters({ bots: 'nonsense' }).bots, 'include');
});

test('SG-02: segment names are validated', () => {
  assert.equal(segments.normalizeSegmentName('  Mobile AZ  '), 'Mobile AZ');
  assert.equal(segments.normalizeSegmentName('a'), '');
  assert.equal(segments.normalizeSegmentName('x'.repeat(200)).length, segments.SEGMENT_NAME_MAX);
});

// ---------------------------------------------------------------------------
// Visitor split helper (F6)
// ---------------------------------------------------------------------------

test('VS-01: the visitor window is inclusive and clamped', () => {
  const now = new Date('2026-10-31T12:00:00.000Z');
  const seven = visitorSplit.resolveStartDay({ days: 7, now });
  assert.equal(seven.days, 7);
  assert.equal(seven.startDay, '2026-10-25');

  const clamped = visitorSplit.resolveStartDay({ days: 9999, now });
  assert.equal(clamped.days, 365);

  const fallback = visitorSplit.resolveStartDay({ days: 'nope', now });
  assert.equal(fallback.days, 30);
});

// ---------------------------------------------------------------------------
// Audit log (F12) - in-memory behaviour only
// ---------------------------------------------------------------------------

test('AU-01: only whitelisted actions are accepted', () => {
  audit.resetAuditStateForTests();
  assert.equal(audit.recordAnalyticsAccess({ userId: 1, urlId: 2, action: 'stats.view' }), true);
  assert.equal(audit.recordAnalyticsAccess({ userId: 1, urlId: 2, action: 'evil.action' }), false);
  assert.equal(audit.getAuditStats().queued, 1);
  audit.resetAuditStateForTests();
});

test('AU-02: repeated reads by the same actor are deduped', () => {
  audit.resetAuditStateForTests();
  const first = audit.recordAnalyticsAccess({ userId: 7, urlId: 9, action: audit.AUDIT_ACTIONS.VIEW });
  const second = audit.recordAnalyticsAccess({ userId: 7, urlId: 9, action: audit.AUDIT_ACTIONS.VIEW });
  const otherAction = audit.recordAnalyticsAccess({ userId: 7, urlId: 9, action: audit.AUDIT_ACTIONS.EXPORT });

  assert.equal(first, true);
  assert.equal(second, false, 'same actor + action + link inside the TTL must dedupe');
  assert.equal(otherAction, true);
  assert.equal(audit.getAuditStats().queued, 2);
  audit.resetAuditStateForTests();
});
