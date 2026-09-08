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

test('bots/shared createShortLink blocks reserved system aliases', async () => {
  const { createBotShared } = require('../bots/shared');
  const mockDb = {
    get: (_sql, _params, cb) => cb(null, null),
    run: (_sql, _params, cb) => cb(null)
  };
  const shared = createBotShared(mockDb, {
    isReservedShortAlias: (alias) => ['login', 'admin', 'pricing', 'api', 'terms'].includes(alias),
    generateSafeShortCode: () => 'rnd123'
  });

  const resReserved = await shared.createShortLink(null, 'https://google.com', 'admin');
  assert.deepEqual(resReserved, { error: 'alias_taken' });

  const resAllowed = await shared.createShortLink(null, 'https://google.com', 'myblog123');
  assert.ok(resAllowed.short);
  assert.equal(resAllowed.short, 'myblog123');
});

test('pending-actions recovers safely from malformed state and caps entries at 200', () => {
  const pendingActions = require('../src/marketing_bots/pending-actions');
  const filePath = path.join(__dirname, '../bot_data/pending_actions.json');
  const backup = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;

  try {
    // 1. Simulate corrupted/empty structure
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ hn: null, mail: null }), 'utf8');

    // Should not throw
    assert.equal(pendingActions.getPendingHn('nonexistent'), null);
    assert.equal(pendingActions.getPendingMail('nonexistent'), null);

    // 2. Sliding window pruning to 200 items
    for (let i = 0; i < 220; i++) {
      pendingActions.storePendingHn(`post_${i}`, { title: `Test ${i}` });
    }

    const fileContent = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const hnKeys = Object.keys(fileContent.hn || {});
    assert.ok(hnKeys.length <= 200, `Expected <= 200 keys, found ${hnKeys.length}`);
    assert.ok(!hnKeys.includes('post_0'), 'Oldest item post_0 should have been pruned');
    assert.ok(hnKeys.includes('post_219'), 'Latest item post_219 should be present');
  } finally {
    if (backup) {
      fs.writeFileSync(filePath, backup, 'utf8');
    }
  }
});

test('public/lang.js updates_release_20260908_pwa translation keys exist across az, tr, and en', () => {
  const { translations } = require('../public/lang');
  const requiredKeys = [
    'updates_release_20260908_pwa_title',
    'updates_release_20260908_pwa_badge',
    'updates_release_20260908_pwa_desc',
    'updates_release_20260908_pwa_item1',
    'updates_release_20260908_pwa_item2'
  ];

  for (const lang of ['az', 'tr', 'en']) {
    assert.ok(translations[lang], `Language pack ${lang} must exist`);
    for (const key of requiredKeys) {
      assert.ok(translations[lang][key], `Key "${key}" must exist and not be empty in ${lang}`);
      assert.equal(typeof translations[lang][key], 'string');
      assert.ok(translations[lang][key].trim().length > 0);
    }
  }
});

test('bots/shared createShortLink retries on unique collision for random codes', async () => {
  const { createBotShared } = require('../bots/shared');
  let runCount = 0;
  const mockDb = {
    get: (_sql, _params, cb) => cb(null, null),
    run: (_sql, params, cb) => {
      runCount++;
      // Fail first attempt with UNIQUE constraint
      if (runCount === 1) {
        return cb(new Error('UNIQUE constraint failed: urls.short'));
      }
      // Succeed on second attempt
      cb(null);
    }
  };

  let codeCount = 0;
  const shared = createBotShared(mockDb, {
    generateSafeShortCode: () => `code_${++codeCount}`,
    isReservedShortAlias: () => false
  });

  const res = await shared.createShortLink(null, 'https://example.com');
  assert.ok(res);
  assert.ok(!res.error);
  assert.equal(res.short, 'code_2');
  assert.equal(runCount, 2);
});

