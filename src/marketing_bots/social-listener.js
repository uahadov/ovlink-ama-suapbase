require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { sendTelegramAlert } = require('./telegram-notifier');
const { storePendingHn } = require('./pending-actions');
const { cleanHtmlSnippet, escapeTelegramHtml, sanitizeAISocialReply } = require('./ai-sanitizer');

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
        const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}&tags=(story,comment)&hitsPerPage=8`;
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

          const title = cleanHtmlSnippet(hit.title || hit.story_title || 'URL Shortener Discussion', 140);
          const rawText = hit.comment_text || hit.story_text || title;
          const cleanText = cleanHtmlSnippet(rawText, 500);

          const lower = (title + ' ' + cleanText).toLowerCase();
          const matches = ['shorten', 'bitly', 'link', 'domain', 'redirect', 'analytics', 'tinyurl'].some(w => lower.includes(w));
          if (!matches) continue;

          discovered.push({
            id,
            platform: 'Hacker News',
            title,
            author: hit.author || 'community_member',
            context: cleanText,
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

  /**
   * Evaluates whether this post is genuinely relevant and appropriate for Ovlink.
   * Filters out false positives and unrelated technical topics.
   */
  async analyzeSuitability(post) {
    const textToAnalyze = `${post.title}\n${post.context}`.toLowerCase();

    // 1. Hard Disqualifiers: Unrelated technical areas
    const disqualifiers = [
      'deep link', 'deeplink', 'universal link', 'swiftui', 'react native', 'flutter',
      'dnssec', 'bind 9', 'bind9', 'bind ', 'unbound', 'authoritative dns', 'dns resolver', 'recursive dns', 'dns architecture',
      'nameserver', 'whois dispute', 'icann', 'markdown link', 'hyperlink syntax', 'broken html link',
      'internal link graph', 'obsidian', 'roam research', 'blockchain domain', '.eth', 'ens domain'
    ];

    for (const dis of disqualifiers) {
      if (textToAnalyze.includes(dis)) {
        return {
          isSuitable: false,
          score: 2,
          reason: `Konu (${dis}) URL kısaltma/yönlendirme hizmetimizle alakasız teknik bir tartışma.`
        };
      }
    }

    // 2. High-Intent Keywords
    const highIntentKeywords = [
      'bitly alternative', 'url shortener', 'link shortener', 'custom domain shortener',
      'branded link', 'link tracking', 'click analytics', 'link rotator', 'qr code tracking',
      'short link api', 'dub.co alternative', 'tinyurl alternative', 'rebrandly alternative',
      'shorten url', 'short url'
    ];
    const hasHighIntent = highIntentKeywords.some(kw => textToAnalyze.includes(kw));

    // 3. AI Suitability Evaluation
    const prompt = `
