const fs = require('fs');
const path = require('path');

/**
 * Retrieves the Hacker News session cookie from file or environment.
 */
function getHackerNewsCookie() {
  if (process.env.HACKER_NEWS_COOKIE) {
    return process.env.HACKER_NEWS_COOKIE.trim();
  }

  const cookiePath = path.join(__dirname, '../../hacker-news-cookie.json');
  if (fs.existsSync(cookiePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
      if (Array.isArray(parsed)) {
        return parsed.map(c => `${c.name}=${c.value}`).join('; ');
      }
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.cookie === 'string') return parsed.cookie;
        return Object.entries(parsed).map(([k, v]) => `${k}=${v}`).join('; ');
      }
    } catch (e) {
      console.warn('[HN Client] Error parsing hacker-news-cookie.json:', e.message);
    }
  }

  return null;
}

/**
 * Posts an autonomous comment on Hacker News as user @exlr using session cookies.
 * @param {string|number} postId - Target item ID to reply to
 * @param {string} text - Comment text to post
 * @returns {Promise<{success: boolean, user: string, url: string}>}
 */
async function postHackerNewsComment(postId, text) {
  const cookie = getHackerNewsCookie();
  if (!cookie) {
    throw new Error('Hacker News oturum çerezi bulunamadı (hacker-news-cookie.json eksik).');
  }

  const itemUrl = `https://news.ycombinator.com/item?id=${postId}`;
  const getRes = await fetch(itemUrl, {
    signal: AbortSignal.timeout(10000),
    headers: {
      'Cookie': cookie,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
    }
  });

  if (!getRes.ok) {
    throw new Error(`Hacker News gönderisine ulaşılamadı (HTTP ${getRes.status})`);
  }

  const html = await getRes.text();

  // Validate active login
  const userMatch = html.match(/<a [^>]*id=['"]me['"][^>]*>([^<]+)<\/a>/i) ||
                    html.match(/<a href="user\?id=([^"]+)">/i);
  if (!userMatch) {
    throw new Error('Hacker News oturumunun süresi dolmuş. Lütfen hacker-news-cookie.json çerezini yenileyin.');
  }
  const username = userMatch[1];

  // Extract dynamic HMAC token from comment form
  const hmac = extractHmac(html);
  if (!hmac) {
    throw new Error('Hacker News yorum formu HMAC tokeni bulunamadı. Gönderi yoruma kapalı veya kilitli olabilir.');
  }

  // Prepare submission payload
  const bodyParams = new URLSearchParams();
  bodyParams.append('parent', String(postId));
  bodyParams.append('goto', `item?id=${postId}`);
  bodyParams.append('hmac', hmac);
  bodyParams.append('text', text);

  const postRes = await fetch('https://news.ycombinator.com/comment', {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
    headers: {
      'Cookie': cookie,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': itemUrl,
      'Origin': 'https://news.ycombinator.com',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
    },
    body: bodyParams.toString(),
    redirect: 'manual'
  });

  const location = postRes.headers.get('location') || '';
  if (postRes.status === 302 && (location.includes(`item?id=${postId}`) || location.includes('item?id='))) {
    return { success: true, user: username, url: `https://news.ycombinator.com/item?id=${postId}` };
  }

  if (postRes.status === 200) {
    const postHtml = await postRes.text();
    if (postHtml.includes('submitting too fast') || postHtml.includes('Can\'t post') || postHtml.includes('Validation error')) {
      const errClean = postHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
      throw new Error(`Hacker News: ${errClean}`);
    }
    return { success: true, user: username, url: `https://news.ycombinator.com/item?id=${postId}` };
  }

  throw new Error(`Hacker News beklenmeyen yanıt verdi (HTTP ${postRes.status}, location: ${location})`);
}

/**
 * Extracts HMAC token from Hacker News comment HTML.
 */
function extractHmac(html) {
  if (!html) return null;
  const hmacMatch = html.match(/<input [^>]*name=['"]hmac['"][^>]*value=['"]([^'"]+)['"]/i) ||
                    html.match(/value=['"]([^'"]+)['"][^>]*name=['"]hmac['"]/i);
  return hmacMatch ? hmacMatch[1] : null;
}

module.exports = {
  getHackerNewsCookie,
  postHackerNewsComment,
  extractHmac
};