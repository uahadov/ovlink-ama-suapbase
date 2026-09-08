const fs = require('fs');
const path = require('path');

const HN_BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
  'Upgrade-Insecure-Requests': '1'
};

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
 * Fetches a Hacker News page with browser headers and transient retry logic.
 */
async function fetchHNPage(url, cookie, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(12000),
        headers: {
          'Cookie': cookie,
          ...HN_BROWSER_HEADERS
        }
      });
      const html = await res.text();

      // Check if Hacker News returned a server-side overload/outage page
      if (html.includes("We're having some trouble serving your request")) {
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        throw new Error('Hacker News sunucuları şu anda aşırı yoğun ("We\'re having some trouble serving your request"). Lütfen 1-2 dakika sonra tekrar deneyin.');
      }

      return { ok: res.ok, status: res.status, html };
    } catch (err) {
      if (attempt < retries && !err.message.includes('aşırı yoğun')) {
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Extracts form data (hmac, parent, goto) from Hacker News HTML.
 */
function extractCommentForm(html) {
  if (!html) return null;

  // Search inside form with action="comment" or entire snippet
  const formMatch = html.match(/<form [^>]*action=['"]\/?comment['"][^>]*>([\s\S]*?)<\/form>/i);
  const searchScope = formMatch ? formMatch[1] : html;

  const hmacMatch = searchScope.match(/<input [^>]*name=['"]hmac['"][^>]*value=['"]([^'"]+)['"]/i) ||
                    searchScope.match(/<input [^>]*value=['"]([^'"]+)['"][^>]*name=['"]hmac['"]/i);
  if (!hmacMatch) return null;

  const parentMatch = searchScope.match(/<input [^>]*name=['"]parent['"][^>]*value=['"]([^'"]+)['"]/i) ||
                      searchScope.match(/<input [^>]*value=['"]([^'"]+)['"][^>]*name=['"]parent['"]/i);
  const gotoMatch = searchScope.match(/<input [^>]*name=['"]goto['"][^>]*value=['"]([^'"]+)['"]/i) ||
                    searchScope.match(/<input [^>]*value=['"]([^'"]+)['"][^>]*name=['"]goto['"]/i);

  return {
    hmac: hmacMatch[1],
    parent: parentMatch ? parentMatch[1] : null,
    goto: gotoMatch ? gotoMatch[1] : null
  };
}

/**
 * Extracts HMAC token from Hacker News comment HTML.
 */
function extractHmac(html) {
  const form = extractCommentForm(html);
  return form ? form.hmac : null;
}

/**
 * Posts an autonomous comment on Hacker News using session cookies.
 * Supports both top-level stories (item?id=) and comments/replies (reply?id=).
 * @param {string|number} postId - Target item ID to reply to
 * @param {string} text - Comment text to post
 * @returns {Promise<{success: boolean, user: string, url: string}>}
 */
async function postHackerNewsComment(postId, text) {
  const cookie = getHackerNewsCookie();
  if (!cookie) {
    throw new Error('Hacker News oturum çerezi bulunamadı (hacker-news-cookie.json eksik).');
  }

  // 1. Fetch item page
  const itemUrl = `https://news.ycombinator.com/item?id=${postId}`;
  const itemRes = await fetchHNPage(itemUrl, cookie, 1);
  if (!itemRes.ok) {
    throw new Error(`Hacker News gönderisine ulaşılamadı (HTTP ${itemRes.status})`);
  }

  const html = itemRes.html;

  // 2. Validate active login: Only <a id="me"> indicates an active session
  const meMatch = html.match(/<a [^>]*id=['"]me['"][^>]*>([^<]+)<\/a>/i);
  if (!meMatch) {
    if (html.includes('login?goto=') || html.includes('<a href="login">')) {
      throw new Error('Hacker News oturumunun süresi dolmuş. Lütfen hacker-news-cookie.json çerezini yenileyin.');
    }
    throw new Error('Hacker News oturumu doğrulanamadı. Çerez geçersiz veya süresi dolmuş (hacker-news-cookie.json).');
  }
  const username = meMatch[1];

  // 3. Find the comment form (try story page first, then reply page for comments)
  let formData = extractCommentForm(html);
  let pageUrl = itemUrl;

  if (!formData) {
    const replyUrl = `https://news.ycombinator.com/reply?id=${postId}`;
    const replyRes = await fetchHNPage(replyUrl, cookie, 1);
    if (replyRes.html) {
      formData = extractCommentForm(replyRes.html);
      if (formData) {
        pageUrl = replyUrl;
      }
    }
  }

  if (!formData || !formData.hmac) {
    if (html.includes('locked') || html.includes('closed') || html.includes('story is closed')) {
      throw new Error('Hacker News gönderisi yoruma kapalı veya kilitli.');
    }
    throw new Error('Hacker News yorum formu veya HMAC tokeni bulunamadı. Gönderi kilitli, silinmiş veya yoruma kapatılmış olabilir.');
  }

  // 4. Prepare submission payload
  const bodyParams = new URLSearchParams();
  bodyParams.append('parent', formData.parent || String(postId));
  bodyParams.append('goto', formData.goto || `item?id=${postId}`);
  bodyParams.append('hmac', formData.hmac);
  bodyParams.append('text', text);

  const postRes = await fetch('https://news.ycombinator.com/comment', {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    headers: {
      'Cookie': cookie,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': pageUrl,
      'Origin': 'https://news.ycombinator.com',
      ...HN_BROWSER_HEADERS
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
 * Verifies if the stored Hacker News cookie has an active, valid session.
 */
async function verifyHackerNewsCookie() {
  const cookie = getHackerNewsCookie();
  if (!cookie) return { valid: false, error: 'Çerez dosyası bulunamadı.' };
  try {
    const res = await fetchHNPage('https://news.ycombinator.com/news', cookie, 1);
    if (!res.ok) return { valid: false, error: `Hacker News yanıt vermedi (HTTP ${res.status})` };
    const meMatch = res.html.match(/<a [^>]*id=['"]me['"][^>]*>([^<]+)<\/a>/i);
    if (!meMatch) {
      return { valid: false, error: 'Oturum açılmamış. Çerez geçersiz veya süresi dolmuş.' };
    }
    return { valid: true, username: meMatch[1] };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

module.exports = {
  getHackerNewsCookie,
  postHackerNewsComment,
  extractHmac,
  extractCommentForm,
  verifyHackerNewsCookie
};