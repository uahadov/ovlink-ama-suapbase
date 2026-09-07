require('dotenv').config();
const fs = require('fs');
const path = require('path');
let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch {
  // nodemailer optional
}
const { sendTelegramAlert } = require('./telegram-notifier');

class B2BEmailHunter {
  constructor() {
    this.intervalId = null;
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
    this.isRunning = false;
    this.leadsPath = path.join(__dirname, '../../bot_data/b2b_leads.json');
    this.ensureLeadsQueue();
  }

  ensureLeadsQueue() {
    try {
      const dir = path.dirname(this.leadsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      if (!fs.existsSync(this.leadsPath)) {
        const defaultLeads = [
          {
            id: 'lead_1',
            name: 'Sarah Jenkins',
            role: 'Media Buying Director',
            company: 'GrowthWave Media',
            niche: 'Digital Marketing & Media Buying Agency',
            email: 'sarah@growthwavemedia.com',
            context: 'Managing 25+ paid ad client accounts across TikTok and Meta. Currently struggling with fragmented link attribution and client-branded domain setup.',
            status: 'pending'
          },
          {
            id: 'lead_2',
            name: 'Marcus Vance',
            role: 'Head of Growth',
            company: 'Lumina Apparel',
            niche: 'E-Commerce & Direct-to-Consumer',
            email: 'marcus@luminaapparel.com',
            context: 'Scaling influencer affiliate links and QR packaging inserts for new seasonal launch. Bitly pricing is too high for their required link volume.',
            status: 'pending'
          },
          {
            id: 'lead_3',
            name: 'Elena Rostova',
            role: 'Founder & CEO',
            company: 'CloudSync Studio',
            niche: 'B2B SaaS Startup',
            email: 'elena@cloudsync.io',
            context: 'Building developer tools, needs programmatic API link creation and custom branded short links for product onboarding emails.',
            status: 'pending'
          },
          {
            id: 'lead_4',
            name: 'David Kim',
            role: 'Director of Operations',
            company: 'TechBrief Daily',
            niche: 'Newsletter & Creator Media Network',
            email: 'david@techbriefdaily.com',
            context: 'Publishes daily tech newsletter with 120,000 subscribers. Needs click analytics and sponsor link redirection without link breakdown.',
            status: 'pending'
          },
          {
            id: 'lead_5',
            name: 'Alex Rivera',
            role: 'Affiliate Marketing Manager',
            company: 'Pulse Commerce',
            niche: 'Multi-Channel Retail & Affiliates',
            email: 'alex.rivera@pulsecommerce.net',
            context: 'Coordinates 200+ micro-affiliates and needs real-time click heatmaps and device targeting for mobile shoppers.',
            status: 'pending'
          }
        ];
        fs.writeFileSync(this.leadsPath, JSON.stringify(defaultLeads, null, 2), 'utf8');
      }
    } catch (err) {
      console.warn('[B2B Hunter] Error initializing leads queue:', err.message);
    }
  }

  loadLeads() {
    try {
      if (fs.existsSync(this.leadsPath)) {
        return JSON.parse(fs.readFileSync(this.leadsPath, 'utf8'));
      }
    } catch (e) {
      console.warn('[B2B Hunter] Error reading leads file:', e.message);
    }
    return [];
  }

  saveLeads(leads) {
    try {
      const dir = path.dirname(this.leadsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.leadsPath, JSON.stringify(leads, null, 2), 'utf8');
    } catch (e) {
      console.warn('[B2B Hunter] Error writing leads file:', e.message);
    }
  }

  getNextPendingLead() {
    const leads = this.loadLeads();
    let lead = leads.find(l => l.status === 'pending');
    if (!lead) {
      // If all leads completed, recycle the queue so engine can run continuously
      leads.forEach(l => { l.status = 'pending'; });
      this.saveLeads(leads);
      lead = leads[0];
    }
    return lead;
  }

  async generateEmail(lead) {
    const prompt = `
You are the software developer and founder behind Ovlink (https://ovlink.sbs).
Write a polite, respectful, and transparent inquiry to ${lead.name}, who is the ${lead.role} at ${lead.company}.
Niche: ${lead.niche}
Context: ${lead.context}

CRITICAL ETHICAL & QUALITY RULES:
1. COMPLETE HONESTY & RESPECT: Be polite, humble, and completely transparent. Never make false claims, never use pushy sales tactics, and genuinely respect their time.
2. STRICTLY ZERO EMOJIS: Do not use any emojis, icons, or symbols.
3. Authentic, natural American English (maximum 3 to 4 sentences).
4. Address their specific link or attribution workflow simply, and introduce Ovlink as an independent, lightweight platform built to make custom domains and click analytics accessible and clean.
5. End with a zero-pressure invitation (e.g., "If this is relevant to your roadmap, I would be glad to answer any questions. If not, no worries at all.").

Format your output EXACTLY like this:
Subject: [Short, honest 3-5 word subject line without emojis]

[Email body here]
`;

    const complianceFooter = `\n\n---\nOvlink Link Infrastructure | https://ovlink.sbs\nTo opt out of future updates, reply with "unsubscribe" or "stop".`;

    for (const model of this.freeModels) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);

      try {
        const sessionId = 'ses_' + Date.now();
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
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.7,
            max_tokens: 350,
            stream: false
          })
        });

        clearTimeout(timeout);

        if (!response.ok) {
          console.warn(`[B2B Hunter] Model ${model} returned status ${response.status}. Trying fallback...`);
          continue;
        }

        const data = await response.json();
        let content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (content) {
          if (content.includes('</think>')) {
            content = content.split('</think>').pop().trim();
          } else if (content.startsWith("Here's a thinking process")) {
            const lines = content.split('\n');
            const cleanLines = lines.filter(l => !l.startsWith('1.') && !l.startsWith('2.') && !l.startsWith('**') && !l.includes('Analyze'));
            content = cleanLines.join('\n').trim();
          }

          const emojiCleaned = content.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim();
          return emojiCleaned + complianceFooter;
        }
      } catch (error) {
        clearTimeout(timeout);
        console.warn(`[B2B Hunter] Error with model ${model}:`, error.message);
      }
    }

    // High-converting human fallback if AI API is temporarily unreachable
    return `Subject: link attribution and campaign tracking at ${lead.company}\n\nHi ${lead.name},\n\nNoticed ${lead.company} is active across digital growth campaigns. Managing cross-channel links and keeping custom domain attribution clean usually creates avoidable friction.\n\nWe built Ovlink (https://ovlink.sbs) to provide lightweight custom domains and real-time click analytics without enterprise cost.\n\nWould you be open to a quick 5-minute chat this week?` + complianceFooter;
  }

  async processQueue() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      console.log('[B2B Hunter] Waking up, checking lead pipeline...');
      const lead = this.getNextPendingLead();

      if (!lead) {
        console.log('[B2B Hunter] No pending leads in queue.');
        return;
      }

      console.log(`[B2B Hunter] Processing lead: ${lead.name} (${lead.role} @ ${lead.company}). Asking Muse Spark to craft pitch...`);

      const emailContent = await this.generateEmail(lead);

      if (emailContent) {
        console.log('\n================ B2B EMAIL GENERATED ================');
        console.log(`To: ${lead.name} <${lead.email}>`);
        console.log(`Niche: ${lead.niche}`);
        console.log('Body:');
        console.log(emailContent);
        console.log('=====================================================\n');

        let statusText = '📧 Hazırlandı & Onay Bekliyor (Admin İncelemesi)';

        // Attempt SMTP dispatch if credentials exist and not in test environment
        if (nodemailer && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.NODE_ENV !== 'test') {
          try {
            const transporter = nodemailer.createTransport({
              host: process.env.SMTP_HOST || 'smtp.gmail.com',
              port: Number(process.env.SMTP_PORT) || 587,
              secure: false,
              auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
              }
            });

            statusText = `✅ SMTP Canlı Gönderime Hazır (${process.env.SMTP_USER})`;
          } catch (smtpErr) {
            statusText = `⚠️ SMTP Bağlantı Uyarısı: ${smtpErr.message}`;
          }
        }

        const safeName = lead.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const safeRole = lead.role.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const safeCompany = lead.company.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const safeNiche = lead.niche.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const safeEmail = lead.email.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const safeContent = emailContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        // Send Telegram notification to user
        const tgMsg = `📨 <b>[B2B Satış Avcısı] Yeni Müşteri Adayı E-Postası Hazırlandı!</b>\n\n` +
          `👤 <b>Alıcı:</b> ${safeName} (${safeRole})\n` +
          `🏢 <b>Şirket:</b> ${safeCompany} (${safeNiche})\n` +
          `📬 <b>E-posta Adresi:</b> <code>${safeEmail}</code>\n` +
          `📊 <b>Durum:</b> ${statusText}\n` +
          `🛡️ <b>CAN-SPAM / Opt-Out:</b> ✅ Dahil Edildi\n\n` +
          `📝 <b>Muse Spark'ın Yazdığı E-Posta Taslağı:</b>\n` +
          `<blockquote>${safeContent}</blockquote>`;

        await sendTelegramAlert(tgMsg);

        // Update lead status in pipeline
        lead.status = 'drafted';
        lead.lastDraftedAt = new Date().toISOString();
        const allLeads = this.loadLeads();
        const idx = allLeads.findIndex(l => l.id === lead.id);
        if (idx !== -1) {
          allLeads[idx] = lead;
          this.saveLeads(allLeads);
        }

        console.log(`[B2B Hunter] Lead #${lead.id} processed and Telegram alert dispatched.`);
      }
    } catch (error) {
      console.error('[B2B Hunter] Pipeline error:', error);
    } finally {
      this.isRunning = false;
    }
  }

  start() {
    console.log('[B2B Hunter] Starting 24/7 B2B Cold Email automation engine...');
    // Run every 6 hours
    const intervalMs = 6 * 60 * 60 * 1000;
    this.intervalId = setInterval(() => this.processQueue(), intervalMs);

    // Initial check (unref to avoid blocking graceful shutdown)
    setTimeout(() => this.processQueue(), 5000).unref?.();
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      console.log('[B2B Hunter] Stopped.');
    }
  }
}

module.exports = new B2BEmailHunter();
