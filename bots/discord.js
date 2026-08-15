// Uses Node 18+ built-in fetch (no external dependency needed)
const crypto = require('crypto');

const TRANSLATIONS = {
  en: {
    lang_updated: "✅ Language updated to English.",
    not_linked: "⚠️ Your account is not linked. Use `/link` to connect it.",
    already_unlinked: "⚠️ Account is not linked.",
    unlinked_success: "✅ Account disconnected.",
    stats_pro: "🔒 Stats require Pro plan. `/upgrade`",
    stats_code_required: "❌ Code is required. Usage: `/stats <url_code>`",
    stats_not_found: "❌ Link code not found.",
    stats_title: "📊 {short}",
    stats_clicks: "👁 Clicks",
    stats_created: "📅 Created",
    link_title: "🔗 **Click the following link to connect your account:**\n\n{authUrl}\n\n*Note: You may be prompted to log in to the website first.*",
    link_created_title: "✅ Link Created",
    short_limit_reached: "❌ Daily limit ({limit}) reached. `/upgrade`",
    short_pro_required: "❌ Custom alias requires Pro plan. `/upgrade`",
    short_invalid_url: "❌ Invalid URL.",
    short_invalid_alias: "❌ Invalid alias (3-50 chars, a-z, 0-9, _, -).",
    short_alias_taken: "❌ Alias is already taken.",
    short_db_error: "❌ Server error.",
    help_title: "📖 Ovlink Bot — Commands",
    help_short_val: "URL shorten",
    help_stats_val: "Statistics (⭐ Pro)",
    help_mylinks_val: "Recent 10 links",
    help_link_val: "Connect Ovlink account",
    help_unlink_val: "Disconnect account",
    help_upgrade_val: "Pro plan info",
    help_lang_val: "Change bot language",
    help_footer: "💡 Send a URL to shorten automatically!",
    upgrade_title: "⭐ Ovlink Pro",
    upgrade_free_val: "50 links/day",
    upgrade_pro_val: "500 links/day\nCustom alias\nStatistics\nAPI",
  },
  tr: {
    lang_updated: "✅ Dil Türkçe olarak güncellendi.",
    not_linked: "⚠️ Hesabın bağlı değil. `/link` ile bağla.",
    already_unlinked: "⚠️ Zaten bağlı değil.",
    unlinked_success: "✅ Hesap ayrıldı.",
    stats_pro: "🔒 İstatistikler Pro plan gerektirir. `/upgrade`",
    stats_code_required: "❌ Kod gerekli. Kullanım: `/stats <kod>`",
    stats_not_found: "❌ Bulunamadı.",
    stats_title: "📊 {short}",
    stats_clicks: "👁 Tıklama",
    stats_created: "📅 Oluşturulma",
    link_title: "🔗 **Hesabınızı bağlamak için aşağıdaki linke tıklayın:**\n\n{authUrl}\n\n*Not: Linke tıkladıktan sonra siteye giriş yapmanız istenebilir.*",
    link_created_title: "✅ Link Oluşturuldu",
    short_limit_reached: "❌ Günlük limit ({limit}) doldu. `/upgrade`",
    short_pro_required: "❌ Özel alias Pro plan gerektirir. `/upgrade`",
    short_invalid_url: "❌ Geçersiz URL.",
    short_invalid_alias: "❌ Geçersiz alias (3-50 karakter, harf/rakam/_/-).",
    short_alias_taken: "❌ Alias zaten kullanımda.",
    short_db_error: "❌ Sunucu hatası.",
    help_title: "📖 Ovlink Bot — Komutlar",
    help_short_val: "URL kısalt",
    help_stats_val: "İstatistik (⭐ Pro)",
    help_mylinks_val: "Son 10 link",
    help_link_val: "Ovlink hesabını bağla",
    help_unlink_val: "Hesabı ayır",
    help_upgrade_val: "Pro plan bilgisi",
    help_lang_val: "Bot dilini değiştir",
    help_footer: "💡 URL gönder, otomatik kısaltır!",
    upgrade_title: "⭐ Ovlink Pro",
    upgrade_free_val: "Günde 50 link",
    upgrade_pro_val: "Günde 500 link\nÖzel alias\nİstatistik\nAPI",
  },
  az: {
    lang_updated: "✅ Dil Azərbaycan dili olaraq yeniləndi.",
    not_linked: "⚠️ Hesabınız bağlı deyil. `/link` ilə bağlayın.",
    already_unlinked: "⚠️ Onsuz da bağlı deyil.",
    unlinked_success: "✅ Hesab ayrıldı.",
    stats_pro: "🔒 Statistika Pro plan tələb edir. `/upgrade`",
    stats_code_required: "❌ Kod tələb olunur. İstifadəsi: `/stats <kod>`",
    stats_not_found: "❌ Tapılmadı.",
    stats_title: "📊 {short}",
    stats_clicks: "👁 Klik sayı",
    stats_created: "📅 Yaradılma",
    link_title: "🔗 **Hesabınızı bağlamaq üçün aşağıdakı linkə klikləyin:**\n\n{authUrl}\n\n*Qeyd: Kliklədikdən sonra sayta daxil olmanız tələb oluna bilər.*",
    link_created_title: "✅ Link Yaradıldı",
    short_limit_reached: "❌ Gündəlik limit ({limit}) doldu. `/upgrade`",
    short_pro_required: "❌ Xüsusi alias Pro plan tələb edir. `/upgrade`",
    short_invalid_url: "❌ Keçərsiz URL.",
    short_invalid_alias: "❌ Keçərsiz alias (3-50 simvol, hərf/rəqəm/_/-).",
    short_alias_taken: "❌ Bu alias artıq istifadə olunur.",
    short_db_error: "❌ Server xətası.",
    help_title: "📖 Ovlink Bot — Komandalar",
    help_short_val: "URL qısalt",
    help_stats_val: "Statistika (⭐ Pro)",
    help_mylinks_val: "Son 10 link",
    help_link_val: "Ovlink hesabını bağla",
    help_unlink_val: "Hesabı ayır",
    help_upgrade_val: "Pro plan haqqında",
    help_lang_val: "Botun dilini dəyiş",
    help_footer: "💡 URL göndərin, avtomatik qısaldılsın!",
    upgrade_title: "⭐ Ovlink Pro",
    upgrade_free_val: "Gündə 50 link",
    upgrade_pro_val: "Gündə 500 link\nXüsusi alias\nStatistika\nAPI",
  },
  ru: {
    lang_updated: "✅ Язык изменен на русский.",
    not_linked: "⚠️ Ваш аккаунт не привязан. Используйте `/link` для привязки.",
    already_unlinked: "⚠️ Аккаунт и так не привязан.",
    unlinked_success: "✅ Аккаунт отключен.",
    stats_pro: "🔒 Статистика доступна только на Pro тарифе. `/upgrade`",
    stats_code_required: "❌ Требуется код. Использование: `/stats <код>`",
    stats_not_found: "❌ Ссылка не найдена.",
    stats_title: "📊 {short}",
    stats_clicks: "👁 Клики",
    stats_created: "📅 Создана",
    link_title: "🔗 **Для привязки аккаунта нажмите на ссылку ниже:**\n\n{authUrl}\n\n*Примечание: Может потребоваться войти на сайт.*",
    link_created_title: "✅ Ссылка создана",
    short_limit_reached: "❌ Дневной лимит ({limit}) исчерпан. `/upgrade`",
    short_pro_required: "❌ Свой алиас доступен только в Pro тарифе. `/upgrade`",
    short_invalid_url: "❌ Неверный URL.",
    short_invalid_alias: "❌ Неверный алиас (3-50 символов, a-z, 0-9, _, -).",
    short_alias_taken: "❌ Этот алиас уже занят.",
    short_db_error: "❌ Ошибка сервера.",
    help_title: "📖 Ovlink Bot — Команды",
    help_short_val: "Сократить URL",
    help_stats_val: "Статистика (⭐ Pro)",
    help_mylinks_val: "Последние 10 ссылок",
    help_link_val: "Привязать аккаунт",
    help_unlink_val: "Отключить аккаунт",
    help_upgrade_val: "О Pro тарифе",
    help_lang_val: "Изменить язык бота",
    help_footer: "💡 Отправьте ссылку для автоматического сокращения!",
    upgrade_title: "⭐ Ovlink Pro",
    upgrade_free_val: "50 ссылок в день",
    upgrade_pro_val: "500 ссылок в день\nСвой алиас\nСтатистика\nAPI",
  }
};

