/**
 * AI Output Sanitizer & HTML Entity Decoder
 * Ensures that Telegram alerts, cold emails, and social media comments:
 * 1. Have all HTML entities (&#x2F;, &#x27;, &gt;, &quot;, &amp;, etc.) properly decoded into clean text.
 * 2. Strip ALL AI chain-of-thought, reasoning, prompt echoes, constraints, preambles, and post-checks.
 * 3. Never truncate sentences in the middle of words.
 */

/**
 * Decodes HTML entities commonly found in Hacker News and web feeds.
 * Supports hex (&#x2F;), dec (&#47;), and named entities (&quot;, &amp;, &lt;, &gt;, etc.).
 */
function decodeHtmlEntities(text) {
  if (!text || typeof text !== 'string') return '';
  let str = text;

  // Run up to 2 passes to resolve double-encoded entities like &amp;#x27; -> &#x27; -> '
  for (let i = 0; i < 2; i++) {
    const prev = str;
    str = str
      .replace(/&#(\d+);?/g, (_, dec) => {
        try {
          const code = parseInt(dec, 10);
          return code > 0 && code < 65536 ? String.fromCharCode(code) : '';
        } catch {
          return '';
        }
      })
      .replace(/&#x([0-9a-fA-F]+);?/gi, (_, hex) => {
        try {
          const code = parseInt(hex, 16);
          return code > 0 && code < 65536 ? String.fromCharCode(code) : '';
        } catch {
          return '';
        }
      })
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'")
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/gi, "'")
      .replace(/&#x2F;/gi, '/')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&mdash;/gi, '—')
      .replace(/&ndash;/gi, '–')
      .replace(/&hellip;/gi, '…')
      .replace(/&laquo;/gi, '«')
      .replace(/&raquo;/gi, '»')
      .replace(/&copy;/gi, '©')
      .replace(/&reg;/gi, '®')
      .replace(/&amp;/gi, '&');

    if (str === prev) break;
  }

  return str;
}

/**
 * Strips HTML tags, decodes entities, and cleans whitespace.
 * Truncates neatly at word boundaries if maxLen is set.
 */
function cleanHtmlSnippet(rawHtml, maxLen = 0) {
  if (!rawHtml || typeof rawHtml !== 'string') return '';

  // Replace <br> and <p> with spaces to avoid smashing words together
  let text = rawHtml
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');

  // Decode entities
  text = decodeHtmlEntities(text);

  // Normalize spaces
  text = text.replace(/\s+/g, ' ').trim();

  if (maxLen > 0 && text.length > maxLen) {
    const slice = text.slice(0, maxLen);
    const lastSpace = slice.lastIndexOf(' ');
    const boundary = lastSpace > maxLen * 0.7 ? lastSpace : maxLen;
    return slice.slice(0, boundary).trim() + '...';
  }

  return text;
}

/**
 * Escapes characters for Telegram HTML parse mode (<b>, <i>, <blockquote>, etc.)
 */
function escapeTelegramHtml(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Cleans emojis from text.
 */
function stripEmojis(text) {
  if (!text || typeof text !== 'string') return '';
  return text.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F7FF}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '');
}

/**
 * Extracts and sanitizes B2B cold email output from AI models.
 * Strips chain-of-thought, prompt restatements, constraints, and post-generation self-checks.
 * Returns { subject, body } or null if output is unusable.
 */
