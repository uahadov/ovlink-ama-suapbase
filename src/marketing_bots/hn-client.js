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
  let cookie = getHackerNewsCookie();
  const hasCredentials = Boolean(
    (process.env.HACKER_NEWS_USERNAME || process.env.HN_USERNAME) &&
    (process.env.HACKER_NEWS_PASSWORD || process.env.HN_PASSWORD)
  );

  // If cookie is missing but credentials exist, attempt auto-login
  if (!cookie && hasCredentials) {
    try {
      console.log('[HN Client] Cookie missing; performing auto-login...');
      const loginRes = await loginHackerNews();
      cookie = loginRes.cookie;
    } catch (e) {
      console.warn('[HN Client] Auto-login failed:', e.message);
    }
  }

  if (!cookie) {
    throw new Error('Hacker News oturum çerezi bulunamadı (hacker-news-cookie.json eksik veya HACKER_NEWS_USERNAME/HACKER_NEWS_PASSWORD tanımlanmamış).');
  }

  // 1. Fetch item page
  const itemUrl = `https://news.ycombinator.com/item?id=${postId}`;
  let itemRes = await fetchHNPage(itemUrl, cookie, 1);
  if (!itemRes.ok) {
    throw new Error(`Hacker News gönderisine ulaşılamadı (HTTP ${itemRes.status})`);
  }

  let html = itemRes.html;

  // 2. Validate active login: Only <a id="me"> indicates an active session
  let meMatch = html.match(/<a [^>]*id=['"]me['"][^>]*>([^<]+)<\/a>/i);
  if (!meMatch && hasCredentials) {
    try {
      console.log('[HN Client] Session expired; re-authenticating with credentials...');
      const loginRes = await loginHackerNews();
      cookie = loginRes.cookie;
      const retryRes = await fetchHNPage(itemUrl, cookie, 1);
      if (retryRes.ok) {
        itemRes = retryRes;
        html = retryRes.html;
        meMatch = html.match(/<a [^>]*id=['"]me['"][^>]*>([^<]+)<\/a>/i);
      }
    } catch (e) {
      console.warn('[HN Client] Re-authentication failed:', e.message);
    }
  }

  if (!meMatch) {
    if (html.includes('login?goto=') || html.includes('<a href="login">')) {
      throw new Error('Hacker News oturumunun süresi dolmuş. Lütfen Telegram üzerinden /hn_login <ad> <şifre> komutunu kullanın veya hacker-news-cookie.json çerezini yenileyin.');
    }
    throw new Error('Hacker News oturumu doğrulanamadı. Çerez geçersiz veya süresi dolmuş.');
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
 * Automatically logs in to Hacker News using credentials and saves the session cookie.
 * @param {string} [username]
 * @param {string} [password]
 * @returns {Promise<{success: boolean, cookie: string, user: string}>}
 */
async function loginHackerNews(username, password) {
  const user = username || process.env.HACKER_NEWS_USERNAME || process.env.HN_USERNAME;
  const pass = password || process.env.HACKER_NEWS_PASSWORD || process.env.HN_PASSWORD;

  if (!user || !pass) {
    throw new Error('Hacker News istifadəçi adı və ya şifrəsi təyin edilməyib (HACKER_NEWS_USERNAME, HACKER_NEWS_PASSWORD).');
  }

  const body = new URLSearchParams({
    acct: user.trim(),
    pw: pass.trim()
  });

  const res = await fetch('https://news.ycombinator.com/login', {
    method: 'POST',
    signal: AbortSignal.timeout(12000),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': 'https://news.ycombinator.com',
      'Referer': 'https://news.ycombinator.com/login',
      ...HN_BROWSER_HEADERS
    },
    body: body.toString(),
    redirect: 'manual'
  });

  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  let userCookie = null;

  for (const c of setCookies) {
    const match = c.match(/(user=[^;]+)/);
    if (match) {
      userCookie = match[1];
      break;
    }
  }

  if (res.status === 302 && userCookie) {
    const cookiePath = path.join(__dirname, '../../hacker-news-cookie.json');
    const cookieVal = userCookie.replace(/^user=/, '');
    const cookieObj = [
      {
        domain: 'news.ycombinator.com',
        expirationDate: Math.floor(Date.now() / 1000) + 63072000,
        hostOnly: true,
        httpOnly: true,
        name: 'user',
        path: '/',
        sameSite: 'lax',
        secure: true,
        session: false,
        storeId: null,
        value: cookieVal
      }
    ];
    try {
      fs.writeFileSync(cookiePath, JSON.stringify(cookieObj, null, 2), 'utf8');
      console.log(`[HN Client] Auto-login successful for @${user}. New session cookie saved to hacker-news-cookie.json.`);
    } catch (e) {
      console.warn('[HN Client] Could not save auto-login cookie to file:', e.message);
    }
    return { success: true, cookie: userCookie, user };
  }

  const text = await res.text();
  if (text.includes('Bad login')) {
    throw new Error('Hacker News girişi uğursuz oldu: İstifadəçi adı və ya şifrə yanlışdır.');
  }

  throw new Error(`Hacker News daxilolma xətası (HTTP ${res.status})`);
}

/**
 * Saves a raw cookie string directly into hacker-news-cookie.json.
 */
function saveRawHackerNewsCookie(rawCookie) {
  if (!rawCookie) return false;
  const cookiePath = path.join(__dirname, '../../hacker-news-cookie.json');
  let cookieVal = rawCookie.trim();
  if (cookieVal.startsWith('user=')) {
    cookieVal = cookieVal.slice(5).split(';')[0];
  }
  const cookieObj = [
    {
      domain: 'news.ycombinator.com',
      expirationDate: Math.floor(Date.now() / 1000) + 63072000,
      hostOnly: true,
      httpOnly: true,
      name: 'user',
      path: '/',
      sameSite: 'lax',
      secure: true,
      session: false,
      storeId: null,
      value: cookieVal
    }
  ];
  fs.writeFileSync(cookiePath, JSON.stringify(cookieObj, null, 2), 'utf8');
  return true;
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
  verifyHackerNewsCookie,
  loginHackerNews,
  saveRawHackerNewsCookie
};