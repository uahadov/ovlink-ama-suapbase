require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { cleanHtmlSnippet } = require('./ai-sanitizer');

class RedditClient {
  constructor() {
    this.dataPath = path.join(__dirname, '../../bot_data/seen_reddit_posts.json');
    this.seenPostIds = this.loadSeenPosts();
    this.queries = [
      'bitly alternative',
      'url shortener',
      'link tracking',
      'custom domain shortener',
      'short link api',
      'link rotator'
    ];
    this.targetSubreddits = [
      'SaaS',
      'webdev',
      'SideProject',
      'Entrepreneur',
      'marketing',
      'Affiliatemarketing',
      'startups'
    ];
  }

  loadSeenPosts() {
    try {
      if (fs.existsSync(this.dataPath)) {
        const raw = fs.readFileSync(this.dataPath, 'utf8');
        const list = JSON.parse(raw);
        return new Set(Array.isArray(list) ? list : []);
      }
    } catch (e) {
      console.warn('[Reddit Client] Could not read seen posts file:', e.message);
    }
    return new Set();
  }

  saveSeenPosts() {
    try {
      const dir = path.dirname(this.dataPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const arr = Array.from(this.seenPostIds).slice(-600);
      this.seenPostIds = new Set(arr);
      fs.writeFileSync(this.dataPath, JSON.stringify(arr, null, 2), 'utf8');
    } catch (e) {
      console.warn('[Reddit Client] Could not save seen posts:', e.message);
    }
  }

  /**
   * Fetches discussions using Pullpush API (primary)
   */
  async fetchFromPullpush(query) {
    const results = [];
    const encoded = encodeURIComponent(query);
    const subUrl = `https://api.pullpush.io/reddit/search/submission/?q=${encoded}&size=6`;
    const comUrl = `https://api.pullpush.io/reddit/search/comment/?q=${encoded}&size=6`;

    const fetchEndpoint = async (endpoint, type) => {
      try {
        const res = await fetch(endpoint, {
          signal: AbortSignal.timeout(6000),
          headers: { 'User-Agent': 'OvlinkBot/1.0.0' }
        });
        if (!res.ok) return [];
        const data = await res.json();
        return Array.isArray(data.data) ? data.data.map(item => ({ item, type })) : [];
      } catch (err) {
        return [];
      }
    };

    const [subs, comms] = await Promise.all([
      fetchEndpoint(subUrl, 'submission'),
      fetchEndpoint(comUrl, 'comment')
    ]);

    for (const { item, type } of [...subs, ...comms]) {
      if (!item || !item.id) continue;
      const rawId = String(item.id);
      const uniqueId = `reddit_${type}_${rawId}`;
      if (this.seenPostIds.has(uniqueId)) continue;

      const subreddit = item.subreddit || 'general';
      const author = item.author || 'reddit_user';
      const title = type === 'submission'
        ? cleanHtmlSnippet(item.title || 'Reddit Discussion', 140)
        : `r/${subreddit} Comment on ${query}`;
      
      const rawBody = type === 'submission'
        ? (item.selftext || item.title || '')
        : (item.body || '');
      const cleanBody = cleanHtmlSnippet(rawBody, 500);

      const permalink = item.permalink
        ? (item.permalink.startsWith('http') ? item.permalink : `https://reddit.com${item.permalink}`)
        : `https://reddit.com/r/${subreddit}`;

      results.push({
        id: uniqueId,
        platform: 'Reddit',
        subreddit,
        author,
        title,
        context: cleanBody || title,
        url: permalink,
        createdAt: item.created_utc ? new Date(item.created_utc * 1000).toISOString() : new Date().toISOString()
      });
    }

    return results;
  }

  /**
   * Fetches discussions using Reddit RSS feeds as fallback
   */
  async fetchFromRss(query) {
    const results = [];
    try {
      const subreddits = this.targetSubreddits.slice(0, 4).join('+');
      const encoded = encodeURIComponent(query);
      const url = `https://www.reddit.com/r/${subreddits}/search.rss?q=${encoded}&sort=new&restrict_sr=1`;

      const res = await fetch(url, {
        signal: AbortSignal.timeout(6000),
        headers: { 'User-Agent': 'OvlinkBot/1.0.0 (by /u/ovlinkapp)' }
      });
      if (!res.ok) return [];

      const xml = await res.text();
      const entries = xml.split('<entry>').slice(1);

      for (const entry of entries) {
        const idMatch = entry.match(/<id>([\s\S]*?)<\/id>/);
        const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/);
        const linkMatch = entry.match(/<link href="([^"]+)"/);
        const authorMatch = entry.match(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/);
        const contentMatch = entry.match(/<content type="html">([\s\S]*?)<\/content>/);
        const categoryMatch = entry.match(/<category term="([^"]+)"/);

        const rawId = idMatch ? idMatch[1].trim() : String(Date.now());
        const uniqueId = `reddit_rss_${rawId.replace(/[^a-zA-Z0-9_]/g, '_').slice(-24)}`;
        if (this.seenPostIds.has(uniqueId)) continue;

        const title = titleMatch ? cleanHtmlSnippet(titleMatch[1], 140) : 'Reddit Discussion';
        const urlLink = linkMatch ? linkMatch[1] : 'https://reddit.com';
        const author = authorMatch ? authorMatch[1].replace(/^\/u\//, '') : 'reddit_user';
        const rawContent = contentMatch ? contentMatch[1] : title;
        const cleanBody = cleanHtmlSnippet(rawContent, 500);
        const subreddit = categoryMatch ? categoryMatch[1] : 'SaaS';

        results.push({
          id: uniqueId,
          platform: 'Reddit',
          subreddit,
          author,
          title,
          context: cleanBody || title,
          url: urlLink,
          createdAt: new Date().toISOString()
        });
      }
    } catch (e) {
      // Fallback network error ignored
    }
    return results;
  }

  /**
   * Fetches all live Reddit discussions across all target queries
   */
  async fetchLiveDiscussions() {
    const allDiscussions = [];

    for (const query of this.queries) {
      try {
        let items = await this.fetchFromPullpush(query);
        if (!items || items.length === 0) {
          items = await this.fetchFromRss(query);
        }
        for (const item of items) {
          if (!allDiscussions.some(d => d.id === item.id)) {
            allDiscussions.push(item);
          }
        }
      } catch (err) {
        console.warn(`[Reddit Client] Error fetching query "${query}":`, err.message);
      }
    }

    return allDiscussions;
  }
}

module.exports = new RedditClient();
