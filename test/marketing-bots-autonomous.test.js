process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'b66f58f96f4a4f6090de997ca71b72910d9695f95f24ddf9b255f4cbebf9804cff9e1b9d79f60df7e840a9136dbf126fd1f6f4f94b1f8cfbd93afbfccf8d4f8a';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('fs');

const {
  storePendingHn,
  storePendingMail,
  getPendingHn,
  getPendingMail,
  skipAction
} = require('../src/marketing_bots/pending-actions');

const socialListener = require('../src/marketing_bots/social-listener');
const b2bHunter = require('../src/marketing_bots/b2b-email-hunter');
const { extractHmac } = require('../src/marketing_bots/hn-client');

const originalFetch = global.fetch;

test.before(() => {
  global.fetch = async (url, opts) => {
    const urlStr = String(url);
    if (urlStr.includes('opencode') || urlStr.includes('chat/completions')) {
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  is_suitable: true,
                  score: 8,
                  reason: 'Bağlantı yönetimi ve analitik ihtiyacı açıkça belirtilmiş.'
                })
              }
            }
          ]
        })
      };
    }
    return originalFetch(url, opts);
  };
});

test.after(() => {
  global.fetch = originalFetch;
});

test('pending-actions store stores, retrieves, and updates pending actions', () => {
  const testPostId = 'test_post_' + Date.now();
  storePendingHn(testPostId, {
    title: 'Show HN: Fast URL Shortener',
    author: 'indie_dev',
    context: 'Looking for a clean bitly alternative',
    url: `https://news.ycombinator.com/item?id=${testPostId}`,
    commentText: 'Full disclosure: I built Ovlink...',
    suitabilityScore: 9,
    suitabilityReason: 'Bitly alternative requested.'
  });

  const storedHn = getPendingHn(testPostId);
  assert.ok(storedHn, 'Pending HN action should be stored');
  assert.equal(storedHn.author, 'indie_dev');
  assert.equal(storedHn.status, 'pending');
  assert.equal(storedHn.suitabilityScore, 9);

  skipAction('hn', testPostId);
  const skippedHn = getPendingHn(testPostId);
  assert.equal(skippedHn.status, 'skipped');

  const testLeadId = 'test_lead_' + Date.now();
  storePendingMail(testLeadId, {
    to: 'growth@example.com',
    name: 'Jane Doe',
    role: 'Head of Growth',
    company: 'SaaS Metrics',
    niche: 'B2B SaaS',
    context: 'Managing affiliate links and marketing campaigns',
    subject: 'Link attribution at SaaS Metrics',
    body: 'Hi Jane, noticed SaaS Metrics is scaling campaigns...',
    suitabilityScore: 8,
    suitabilityReason: 'High growth SaaS marketing lead'
  });

  const storedMail = getPendingMail(testLeadId);
  assert.ok(storedMail, 'Pending Mail action should be stored');
  assert.equal(storedMail.name, 'Jane Doe');
  assert.equal(storedMail.status, 'pending');

  skipAction('mail', testLeadId);
  const skippedMail = getPendingMail(testLeadId);
  assert.equal(skippedMail.status, 'skipped');
});

test('social-listener negative disqualifiers reject DNS and irrelevant link posts', async () => {
  const dnsPost = {
    id: 11111,
    title: 'BIND 9.18 Release Notes and Deep DNS Architecture',
    context: 'Looking into deep bind and recursive DNS resolvers and links between servers.',
    author: 'sysadmin',
    platform: 'Hacker News'
  };

  const suitabilityDns = await socialListener.analyzeSuitability(dnsPost);
  assert.equal(suitabilityDns.isSuitable, false, 'DNS server posts must be disqualified');
  assert.ok(suitabilityDns.score <= 3);

  const markdownPost = {
    id: 22222,
    title: 'Fixing Markdown Deep Links in Obsidian',
    context: 'How do you create deep link anchors inside local markdown files?',
    author: 'writer',
    platform: 'Hacker News'
  };

  const suitabilityMd = await socialListener.analyzeSuitability(markdownPost);
  assert.equal(suitabilityMd.isSuitable, false, 'Markdown internal deep link posts must be disqualified');
});

test('social-listener recognizes high-intent URL shortener and Bitly discussions', async () => {
  const bitlyPost = {
    id: 33333,
    title: 'Ask HN: What is the best Bitly alternative for custom domains and analytics?',
    context: 'Bitly changed their pricing again and we need a lightweight alternative with clean links and clicks.',
    author: 'founder123',
    platform: 'Hacker News'
  };

  const suitability = await socialListener.analyzeSuitability(bitlyPost);
  assert.equal(suitability.isSuitable, true, 'Bitly alternative post should be suitable');
  assert.ok(suitability.score >= 6, 'Score must be at least 6/10');
});

