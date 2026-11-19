'use strict';

/**
 * Structured Bot User-Agent Classifier & Transparency Spec (P20).
 *
 * Centralizes bot detection rules, categories, confidence levels, and known
 * false-positive / false-negative limits so redirect ingestion, conversion
 * guards, link stats, campaign stats, and /api/analytics/methodology share one
 * exact contract.
 */

const BOT_CLASSIFIER_VERSION = 'v1';

const BOT_RULE_GROUPS = Object.freeze([
  Object.freeze({
    category: 'social_preview',
    confidence: 'high',
    description: 'Messaging and social link-unfurler preview fetchers',
    pattern: new RegExp(
      [
        'facebookexternalhit',
        'facebot',
        'meta-externalagent',
        'twitterbot',
        'linkedinbot',
        'slackbot',
        'telegrambot',
        'discordbot',
        'whatsapp',
        'skypeuripreview',
        'vkshare',
        'embedly',
        'pinterest',
        'viber',
      ].join('|'),
      'i'
    ),
  }),
  Object.freeze({
    category: 'ai_crawler',
    confidence: 'high',
    description: 'AI training and retrieval crawlers',
    pattern: new RegExp(
      [
        'gptbot',
        'chatgpt-user',
        'oai-searchbot',
        'claudebot',
        'claude-web',
        'anthropic-ai',
        'perplexitybot',
        'bytespider',
        'ccbot',
        'amazonbot',
        'applebot-extended',
      ].join('|'),
      'i'
    ),
  }),
  Object.freeze({
    category: 'headless_automation',
    confidence: 'high',
    description: 'Headless browsers and test/scraping automation frameworks',
    pattern: new RegExp(
      [
        'headlesschrome',
        'phantomjs',
        'playwright',
        'puppeteer',
        'selenium',
        'webdriver',
        'scrapy',
      ].join('|'),
      'i'
    ),
  }),
  Object.freeze({
    category: 'monitoring',
    confidence: 'high',
    description: 'Uptime monitors, synthetic probes, and page-speed validators',
    pattern: new RegExp(
      [
        'lighthouse',
        'pingdom',
        'uptimerobot',
        'gtmetrix',
        'w3c_validator',
        'datadog',
        'newrelicpinger',
        'statuscake',
      ].join('|'),
      'i'
    ),
  }),
  Object.freeze({
    category: 'http_client',
    confidence: 'high',
    description: 'CLI tools, HTTP libraries, and API test clients',
    pattern: new RegExp(
      [
        'curl/',
        'wget/',
        'python-requests',
        'python-urllib',
        'httpx/',
        'aiohttp/',
        'go-http-client',
        'java/',
        'okhttp',
        'axios/',
        'node-fetch',
        'undici',
        'postmanruntime',
        'insomnia/',
      ].join('|'),
      'i'
    ),
  }),
  Object.freeze({
    category: 'search_crawler',
    confidence: 'medium',
    description: 'Search engine indexers, SEO spiders, and generic bot user agents',
    pattern: new RegExp(
      [
        'googlebot',
        'bingbot',
        'yandexbot',
        'baiduspider',
        'duckduckbot',
        'applebot',
        'ahrefsbot',
        'semrushbot',
        'mj12bot',
        'dotbot',
        'petalbot',
        'slurp',
        'crawler',
        'spider',
        'crawl',
        'bot\\b',
      ].join('|'),
      'i'
    ),
  }),
]);

const BOT_CLASSIFICATION_LIMITATIONS = Object.freeze({
  false_negatives: [
    'Stealth headless browsers or click-farms that spoof standard Chrome/Safari User-Agent strings cannot be guaranteed 0% with UA-only classification.',
    'Server-side or proxied fetches that replay a real browser User-Agent are classified as human unless corroborated by future behavioral signals.',
  ],
  false_positives: [
    'Niche corporate proxies or embedded webviews that strip the User-Agent header completely are classified as empty_ua bots.',
    'Custom internal clients whose User-Agent contains generic tokens such as "bot" or "crawler" are classified as search_crawler.',
  ],
  unfilterable_measurements: Object.freeze([
    Object.freeze({
      measurement: 'essential_consent_clicks',
      reason: 'Essential-only consent mode does not store User-Agent or ip_hash (browser uses REDIRECT_CONSENT_MARKER, is_bot=0), so bot filtering cannot exclude bots within essential-consent clicks.',
    }),
    Object.freeze({
      measurement: 'qr_scans',
      reason: 'QR scan counters (qr_codes.scans / qr_scan_daily.scans) are incremented independently of raw click bot classification.',
    }),
    Object.freeze({
      measurement: 'daily_rollup_uniques_and_conversions',
      reason: 'link_stats_daily.uniques and link_stats_daily.conversions aggregate all traffic; bots=exclude therefore queries raw clicks and attributed conversions directly.',
    }),
  ]),
});

function classifyUserAgent(userAgentRaw) {
  const ua = (userAgentRaw || '').toString().slice(0, 512).trim();
  if (!ua) {
    return {
      is_bot: true,
      category: 'empty_ua',
      rule: 'empty_user_agent',
      confidence: 'high',
      reason: 'Missing or blank User-Agent header',
    };
  }

  for (const group of BOT_RULE_GROUPS) {
    const match = ua.match(group.pattern);
    if (match) {
      return {
        is_bot: true,
        category: group.category,
        rule: match[0].toLowerCase(),
        confidence: group.confidence,
        reason: group.description,
      };
    }
  }

  return {
    is_bot: false,
    category: 'human',
    rule: null,
    confidence: 'estimated',
    reason: 'No known bot or automation signature matched',
  };
}

function isBotUserAgent(userAgentRaw) {
  return classifyUserAgent(userAgentRaw).is_bot;
}

function getBotClassifierSpec() {
  return {
    version: BOT_CLASSIFIER_VERSION,
    mode: 'user_agent_heuristic',
    categories: ['empty_ua', ...BOT_RULE_GROUPS.map((g) => g.category), 'human'],
    rules: BOT_RULE_GROUPS.map((g) => ({
      category: g.category,
      confidence: g.confidence,
      description: g.description,
    })),
    limitations: BOT_CLASSIFICATION_LIMITATIONS,
  };
}

module.exports = {
  BOT_CLASSIFIER_VERSION,
  BOT_RULE_GROUPS,
  BOT_CLASSIFICATION_LIMITATIONS,
  classifyUserAgent,
  isBotUserAgent,
  getBotClassifierSpec,
};
