// Uses Node 18+ built-in fetch (no external dependency needed)

const TRANSLATIONS = {
  en: {
    welcome_linked: "👋 Welcome back, <b>{name}</b>!\n\n" +
      "🔗 <b>Ovlink Bot</b> — {tier}\n" +
      "📊 Daily limit: {dailyLinks} links\n" +
      "📈 Today: {dailyCount}/{dailyLinks} links used\n\n" +
      "📌 <b>Commands:</b>\n" +
      "/short &lt;url&gt; — Shorten a URL\n" +
      "/short &lt;url&gt; &lt;alias&gt; — Custom alias (⭐ Pro)\n" +
      "/stats &lt;kod&gt; — View link stats (⭐ Pro)\n" +
      "/mylinks — Your recent 10 links\n" +
      "/help — All commands\n" +
      "/lang — Change language\n" +
      "/unlink — Disconnect account\n\n" +
      "💡 Just send me a URL to shorten it instantly!\n\n" +
      "🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    welcome_guest: "👋 <b>Ovlink Bot</b> helps you shorten long URLs into short, easy-to-share links — instantly!\n\n" +
      "📌 <b>What I can do:</b>\n" +
      "• Shorten any URL — just send it to me\n" +
      "• Track how many clicks your links get\n" +
      "• View your recent links anytime\n" +
      "• Available in 4 languages\n\n" +
      "⚡ <b>Try it now:</b> Send me a link!\n\n" +
      "🔑 <b>Link your account</b> (optional) to manage links on the web:\n" +
      "<a href=\"{authUrl}\">→ Link Account</a>\n\n" +
      "🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    welcome_guest_btn: "🔗 Link Account",
    help: "📖 <b>Ovlink Bot Commands</b>\n\n" +
      "/short &lt;url&gt; — Shorten URL\n" +
      "/short &lt;url&gt; &lt;alias&gt; — Custom alias (⭐ Pro)\n" +
      "/stats &lt;kod&gt; — Statistics (⭐ Pro)\n" +
      "/mylinks — Recent links\n" +
      "/unlink — Disconnect account\n" +
      "/lang — Change language\n" +
      "/upgrade — Pro plan info\n\n" +
      "💡 Send a URL directly to shorten it!\n\n" +
      "🌐 Website: <a href=\"{baseUrl}\">ovlink.sbs</a>",
    upgrade: "⭐ <b>Ovlink Pro — $2/month</b>\n\n" +
      "🆓 Free: 10 links/day\n" +
      "⭐ Pro: 100 links/day + custom alias + stats + API\n\n" +
      "🌐 <a href=\"{baseUrl}/pricing\">ovlink.sbs/pricing</a>",
    url_required: "❌ URL is required.\nUsage: /short &lt;url&gt; [alias]",
    invalid_url: "❌ Invalid URL.",
    daily_limit_reached: "❌ Daily limit ({limit}) reached.",
    custom_alias_pro: "❌ Custom alias is for Pro plan. /upgrade",
    invalid_alias: "❌ Invalid alias (3-50 chars, a-z, 0-9, _, -).",
    alias_taken: "❌ Alias is already taken.",
    db_error: "❌ Server error.",
    link_created: "✅ <b>{shortUrl}</b>\n📎 {original}\n\n🌐 Shorten more at <a href=\"{baseUrl}\">ovlink.sbs</a>",
    link_created_guest: "✅ <b>{shortUrl}</b>\n📎 {original}\n\n<i>Link your account with /start to see links on website</i>\n\n🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    no_links: "📭 No links found.",
    recent_links: "📋 <b>Your Recent 10 Links:</b>\n\n{lines}\n\n🌐 Manage all links at <a href=\"{baseUrl}\">ovlink.sbs</a>",
    not_linked: "⚠️ Your account is not linked. Use /start to link.",
    unlinked_success: "✅ Account disconnected.",
    already_unlinked: "⚠️ Account is not linked.",
    stats_pro: "🔒 Stats require Pro plan. /upgrade",
    stats_code_required: "❌ Code is required. Usage: /stats &lt;kod&gt;",
    stats_not_found: "❌ Link code not found.",
    stats_detail: "📊 <b>{short}</b>\n" +
      "📎 {original}\n" +
      "👁 Clicks: {clicks}\n" +
      "📅 Created: {created}\n\n" +
      "🌐 Detailed stats at <a href=\"{baseUrl}\">ovlink.sbs</a>",
    select_lang: "🌐 <b>Select your language / Dil seçin / Выберите язык:</b>",
    lang_updated: "✅ Language updated to English.",
  },
  tr: {
    welcome_linked: "👋 Tekrar hoş geldin, <b>{name}</b>!\n\n" +
      "🔗 <b>Ovlink Bot</b> — {tier}\n" +
      "📊 Günlük limit: {dailyLinks} link\n" +
      "📈 Bugün: {dailyCount}/{dailyLinks} link kullanıldı\n\n" +
      "📌 <b>Komutlar:</b>\n" +
      "/short &lt;url&gt; — URL kısalt\n" +
      "/short &lt;url&gt; &lt;alias&gt; — Özel alias (⭐ Pro)\n" +
      "/stats &lt;kod&gt; — Link istatistiği (⭐ Pro)\n" +
      "/mylinks — Son 10 linkin\n" +
      "/help — Tüm komutlar\n" +
      "/lang — Dil değiştir\n" +
      "/unlink — Hesabı ayır\n\n" +
      "💡 URL gönder, anında kısaltayım!\n\n" +
      "🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    welcome_guest: "👋 <b>Ovlink Bot</b> uzun URL'leri kısaltıp kolayca paylaşmana yardımcı olur!\n\n" +
      "📌 <b>Neler yapabilirim:</b>\n" +
      "• Herhangi bir URL'yi kısalt — bana gönder, yapayım\n" +
      "• Linklerinin kaç tık aldığını gör\n" +
      "• Son linklerini istediğin zaman listele\n" +
      "• 4 dilde kullanılabilir\n\n" +
      "⚡ <b>Hemen dene:</b> Bana bir link gönder!\n\n" +
      "🔑 <b>Hesabını bağla</b> (isteğe bağlı) linkleri web'de yönetmek için:\n" +
      "<a href=\"{authUrl}\">→ Hesabımı Bağla</a>\n\n" +
      "🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    welcome_guest_btn: "🔗 Hesabımı Bağla",
    help: "📖 <b>Ovlink Bot Komutları</b>\n\n" +
      "/short &lt;url&gt; — Kısalt\n" +
      "/short &lt;url&gt; &lt;alias&gt; — Özel alias (⭐ Pro)\n" +
      "/stats &lt;kod&gt; — İstatistik (⭐ Pro)\n" +
      "/mylinks — Son linkler\n" +
      "/unlink — Hesabı ayır\n" +
      "/lang — Dil değiştir\n" +
      "/upgrade — Pro plan bilgisi\n\n" +
      "💡 URL gönder, otomatik kısalt!\n\n" +
      "🌐 Web sitesi: <a href=\"{baseUrl}\">ovlink.sbs</a>",
    upgrade: "⭐ <b>Ovlink Pro — $2/ay</b>\n\n" +
      "🆓 Free: Günde 10 link\n" +
      "⭐ Pro: Günde 100 link + özel alias + istatistik + API\n\n" +
      "🌐 <a href=\"{baseUrl}/pricing\">ovlink.sbs/pricing</a>",
    url_required: "❌ URL gerekli.\nKullanım: /short &lt;url&gt; [alias]",
    invalid_url: "❌ Geçersiz URL.",
    daily_limit_reached: "❌ Günlük limit ({limit}) doldu.",
    custom_alias_pro: "❌ Özel alias Pro plan gerektirir. /upgrade",
    invalid_alias: "❌ Geçersiz alias (3-50 karakter, harf/rakam/_/-).",
    alias_taken: "❌ Alias zaten kullanımda.",
    db_error: "❌ Sunucu hatası.",
    link_created: "✅ <b>{shortUrl}</b>\n📎 {original}\n\n🌐 Daha fazla kısaltmak için <a href=\"{baseUrl}\">ovlink.sbs</a>",
    link_created_guest: "✅ <b>{shortUrl}</b>\n📎 {original}\n\n<i>Linkleri web sitesinde görmek için hesabını /start ile bağla</i>\n\n🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    no_links: "📭 Henüz link yok.",
    recent_links: "📋 <b>Son 10 Linkiniz:</b>\n\n{lines}\n\n🌐 Tüm linkleri yönetin: <a href=\"{baseUrl}\">ovlink.sbs</a>",
    not_linked: "⚠️ Hesabın bağlı değil. /start ile bağla.",
    unlinked_success: "✅ Hesap ayrıldı.",
    already_unlinked: "⚠️ Zaten bağlı değil.",
    stats_pro: "🔒 İstatistikler Pro plan gerektirir. /upgrade",
    stats_code_required: "❌ Kod gerekli. Kullanım: /stats &lt;kod&gt;",
    stats_not_found: "❌ Bulunamadı.",
    stats_detail: "📊 <b>{short}</b>\n" +
      "📎 {original}\n" +
      "👁 Tıklama: {clicks}\n" +
      "📅 Oluşturulma: {created}\n\n" +
      "🌐 Ayrıntılı istatistikler: <a href=\"{baseUrl}\">ovlink.sbs</a>",
    select_lang: "🌐 <b>Select your language / Dil seçin / Выберите язык:</b>",
    lang_updated: "✅ Dil Türkçe olarak güncellendi.",
  },
  az: {
    welcome_linked: "👋 Xoş gəldiniz, <b>{name}</b>!\n\n" +
      "🔗 <b>Ovlink Bot</b> — {tier}\n" +
      "📊 Gündəlik limit: {dailyLinks} link\n" +
      "📈 Bu gün: {dailyCount}/{dailyLinks} link istifadə edilib\n\n" +
      "📌 <b>Komandalar:</b>\n" +
      "/short &lt;url&gt; — URL qısalt\n" +
      "/short &lt;url&gt; &lt;alias&gt; — Xüsusi alias (⭐ Pro)\n" +
      "/stats &lt;kod&gt; — Link statistikası (⭐ Pro)\n" +
      "/mylinks — Son 10 linkiniz\n" +
      "/help — Bütün komandalar\n" +
      "/lang — Dil dəyişdir\n" +
      "/unlink — Hesabı ayır\n\n" +
      "💡 URL göndərin, dərhal qısaldım!\n\n" +
      "🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    welcome_guest: "👋 <b>Ovlink Bot</b> uzun URL-ləri qısaldıb asanlıqla paylaşmağa kömək edir!\n\n" +
      "📌 <b>Nələr edə bilərəm:</b>\n" +
      "• İstənilən URL-i qısalt — mənə göndər, kifayətdir\n" +
      "• Linklərinizin neçə klik aldığını izləyin\n" +
      "• Son linklərinizi istənilən vaxt görün\n" +
      "• 4 dildə istifadə oluna bilər\n\n" +
      "⚡ <b>İndi yoxlayın:</b> Mənə bir link göndərin!\n\n" +
      "🔑 <b>Hesabınızı bağlayın</b> (istəyə bağlı) linkləri vebdə idarə etmək üçün:\n" +
      "<a href=\"{authUrl}\">→ Hesabımı Bağla</a>\n\n" +
      "🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    welcome_guest_btn: "🔗 Hesabımı Bağla",
    help: "📖 <b>Ovlink Bot Komandaları</b>\n\n" +
      "/short &lt;url&gt; — Qısalt\n" +
      "/short &lt;url&gt; &lt;alias&gt; — Xüsusi alias (⭐ Pro)\n" +
      "/stats &lt;kod&gt; — Statistika (⭐ Pro)\n" +
      "/mylinks — Son linklər\n" +
      "/unlink — Hesabı ayır\n" +
      "/lang — Dili dəyişdir\n" +
      "/upgrade — Pro plan haqqında\n\n" +
      "💡 URL göndərin, avtomatik qısaldılsın!\n\n" +
      "🌐 Veb sayt: <a href=\"{baseUrl}\">ovlink.sbs</a>",
    upgrade: "⭐ <b>Ovlink Pro — $2/ay</b>\n\n" +
      "🆓 Free: Gündə 10 link\n" +
      "⭐ Pro: Gündə 100 link + xüsusi alias + statistika + API\n\n" +
      "🌐 <a href=\"{baseUrl}/pricing\">ovlink.sbs/pricing</a>",
    url_required: "❌ URL tələb olunur.\nİstifadəsi: /short &lt;url&gt; [alias]",
    invalid_url: "❌ Keçərsiz URL.",
    daily_limit_reached: "❌ Gündəlik limit ({limit}) doldu.",
    custom_alias_pro: "❌ Xüsusi alias Pro plan tələb edir. /upgrade",
    invalid_alias: "❌ Keçərsiz alias (3-50 simvol, hərf/rəqəm/_/-).",
    alias_taken: "❌ Bu alias artıq istifadə olunur.",
    db_error: "❌ Server xətası.",
    link_created: "✅ <b>{shortUrl}</b>\n📎 {original}\n\n🌐 Daha çox qısaltmaq üçün <a href=\"{baseUrl}\">ovlink.sbs</a>",
    link_created_guest: "✅ <b>{shortUrl}</b>\n📎 {original}\n\n<i>Linkləri veb-saytda görmək üçün hesabınızı /start ilə bağlayın</i>\n\n🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    no_links: "📭 Hələ ki, link yoxdur.",
    recent_links: "📋 <b>Son 10 Linkiniz:</b>\n\n{lines}\n\n🌐 Bütün linkləri idarə edin: <a href=\"{baseUrl}\">ovlink.sbs</a>",
    not_linked: "⚠️ Hesabınız bağlı deyil. /start ilə bağlayın.",
    unlinked_success: "✅ Hesab ayrıldı.",
    already_unlinked: "⚠️ Onsuz da bağlı deyil.",
    stats_pro: "🔒 Statistika Pro plan tələb edir. /upgrade",
    stats_code_required: "❌ Kod tələb olunur. İstifadəsi: /stats &lt;kod&gt;",
    stats_not_found: "❌ Tapılmadı.",
    stats_detail: "📊 <b>{short}</b>\n" +
      "📎 {original}\n" +
      "👁 Klik sayı: {clicks}\n" +
      "📅 Yaradılma: {created}\n\n" +
      "🌐 Ətraflı statistika: <a href=\"{baseUrl}\">ovlink.sbs</a>",
    select_lang: "🌐 <b>Select your language / Dil seçin / Выберите язык:</b>",
    lang_updated: "✅ Dil Azərbaycan dili olaraq yeniləndi.",
  },
  ru: {
    welcome_linked: "👋 С возвращением, <b>{name}</b>!\n\n" +
      "🔗 <b>Ovlink Bot</b> — {tier}\n" +
      "📊 Лимит: {dailyLinks} ссылок в день\n" +
      "📈 Сегодня: {dailyCount}/{dailyLinks} использовано\n\n" +
      "📌 <b>Команды:</b>\n" +
      "/short &lt;url&gt; — Сократить URL\n" +
      "/short &lt;url&gt; &lt;alias&gt; — Свой алиас (⭐ Pro)\n" +
      "/stats &lt;kod&gt; — Статистика ссылки (⭐ Pro)\n" +
      "/mylinks — Последние 10 ссылок\n" +
      "/help — Все команды\n" +
      "/lang — Сменить язык\n" +
      "/unlink — Отвязать аккаунт\n\n" +
      "💡 Отправьте URL, я сокращу его мгновенно!\n\n" +
      "🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    welcome_guest: "👋 <b>Ovlink Bot</b> помогает сокращать длинные URL в короткие ссылки для удобного обмена!\n\n" +
      "📌 <b>Что я умею:</b>\n" +
      "• Сократить любой URL — просто отправьте мне\n" +
      "• Отслеживать количество переходов\n" +
      "• Показывать ваши последние ссылки\n" +
      "• Доступен на 4 языках\n\n" +
      "⚡ <b>Попробуйте:</b> Отправьте мне ссылку!\n\n" +
      "🔑 <b>Привязать аккаунт</b> (необязательно) для управления ссылками на сайте:\n" +
      "<a href=\"{authUrl}\">→ Привязать аккаунт</a>\n\n" +
      "🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    welcome_guest_btn: "🔗 Привязать аккаунт",
    help: "📖 <b>Команды Ovlink Bot</b>\n\n" +
      "/short &lt;url&gt; — Сократить URL\n" +
      "/short &lt;url&gt; &lt;alias&gt; — Свой алиас (⭐ Pro)\n" +
      "/stats &lt;kod&gt; — Статистика (⭐ Pro)\n" +
      "/mylinks — Последние ссылки\n" +
      "/unlink — Отключить аккаунт\n" +
      "/lang — Изменить язык\n" +
      "/upgrade — О Pro тарифе\n\n" +
      "💡 Отправьте URL напрямую для сокращения!\n\n" +
      "🌐 Сайт: <a href=\"{baseUrl}\">ovlink.sbs</a>",
    upgrade: "⭐ <b>Ovlink Pro — $2/мес</b>\n\n" +
      "🆓 Free: 10 ссылок в день\n" +
      "⭐ Pro: 100 ссылок в день + свой алиас + статистика + API\n\n" +
      "🌐 <a href=\"{baseUrl}/pricing\">ovlink.sbs/pricing</a>",
    url_required: "❌ Требуется URL.\nИспользование: /short &lt;url&gt; [алиас]",
    invalid_url: "❌ Неверный URL.",
    daily_limit_reached: "❌ Дневной лимит ({limit}) исчерпан.",
    custom_alias_pro: "❌ Свой алиас доступен только на Pro тарифе. /upgrade",
    invalid_alias: "❌ Неверный алиас (3-50 символов, a-z, 0-9, _, -).",
    alias_taken: "❌ Этот алиас уже занят.",
    db_error: "❌ Ошибка сервера.",
    link_created: "✅ <b>{shortUrl}</b>\n📎 {original}\n\n🌐 Сокращайте больше на <a href=\"{baseUrl}\">ovlink.sbs</a>",
    link_created_guest: "✅ <b>{shortUrl}</b>\n📎 {original}\n\n<i>Чтобы видеть свои ссылки на сайте, привяжите аккаунт с помощью /start</i>\n\n🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    no_links: "📭 Ссылок не найдено.",
    recent_links: "📋 <b>Ваши последние 10 ссылок:</b>\n\n{lines}\n\n🌐 Управляйте ссылками на <a href=\"{baseUrl}\">ovlink.sbs</a>",
    not_linked: "⚠️ Ваш аккаунт не привязан. Используйте /start для привязки.",
    unlinked_success: "✅ Аккаунт отключен.",
    already_unlinked: "⚠️ Аккаунт и так не привязан.",
    stats_pro: "🔒 Статистика доступна только на Pro тарифе. /upgrade",
    stats_code_required: "❌ Требуется код. Использование: /stats &lt;код&gt;",
    stats_not_found: "❌ Ссылка не найдена.",
    stats_detail: "📊 <b>{short}</b>\n" +
      "📎 {original}\n" +
      "👁 Клики: {clicks}\n" +
      "📅 Создана: {created}\n\n" +
      "🌐 Подробная статистика на <a href=\"{baseUrl}\">ovlink.sbs</a>",
    select_lang: "🌐 <b>Select your language / Dil seçin / Выберите язык:</b>",
    lang_updated: "✅ Язык изменен на русский.",
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

function createTelegramBot(db, options = {}) {
  const { buildShortUrl, isProAccessActive, logSecurityEvent } = options;
  const shared = require('./shared').createBotShared(db, options);

  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
  const BOT_USERNAME = (process.env.TELEGRAM_BOT_USERNAME || '').toLowerCase().replace('@', '');
  const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;
  const BASE_URL = process.env.PUBLIC_BASE_URL || 'https://ovlink.sbs';

  if (!BOT_TOKEN) {
    console.warn('[telegram-bot] TELEGRAM_BOT_TOKEN not set; disabled.');
  }

  async function sendMessage(chatId, text, options = {}) {
    if (!BOT_TOKEN) return null;
    try {
      const payload = {
        chat_id: chatId,
        text: text.slice(0, 4096),
        disable_web_page_preview: true,
        parse_mode: 'HTML',
      };
      if (options.replyToMessageId) payload.reply_to_message_id = options.replyToMessageId;
      if (options.keyboard) {
        payload.reply_markup = JSON.stringify({ inline_keyboard: options.keyboard });
      }
      const res = await fetch(`${API_BASE}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return await res.json();
    } catch (err) {
      console.error('[telegram-bot] sendMessage error:', err.message);
      return null;
    }
  }

  async function answerCallbackQuery(callbackQueryId, text) {
    if (!BOT_TOKEN) return null;
    try {
      await fetch(`${API_BASE}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
      });
    } catch (err) {
      console.error('[telegram-bot] answerCallbackQuery error:', err.message);
    }
  }

  function esc(t) {
    return (t || '').toString().replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }

  // --- Command Handlers ---

  async function handleStart(chat, args) {
    const lang = await shared.getBotLanguage('telegram', chat.id);
    const botUser = await shared.getBotUser('telegram', chat.id);
    if (botUser) {
      const isPro = isProAccessActive(botUser);
      const limits = shared.getTierLimits(botUser);
      const dailyCount = await shared.getDailyLinkCount(botUser.user_id);
      const tier = isPro ? '⭐ PRO' : '🆓 Free';
      const text = t(lang, 'welcome_linked', {
        name: esc(chat.first_name),
        tier,
        dailyCount,
        dailyLinks: limits.dailyLinks,
        baseUrl: BASE_URL
      });
      await sendMessage(chat.id, text);
      return;
    }

    const authUrl = `${BASE_URL}/bot/auth?platform=telegram&id=${chat.id}&name=${encodeURIComponent(chat.username || chat.first_name || '')}`;
    const text = t(lang, 'welcome_guest', {
      name: esc(chat.first_name),
      authUrl,
      baseUrl: BASE_URL
    });
    const keyboard = [[{ text: t(lang, 'welcome_guest_btn'), url: authUrl }]];
    await sendMessage(chat.id, text, { replyToMessageId: args.messageId, keyboard });
  }

  async function handleShort(chat, args) {
    const lang = await shared.getBotLanguage('telegram', chat.id);
    const parts = (args.text || '').replace(/^\/short\s*/i, '').trim().split(/\s+/);
    const url = parts[0] || '';
    const alias = parts[1] || '';

    if (!url) {
      await sendMessage(chat.id, t(lang, 'url_required'));
      return;
    }

    const botUser = await shared.getBotUser('telegram', chat.id);
    if (!botUser) {
      await sendMessage(chat.id, t(lang, 'not_linked'));
      return;
    }
    const userId = botUser.user_id;
    const limits = shared.getTierLimits(botUser);

    const dailyCount = await shared.getDailyLinkCount(userId);
    if (dailyCount >= limits.dailyLinks) {
      await sendMessage(chat.id, t(lang, 'daily_limit_reached', { limit: limits.dailyLinks }));
      return;
    }

    if (alias && !limits.customAlias) {
      await sendMessage(chat.id, t(lang, 'custom_alias_pro'));
      return;
    }

    const result = await shared.createShortLink(userId, url, alias || null);
    if (result.error) {
      const errorMap = {
        invalid_url: 'invalid_url',
        invalid_alias: 'invalid_alias',
        alias_taken: 'alias_taken',
        db_error: 'db_error',
      };
      const key = errorMap[result.error] || 'db_error';
      await sendMessage(chat.id, t(lang, key));
      return;
    }

    const shortUrl = `${BASE_URL}/${result.short}`;
    const text = userId
      ? t(lang, 'link_created', { shortUrl, original: esc(result.original.slice(0, 80)), baseUrl: BASE_URL })
      : t(lang, 'link_created_guest', { shortUrl, original: esc(result.original.slice(0, 80)), baseUrl: BASE_URL });
    await sendMessage(chat.id, text, { replyToMessageId: args.messageId });
  }

  async function handlePlainUrl(chat, args) {
    const lang = await shared.getBotLanguage('telegram', chat.id);
    const text = (args.text || '').trim();
    if (!text.match(/^https?:\/\//i) && !text.match(/^[\w.-]+\.[a-z]{2,}/i)) return;

    const botUser = await shared.getBotUser('telegram', chat.id);
    if (!botUser) return;
    const userId = botUser.user_id;
    const limits = shared.getTierLimits(botUser);

    const dailyCount = await shared.getDailyLinkCount(userId);
    if (dailyCount >= limits.dailyLinks) {
      await sendMessage(chat.id, t(lang, 'daily_limit_reached', { limit: limits.dailyLinks }));
      return;
    }

    const result = await shared.createShortLink(userId, text.split(/\s+/)[0]);
    if (result.error) return;

    const shortUrl = `${BASE_URL}/${result.short}`;
    const replyText = userId
      ? t(lang, 'link_created', { shortUrl, original: esc(result.original.slice(0, 80)), baseUrl: BASE_URL })
      : t(lang, 'link_created_guest', { shortUrl, original: esc(result.original.slice(0, 80)), baseUrl: BASE_URL });
    await sendMessage(chat.id, replyText);
  }

  async function handleMyLinks(chat) {
    const lang = await shared.getBotLanguage('telegram', chat.id);
    const botUser = await shared.getBotUser('telegram', chat.id);
    if (!botUser) {
      await sendMessage(chat.id, t(lang, 'not_linked'));
      return;
    }

    return new Promise((resolve) => {
      db.all(
        'SELECT short, original, created_at FROM urls WHERE user_id = ? ORDER BY created_at DESC LIMIT 10',
        [botUser.user_id],
        async (err, rows) => {
          if (err || !rows.length) {
            await sendMessage(chat.id, t(lang, 'no_links'));
            return resolve();
          }
          const lines = rows.map((r, i) =>
            `${i + 1}. ${BASE_URL}/${esc(r.short)} — <code>${esc(r.original.slice(0, 50))}</code>`
          ).join('\n');
          await sendMessage(chat.id, t(lang, 'recent_links', { lines, baseUrl: BASE_URL }));
          resolve();
        }
      );
    });
  }

  async function handleStats(chat, args) {
    const lang = await shared.getBotLanguage('telegram', chat.id);
    const botUser = await shared.getBotUser('telegram', chat.id);
    if (!botUser) return sendMessage(chat.id, t(lang, 'not_linked'));
    if (!isProAccessActive(botUser)) return sendMessage(chat.id, t(lang, 'stats_pro'));

    const shortCode = (args.text || '').replace(/^\/stats\s*/i, '').trim();
    if (!shortCode) return sendMessage(chat.id, t(lang, 'stats_code_required'));

    const stats = await shared.getLinkStats(botUser.user_id, shortCode);
    if (!stats) return sendMessage(chat.id, t(lang, 'stats_not_found'));

    await sendMessage(chat.id, t(lang, 'stats_detail', {
      short: stats.short,
      original: esc(stats.original.slice(0, 60)),
      clicks: stats.total_clicks,
      created: stats.created_at.slice(0, 10),
      baseUrl: BASE_URL
    }));
  }

  async function handleUnlink(chat) {
    const lang = await shared.getBotLanguage('telegram', chat.id);
    const botUser = await shared.getBotUser('telegram', chat.id);
    if (!botUser) return sendMessage(chat.id, t(lang, 'already_unlinked'));
    await shared.unlinkBotUser('telegram', chat.id);
    await sendMessage(chat.id, t(lang, 'unlinked_success'));
  }

  async function handleHelp(chat) {
    const lang = await shared.getBotLanguage('telegram', chat.id);
    await sendMessage(chat.id, t(lang, 'help', { baseUrl: BASE_URL }));
  }

  async function handleUpgrade(chat) {
    const lang = await shared.getBotLanguage('telegram', chat.id);
    await sendMessage(chat.id, t(lang, 'upgrade', { baseUrl: BASE_URL }));
  }

  async function handleLang(chat) {
    const lang = await shared.getBotLanguage('telegram', chat.id);
    const keyboard = [
      [
        { text: '🇬🇧 English', callback_data: 'lang_en' },
        { text: '🇹🇷 Türkçe', callback_data: 'lang_tr' }
      ],
      [
        { text: '🇦🇿 Azərbaycan', callback_data: 'lang_az' },
        { text: '🇷🇺 Русский', callback_data: 'lang_ru' }
      ]
    ];
    await sendMessage(chat.id, t(lang, 'select_lang'), { keyboard });
  }

  // --- Main Router ---

  async function processUpdate(update) {
    // Handle inline button callbacks
    if (update.callback_query) {
      const callbackQueryId = update.callback_query.id;
      const data = update.callback_query.data || '';
      const message = update.callback_query.message;
      if (!message || !message.chat) return;

      if (data.startsWith('lang_')) {
        const selectedLang = data.replace('lang_', '');
        await shared.setBotLanguage('telegram', message.chat.id, selectedLang);
        const successMsg = t(selectedLang, 'lang_updated');
        await answerCallbackQuery(callbackQueryId, successMsg);
        await sendMessage(message.chat.id, successMsg);
      }
      return;
    }

    const message = update.message || update.edited_message;
    if (!message) return;

    const chat = message.chat;
    const text = (message.text || '').trim();
    const messageId = message.message_id;

    if (!text) return;

    const cmd = text.split(/\s+/)[0].toLowerCase().replace('@' + BOT_USERNAME, '');

    switch (cmd) {
      case '/start': return handleStart(chat, { text, messageId });
      case '/short': return handleShort(chat, { text, messageId });
      case '/mylinks': return handleMyLinks(chat);
      case '/stats': return handleStats(chat, { text, messageId });
      case '/help': return handleHelp(chat);
      case '/unlink': return handleUnlink(chat);
      case '/upgrade': return handleUpgrade(chat);
      case '/lang':
      case '/language':
        return handleLang(chat);
      default:
        if (text.match(/^https?:\/\//i) || text.match(/^[\w.-]+\.[a-z]{2,}/i)) {
          return handlePlainUrl(chat, { text, messageId });
        }
    }
  }

  async function setWebhook(webhookUrl, secretToken) {
    if (!BOT_TOKEN) return false;
    try {
      const payload = { url: webhookUrl, allowed_updates: ['message', 'callback_query'] };
      if (secretToken) payload.secret_token = secretToken;
      const res = await fetch(`${API_BASE}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      console.log('[telegram-bot] webhook:', data.ok ? 'set' : data.description);
      return data.ok;
    } catch (err) {
      console.error('[telegram-bot] webhook error:', err.message);
      return false;
    }
  }

  return { processUpdate, setWebhook, isEnabled: !!BOT_TOKEN };
}

module.exports = { createTelegramBot };