test('telegram-notifier falls back to plain text when Telegram returns parse error', async () => {
  const { sendTelegramAlert } = require('../src/marketing_bots/telegram-notifier');

  const origFetch = global.fetch;
  const origToken = process.env.TELEGRAM_BOT_TOKEN;
  const origChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;

  process.env.TELEGRAM_BOT_TOKEN = 'mock_token_123';
  process.env.TELEGRAM_ADMIN_CHAT_ID = 'mock_chat_123';

  const calls = [];
  global.fetch = async (url, opts) => {
    const payload = JSON.parse(opts.body);
    calls.push(payload);
    if (payload.parse_mode === 'HTML') {
      return {
        ok: true,
        json: async () => ({
          ok: false,
          error_code: 400,
          description: "Bad Request: can't parse entities: Unclosed <blockquote> tag"
        })
      };
    }
    return {
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 12345 } })
    };
  };

  try {
    const alertSent = await sendTelegramAlert('<blockquote>Unclosed tag test');
    assert.strictEqual(alertSent, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].parse_mode, 'HTML');
    assert.equal(calls[1].parse_mode, undefined);
    assert.equal(calls[1].text, 'Unclosed tag test');
  } finally {
    global.fetch = origFetch;
    process.env.TELEGRAM_BOT_TOKEN = origToken;
    process.env.TELEGRAM_ADMIN_CHAT_ID = origChatId;
  }
});

test('appendSentMailToImap escapes folder quotes, completes TLS handshake, and aborts immediately on error', async () => {
  const { appendSentMailToImap } = require('../src/lib/email');
  const tls = require('tls');
  const EventEmitter = require('events');

  // 1. Missing credentials returns false
  const origUser = process.env.SMTP_USER;
  const origPass = process.env.SMTP_PASS;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;

  const noCreds = await appendSentMailToImap({ to: 'test@example.com', subject: 'Hi', text: 'Hello' });
  assert.strictEqual(noCreds, false);

  process.env.SMTP_USER = 'test@spacemail.com';
  process.env.SMTP_PASS = 'secret123';
  process.env.IMAP_SENT_FOLDER = 'Sent "Quotes" & Special';

  const origConnect = tls.connect;
  const socketWrites = [];

  class MockSocket extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
    }
    setEncoding() {}
    write(data) {
      socketWrites.push(data.toString());
      if (data.toString().includes('A01 LOGIN')) {
        process.nextTick(() => this.emit('data', 'A01 OK LOGIN completed\r\n'));
      } else if (data.toString().includes('A02 APPEND')) {
        process.nextTick(() => this.emit('data', '+ Ready for literal data\r\n'));
      } else if (data.toString().includes('From:')) {
        process.nextTick(() => this.emit('data', 'A02 OK APPEND completed [APPENDUID 1 23]\r\n'));
      }
    }
    end() {
      this.destroyed = true;
      process.nextTick(() => this.emit('close'));
    }
    destroy() {
      this.destroyed = true;
      process.nextTick(() => this.emit('close'));
    }
  }

  // 2. Successful append with escaped folder name
  tls.connect = (port, host, options, cb) => {
    const sock = new MockSocket();
    process.nextTick(() => {
      sock.emit('data', '* OK [CAPABILITY IMAP4rev1] SpaceMail Ready\r\n');
    });
    return sock;
  };

  try {
    const success = await appendSentMailToImap({
      from: 'test@spacemail.com',
      to: 'target@example.com',
      subject: 'Test Subject',
      text: 'Test Body'
    });
    assert.strictEqual(success, true);
    // Verify folder was escaped: Sent \"Quotes\" & Special
    const appendCmd = socketWrites.find(w => w.startsWith('A02 APPEND'));
    assert.ok(appendCmd, 'A02 APPEND command must be written');
    assert.ok(appendCmd.includes('"Sent \\"Quotes\\" & Special"'), `Expected escaped folder, got: ${appendCmd}`);

    // 3. Fast abort on * NO or * BYE without waiting for timeout
    socketWrites.length = 0;
    tls.connect = (port, host, options, cb) => {
      const sock = new MockSocket();
      process.nextTick(() => {
        sock.emit('data', '* BYE Server connection rejected\r\n');
      });
      return sock;
    };

    const startTime = Date.now();
    const failRes = await appendSentMailToImap({
      from: 'test@spacemail.com',
      to: 'target@example.com',
      subject: 'Test Subject',
      text: 'Test Body'
    });
    const elapsed = Date.now() - startTime;
    assert.strictEqual(failRes, false);
    assert.ok(elapsed < 2000, `Must abort fast on BYE, took ${elapsed}ms`);
  } finally {
    tls.connect = origConnect;
    if (origUser) process.env.SMTP_USER = origUser; else delete process.env.SMTP_USER;
    if (origPass) process.env.SMTP_PASS = origPass; else delete process.env.SMTP_PASS;
    delete process.env.IMAP_SENT_FOLDER;
  }
});