function t(lang, key, params = {}) {
  const translations = TRANSLATIONS[lang] || TRANSLATIONS['en'] || {};
  let msg = translations[key] || TRANSLATIONS['en']?.[key] || key;
  for (const [k, v] of Object.entries(params)) {
    msg = msg.replace(new RegExp(`{${k}}`, 'g'), v);
  }
  return msg;
}

function createDiscordBot(db, options = {}) {
  const { buildShortUrl, isProAccessActive, logSecurityEvent } = options;
  const shared = require('./shared').createBotShared(db, options);

  const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
  const APP_ID = process.env.DISCORD_APP_ID || '';
  const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY || '';
  const BASE_URL = process.env.PUBLIC_BASE_URL || 'https://ovlink.sbs';
  const API_BASE = 'https://discord.com/api/v10';

  if (!BOT_TOKEN) {
    console.warn('[discord-bot] DISCORD_BOT_TOKEN not set; disabled.');
  }

  function verifySignature(signature, timestamp, body) {
    if (!PUBLIC_KEY) return false;
    try {
      const msg = Buffer.from(timestamp + body);
      const keyBytes = Buffer.from(PUBLIC_KEY, 'hex');
      const derPrefix = Buffer.from('302a300506032b6570032100', 'hex');
      const derKey = Buffer.concat([derPrefix, keyBytes]);
      const key = crypto.createPublicKey({ key: derKey, format: 'der', type: 'spki' });
      return crypto.verify(null, msg, key, Buffer.from(signature, 'hex'));
    } catch (err) {
      console.error('[discord-bot] verifySignature error:', err.message);
      return false;
    }
  }

  async function sendDM(userId, content, embeds) {
    if (!BOT_TOKEN) return null;
    try {
      // Open DM channel
      const dmRes = await fetch(`${API_BASE}/users/@me/channels`, {
        method: 'POST',
        headers: { 'Authorization': `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient_id: userId }),
      });
      const dm = await dmRes.json();
      if (!dm.id) return null;

      const payload = { content: content || '' };
      if (embeds && embeds.length) payload.embeds = embeds;

      const res = await fetch(`${API_BASE}/channels/${dm.id}/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return await res.json();
    } catch (err) {
      console.error('[discord-bot] sendDM error:', err.message);
      return null;
    }
  }

  async function handleInteraction(interaction) {
    if (!interaction.data) return { type: 4, data: { content: '❌ Hata.', flags: 64 } };

    const userId = interaction.member?.user?.id || interaction.user?.id || '';
    const username = interaction.member?.user?.username || interaction.user?.username || '';
    const commandName = (interaction.data.name || '').toLowerCase();
    const options = interaction.data.options || [];
    const opts = {};
    for (const o of options) opts[o.name] = o.value;

    const lang = await shared.getBotLanguage('discord', userId);

    switch (commandName) {
      case 'short': return cmdShort(userId, username, opts, lang);
      case 'stats': return cmdStats(userId, opts, lang);
      case 'mylinks': return cmdMyLinks(userId, lang);
      case 'link': return cmdLink(userId, username, lang);
      case 'unlink': return cmdUnlink(userId, lang);
      case 'help': return cmdHelp(lang);
      case 'upgrade': return cmdUpgrade(lang);
      case 'lang':
      case 'language':
        return cmdLang(userId, opts, lang);
      default: return { type: 4, data: { content: '❓ Bilinmeyen komut.', flags: 64 } };
    }
  }

  async function cmdShort(userId, username, opts, lang) {
    const url = opts.url || '';
    const alias = opts.alias || '';
    if (!url) return { type: 4, data: { content: t(lang, 'short_invalid_url'), flags: 64 } };

    const botUser = await shared.getBotUser('discord', userId);
    if (!botUser) return { type: 4, data: { content: t(lang, 'not_linked'), flags: 64 } };
    const limits = shared.getTierLimits(botUser);
    const dailyCount = await shared.getDailyLinkCount(botUser.user_id);

    if (dailyCount >= limits.dailyLinks) {
      return { type: 4, data: { content: t(lang, 'short_limit_reached', { limit: limits.dailyLinks }), flags: 64 } };
    }
    if (alias && !limits.customAlias) {
      return { type: 4, data: { content: t(lang, 'short_pro_required'), flags: 64 } };
    }

    const result = await shared.createShortLink(botUser.user_id, url, alias || null);
    if (result.error) {
      const errorMap = {
        invalid_url: 'short_invalid_url',
        alias_taken: 'short_alias_taken',
        invalid_alias: 'short_invalid_alias',
      };
      return { type: 4, data: { content: t(lang, errorMap[result.error] || 'short_db_error'), flags: 64 } };
    }

    return {
      type: 4,
      data: {
        content: '',
        embeds: [{
          title: t(lang, 'link_created_title'),
          description: `**${result.short}**\n${result.original.slice(0, 100)}\n\n🌐 [ovlink.sbs](${BASE_URL})`,
          color: 0x16a34a,
          fields: [{ name: 'Link', value: `${BASE_URL}/${result.short}`, inline: true }],
          footer: { text: `Ovlink${isProAccessActive(botUser) ? ' ⭐ PRO' : ''}` },
        }],
      },
    };
  }

  async function cmdStats(userId, opts, lang) {
    const botUser = await shared.getBotUser('discord', userId);
    if (!botUser) return { type: 4, data: { content: t(lang, 'not_linked'), flags: 64 } };
    if (!isProAccessActive(botUser)) return { type: 4, data: { content: t(lang, 'stats_pro'), flags: 64 } };

    const code = opts.code || opts.kod || '';
    if (!code) return { type: 4, data: { content: t(lang, 'stats_code_required'), flags: 64 } };

    const stats = await shared.getLinkStats(botUser.user_id, code);
    if (!stats) return { type: 4, data: { content: t(lang, 'stats_not_found'), flags: 64 } };

    return {
      type: 4,
      data: {
        content: '',
        embeds: [{
          title: t(lang, 'stats_title', { short: stats.short }),
          description: stats.original.slice(0, 100) + `\n\n🌐 [Detailed stats on web](${BASE_URL})`,
          color: 0x8b5cf6,
          fields: [
            { name: t(lang, 'stats_clicks'), value: String(stats.total_clicks), inline: true },
            { name: t(lang, 'stats_created'), value: stats.created_at.slice(0, 10), inline: true },
          ],
        }],
      },
    };
  }

  async function cmdMyLinks(userId, lang) {
    const botUser = await shared.getBotUser('discord', userId);
    if (!botUser) return { type: 4, data: { content: t(lang, 'not_linked'), flags: 64 } };

    return new Promise((resolve) => {
      db.all(
        'SELECT short, original, created_at FROM urls WHERE user_id = ? ORDER BY created_at DESC LIMIT 10',
        [botUser.user_id],
        async (err, rows) => {
          if (err || !rows.length) return resolve({ type: 4, data: { content: t(lang, 'no_links'), flags: 64 } });
          const desc = rows.map((r, i) => `${i + 1}. \`${r.short}\` — [${r.original.slice(0, 40)}](${BASE_URL}/${r.short})`).join('\n') + `\n\n🌐 [Manage links on website](${BASE_URL})`;
          const titleMap = {
            en: '📋 Your Recent Links',
            tr: '📋 Son 10 Linkiniz',
            az: '📋 Son 10 Linkiniz',
            ru: '📋 Ваши последние ссылки',
          };
          resolve({ type: 4, data: { content: '', embeds: [{ title: titleMap[lang] || titleMap.en, description: desc, color: 0x2563eb }] } });
        }
      );
    });
  }

  async function cmdLink(userId, username, lang) {
    const authUrl = `${BASE_URL}/bot/auth?platform=discord&id=${userId}&name=${encodeURIComponent(username || '')}`;
    return { 
      type: 4, 
      data: { 
        content: t(lang, 'link_title', { authUrl }), 
        flags: 64 
      } 
    };
  }

  async function cmdUnlink(userId, lang) {
    await shared.unlinkBotUser('discord', userId);
    return { type: 4, data: { content: t(lang, 'unlinked_success'), flags: 64 } };
  }

  function cmdHelp(lang) {
    return {
      type: 4,
      data: {
        content: '',
        embeds: [{
          title: t(lang, 'help_title'),
          color: 0x2563eb,
          description: `🌐 [ovlink.sbs](${BASE_URL})`,
          fields: [
            { name: '/short <url> [alias]', value: t(lang, 'help_short_val'), inline: false },
            { name: '/stats <kod>', value: t(lang, 'help_stats_val'), inline: false },
            { name: '/mylinks', value: t(lang, 'help_mylinks_val'), inline: false },
            { name: '/link', value: t(lang, 'help_link_val'), inline: false },
            { name: '/unlink', value: t(lang, 'help_unlink_val'), inline: false },
            { name: '/lang <language>', value: t(lang, 'help_lang_val'), inline: false },
            { name: '/upgrade', value: t(lang, 'help_upgrade_val'), inline: false },
            { name: '💡', value: t(lang, 'help_footer'), inline: false },
          ],
        }],
      },
    };
  }

  function cmdUpgrade(lang) {
    return {
      type: 4,
      data: {
        content: '',
        embeds: [{
          title: t(lang, 'upgrade_title'),
          color: 0xf59e0b,
          fields: [
            { name: '🆓 Free', value: t(lang, 'upgrade_free_val'), inline: true },
            { name: '⭐ Pro', value: t(lang, 'upgrade_pro_val'), inline: true },
          ],
          url: `${BASE_URL}/pricing`,
        }],
      },
    };
  }

  async function cmdLang(userId, opts, lang) {
    const selectedLang = opts.lang || opts.language || 'en';
    await shared.setBotLanguage('discord', userId, selectedLang);
    return { type: 4, data: { content: t(selectedLang, 'lang_updated'), flags: 64 } };
  }

  // Handle plain URL messages
  async function handleMessageCreate(message) {
    if (message.author?.bot) return null;
    const text = (message.content || '').trim();
    if (!text.match(/^https?:\/\//i)) return null;

    const botUser = await shared.getBotUser('discord', message.author.id);
    if (!botUser) return null;
    const limits = shared.getTierLimits(botUser);
    const dailyCount = await shared.getDailyLinkCount(botUser.user_id);

    if (dailyCount >= limits.dailyLinks) return null;

    const result = await shared.createShortLink(botUser.user_id, text.split(/\s+/)[0]);
    if (result.error) return null;

    const lang = await shared.getBotLanguage('discord', message.author.id);

    return {
      content: '',
      embeds: [{
        title: '✅',
        description: `**${result.short}** — ${BASE_URL}/${result.short}\n\n🌐 [ovlink.sbs](${BASE_URL})`,
        color: 0x2563eb,
        footer: { text: isProAccessActive(botUser) ? '⭐ PRO' : '/link ile hesabını bağla' },
      }],
    };
  }

  return {
    handleInteraction,
    handleMessageCreate,
    verifySignature,
    isEnabled: !!(BOT_TOKEN && APP_ID && PUBLIC_KEY),
    APP_ID,
  };
}

module.exports = { createDiscordBot };
