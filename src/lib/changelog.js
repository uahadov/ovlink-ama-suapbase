'use strict';

/**
 * Public changelog data (A17).
 *
 * `views/updates.ejs` owns the trilingual timeline markup and is intentionally
 * left untouched — parsing it would make the feed depend on presentation. This
 * module is the single source for machine-readable entries: English titles and
 * summaries, ISO dates and a stable slug used as the feed guid.
 */

const CHANGELOG = Object.freeze([
  {
    date: '2026-11-01',
    slug: 'platform-expansion',
    title: 'QR management, onboarding and operational visibility',
    summary: 'Saved QR codes with per-day scan counts, a first-steps checklist on the dashboard, structured logs with request ids, /health and /api/health endpoints, and cold-outreach automation moved out of the web process.',
  },
  {
    date: '2026-11-01',
    slug: 'insights-upgrade',
    title: 'Analytics insights upgrade',
    summary: 'New vs returning visitors, funnel step reporting and significance testing for A/B variants.',
  },
  {
    date: '2026-10-31',
    slug: 'analytics-rollups',
    title: 'Rollup-based analytics performance',
    summary: 'Statistics are served from daily rollup tables, so long date ranges no longer scan raw click rows.',
  },
  {
    date: '2026-10-30',
    slug: 'account-tabs',
    title: 'Account page reorganised into tabs',
    summary: 'Profile, security, API keys and billing sections moved into tabs with deep links.',
  },
  {
    date: '2026-09-18',
    slug: 'security-hardening',
    title: 'Security hardening release',
    summary: 'Session regeneration on login, CSRF double-submit validation, strict CSP nonces and rate-limit tuning.',
  },
  {
    date: '2026-09-18',
    slug: 'link-tags',
    title: 'Tags and folders for links',
    summary: 'Group links with tags and folders, filter the dashboard and keep both when exporting.',
  },
  {
    date: '2026-09-17',
    slug: 'link-deletion',
    title: 'Safe link deletion',
    summary: 'Deleting a link now removes every dependent analytics row in one transaction.',
  },
  {
    date: '2026-09-17',
    slug: 'stats-sharing',
    title: 'Shareable statistics views',
    summary: 'Publish a read-only statistics link for a single short URL.',
  },
]);

function latestBuildDate() {
  return CHANGELOG.reduce((max, entry) => (entry.date > max ? entry.date : max), CHANGELOG[0].date);
}

function escapeXml(value) {
  return (value == null ? '' : value).toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * RSS 2.0 feed. Built by string concatenation on purpose: no template engine and
 * no XML library enter the request path.
 */
function buildRssFeed({ siteUrl, siteName = 'Ovlink', description = '', language = 'en-us' } = {}) {
  const base = (siteUrl || '').toString().replace(/\/+$/, '');
  const now = new Date().toUTCString();
  const items = CHANGELOG.map((entry) => [
    '    <item>',
    `      <title>${escapeXml(entry.title)}</title>`,
    `      <link>${escapeXml(`${base}/updates`)}</link>`,
    `      <guid isPermaLink="false">${escapeXml(`ovlink-${entry.slug}`)}</guid>`,
    `      <pubDate>${new Date(`${entry.date}T09:00:00Z`).toUTCString()}</pubDate>`,
    `      <description>${escapeXml(entry.summary)}</description>`,
    '    </item>',
  ].join('\n')).join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${escapeXml(siteName)}</title>`,
    `    <link>${escapeXml(base)}</link>`,
    `    <description>${escapeXml(description)}</description>`,
    `    <language>${escapeXml(language)}</language>`,
    `    <lastBuildDate>${now}</lastBuildDate>`,
    `    <atom:link href="${escapeXml(`${base}/updates.xml`)}" rel="self" type="application/rss+xml"/>`,
    items,
    '  </channel>',
    '</rss>',
  ].join('\n');
}

module.exports = { CHANGELOG, latestBuildDate, buildRssFeed, escapeXml };
