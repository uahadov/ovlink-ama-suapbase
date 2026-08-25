const { getPublicBaseUrl } = require('./security');
const { getLangFromCookie, normalizeLang, pickLang } = require('./i18n');

const DEFAULT_SEO_KEYWORDS = Object.freeze([
  'ovlink',
  'link qisaltmaq',
  'link qısaltma',
  'link qisalt',
  'url shortener',
  'shorten url',
  'free url shortener',
  'custom url shortener',
  'qr kod yaratmaq',
  'qr kod oluştur',
  'qr code generator',
  'dynamic qr code',
  'best link shortening sites',
  'popular URL shortener services',
  'free link shortener websites',
  'best URL shorteners 2025 comparison',
  'free custom domain URL shortener',
  'are URL shorteners safe security risks phishing malware',
]);

function normalizeSeoKeywords(rawKeywords) {
  const output = [];
  const seen = new Set();
  const pushKeyword = (value) => {
    const keyword = (value || '').toString().trim();
    if (!keyword) return;
    const key = keyword.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    output.push(keyword);
  };

  if (Array.isArray(rawKeywords)) {
    rawKeywords.forEach(pushKeyword);
  } else if (typeof rawKeywords === 'string') {
    rawKeywords.split(',').forEach(pushKeyword);
  }

  return output;
}

function buildSeo(req, opts = {}) {
  const base = getPublicBaseUrl(req);
  const rawLang = getLangFromCookie(req) || req.defaultLang || 'en';
  const lang = normalizeLang(rawLang, 'en');
  const title = pickLang(lang, opts.titleAz || 'Ovlink - Link Qısaltmaq', opts.titleTr || 'Ovlink - Link Kısaltma', opts.titleEn || 'Ovlink - URL Shortener');
  const description = pickLang(lang, opts.descAz || 'Ovlink ilə uzun linkləri pulsuz qısaldın və QR kod yaradın.', opts.descTr || 'Ovlink ile linklerinizi ücretsiz kısaltın ve QR kod oluşturun.', opts.descEn || 'Shorten long links for free and generate custom QR codes with Ovlink.');
  const keywords = normalizeSeoKeywords([
    ...DEFAULT_SEO_KEYWORDS,
    ...normalizeSeoKeywords(opts.keywords || []),
  ]).join(', ');
  const path = (opts.path || req.path || '/').toString();
  const canonical = base + path;
  const org = { "@context": "https://schema.org", "@type": "Organization", "name": "Ovlink", "url": base, "logo": `${base}/logo.png` };
  const website = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "name": "Ovlink",
    "url": base,
    "potentialAction": {
      "@type": "SearchAction",
      "target": `${base}/?q={search_term_string}`,
      "query-input": "required name=search_term_string"
    }
  };
  const softwareApp = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    "name": "Ovlink",
    "url": base,
    "applicationCategory": "UtilityApplication",
    "operatingSystem": "Web, iOS, Android, Telegram",
    "offers": {
      "@type": "Offer",
      "price": "0",
      "priceCurrency": "USD"
    },
    "featureList": [
      "URL Shortener",
      "Custom Aliases",
      "Dynamic QR Code Generator",
      "Real-time Click Analytics",
      "Telegram Bot Integration (@OvlinkBOT)",
      "Multi-language support"
    ]
  };
  const hreflangEn = base + path + (path.includes('?') ? '&' : '?') + 'lang=en';
  const hreflangAz = base + path + (path.includes('?') ? '&' : '?') + 'lang=az';
  const hreflangTr = base + path + (path.includes('?') ? '&' : '?') + 'lang=tr';
  const hreflangXDefault = hreflangEn;
  return {
    lang,
    title,
    description,
    keywords,
    canonical,
    ogTitle: title,
    ogDescription: description,
    ogUrl: canonical,
    twitterTitle: title,
    twitterDescription: description,
    hreflangEn,
    hreflangAz,
    hreflangTr,
    hreflangXDefault,
    jsonLd: JSON.stringify([org, website, softwareApp]).replace(/</g, '\\u003c').replace(/\//g, '\\u002f')
  };
}

module.exports = {
  buildSeo,
  buildSeoMeta: buildSeo,
  DEFAULT_SEO_KEYWORDS,
  normalizeSeoKeywords
};
