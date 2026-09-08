const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decodeHtmlEntities,
  cleanHtmlSnippet,
  escapeTelegramHtml,
  sanitizeAIEmail,
  sanitizeAISocialReply
} = require('../src/marketing_bots/ai-sanitizer');

test('decodeHtmlEntities decodes hex, dec and named entities cleanly', () => {
  // Test Image 1 cases
  const sample1 = 'https:&#x2F;&#x2F;perma.cc&#x2F;';
  assert.equal(decodeHtmlEntities(sample1), 'https://perma.cc/');

  const sample2 = 'what&#x27;s there';
  assert.equal(decodeHtmlEntities(sample2), "what's there");

  const sample3 = '&gt; You give &quot;perma.cc&#x2F;';
  assert.equal(decodeHtmlEntities(sample3), '> You give "perma.cc/');

  // Double encoded entities
  const doubleEncoded = '&amp;#x27; and &amp;quot;';
  assert.equal(decodeHtmlEntities(doubleEncoded), "' and \"");

  // Astral plane unicode entities (emojis > 0xFFFF)
  const astralDecimal = 'Launch &#128640; Grin &#128512;';
  assert.equal(decodeHtmlEntities(astralDecimal), 'Launch 🚀 Grin 😀');

  const astralHex = 'Rocket &#x1F680; Smile &#x1F600;';
  assert.equal(decodeHtmlEntities(astralHex), 'Rocket 🚀 Smile 😀');
});

test('cleanHtmlSnippet strips tags, decodes entities, and trims at word boundary', () => {
  const raw = '<p>If you&#x27;ve ever had to share a huge, confusing link on WhatsApp, Instagram, or email, you&#x27;ve probably realized it&#x27;s not practical at all. That&#x27;s where link shorteners come in&mdash;tools that transform long URLs into short versions that are easy to remember and click.</p>';
  const cleaned = cleanHtmlSnippet(raw, 120);

  assert.ok(!cleaned.includes('&#x27;'));
  assert.ok(!cleaned.includes('&mdash;'));
  assert.ok(!cleaned.includes('<p>'));
  assert.ok(cleaned.endsWith('...'));
  // Ensure not cut mid-word
  assert.ok(!cleaned.endsWith('th...'));
});

test('sanitizeAIEmail strips reasoning preamble, constraints, and post-checks from Image 2', () => {
  const rawImage2Output = `The user wants me to write a cold email to David Kim, Director of Operations at TechBrief Daily, a tech newsletter with 120k subscribers. They need click analytics and sponsor link redirection without link breakdown.

Constraints:
1. Polite, respectful, transparent, humble
2. NO EMOJIS
3. Max 3-4 sentences
4. Authentic American English
5. Address their specific workflow (link/attribution)
6. Introduce Ovlink as independent, lightweight platform for custom domains and click analytics
7. End with zero-pressure invitation
8. Format: Subject line (3-5 words, no emojis) then email body

Let me craft this carefully.

Subject: Click analytics for sponsor links

Body:
Hi David, I noticed TechBrief Daily manages sponsor links at scale and thought you might be evaluating cleaner attribution tools. I built Ovlink as an independent, lightweight platform that handles custom domains and click analytics without breaking redirects or adding bloat. If this aligns with your roadmap, I would be glad to answer any questions. If not, no worries at all.

That's 3 sentences. Let me check:
- Sentence 1: "I noticed TechBrief Daily manages sponsor links at scale and thought you might be evaluating cleaner attribution tools."
- Sentence 2: "I built Ovlink as an independent, lightweight platform that handles custom domains and click analytics without breaking redirects or adding bloat."
- Sentence 3: "If this aligns with your roadmap, I would be glad to answer any questions. If not, no worries at all."

Wait, that last one is technically two sentences joined by period.

---
Ovlink Link Infrastructure | https://ovlink.sbs
To opt out of future updates, reply with "unsubscribe" or "stop".`;

  const result = sanitizeAIEmail(rawImage2Output, { company: 'TechBrief Daily' });
  assert.ok(result, 'Result must not be null');
  assert.equal(result.subject, 'Click analytics for sponsor links');

  // Verify that preamble and post-checks are 100% eliminated
  assert.ok(!result.body.includes('The user wants me to write'));
  assert.ok(!result.body.includes('Constraints:'));
  assert.ok(!result.body.includes('Let me craft this carefully'));
  assert.ok(!result.body.includes("That's 3 sentences"));
  assert.ok(!result.body.includes('Let me check:'));
  assert.ok(!result.body.includes('Sentence 1:'));
  assert.ok(!result.body.includes('Wait, that last one'));

  // Verify that actual email body is preserved intact
  assert.ok(result.body.includes('Hi David, I noticed TechBrief Daily'));
  assert.ok(result.body.includes('If not, no worries at all.'));
  assert.ok(result.body.includes('Ovlink Link Infrastructure | https://ovlink.sbs'));
});

