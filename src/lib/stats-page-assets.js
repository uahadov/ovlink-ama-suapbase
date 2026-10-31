// Single source for the stats detail page script (W4.4).
//
// The browser normally loads /public/stats-page.js (extracted from
// views/stats-page.ejs). As a one-release rollback lever, STATS_PAGE_INLINE_JS=1
// inlines the *same* file body into the page and hands the page config through
// window.__OVLINK_STATS_PAGE__ instead of the data-* attributes.
const fs = require('fs');
const path = require('path');

const { isEnabledEnv } = require('../config/index');

const SCRIPT_PATH = path.join(__dirname, '../../public/stats-page.js');

let cachedBody = null;

// Only the rollback lever reads this file, so a plain require-time cache is fine
// (and keeps a broken deploy from turning into a per-request disk hit).
function readStatsPageScriptBody() {
  if (cachedBody === null) {
    try {
      cachedBody = fs.readFileSync(SCRIPT_PATH, 'utf8');
    } catch {
      cachedBody = '';
    }
  }
  return cachedBody;
}

function buildInlineStatsPage(config) {
  const body = readStatsPageScriptBody();
  if (!body) return '';
  // `<` must not survive in the JSON payload: it could otherwise close the
  // inline <script> element if a short code ever carried markup characters.
  const payload = JSON.stringify(config).replace(/</g, '\\u003c');
  return `window.__OVLINK_STATS_PAGE__ = ${payload};\n` + body;
}

// Returns the inline body when the rollback lever is on, otherwise null so the
// view emits the plain <script src> tag.
function statsPageInlineJs(config) {
  if (!isEnabledEnv('STATS_PAGE_INLINE_JS')) return null;
  return buildInlineStatsPage(config);
}

module.exports = {
  SCRIPT_PATH,
  readStatsPageScriptBody,
  buildInlineStatsPage,
  statsPageInlineJs,
};
