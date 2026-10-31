const express = require('express');
const { buildSeo } = require('../lib/seo');
const { normalizeLang } = require('../lib/i18n');
const {
  SEO_LANDING_PAGES,
  findLandingPage,
  landingCopy,
  landingShared,
} = require('../lib/seo-pages');

const router = express.Router();

/** Slug shape guard before touching the manifest: lowercase, hyphenated, bounded. */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

/** Trilingual titles for the interlinks, so a crawler sees real anchor text. */
function relatedPages(lang, excludeSlug) {
  const l = normalizeLang(lang, 'az');
  return SEO_LANDING_PAGES
    .filter((page) => page.slug !== excludeSlug)
    .map((page) => ({ slug: page.slug, title: page.copy.title[l] }));
}

/**
 * Landing-page cluster index. Rendered with the same template so the markup,
 * the navbar and the structured data stay identical across the set.
 *
 * Mounted as a two-segment path on purpose: a one-segment `/l` would shadow any
 * existing one-character short code, and this router must not touch that
 * namespace.
 */
router.get('/l/guides', (req, res) => {
  const seo = buildSeo(req, {
    path: '/l/guides',
    titleAz: 'Bütün təlimatlar — Ovlink',
    titleTr: 'Tüm rehberler — Ovlink',
    titleEn: 'All guides — Ovlink',
    descAz: 'Qısaltma, QR kod, statistika və öz domeni üçün Ovlink təlimatları.',
    descTr: 'Kısaltma, QR kod, istatistik ve kendi alan adı için Ovlink rehberleri.',
    descEn: 'Ovlink guides for link shortening, QR codes, analytics and custom domains.',
  });
  const shared = landingShared(seo.lang);
  res.render('seo-landing', {
    csrfToken: res.locals._csrf,
    seo,
    page: { slug: 'guides', titleKey: 'seo_landing_back_title', leadKey: 'seo_landing_more_title', pointKeys: [] },
    copy: { title: shared.backTitle, lead: shared.moreTitle, points: [] },
    related: relatedPages(seo.lang, 'guides'),
  });
});

/**
 * Programmatic landing pages (A17). Allowlist only: an unknown slug calls
 * next() so the request keeps its normal routing (and eventually 404s) instead
 * of inventing a page. 'guides' is taken by the index route above.
 */
router.get('/l/:slug', (req, res, next) => {
  const raw = (req.params.slug || '').toString();
  if (raw === 'guides') return next();
  if (!SLUG_RE.test(raw)) return next();
  const page = findLandingPage(raw);
  if (!page) return next();

  const path = `/l/${page.slug}`;
  const seo = buildSeo(req, {
    path,
    titleAz: page.copy.title.az,
    titleTr: page.copy.title.tr,
    titleEn: page.copy.title.en,
    descAz: page.copy.lead.az,
    descTr: page.copy.lead.tr,
    descEn: page.copy.lead.en,
  });
  // buildSeo falls back to 'en'; the copy blocks default to Azerbaijani, so keep
  // the rendered language and the lang attribute in sync.
  const copy = landingCopy(page, seo.lang);

  res.render('seo-landing', {
    csrfToken: res.locals._csrf,
    seo,
    page,
    copy,
    related: relatedPages(seo.lang, page.slug),
  });
});

module.exports = router;
