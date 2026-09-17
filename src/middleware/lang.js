const { getRequestGeoMeta, parseAcceptLang } = require('../lib/geo');
const { ASSET_VERSION } = require('../config/index');

function langMiddleware(req, res, next) {
  const validLangs = ['az', 'tr', 'en'];
  const cookieHeader = req.headers.cookie || '';
  const cookieMatch = cookieHeader.match(/(?:^|;\s*)(?:lang_default|lang|ovlink_lang)=([^;]+)/i);
  const cookieVal = cookieMatch ? decodeURIComponent(cookieMatch[1]).trim().toLowerCase() : '';

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
    // lang_default is intentionally readable by client for language switcher (non-HttpOnly).
    res.cookie('lang_default', lang, { httpOnly: false, sameSite: 'Lax', secure: process.env.NODE_ENV === 'production' });
  }
  next();
}

module.exports = langMiddleware;
