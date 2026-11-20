'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SEO_LANDING_PAGES,
  findLandingPage,
  landingPagePaths,
  landingCopy,
} = require('../src/lib/seo-pages');

test('P39 unit: Agency & E-Commerce solution pages exist, are in sitemap paths, and have distinct non-spam content', () => {
  const agency = findLandingPage('agency-client-reporting');
  const ecom = findLandingPage('ecommerce-campaign-tracking');
  assert.ok(agency, 'agency-client-reporting page must exist');
  assert.ok(ecom, 'ecommerce-campaign-tracking page must exist');

  const paths = landingPagePaths();
  assert.ok(paths.includes('/l/agency-client-reporting'));
  assert.ok(paths.includes('/l/ecommerce-campaign-tracking'));

  for (const lang of ['az', 'tr', 'en']) {
    const a = landingCopy(agency, lang);
    const e = landingCopy(ecom, lang);
    assert.notEqual(a.title, e.title);
    assert.notEqual(a.lead, e.lead);
    assert.ok(a.solution && e.solution, `solution metadata required for ${lang}`);
    assert.match(a.solution.syntheticNotice, /sintetik|sentetik|synthetic/i);
    assert.match(e.solution.syntheticNotice, /sintetik|sentetik|synthetic/i);
    assert.ok(a.solution.faq.length >= 2);
    assert.ok(e.solution.faq.length >= 2);
  }

  // Unknown slugs must not invent doorway pages
  assert.equal(findLandingPage('random-doorway-spam-page'), null);
  assert.ok(SEO_LANDING_PAGES.length >= 7);
});
