const express = require('express');
const router = express.Router();
let cheerio = null;
try {
  cheerio = require('cheerio');
} catch {
  // Fallback to regex-based extraction if cheerio is not installed
}

// GET /tools/preview
router.get('/tools/preview', (req, res) => {
  res.render('tools/preview', {
    title: 'Free Social Media Link Previewer & AI Optimizer | Ovlink',
    req: req,
  });
});

// POST /api/tools/fetch-metadata
router.post('/api/tools/fetch-metadata', async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    new URL(url); // Validate URL

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch URL: ${response.status}`);
    }

    const html = await response.text();
    let metadata;

    if (cheerio) {
      const $ = cheerio.load(html);
      metadata = {
        title: $('meta[property="og:title"]').attr('content') || $('title').text() || '',
        description: $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '',
        image: $('meta[property="og:image"]').attr('content') || '',
        url: $('meta[property="og:url"]').attr('content') || url,
        domain: new URL(url).hostname
      };
    } else {
      const getMeta = (prop) => {
        const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["'](?:og:)?${prop}["'][^>]+content=["']([^"']*)["']`, 'i')) ||
                  html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["'](?:og:)?${prop}["']`, 'i'));
        return m ? m[1] : '';
      };
      const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
      metadata = {
        title: getMeta('title') || (titleMatch ? titleMatch[1].trim() : ''),
        description: getMeta('description'),
        image: getMeta('image'),
        url: getMeta('url') || url,
        domain: new URL(url).hostname
      };
    }

    res.json(metadata);
  } catch (error) {
    console.error('Error fetching metadata:', error);
    res.status(500).json({ error: 'Failed to extract metadata from the URL.' });
  }
});

// POST /api/tools/optimize-title
router.post('/api/tools/optimize-title', async (req, res) => {
  const { title, description } = req.body;
  if (!title) {
    return res.status(400).json({ error: 'Title is required' });
  }

  const apiKey = process.env.OPENCODE_AI_API_KEY || '';
  const apiUrl = (process.env.OPENCODE_AI_BASE_URL || 'https://opencode.ai/zen/v1') + '/chat/completions';

  const freeModels = [
    process.env.OPENCODE_AI_MODEL || 'muse-spark-1.3-contributor-free',
    'nemotron-3.5-lightning-free',
    'nemotron-3-ultra-free',
    'ling-3.0-flash-fin-free',
    'mimo-v2.5-free',
    'big-pickle'
  ];

  const prompt = `
You are a world-class social media copywriter.
Generate 3 distinct high-converting headlines for social media (Twitter/LinkedIn) based on this content:
Original Title: "${title}"
Context / Description: "${description || ''}"

CRITICAL RULES:
1. STRICTLY ZERO EMOJIS: Never use any emojis, icons, or pictorial symbols.
2. English only. Keep each headline under 75 characters.
3. Provide exactly 3 lines formatted as follows:
Direct: [Clear, punchy headline]
Curiosity: [Question or curiosity gap]
Value: [Actionable benefit or key takeaway]
`;

  for (const model of freeModels) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    try {
      const sessionId = 'ses_' + Date.now();
      const response = await fetch(apiUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'x-session-id': sessionId,
          'x-opencode-session': sessionId,
          'x-opencode-client': 'cli',
          'User-Agent': 'opencode/1.0.0'
        },
        body: JSON.stringify({
          model: model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.7,
          max_tokens: 150,
          stream: false
        })
      });

      clearTimeout(timeout);

      if (!response.ok) continue;

      const data = await response.json();
      let rawContent = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (rawContent) {
        if (rawContent.includes('</think>')) {
          rawContent = rawContent.split('</think>').pop().trim();
        }

        const clean = rawContent.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim();

        const lines = clean.split('\n').map(l => l.trim()).filter(Boolean);
        const variants = [];

        let direct = lines.find(l => /^direct:/i.test(l))?.replace(/^direct:\s*/i, '') || '';
        let curiosity = lines.find(l => /^curiosity:/i.test(l))?.replace(/^curiosity:\s*/i, '') || '';
        let value = lines.find(l => /^value:/i.test(l))?.replace(/^value:\s*/i, '') || '';

        if (direct) variants.push({ label: 'Direct & Punchy', text: direct.replace(/^"|"$/g, '') });
        if (curiosity) variants.push({ label: 'Curiosity Hook', text: curiosity.replace(/^"|"$/g, '') });
        if (value) variants.push({ label: 'Value-Focused', text: value.replace(/^"|"$/g, '') });

        if (variants.length === 0 && lines.length > 0) {
          variants.push({ label: 'Optimized', text: lines[0].replace(/^["'\d\.\-\s]+|["'\s]+$/g, '') });
        }

        if (variants.length > 0) {
          return res.json({
            optimizedTitle: variants[0].text,
            variants
          });
        }
      }
    } catch (error) {
      clearTimeout(timeout);
    }
  }

  // Fallback variants if AI is temporarily unreachable
  const cleanTitle = title.replace(/^["'\s]+|["'\s]+$/g, '');
  const fallbackVariants = [
    { label: 'Direct & Punchy', text: `${cleanTitle}: The Essential Breakdown` },
    { label: 'Curiosity Hook', text: `Why Most People Get ${cleanTitle} Wrong` },
    { label: 'Value-Focused', text: `A Smarter Way to Approach ${cleanTitle}` }
  ];

  res.json({
    optimizedTitle: fallbackVariants[0].text,
    variants: fallbackVariants
  });
});

module.exports = router;
