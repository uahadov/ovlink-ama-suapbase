const { getRequestGeoMeta, parseAcceptLang } = require('../lib/geo');
const { ASSET_VERSION } = require('../config/index');

function extractCookieLang(cookieHeader) {
  if (!cookieHeader || typeof cookieHeader !== 'string') return '';
  const getVal = (name) => {
    const m = cookieHeader.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)', 'i'));
    return m ? decodeURIComponent(m[1]).trim().toLowerCase() : '';
  };
  const valid = ['az', 'tr', 'en'];
  // Priority: lang_default is primary, followed by ovlink_lang, then legacy lang
  const defaultVal = getVal('lang_default');
  if (valid.includes(defaultVal)) return defaultVal;
  const ovlinkVal = getVal('ovlink_lang');
  if (valid.includes(ovlinkVal)) return ovlinkVal;
  const genericVal = getVal('lang');
  if (valid.includes(genericVal)) return genericVal;
  return '';
}

function langMiddleware(req, res, next) {
  const validLangs = ['az', 'tr', 'en'];
  const cookieHeader = req.headers.cookie || '';
  const cookieVal = extractCookieLang(cookieHeader);

  let lang = 'en';

  if (validLangs.includes(cookieVal)) {
    lang = cookieVal;
  } else {
    const geoMeta = getRequestGeoMeta(req);
    if (geoMeta.country === 'AZ') lang = 'az';
    else if (geoMeta.country === 'TR') lang = 'tr';
    else {
      const acceptLang = parseAcceptLang(req.headers['accept-language']);
      if (acceptLang && validLangs.includes(acceptLang)) lang = acceptLang;
      else lang = 'az'; // Default to az for Ovlink
    }
  }

  res.locals.defaultLang = lang;
  res.locals.assetVersion = ASSET_VERSION;
  res.locals.seo = null;
  req.defaultLang = lang;

  const accept = (req.get('accept') || '').toLowerCase();
  const isHtml = accept.includes('text/html');
  const isApi = req.path.startsWith('/api/');
  const isAsset = /\.(css|js|png|jpg|jpeg|webp|svg|ico|woff2?|ttf|map)$/i.test(req.path);
  if (isHtml && !isApi && !isAsset) {
    const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
    const isLocal = req.hostname === 'localhost' || req.hostname === '127.0.0.1';
    const secureCookie = isHttps && !isLocal;
    // lang_default is intentionally readable by client for language switcher (non-HttpOnly).
    res.cookie('lang_default', lang, { httpOnly: false, sameSite: 'Lax', secure: secureCookie, maxAge: 31536000000 });
  }
  next();
}

module.exports = langMiddleware;
