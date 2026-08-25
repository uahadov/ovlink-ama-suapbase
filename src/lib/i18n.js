function getCookieValue(req, name) {
  const key = (name || '').toString().trim();
  if (!key) return '';
  try {
    const cookie = (req.headers.cookie || '').toString();
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = cookie.match(new RegExp('(?:^|;)\\s*' + escapedKey + '=([^;]+)', 'i'));
    if (!m) return '';
    return decodeURIComponent(m[1] || '').trim();
  } catch {
    return '';
  }
}

function pickLang(lang, az, tr, en) {
  if (lang === 'tr') return tr;
  if (lang === 'en') return en;
  return az;
}

function normalizeLang(lang, fallback = 'az') {
  return (lang === 'tr' || lang === 'az' || lang === 'en') ? lang : fallback;
}

function getLangFromCookie(req) {
  const raw = getCookieValue(req, 'lang_default');
  return raw || null;
}

module.exports = {
  pickLang,
  normalizeLang,
  getLangFromCookie
};