test('sanitizeAISocialReply rejects pure thinking output from Image 3', () => {
  const rawImage3Output = `Here's a thinking process: - **Role:** Software engineer and indie founder who built Ovlink (https://ovlink.sbs) - **Context:** Hacker News discussion about URL shorteners/link management - **Post/Comment Content:** A snippet about link shorteners being practical for sharing long URLs on WhatsApp, Instagram, email, etc., mentioning 2025 options and features. - **Ground Rules:** - Complete honesty & transparency: Must state I built Ovlink - Strictly zero emojis - Natural, humble, peer-to-peer American English, 2-3 sentences max - No spam, no hard selling, no exaggerated claims - Genuinely address their technical points/problem - Offer Ovlink as lightweight, honest option with clean custom domains, fast redirects, privacy-respecting analytics without enterprise price bloat - **Output:** Comment text only -`;

  const result = sanitizeAISocialReply(rawImage3Output);
  // Must return null because there is no actual reply, only prompt echo and scratchpad!
  assert.equal(result, null, 'Pure thinking output must be rejected as defective');
});

test('sanitizeAISocialReply extracts clean comment when thinking process precedes output', () => {
  const outputWithThinking = `Here's a thinking process:
- Check constraints
- Craft reply

Comment:
Full disclosure: I built Ovlink (https://ovlink.sbs). If you need clean link tracking and custom domains without enterprise pricing tiers, it offers fast redirects and instant analytics.

That's 2 sentences. Let me check:
- Sentence 1: OK`;

  const result = sanitizeAISocialReply(outputWithThinking);
  assert.ok(result);
  assert.ok(result.startsWith('Full disclosure: I built Ovlink'));
  assert.ok(result.includes('instant analytics.'));
  assert.ok(!result.includes("Here's a thinking process"));
  assert.ok(!result.includes("That's 2 sentences"));
  assert.ok(!result.includes('Comment:'));
});

test('sanitizeAIEmail correctly preserves international recipient names in greeting', () => {
  const aiOutput = `Subject: Ovlink analytics for tech team
Body:
Hi Özgür, I noticed your team is managing affiliate campaigns across multiple regions. Ovlink provides lightweight link analytics with custom domains. Let me know if you would like a brief walkthrough.

---
Ovlink Link Infrastructure | https://ovlink.sbs
To opt out of future updates, reply with "unsubscribe" or "stop".`;

  const result = sanitizeAIEmail(aiOutput, { company: 'GlobalTech' });
  assert.ok(result);
  assert.equal(result.subject, 'Ovlink analytics for tech team');
  assert.ok(result.body.includes('Hi Özgür, I noticed your team'));
});

test('sanitizeAISocialReply allows comments up to 1500 chars', () => {
  const longComment = `Full disclosure: I built Ovlink (https://ovlink.sbs). ` + 'A'.repeat(1200);
  const result = sanitizeAISocialReply(longComment);
  assert.ok(result);
  assert.equal(result.length, longComment.length);

  const tooLongComment = `Full disclosure: I built Ovlink (https://ovlink.sbs). ` + 'B'.repeat(1600);
  const rejected = sanitizeAISocialReply(tooLongComment);
  assert.equal(rejected, null, 'Comments exceeding 1500 chars must be rejected');
});

test('sanitizeAIEmail strips Note: and Notes: post-checks and rejects sentence counter leaks', () => {
  const emailWithNote = `Subject: Ovlink infrastructure
Body:
Hi Alex, I saw your recent discussion on multi-tenant link branding. Ovlink provides vanity domain routing and analytics without enterprise pricing overhead. Let me know if you would like to test our API integration.

Note: I kept the response focused on developer tooling without marketing buzzwords.`;

  const cleanEmail = sanitizeAIEmail(emailWithNote, { company: 'AlexCorp' });
  assert.ok(cleanEmail);
  assert.ok(!cleanEmail.body.includes('Note:'));
  assert.ok(!cleanEmail.body.includes('marketing buzzwords'));

  // Defective email with sentence check leak that survived at root
  const emailWithSentenceLeak = `Subject: Ovlink infrastructure
Body:
Hi Alex, I saw your recent discussion on multi-tenant link branding. Ovlink provides vanity domain routing and analytics without enterprise pricing overhead.
That's 2 sentences. Let me check:
- Sentence 1: OK`;
  const sanitized = sanitizeAIEmail(emailWithSentenceLeak, { company: 'AlexCorp' });
  assert.ok(sanitized);
  assert.ok(!sanitized.body.includes("That's 2 sentences"));
  assert.ok(!sanitized.body.includes("Let me check"));
});