You are the Growth Lead and Product Analyst for Ovlink (https://ovlink.sbs).
Ovlink is an indie link management and URL shortener platform providing:
- Custom branded domains
- Real-time click analytics & geolocation stats
- QR code generator
- A/B testing link rotator
- Developer REST API & webhooks
- Simple, fair pricing ($4.99/mo) vs Bitly enterprise bloat

Analyze this Hacker News post:
Title: "${post.title}"
Context: "${post.context}"

Determine if recommending Ovlink is genuinely relevant, helpful, and natural (NOT spammy).
Answer in strictly valid JSON:
{
  "is_suitable": boolean,
  "score": number from 1 to 10,
  "reason": "1 concise sentence in Turkish explaining why this is or isn't a good fit"
}
`;

    for (const model of this.freeModels) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      try {
        const sessionId = 'suit_' + Date.now();
        const res = await fetch(this.apiUrl, {
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
            temperature: 0.2,
            max_tokens: 180,
            stream: false
          })
        });

        clearTimeout(timeout);
        if (!res.ok) continue;

        const data = await res.json();
        const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (content) {
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            const score = Number(parsed.score) || (hasHighIntent ? 8 : 5);
            return {
              isSuitable: !!parsed.is_suitable && score >= 6,
              score,
              reason: parsed.reason || 'Kullanıcı bağlantı yönetimi ve analiz aracı arıyor.'
            };
          }
        }
      } catch (e) {
        clearTimeout(timeout);
      }
    }

    if (hasHighIntent) {
      return {
        isSuitable: true,
        score: 8,
        reason: 'Yüksek niyetli anahtar kelime eşleşmesi (Bitly alternatifi / link kısaltma / analitik).'
      };
    }

    return {
      isSuitable: false,
      score: 4,
      reason: 'Net bir link kısaltma veya analitik ihtiyacı tespit edilemedi.'
    };
  }

  async generateReply(post) {
    const systemPrompt = `You are a software engineer and founder who built Ovlink (https://ovlink.sbs).
ABSOLUTE PRODUCTION DIRECTIVE:
- Output ONLY the final 2-3 sentence comment for Hacker News.
- NEVER include any thinking process, reasoning, planning, "Here's a thinking process", "Role:", "Ground Rules:", or "Constraints:".
- Strictly ZERO emojis or icons.
- Natural, humble, peer-to-peer American English.
- Always include transparent indie disclosure (e.g., "Full disclosure: I built Ovlink...").
- Output pure plain text only.`;

    const userPrompt = `Discussion Title: "${post.title}"
Post Context: "${post.context}"

Write a concise 2-3 sentence Hacker News comment sharing Ovlink as an independent, lightweight alternative with custom domains and analytics. Start directly with "Full disclosure: I built Ovlink...". Do not include any other words.`;

    for (const model of this.freeModels) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 7000);

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
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt }
            ],
            temperature: 0.6,
            max_tokens: 600,
            stream: false
          })
        });

        clearTimeout(timeout);
        if (!response.ok) continue;

        const data = await response.json();
        const rawContent = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (rawContent) {
          const sanitized = sanitizeAISocialReply(rawContent);
          if (sanitized) {
            return sanitized;
          }
          console.warn(`[Social Listener] Model "${model}" output was rejected by sanitizer (contained thinking/defects). Trying next model...`);
        }
      } catch (err) {
        clearTimeout(timeout);
      }
    }

    return 'Full disclosure: I built Ovlink (https://ovlink.sbs). If you need clean link tracking and custom domains without enterprise pricing tiers, it offers fast redirects and instant analytics.';
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

      console.log(`[Social Listener] Discovered ${livePosts.length} discussions. Analyzing suitability for Ovlink...`);

      for (const post of livePosts) {
        this.seenPostIds.add(post.id);

        // Perform Suitability Analysis before disturbing user
        const suitability = await this.analyzeSuitability(post);
        console.log(`[Social Listener] Item #${post.id} suitability: ${suitability.isSuitable} (Score: ${suitability.score}/10) - ${suitability.reason}`);

        if (!suitability.isSuitable) {
          continue;
        }

        console.log(`[Social Listener] High-quality lead identified: "${post.title}". Generating reply...`);
        const aiReply = await this.generateReply(post);

        // Store pending action so Telegram callback button can execute comment
        storePendingHn(post.id, {
          title: post.title,
          author: post.author,
          context: post.context,
          url: post.url,
          commentText: aiReply,
          suitabilityScore: suitability.score,
          suitabilityReason: suitability.reason
        });

        const safeSnippet = escapeTelegramHtml(post.context || 'Tartisma icerigi');
        const safeTitle = escapeTelegramHtml(post.title || '');
        const safeAuthor = escapeTelegramHtml(post.author || 'community_member');
        const safeReason = escapeTelegramHtml(suitability.reason || '');
        const safeReply = escapeTelegramHtml(aiReply || '');

        const tgMsg = `🎯 <b>[Sosyal Müşteri Radarı] Canlı Fırsat Yakalandı!</b>\n\n` +
          `🔍 <b>Uygunluk Analizi:</b> ${safeReason} (Skor: <b>${suitability.score}/10</b>)\n` +
          `📍 <b>Platform:</b> ${post.platform}\n` +
          `👤 <b>Kullanıcı:</b> @${safeAuthor}\n` +
          `❓ <b>Konu:</b> "${safeTitle}"\n` +
          `💬 <b>Gönderi / Yorum:</b>\n<i>${safeSnippet}</i>\n\n` +
          `🤖 <b>Hazırlanan Yanıt:</b>\n` +
          `<blockquote>${safeReply}</blockquote>\n\n` +
          `👉 <i>Aşağıdaki butona tıklayarak @exlr çerezleri ile yorumu <b>otomatik yayınlayabilir</b> veya iptal edebilirsiniz:</i>`;

        const keyboard = [
          [
            { text: '🚀 Otomatik Yanıtla (HN)', callback_data: `hn_send:${post.id}` },
            { text: '❌ Gönderme / İptal', callback_data: `hn_skip:${post.id}` }
          ],
          [
            { text: '🔗 Gönderiyi Aç (Hacker News)', url: post.url }
          ]
        ];

        await sendTelegramAlert(tgMsg, { keyboard });
        this.saveSeenPosts();
        console.log(`[Social Listener] Alert dispatched for qualified item #${post.id}`);

        // Limit to 1 notification per cycle to prevent noise
        break;
      }

      this.saveSeenPosts();
    } catch (error) {
      console.error('[Social Listener] Error scanning networks:', error.message);
    } finally {
      this.isRunning = false;
    }
  }

  start() {
    console.log('[Social Listener] Starting 24/7 live social media monitoring engine with suitability filter & autonomous actions...');
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