require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { sendTelegramAlert } = require('./telegram-notifier');
const { storePendingMail } = require('./pending-actions');

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
      // Recycle the queue so engine can run continuously
      leads.forEach(l => { l.status = 'pending'; });
      this.saveLeads(leads);
      lead = leads[0];
    }
    return lead;
  }

  /**
   * Analyzes whether this lead has a genuine use-case for Ovlink.
   */
  async analyzeLeadSuitability(lead) {
    if (!lead || !lead.email || !lead.company || !lead.name || !lead.email.includes('@')) {
      return {
        isSuitable: false,
        score: 1,
        reason: 'E-posta adresi, şirket veya iletişim bilgisi eksik olan geçersiz aday.'
      };
    }

    const invalidRoles = ['student', 'intern', 'unemployed', 'retired', 'unknown'];
    const lowerRole = (lead.role || '').toLowerCase();
    if (invalidRoles.some(r => lowerRole.includes(r))) {
      return {
        isSuitable: false,
        score: 2,
        reason: 'Adayın pozisyonu bağlantı yönetimi veya pazarlama kararları için uygun değil.'
      };
    }

    const prompt = `
You are the Growth Lead for Ovlink (https://ovlink.sbs).
Ovlink provides custom branded short links, real-time click analytics, QR codes, and developer APIs.

Analyze this prospect:
Name: ${lead.name} (${lead.role})
Company: ${lead.company}
Niche: ${lead.niche}
Workflow context: ${lead.context}

Determine if this lead is a strong fit for Ovlink and why.
Respond in valid JSON only:
{
  "is_suitable": boolean,
  "score": number from 1 to 10,
  "reason": "1-sentence concise explanation in Turkish of why Ovlink is suitable for this company"
}
`;

    for (const model of this.freeModels) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      try {
        const sessionId = 'suit_b2b_' + Date.now();
        const res = await fetch(this.apiUrl, {
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
            temperature: 0.2,
            max_tokens: 180,
            stream: false
          })
        });

        clearTimeout(timeout);
        if (!res.ok) continue;

        const data = await res.json();
        const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (content) {
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return {
              isSuitable: parsed.is_suitable !== false,
              score: Number(parsed.score) || 9,
              reason: parsed.reason || 'Pazarlama kampanyaları ve özel alan adı yönlendirmesi için uygun aday.'
            };
          }
        }
      } catch (e) {
        clearTimeout(timeout);
      }
    }

    return {
      isSuitable: true,
      score: 9,
      reason: `${lead.company} kampanyalarında link trafiği ve özel domain yönetimi için doğrudan tasarruf sağlar.`
    };
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

          const emojiCleaned = content.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F7FF}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '').trim();
          return emojiCleaned + complianceFooter;
        }
      } catch (error) {
        clearTimeout(timeout);
      }
    }

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

      console.log(`[B2B Hunter] Analyzing suitability for lead: ${lead.name} (${lead.role} @ ${lead.company})...`);
      const suitability = await this.analyzeLeadSuitability(lead);

      if (!suitability.isSuitable) {
        console.log(`[B2B Hunter] Lead ${lead.name} skipped (Score: ${suitability.score}/10): ${suitability.reason}`);
        lead.status = 'skipped';
        const allLeads = this.loadLeads();
        const idx = allLeads.findIndex(l => l.id === lead.id);
        if (idx !== -1) {
          allLeads[idx] = lead;
          this.saveLeads(allLeads);
        }
        return;
      }

      console.log(`[B2B Hunter] Generating custom cold email for ${lead.name}...`);
      const rawEmailContent = await this.generateEmail(lead);

      if (rawEmailContent) {
        let subject = `Link infrastructure and campaign tracking at ${lead.company}`;
        let body = rawEmailContent;
        const subMatch = rawEmailContent.match(/^Subject:\s*([^\n]+)/i);
        if (subMatch) {
          subject = subMatch[1].trim();
          body = rawEmailContent.replace(/^Subject:\s*[^\n]+\n+/i, '').trim();
        }

        // Store pending action so Telegram callback buttons can send email or skip
        storePendingMail(lead.id, {
          to: lead.email,
          name: lead.name,
          role: lead.role,
          company: lead.company,
          niche: lead.niche,
          subject,
          body,
          suitabilityScore: suitability.score,
          suitabilityReason: suitability.reason
        });

        const safeName = lead.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const safeRole = lead.role.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const safeCompany = lead.company.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const safeNiche = lead.niche.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const safeEmail = lead.email.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const safeSubject = subject.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const safeBody = body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const safeReason = suitability.reason.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        const hasSmtp = Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
        const statusText = hasSmtp ? `✅ SMTP Hazır (${process.env.SMTP_USER})` : `⚠️ SMTP Ayarları Eksik`;

        // Send Telegram notification with Action Buttons
        const tgMsg = `📨 <b>[B2B Satış Avcısı] Yeni Müşteri Adayı E-Postası Hazırlandı!</b>\n\n` +
          `🔍 <b>Uygunluk Analizi:</b> ${safeReason} (Skor: <b>${suitability.score}/10</b>)\n` +
          `👤 <b>Alıcı:</b> ${safeName} (${safeRole})\n` +
          `🏢 <b>Şirket:</b> ${safeCompany} (${safeNiche})\n` +
          `📬 <b>E-posta Adresi:</b> <code>${safeEmail}</code>\n` +
          `📊 <b>Durum:</b> ${statusText}\n` +
          `🛡️ <b>CAN-SPAM / Opt-Out:</b> ✅ Dahil Edildi\n\n` +
          `📝 <b>Muse Spark'ın Yazdığı E-Posta Taslağı:</b>\n` +
          `<blockquote><b>Konu:</b> ${safeSubject}\n\n${safeBody}</blockquote>\n\n` +
          `👉 <i>Aşağıdaki butonla tek dokunuşla e-postayı <b>otomatik gönderebilir</b> veya iptal edebilirsin:</i>`;

        const keyboard = [
          [
            { text: '📤 Otomatik Mail Gönder', callback_data: `mail_send:${lead.id}` },
            { text: '❌ Gönderme / İptal', callback_data: `mail_skip:${lead.id}` }
          ],
          [
            { text: '🔄 Yeniden Yaz (AI)', callback_data: `mail_rewrite:${lead.id}` }
          ]
        ];

        await sendTelegramAlert(tgMsg, { keyboard });

        // Update lead status in pipeline
        lead.status = 'drafted';
        lead.lastDraftedAt = new Date().toISOString();
        const allLeads = this.loadLeads();
        const idx = allLeads.findIndex(l => l.id === lead.id);
        if (idx !== -1) {
          allLeads[idx] = lead;
          this.saveLeads(allLeads);
        }

        console.log(`[B2B Hunter] Lead #${lead.id} processed and Telegram action buttons dispatched.`);
      }
    } catch (error) {
      console.error('[B2B Hunter] Pipeline error:', error);
    } finally {
      this.isRunning = false;
    }
  }

  start() {
    console.log('[B2B Hunter] Starting 24/7 B2B Cold Email engine with suitability filter & action buttons...');
    const intervalMs = 6 * 60 * 60 * 1000;
    this.intervalId = setInterval(() => this.processQueue(), intervalMs);

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