function sanitizeAIEmail(rawText, lead = {}) {
  if (!rawText || typeof rawText !== 'string') return null;

  let text = rawText.trim();

  // 1. Remove <think>...</think> blocks and orphan <think> tags
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  text = text.replace(/<think>[\s\S]*/gi, '');
  text = text.replace(/[\s\S]*?<\/think>/gi, '');

  // 2. Extract Subject if present anywhere
  let subject = '';
  let body = '';

  const subjectMatch = text.match(/(?:^|\n)\s*(?:(?:\*\*|##|#)?\s*Subject\s*(?:\*\*)?:\s*|\*\*Subject:\*\*\s*)([^\n\r]+)/i);
  if (subjectMatch) {
    subject = subjectMatch[1]
      .replace(/^[\["'\s*]+|[\]"'\s*]+$/g, '')
      .replace(/\*\*/g, '')
      .trim();

    // Body is everything after the subject line
    const subjectIndex = subjectMatch.index + subjectMatch[0].length;
    body = text.slice(subjectIndex).trim();
  } else {
    // Fallback subject
    subject = `Link infrastructure and campaign tracking at ${lead.company || 'your company'}`;

    // Check if body starts with a greeting like "Hi Name," or "Dear Name,"
    const greetingMatch = text.match(/(?:^|\n)\s*(Hi\s+[A-Za-z]+|Hello\s+[A-Za-z]+|Dear\s+[A-Za-z]+|Hey\s+[A-Za-z]+)[\s\S]*/i);
    if (greetingMatch) {
      body = text.slice(greetingMatch.index).trim();
    } else {
      body = text.trim();
    }
  }

  // 3. Strip leading "Body:", "**Body:**", "Email Body:" or "---" if model wrote it
  body = body.replace(/^(?:\*\*|##|#)?\s*(?:Email\s+)?Body\s*(?:\*\*)?:\s*/i, '');
  body = body.replace(/^[-\s=]{3,}\n+/i, '');

  // 4. Strip post-generation self-checks, reflections, and sentence counters
  // e.g.: "That's 3 sentences. Let me check: - Sentence 1: ... Wait, that last one..."
  const postCheckPatterns = [
    /(?:\r?\n)+\s*(?:That's \d+ sentence|That is \d+ sentence|Let me check:?|Sentence \d+:|Wait, that last one|Word count:|Hope this helps!?|Here's the breakdown:?|Rationale:?|Explanation:?|Self-evaluation:?|Analysis:?|Notes:?)(?:[\s\S]*)$/i,
    /(?:\r?\n)+\s*(?:- Sentence \d+:|1\. Sentence \d+:)(?:[\s\S]*)$/i,
    /(?:\r?\n)+\s*Wait, (?:that|the) last (?:one|sentence)(?:[\s\S]*)$/i
  ];

  for (const pattern of postCheckPatterns) {
    body = body.replace(pattern, '');
  }

  // 5. Strip any prompt echo at the top if it still managed to survive
  body = body.replace(/^(?:The user wants me to|Here's a thinking process|Let me craft|Constraints:)[\s\S]*?(?=(?:Hi|Hello|Dear|Hey)\s+[A-Za-z]+)/i, '');

  // 6. Strip any duplicate compliance footers already generated by the model
  body = body.replace(/(?:\r?\n)+---\s*(?:\r?\n)+Ovlink Link Infrastructure[\s\S]*$/i, '');
  body = body.replace(/(?:\r?\n)+To opt out of future updates[\s\S]*$/i, '');

  // 7. Strip emojis
  subject = stripEmojis(subject).trim();
  body = stripEmojis(body).trim();

  // 8. Quality & Defect Checks
  const forbiddenKeywords = [
    "The user wants me to",
    "Constraints:",
    "Let me craft this",
    "Here's a thinking process",
    "Thinking Process:",
    "That's 3 sentences",
    "Sentence 1:",
    "Wait, that last one"
  ];

  for (const kw of forbiddenKeywords) {
    if (body.includes(kw) || subject.includes(kw)) {
      return null; // Defective AI response, reject
    }
  }

  // Must have reasonable length (at least 15 words)
  const wordCount = body.split(/\s+/).filter(Boolean).length;
  if (wordCount < 15) {
    return null; // Too short or empty
  }

  // Append official standard compliance footer
  const complianceFooter = `\n\n---\nOvlink Link Infrastructure | https://ovlink.sbs\nTo opt out of future updates, reply with "unsubscribe" or "stop".`;
  body = body + complianceFooter;

  return { subject, body };
}

/**
 * Extracts and sanitizes Hacker News social reply from AI models.
 * Strips chain-of-thought, bullet points of rules, persona reflections, and self-checks.
 * Returns clean comment text or null if output is unusable.
 */
function sanitizeAISocialReply(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;

  let text = rawText.trim();

  // 1. Remove <think>...</think>
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  text = text.replace(/<think>[\s\S]*/gi, '');
  text = text.replace(/[\s\S]*?<\/think>/gi, '');

  // 2. Check for explicit Comment / Reply / Output delimiter
  const delimiterMatch = text.match(/(?:^|\n)\s*(?:(?:\*\*|##|#)?\s*(?:Comment|Response|Reply|Final Answer|Output)\s*(?:\*\*)?:\s*)([^\n][\s\S]*)/i);
  if (delimiterMatch) {
    text = delimiterMatch[1].trim();
  } else {
    // Check if it contains "Full disclosure:" or "Disclosure:" or "I built Ovlink"
    const disclosureMatch = text.match(/(?:^|\n)\s*(Full disclosure:[\s\S]*|Disclosure:[\s\S]*|I built Ovlink[\s\S]*|We built Ovlink[\s\S]*)/i);
    if (disclosureMatch) {
      text = disclosureMatch[1].trim();
    } else {
      // Filter out scratchpad/thinking lines
      const lines = text.split('\n');
      const cleanLines = lines.filter(l => {
        const trimmed = l.trim();
        if (!trimmed) return false;
        if (trimmed.startsWith("Here's a thinking process")) return false;
        if (/^[-*•]?\s*\*\*(?:Role|Context|Ground Rules|Post\/Comment Content|Output|Instructions):\*\*/i.test(trimmed)) return false;
        if (/^(?:1\.|2\.|3\.|4\.|5\.|Constraints:)/i.test(trimmed)) return false;
        if (/^(?:Let me craft|The user wants me to|Let me check)/i.test(trimmed)) return false;
        return true;
      });
      text = cleanLines.join(' ').trim();
    }
  }

  // 3. Cut off post-checks at the end
  const postCheckPatterns = [
    /(?:\r?\n)+\s*(?:That's \d+ sentence|Let me check:?|Sentence \d+:|Wait, that last one|Word count:|Hope this helps!?|Note:?)(?:[\s\S]*)$/i
  ];
  for (const pattern of postCheckPatterns) {
    text = text.replace(pattern, '');
  }

  // 4. Strip emojis & quotes surrounding the entire text
  text = stripEmojis(text).trim();
  text = text.replace(/^["']+|["']+$/g, '').trim();

  // 5. Strict Defect Validation
  const forbiddenKeywords = [
    "Here's a thinking process",
    "**Role:**",
    "**Context:**",
    "**Ground Rules:**",
    "**Post/Comment Content:**",
    "Constraints:",
    "The user wants me to",
    "Output: Comment text only",
    "Let me craft",
    "Wait, that last one"
  ];

  for (const kw of forbiddenKeywords) {
    if (text.includes(kw)) {
      return null; // Defective output, reject
    }
  }

  // Must be between 30 and 800 characters
  if (text.length < 30 || text.length > 800) {
    return null;
  }

  return text;
}

module.exports = {
  decodeHtmlEntities,
  cleanHtmlSnippet,
  escapeTelegramHtml,
  stripEmojis,
  sanitizeAIEmail,
  sanitizeAISocialReply
};
