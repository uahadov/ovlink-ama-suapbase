require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { sendTelegramAlert } = require('./telegram-notifier');

class SocialListenerBot {
  constructor() {
    this.intervalId = null;
    this.isRunning = false;
    this.apiKey = process.env.OPENCODE_AI_API_KEY || '';
    this.apiUrl = (process.env.OPENCODE_AI_BASE_URL || 'https://opencode.ai/zen/v1') + '/chat/completions';
    this.freeModels = [
      process.env.OPENCODE_AI_MODEL || 'muse-spark-1.3-contributor-free',
      'nemotron-3.5-lightning-free',
      'nemotron-3-ultra-free',
      'ling-3.0-flash-fin-free',
      'mimo-v2.5-free',
      'big-pickle'
    ];
    this.queries = [
      'url shortener',
      'bitly alternative',
      'link management',
      'custom domain shortener',
      'link tracking'
    ];
    this.dataPath = path.join(__dirname, '../../bot_data/seen_posts.json');
    this.seenPostIds = this.loadSeenPosts();
  }

  loadSeenPosts() {
    try {
      if (fs.existsSync(this.dataPath)) {
        const raw = fs.readFileSync(this.dataPath, 'utf8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) return new Set(list);
      }
    } catch (e) {
      console.warn('[Social Listener] Could not read seen posts file:', e.message);
    }
    return new Set();
  }

  saveSeenPosts() {
    try {
      const dir = path.dirname(this.dataPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const arr = Array.from(this.seenPostIds).slice(-500);
      fs.writeFileSync(this.dataPath, JSON.stringify(arr, null, 2), 'utf8');
    } catch (e) {
      console.warn('[Social Listener] Could not save seen posts:', e.message);
    }
  }

  async fetchLiveDiscussions() {
    const discovered = [];
    for (const query of this.queries) {
      try {
        const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}&tags=(story,comment)&hitsPerPage=6`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);

        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);

        if (!res.ok) continue;
        const data = await res.json();
        const hits = data.hits || [];

        for (const hit of hits) {
          const id = String(hit.objectID);
          if (this.seenPostIds.has(id)) continue;

          const title = hit.title || hit.story_title || 'URL Shortener Discussion';
          const rawText = hit.comment_text || hit.story_text || title;
          const cleanText = rawText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

          const lower = (title + ' ' + cleanText).toLowerCase();
          const matches = ['shorten', 'bitly', 'link', 'domain', 'redirect', 'analytics', 'tinyurl'].some(w => lower.includes(w));
          if (!matches) continue;

          discovered.push({
            id,
            platform: 'Hacker News',
            title: title.slice(0, 120),
            author: hit.author || 'community_member',
            context: cleanText.slice(0, 280),
            url: `https://news.ycombinator.com/item?id=${id}`,
            createdAt: hit.created_at
          });
        }
      } catch (err) {
        console.warn(`[Social Listener] Search error for query "${query}":`, err.message);
      }
    }
    return discovered;
  }

  async generateReply(post) {
    const prompt = `
You are the software engineer and indie founder who built Ovlink (https://ovlink.sbs).
Someone on Hacker News is discussing URL shorteners or link management:
Title: "${post.title}"
Post/Comment Content: "${post.context}"

CRITICAL ETHICAL & QUALITY RULES:
1. COMPLETE HONESTY & TRANSPARENCY: Never pretend to be an unrelated third-party customer. Transparently state that you built or work on Ovlink as an indie tool (e.g., "Full disclosure: I built Ovlink...").
2. STRICTLY ZERO EMOJIS: Never use any emojis or pictorial symbols.
3. Natural, humble, peer-to-peer American English (2 to 3 sentences maximum).
4. No spam, no hard selling, no exaggerated claims. Genuinely address their technical points or problem.
5. Offer Ovlink (https://ovlink.sbs) as a lightweight, honest option if they need clean custom domains, fast redirects, and privacy-respecting analytics without enterprise price bloat.

Output ONLY the comment text.
`;

    for (const model of this.freeModels) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      try {
        const sessionId = 'social_ses_' + Date.now();
        const response = await fetch(this.apiUrl, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
            'x-session-id': sessionId,
            'x-opencode-session': sessionId,
            'x-opencode-client': 'cli',
            'User-Agent': 'opencode/1.0.0'
          },
          body: JSON.stringify({
            model: model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.7,
            max_tokens: 220,
            stream: false
          })
        });

        clearTimeout(timeout);
        if (!response.ok) continue;

        const data = await response.json();
        let content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (content) {
          if (content.includes('</think>')) {
            content = content.split('</think>').pop().trim();
          } else if (content.startsWith("Here's a thinking process")) {
            const lines = content.split('\n');
            const cleanLines = lines.filter(l => !l.startsWith('1.') && !l.startsWith('2.') && !l.startsWith('**') && !l.includes('Analyze'));
            content = cleanLines.join(' ').trim();
          }

          return content.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim();
        }
      } catch (err) {
        clearTimeout(timeout);
      }
    }

    return 'For clean link tracking and custom domains without paying ridiculous monthly subscriptions, Ovlink (https://ovlink.sbs) is worth checking out. It offers instant analytics and straightforward API access.';
  }

  async scanNetworks() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      console.log(`[Social Listener] Live radar active. Scanning Hacker News discussions...`);
      const livePosts = await this.fetchLiveDiscussions();

      if (livePosts.length === 0) {
        console.log('[Social Listener] No new unread discussions found in this cycle.');
        return;
      }

      console.log(`[Social Listener] Discovered ${livePosts.length} fresh opportunities.`);

      // Process up to 2 most recent opportunities to prevent flooding
      const targetBatch = livePosts.slice(0, 2);

      for (const post of targetBatch) {
        console.log(`[Social Listener] Analyzing live post: "${post.title}" by ${post.author}`);
        const aiReply = await this.generateReply(post);

        const safeSnippet = post.context
          ? post.context.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          : 'Canli tartisma icerigi';
        const safeTitle = post.title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const safeAuthor = post.author.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        const tgMsg = `🎯 <b>[Sosyal Müşteri Radarı] Canlı Fırsat Yakalandı!</b>\n\n` +
          `📍 <b>Platform:</b> ${post.platform}\n` +
          `👤 <b>Kullanıcı:</b> @${safeAuthor}\n` +
          `❓ <b>Konu:</b> "${safeTitle}"\n` +
          `💬 <b>Gönderi / Yorum:</b>\n<i>${safeSnippet}</i>\n\n` +
          `🤖 <b>Muse Spark'ın Hazırladığı Yanıt (Kopyala/Yapıştır):</b>\n` +
          `<blockquote>${aiReply}</blockquote>\n\n` +
          `👉 <i>Aşağıdaki butona tıklayıp doğrudan tartışmaya gidebilir ve yanıtı yapıştırabilirsin:</i>`;

        await sendTelegramAlert(tgMsg, {
          keyboard: [[{ text: '🔗 Gönderiyi Aç (Hacker News)', url: post.url }]]
        });

        this.seenPostIds.add(post.id);
        this.saveSeenPosts();

        console.log(`[Social Listener] Alert dispatched for item #${post.id}`);
      }
    } catch (error) {
      console.error('[Social Listener] Error scanning networks:', error.message);
    } finally {
      this.isRunning = false;
    }
  }

  start() {
    console.log('[Social Listener] Starting 24/7 live social media monitoring engine...');
    const intervalMs = 2 * 60 * 60 * 1000;
    this.intervalId = setInterval(() => this.scanNetworks(), intervalMs);

    setTimeout(() => this.scanNetworks(), 3000).unref?.();
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      console.log('[Social Listener] Stopped.');
    }
  }
}

module.exports = new SocialListenerBot();