test('b2b-email-hunter suitability evaluation validates lead relevance', async () => {
  const invalidLead = {
    id: 'lead_inv',
    name: '',
    email: '',
    role: 'Unknown',
    company: 'Ghost Corp',
    niche: 'None'
  };
  const invalidResult = await b2bHunter.analyzeLeadSuitability(invalidLead);
  assert.equal(invalidResult.isSuitable, false, 'Lead without email/company must not be suitable');

  const validLead = {
    id: 'lead_val',
    name: 'Sarah Connor',
    email: 'sarah@growthtech.io',
    role: 'Growth Marketing Manager',
    company: 'GrowthTech',
    niche: 'Digital Marketing & Attribution',
    context: 'Runs multiple paid ad campaigns with UTM tracking'
  };
  const validResult = await b2bHunter.analyzeLeadSuitability(validLead);
  assert.equal(validResult.isSuitable, true, 'Growth marketer lead must be suitable');
  assert.ok(validResult.score >= 6);
});

test('hn-client extractHmac correctly extracts HMAC token from HTML form', () => {
  const html = `
    <form method="post" action="comment">
      <input type="hidden" name="parent" value="43210">
      <input type="hidden" name="goto" value="item?id=43210">
      <input type="hidden" name="hmac" value="a1b2c3d4e5f67890abcdef1234567890abcdef12">
      <textarea name="text"></textarea>
      <input type="submit" value="add comment">
    </form>
  `;

  const hmac = extractHmac(html);
  assert.equal(hmac, 'a1b2c3d4e5f67890abcdef1234567890abcdef12');
});

test('b2b-email-hunter.generateEmail cleanly strips thinking and returns valid subject and body', async () => {
  const customLead = {
    id: 'lead_test_ai',
    name: 'David Kim',
    role: 'Director of Operations',
    company: 'TechBrief Daily',
    niche: 'Tech Newsletter',
    context: 'Managing sponsor links and click attribution'
  };

  const originalFetchLocal = global.fetch;
  global.fetch = async (url, opts) => {
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: `The user wants me to write a cold email to David Kim.
Constraints:
1. Polite
2. NO EMOJIS
Let me craft this carefully.

Subject: Click analytics for sponsor links

Body:
Hi David, I noticed TechBrief Daily manages sponsor links at scale. I built Ovlink as an independent platform that handles custom domains and click analytics without bloat. If this aligns with your roadmap, glad to chat. If not, no worries at all.

That's 3 sentences. Let me check:
- Sentence 1: OK
Wait, that last one is technically two sentences joined by period.`
            }
          }
        ]
      })
    };
  };

  try {
    const emailData = await b2bHunter.generateEmail(customLead);
    assert.ok(emailData);
    assert.equal(emailData.subject, 'Click analytics for sponsor links');
    assert.ok(!emailData.body.includes('The user wants me to write'));
    assert.ok(!emailData.body.includes('Constraints:'));
    assert.ok(!emailData.body.includes("That's 3 sentences"));
    assert.ok(emailData.body.includes('Hi David, I noticed TechBrief Daily'));
    assert.ok(emailData.body.includes('Ovlink Link Infrastructure | https://ovlink.sbs'));
  } finally {
    global.fetch = originalFetchLocal;
  }
});

test('social-listener.generateReply rejects pure thinking and falls back safely', async () => {
  const post = {
    id: 'hn_test_ai',
    title: 'Ask HN: Better URL shortener with analytics',
    context: 'Looking for a clean bitly alternative with custom domains'
  };

  const originalFetchLocal = global.fetch;
  global.fetch = async (url, opts) => {
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: `Here's a thinking process: - **Role:** Software engineer - **Context:** Hacker News - **Ground Rules:** Zero emojis - **Output:** Comment text only -`
            }
          }
        ]
      })
    };
  };

  try {
    const reply = await socialListener.generateReply(post);
    assert.ok(reply);
    // Must NOT contain the thinking process!
    assert.ok(!reply.includes("Here's a thinking process"));
    assert.ok(!reply.includes('**Role:**'));
    assert.ok(reply.startsWith('Full disclosure: I built Ovlink'));
  } finally {
    global.fetch = originalFetchLocal;
  }
});

