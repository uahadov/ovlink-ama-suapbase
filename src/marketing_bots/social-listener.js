require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { sendTelegramAlert } = require('./telegram-notifier');
const { storePendingHn, storePendingReddit } = require('./pending-actions');
const { cleanHtmlSnippet, escapeTelegramHtml, sanitizeAISocialReply } = require('./ai-sanitizer');
const redditClient = require('./reddit-client');

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
      this.seenPostIds = new Set(arr);
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
        const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
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
  "score": number from 1 to 10 (scores >= 6.5 qualify as suitable and relevant for Ovlink),
  "reason": "1 concise sentence in Turkish explaining why this is or isn't a good fit"
}
`;

    for (const model of this.freeModels) {
      try {
        const sessionId = 'suit_' + Date.now();
        const res = await fetch(this.apiUrl, {
          method: 'POST',
          signal: AbortSignal.timeout(6000),
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

        if (!res.ok) continue;

        const data = await res.json();
        const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (content) {
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            const score = Number(parsed.score) || (hasHighIntent ? 8 : 6.5);
            return {
              isSuitable: !!parsed.is_suitable && score >= 6.5,
              score,
              reason: parsed.reason || 'Kullanıcı bağlantı yönetimi ve analiz aracı arıyor.'
            };
          }
        }
      } catch (e) {
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
    const systemPrompt = `You are an experienced software engineer and the creator of Ovlink (https://ovlink.sbs).
You are participating authentically in a Hacker News technical discussion.
Guidelines:
- Write a natural, peer-to-peer 2-3 sentence comment.
- First address the post's problem, technical challenge, or context with genuine insight or empathy.
- Mention Ovlink (https://ovlink.sbs) naturally as an indie project built to solve this simply without enterprise bloat.
- Keep the disclosure transparent and humble (e.g., "Creator here —", "I built https://ovlink.sbs for this exact reason", "Full disclosure: I'm building Ovlink...", etc.). Vary your phrasing naturally so it never sounds scripted.
- Zero emojis, zero aggressive sales talk. Speak developer-to-developer.
- Output ONLY the comment text. No preambles, no quotes, no commentary.`;

    const userPrompt = `Discussion Title: "${post.title}"
Post Context: "${post.context}"

Write an authentic, helpful 2-3 sentence Hacker News comment for this discussion. Address their point first, then share Ovlink naturally. Output comment text only.`;

    for (const model of this.freeModels) {
      try {
        const sessionId = 'social_ses_' + Date.now();
        const response = await fetch(this.apiUrl, {
          method: 'POST',
          signal: AbortSignal.timeout(7000),
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
      }
    }

    return 'Full disclosure: I built Ovlink (https://ovlink.sbs). If you need clean link tracking and custom domains without enterprise pricing tiers, it offers fast redirects and instant analytics.';
  }

  async generateRedditReply(post) {
    const subreddit = post.subreddit || 'SaaS';
    const systemPrompt = `You are an indie software engineer and the creator of Ovlink (https://ovlink.sbs).
You are replying to a real user in r/${subreddit} on Reddit.
Reddit community culture rules:
- Be authentic, conversational, humble, and helpful. Never sound like a corporate marketer, bot, or salesperson.
- Directly answer their technical question, pain point, or discussion first (1-2 sentences).
- If relevant, mention Ovlink (https://ovlink.sbs) naturally as an indie tool you built to solve this exact problem simply without enterprise pricing bloat.
- Transparently state you built it (e.g., "Creator here —", "I built https://ovlink.sbs for this...", "Full disclosure: I'm the builder of Ovlink...").
- Keep it concise (2-3 sentences max). Zero emojis. Output ONLY the comment text.`;

    const userPrompt = `Subreddit: r/${subreddit}
Post Title: "${post.title}"
Context: "${post.context}"

Write an authentic, helpful 2-3 sentence Reddit reply for this discussion. Address their point first, then share Ovlink naturally. Output comment text only.`;

    for (const model of this.freeModels) {
      try {
        const sessionId = 'reddit_ses_' + Date.now();
        const response = await fetch(this.apiUrl, {
          method: 'POST',
          signal: AbortSignal.timeout(7000),
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

        if (!response.ok) continue;

        const data = await response.json();
        const rawContent = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (rawContent) {
          const sanitized = sanitizeAISocialReply(rawContent);
          if (sanitized) {
            return sanitized;
          }
        }
      } catch (err) {}
    }

    return `Creator here — I built Ovlink (https://ovlink.sbs) as an indie alternative specifically for clean custom domains and real-time analytics without steep enterprise pricing. Happy to answer any questions about it!`;
  }

  async scanNetworks() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      // 1. Hacker News Scan
      console.log('[Social Listener] Scanning Hacker News discussions...');
      const liveHnPosts = await this.fetchLiveDiscussions();

      let alertedInThisCycle = false;

      for (const post of liveHnPosts) {
        this.seenPostIds.add(post.id);

        const suitability = await this.analyzeSuitability(post);
        console.log(`[Social Listener] HN Item #${post.id} suitability: ${suitability.isSuitable} (Score: ${suitability.score}/10) - ${suitability.reason}`);

        if (!suitability.isSuitable) continue;

        console.log(`[Social Listener] Qualified HN lead identified: "${post.title}". Generating reply...`);
        const aiReply = await this.generateReply(post);

        storePendingHn(post.id, {
          title: post.title,
          author: post.author,
          context: post.context,
          url: post.url,
          commentText: aiReply,
          suitabilityScore: suitability.score,
          suitabilityReason: suitability.reason
        });

        const safeSnippet = escapeTelegramHtml(post.context || 'Müzakirə məzmunu');
        const safeTitle = escapeTelegramHtml(post.title || '');
        const safeAuthor = escapeTelegramHtml(post.author || 'community_member');
        const safeReason = escapeTelegramHtml(suitability.reason || '');
        const safeReply = escapeTelegramHtml(aiReply || '');

        const tgMsg = `🎯 <b>[Hacker News Radarı] Canlı Fürsət Tapıldı!</b>\n\n` +
          `🔍 <b>Uyğunluq Analizi:</b> ${safeReason} (Skor: <b>${suitability.score}/10</b>)\n` +
          `📍 <b>Platforma:</b> Hacker News\n` +
          `👤 <b>İstifadəçi:</b> @${safeAuthor}\n` +
          `❓ <b>Mövzu:</b> "${safeTitle}"\n` +
          `💬 <b>Göndəriş / Şərh:</b>\n<i>${safeSnippet}</i>\n\n` +
          `🤖 <b>Hazırlanan Rəy:</b>\n` +
          `<blockquote>${safeReply}</blockquote>\n\n` +
          `👉 <i>Aşağıdakı düymə ilə şərhi <b>avtomatik dərc edə</b> və ya ləğv edə bilərsiniz:</i>`;

        const keyboard = [
          [
            { text: '🚀 Avtomatik Şərh Yaz (HN)', callback_data: `hn_send:${post.id}` },
            { text: '❌ Göndərmə / Keç', callback_data: `hn_skip:${post.id}` }
          ],
          [
            { text: '🔗 Mövzunu Aç (Hacker News)', url: post.url }
          ]
        ];

        await sendTelegramAlert(tgMsg, { keyboard });
        this.saveSeenPosts();
        alertedInThisCycle = true;
        break;
      }
      this.saveSeenPosts();

      // 2. Reddit Scan (if not already alerted to prevent noise)
      if (!alertedInThisCycle) {
        console.log('[Social Listener] Scanning Reddit discussions...');
        const liveRedditPosts = await redditClient.fetchLiveDiscussions();

        for (const post of liveRedditPosts) {
          redditClient.seenPostIds.add(post.id);

          const suitability = await this.analyzeSuitability(post);
          console.log(`[Social Listener] Reddit Item #${post.id} suitability: ${suitability.isSuitable} (Score: ${suitability.score}/10) - ${suitability.reason}`);

          if (!suitability.isSuitable) continue;

          console.log(`[Social Listener] Qualified Reddit lead identified: "${post.title}". Generating reply...`);
          const aiReply = await this.generateRedditReply(post);

          storePendingReddit(post.id, {
            subreddit: post.subreddit,
            title: post.title,
            author: post.author,
            context: post.context,
            url: post.url,
            commentText: aiReply,
            suitabilityScore: suitability.score,
            suitabilityReason: suitability.reason
          });

          const safeSnippet = escapeTelegramHtml(post.context || 'Müzakirə məzmunu');
          const safeTitle = escapeTelegramHtml(post.title || '');
          const safeAuthor = escapeTelegramHtml(post.author || 'reddit_user');
          const safeReason = escapeTelegramHtml(suitability.reason || '');
          const safeReply = escapeTelegramHtml(aiReply || '');

          const tgMsg = `🟠 <b>[Reddit Müştəri Radarı] Canlı Fürsət Tapıldı!</b>\n\n` +
            `🔍 <b>Uyğunluq Analizi:</b> ${safeReason} (Skor: <b>${suitability.score}/10</b>)\n` +
            `📍 <b>Subreddit:</b> r/${escapeTelegramHtml(post.subreddit || 'SaaS')}\n` +
            `👤 <b>Müəllif:</b> u/${safeAuthor}\n` +
            `📌 <b>Mövzu:</b> "${safeTitle}"\n` +
            `💬 <b>Mətn:</b>\n<i>${safeSnippet}</i>\n\n` +
            `🤖 <b>Hazırlanan Rəy (Birbaşa kopyalayıb yapışdıra bilərsiniz):</b>\n` +
            `<blockquote>${safeReply}</blockquote>`;

          const keyboard = [
            [
              { text: '💬 Redditdə Aç və Cavabla', url: post.url },
              { text: '📋 Rəy Mətnini Kopyala', callback_data: `reddit_copy:${post.id}` }
            ],
            [
              { text: '🔄 Yenidən Yaz', callback_data: `reddit_rewrite:${post.id}` },
              { text: '⏭️ Keç / İmtina', callback_data: `reddit_skip:${post.id}` }
            ]
          ];

          await sendTelegramAlert(tgMsg, { keyboard });
          redditClient.saveSeenPosts();
          alertedInThisCycle = true;
          break;
        }
        redditClient.saveSeenPosts();
      }
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
    if (typeof this.intervalId.unref === 'function') this.intervalId.unref();

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