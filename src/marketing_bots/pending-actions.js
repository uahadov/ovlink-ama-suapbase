const fs = require('fs');
const path = require('path');
const { postHackerNewsComment } = require('./hn-client');
const { sendMail, escapeHtml } = require('../lib/email');

const ACTIONS_FILE = path.join(__dirname, '../../bot_data/pending_actions.json');
const LEADS_FILE = path.join(__dirname, '../../bot_data/b2b_leads.json');

function ensureActionsFile() {
  try {
    const dir = path.dirname(ACTIONS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(ACTIONS_FILE)) {
      fs.writeFileSync(ACTIONS_FILE, JSON.stringify({ hn: {}, mail: {} }, null, 2), 'utf8');
    }
  } catch (e) {
    console.warn('[Pending Actions] Error creating actions file:', e.message);
  }
}

function loadActions() {
  ensureActionsFile();
  try {
    const raw = fs.readFileSync(ACTIONS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return { hn: {}, mail: {} };
  }
}

function saveActions(data) {
  try {
    const dir = path.dirname(ACTIONS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ACTIONS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.warn('[Pending Actions] Error saving actions:', e.message);
  }
}

function storePendingHn(postId, data) {
  const actions = loadActions();
  actions.hn[String(postId)] = {
    postId: String(postId),
    title: data.title || '',
    author: data.author || '',
    context: data.context || '',
    url: data.url || `https://news.ycombinator.com/item?id=${postId}`,
    commentText: data.commentText || '',
    suitabilityScore: data.suitabilityScore || 0,
    suitabilityReason: data.suitabilityReason || '',
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  saveActions(actions);
}

function storePendingMail(leadId, data) {
  const actions = loadActions();
  actions.mail[String(leadId)] = {
    leadId: String(leadId),
    to: data.to || '',
    name: data.name || '',
    role: data.role || '',
    company: data.company || '',
    niche: data.niche || '',
    context: data.context || '',
    subject: data.subject || '',
    body: data.body || '',
    suitabilityScore: data.suitabilityScore || 0,
    suitabilityReason: data.suitabilityReason || '',
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  saveActions(actions);
}

function getPendingHn(postId) {
  const actions = loadActions();
  return actions.hn[String(postId)] || null;
}

function getPendingMail(leadId) {
  const actions = loadActions();
  return actions.mail[String(leadId)] || null;
}

async function rewriteB2BMail(leadId) {
  const actions = loadActions();
  const item = actions.mail[String(leadId)];
  if (!item) {
    throw new Error('Müşteri adayı bulunamadı.');
  }
  const hunter = require('./b2b-email-hunter');
  const lead = {
    id: leadId,
    name: item.name,
    role: item.role,
    company: item.company,
    niche: item.niche,
    context: item.context || '',
    email: item.to
  };
  const rawEmailContent = await hunter.generateEmail(lead);
  let subject = item.subject;
  let body = rawEmailContent;
  const subMatch = rawEmailContent.match(/^Subject:\s*([^\n]+)/i);
  if (subMatch) {
    subject = subMatch[1].trim();
    body = rawEmailContent.replace(/^Subject:\s*[^\n]+\n+/i, '').trim();
  }
  item.subject = subject;
  item.body = body;
  item.lastRewrittenAt = new Date().toISOString();
  saveActions(actions);
  return { subject, body, item };
}

async function executeHnComment(postId) {
  const actions = loadActions();
  const item = actions.hn[String(postId)];
  if (!item) {
    throw new Error('Hacker News gönderisi hafızada bulunamadı veya süresi doldu.');
  }
  if (item.status === 'sent') {
    throw new Error('Bu Hacker News yorumu daha önce zaten yayınlandı.');
  }

  const result = await postHackerNewsComment(item.postId, item.commentText);

  item.status = 'sent';
  item.sentAt = new Date().toISOString();
  saveActions(actions);

  return result;
}

async function executeB2BMail(leadId) {
  const actions = loadActions();
  const item = actions.mail[String(leadId)];
  if (!item) {
    throw new Error('E-posta taslağı hafızada bulunamadı.');
  }
  if (item.status === 'sent') {
    throw new Error('Bu e-posta daha önce zaten gönderildi.');
  }

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; line-height: 1.6; color: #1e293b; max-width: 600px; padding: 20px;">
      ${escapeHtml(item.body).replace(/\n\n/g, '<br><br>').replace(/\n/g, '<br>')}
    </div>
  `;

  await sendMail({
    to: item.to,
    subject: item.subject,
    text: item.body,
    html
  });

  item.status = 'sent';
  item.sentAt = new Date().toISOString();
  saveActions(actions);

  // Update lead status in leads file
  try {
    if (fs.existsSync(LEADS_FILE)) {
      const leads = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'));
      const idx = leads.findIndex(l => String(l.id) === String(leadId));
      if (idx !== -1) {
        leads[idx].status = 'sent';
        leads[idx].lastSentAt = new Date().toISOString();
        fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2), 'utf8');
      }
    }
  } catch (e) {
    console.warn('[Pending Actions] Could not update leads file:', e.message);
  }

  return { email: item.to, name: item.name };
}

function skipAction(type, id) {
  const actions = loadActions();
  if (type === 'hn' && actions.hn[String(id)]) {
    actions.hn[String(id)].status = 'skipped';
    actions.hn[String(id)].skippedAt = new Date().toISOString();
    saveActions(actions);
  } else if (type === 'mail' && actions.mail[String(id)]) {
    actions.mail[String(id)].status = 'skipped';
    actions.mail[String(id)].skippedAt = new Date().toISOString();
    saveActions(actions);

    try {
      if (fs.existsSync(LEADS_FILE)) {
        const leads = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'));
        const idx = leads.findIndex(l => String(l.id) === String(id));
        if (idx !== -1) {
          leads[idx].status = 'skipped';
          fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2), 'utf8');
        }
      }
    } catch {}
  }
}

module.exports = {
  storePendingHn,
  storePendingMail,
  getPendingHn,
  getPendingMail,
  executeHnComment,
  executeB2BMail,
  rewriteB2BMail,
  skipAction
};