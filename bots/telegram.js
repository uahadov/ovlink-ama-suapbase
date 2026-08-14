const QRCode = require('qrcode');

const TRANSLATIONS = {
  en: {
    welcome_linked: "👋 Welcome back, <b>{name}</b>!\n\n🔗 <b>Ovlink Bot</b> — {tier}\n📊 Daily limit: {dailyLinks} links\n📈 Today: {dailyCount}/{dailyLinks} used\n\n📌 <b>Commands:</b>\n/short &lt;url&gt; — Shorten URL\n/qr &lt;url/code&gt; — Generate QR code\n/limit — Check remaining limits\n/mylinks — Your recent links\n/search &lt;query&gt; — Search your links\n/export — Export your links\n/delete &lt;code&gt; — Delete a link\n/stats &lt;code&gt; — Link stats (⭐ Pro)\n/help — All commands\n/lang — Language\n/unlink — Disconnect\n\n💡 Send URLs directly to shorten!\n\n🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    welcome_guest: "👋 <b>Ovlink Bot</b> — Fast URL shortener!\n\n📌 <b>Features:</b>\n• Shorten any URL (Guest: 5 links/day)\n• QR code generation\n• 4 languages\n\n⚡ Send me a link to test!\n\n🔑 <b>Link account</b> for 50 links/day & Dashboard:\n<a href=\"{authUrl}\">→ Link Account</a>\n\n🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    welcome_guest_btn: "🔗 Link Account",
    help: "📖 <b>Ovlink Bot Commands:</b>\n/short &lt;url&gt; — Shorten URL\n/qr &lt;url/code&gt; — Generate QR Code\n/limit — View daily limits\n/mylinks — Recent links\n/search &lt;query&gt; — Search links\n/export — Export links\n/delete &lt;code&gt; — Delete link\n/stats &lt;code&gt; — Statistics (⭐ Pro)\n/unlink — Disconnect\n/lang — Language\n/upgrade — Pro info\n\n🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    upgrade: "⭐ <b>Ovlink Pro — $2/month</b>\n\n🆓 Free: 50 links/day + 5 bulk\n⭐ Pro: 500 links/day + 50 bulk + alias + stats\n\n🌐 <a href=\"{baseUrl}/pricing\">ovlink.sbs/pricing</a>",
    url_required: "❌ URL is required. Usage: /short <url>",
    invalid_url: "❌ Invalid URL.",
    daily_limit_reached: "❌ Daily limit ({limit}) reached.",
    guest_limit_reached: "⚠️ Guest daily limit (5/5) reached. Link account with /start for 50 links/day!",
    bulk_guest_blocked: "⚠️ Bulk shortening requires a linked account. Use /start to link.",
    bulk_limit_exceeded: "⚠️ Max {max} links at once!",
    phishing_detected: "🚨 Security Alert: Link blocked (phishing/malware).",
    custom_alias_pro: "❌ Custom alias requires Pro plan. /upgrade",
    invalid_alias: "❌ Invalid alias (3-50 chars).",
    alias_taken: "❌ Alias already in use.",
    db_error: "❌ Server error.",
    link_created: "✅ <b>{shortUrl}</b>\n📎 {original}\n\n🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    link_created_guest: "✅ <b>{shortUrl}</b>\n📎 {original}\n\n<i>Link account with /start for 50/day</i>\n\n🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    no_links: "📭 No links found.",
    recent_links: "📋 <b>Your Recent Links:</b>\n\n{lines}\n\n🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    not_linked: "⚠️ Account not linked. Use /start.",
    unlinked_success: "✅ Account disconnected.",
    already_unlinked: "⚠️ Not linked.",
    deleted_success: "🗑️ Link /{short} deleted.",
    qr_btn: "📷 QR Code",
    del_btn: "🗑️ Delete",
    stats_pro: "🔒 Stats require Pro plan. /upgrade",
    stats_code_required: "❌ Code required. /stats <code>",
    stats_not_found: "❌ Link not found.",
    stats_detail: "📊 <b>{short}</b>\n📎 {original}\n👁 Clicks: {clicks}\n📅 Created: {created}\n\n🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    select_lang: "🌐 <b>Select language / Dil seçin / Выберите язык:</b>",
    lang_updated: "✅ Language updated to English."
  },
  tr: {
    welcome_linked: "👋 Tekrar hoş geldin, <b>{name}</b>!\n\n🔗 <b>Ovlink Bot</b> — {tier}\n📊 Günlük limit: {dailyLinks} link\n📈 Bugün: {dailyCount}/{dailyLinks} kullanıldı\n\n📌 <b>Komutlar:</b>\n/short &lt;url&gt; — Link kısalt\n/qr &lt;url/kod&gt; — QR kod oluştur\n/limit — Kalan limitleri gör\n/mylinks — Son linklerin\n/search &lt;arama&gt; — Linklerde ara\n/export — Linkleri dışa aktar\n/delete &lt;kod&gt; — Link sil\n/stats &lt;kod&gt; — İstatistik (⭐ Pro)\n/help — Tüm komutlar\n/lang — Dil değiştir\n/unlink — Hesabı ayır\n\n💡 URL gönder, anında kısaltayım!\n\n🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    welcome_guest: "👋 <b>Ovlink Bot</b> — Hızlı Link Kısaltıcı!\n\n📌 <b>Özellikler:</b>\n• Herhangi bir linki kısalt (Misafir: 5 link/gün)\n• QR kod oluşturma\n• 4 dil desteği\n\n⚡ Denemek için bir link gönder!\n\n🔑 <b>Hesabını bağla</b> (Günde 50 link + Panel):\n<a href=\"{authUrl}\">→ Hesabımı Bağla</a>\n\n🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    welcome_guest_btn: "🔗 Hesabımı Bağla",
    help: "📖 <b>Ovlink Bot Komutları:</b>\n/short &lt;url&gt; — Link kısalt\n/qr &lt;url/kod&gt; — QR kod oluştur\n/limit — Günlük limitleri gör\n/mylinks — Son linkler\n/search &lt;kelime&gt; — Link ara\n/export — Linkleri listele\n/delete &lt;kod&gt; — Link sil\n/stats &lt;kod&gt; — İstatistik (⭐ Pro)\n/unlink — Hesabı ayır\n/lang — Dil değiştir\n/upgrade — Pro bilgi\n\n🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    upgrade: "⭐ <b>Ovlink Pro — $2/ay</b>\n\n🆓 Ücretsiz: Günde 50 link + 5 toplu\n⭐ Pro: Günde 500 link + 50 toplu + alias + istatistik\n\n🌐 <a href=\"{baseUrl}/pricing\">ovlink.sbs/pricing</a>",
    url_required: "❌ URL gerekli. Kullanım: /short <url>",
    invalid_url: "❌ Geçersiz URL.",
    daily_limit_reached: "❌ Günlük limit ({limit}) doldu.",
    guest_limit_reached: "⚠️ Misafir günlük limitiniz (5/5) doldu. Günde 50 link için /start ile hesabınızı bağlayın!",
    bulk_guest_blocked: "⚠️ Toplu kısaltma için hesabınızı bağlayın. /start yazabilirsiniz.",
    bulk_limit_exceeded: "⚠️ Tek seferde en fazla {max} link kısaltabilirsiniz!",
    phishing_detected: "🚨 Güvenlik Uyarısı: Bağlantı engellendi (zararlı/phishing).",
    custom_alias_pro: "❌ Özel alias Pro plan gerektirir. /upgrade",
    invalid_alias: "❌ Geçersiz alias (3-50 karakter).",
    alias_taken: "❌ Alias zaten kullanımda.",
    db_error: "❌ Sunucu hatası.",
    link_created: "✅ <b>{shortUrl}</b>\n📎 {original}\n\n🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    link_created_guest: "✅ <b>{shortUrl}</b>\n📎 {original}\n\n<i>Limiti 50'ye çıkarmak için /start ile bağla</i>\n\n🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    no_links: "📭 Henüz link yok.",
    recent_links: "📋 <b>Son Linkleriniz:</b>\n\n{lines}\n\n🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    not_linked: "⚠️ Hesabınız bağlı değil. /start ile bağlayın.",
    unlinked_success: "✅ Hesap ayrıldı.",
    already_unlinked: "⚠️ Zaten bağlı değil.",
    deleted_success: "🗑️ /{short} linki silindi.",
    qr_btn: "📷 QR Kodu Al",
    del_btn: "🗑️ Sil",
    stats_pro: "🔒 İstatistikler Pro plan gerektirir. /upgrade",
    stats_code_required: "❌ Kod gerekli. /stats <kod>",
    stats_not_found: "❌ Bulunamadı.",
    stats_detail: "📊 <b>{short}</b>\n📎 {original}\n👁 Tıklama: {clicks}\n📅 Oluşturulma: {created}\n\n🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    select_lang: "🌐 <b>Select language / Dil seçin / Выберите язык:</b>",
    lang_updated: "✅ Dil Türkçe olarak güncellendi."
  },
  az: {
    welcome_linked: "👋 Xoş gəldiniz, <b>{name}</b>!\n\n🔗 <b>Ovlink Bot</b> — {tier}\n📊 Gündəlik limit: {dailyLinks} link\n📈 Bu gün: {dailyCount}/{dailyLinks} istifadə edilib\n\n📌 <b>Komandalar:</b>\n/short &lt;url&gt; — Link qısalt\n/qr &lt;url/kod&gt; — QR kod yarat\n/limit — Gündəlik limit vəziyyəti\n/mylinks — Son linkləriniz\n/search &lt;axtarış&gt; — Linklərdə axtarış\n/export — Linkləri ixrac et\n/delete &lt;kod&gt; — Link sil\n/stats &lt;kod&gt; — Statistika (⭐ Pro)\n/help — Bütün komandalar\n/lang — Dil dəyişdir\n/unlink — Hesabı ayır\n\n💡 URL göndərin, dərhal qısaldım!\n\n🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    welcome_guest: "👋 <b>Ovlink Bot</b> — Sürətli Link Qısaldıcı!\n\n📌 <b>Xüsusiyyətlər:</b>\n• İstənilən linki qısalt (Qonaq: 5 link/gün)\n• QR kod generasiyası\n• 4 dil dəstəyi\n\n⚡ Yoxlamaq üçün link göndərin!\n\n🔑 <b>Hesabınızı bağlayın</b> (Gündə 50 link + Panel):\n<a href=\"{authUrl}\">→ Hesabımı Bağla</a>\n\n🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    welcome_guest_btn: "🔗 Hesabımı Bağla",
    help: "📖 <b>Ovlink Bot Komandaları:</b>\n/short &lt;url&gt; — Link qısalt\n/qr &lt;url/kod&gt; — QR kod yarat\n/limit — Gündəlik limitlər\n/mylinks — Son linklər\n/search &lt;söz&gt; — Linklərdə axtarış\n/export — Linkləri göstər\n/delete &lt;kod&gt; — Link sil\n/stats &lt;kod&gt; — Statistika (⭐ Pro)\n/unlink — Hesabı ayır\n/lang — Dil dəyişdir\n/upgrade — Pro haqqında\n\n🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    upgrade: "⭐ <b>Ovlink Pro — $2/ay</b>\n\n🆓 Pulsuz: Gündə 50 link + 5 toplu\n⭐ Pro: Gündə 500 link + 50 toplu + alias + statistika\n\n🌐 <a href=\"{baseUrl}/pricing\">ovlink.sbs/pricing</a>",
    url_required: "❌ URL tələb olunur. İstifadəsi: /short <url>",
    invalid_url: "❌ Keçərsiz URL.",
    daily_limit_reached: "❌ Gündəlik limit ({limit}) doldu.",
    guest_limit_reached: "⚠️ Qonaq günlük limitiniz (5/5) doldu. Gündə 50 link üçün /start ilə hesabınızı bağlayın!",
    bulk_guest_blocked: "⚠️ Toplu qısaltmaq üçün hesabınızı bağlayın. /start ilə bağlayın.",
    bulk_limit_exceeded: "⚠️ Bir dəfəyə ən çox {max} link qısalda bilərsiniz!",
    phishing_detected: "🚨 Təhlükəsizlik Xəbərdarlığı: Link bloklandı (zərərli/phishing).",
    custom_alias_pro: "❌ Xüsusi alias Pro plan tələb edir. /upgrade",
    invalid_alias: "❌ Keçərsiz alias (3-50 simvol).",
    alias_taken: "❌ Bu alias artıq istifadə olunur.",
    db_error: "❌ Server xətası.",
    link_created: "✅ <b>{shortUrl}</b>\n📎 {original}\n\n🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    link_created_guest: "✅ <b>{shortUrl}</b>\n📎 {original}\n\n<i>Limiti 50-yə çıxarmaq üçün /start ilə bağlayın</i>\n\n🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    no_links: "📭 Hələ ki, link yoxdur.",
    recent_links: "📋 <b>Son Linkləriniz:</b>\n\n{lines}\n\n🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    not_linked: "⚠️ Hesabınız bağlı deyil. /start ilə bağlayın.",
    unlinked_success: "✅ Hesab ayrıldı.",
    already_unlinked: "⚠️ Onsuz da bağlı deyil.",
    deleted_success: "🗑️ /{short} linki silindi.",
    qr_btn: "📷 QR Kodu Al",
    del_btn: "🗑️ Sil",
    stats_pro: "🔒 Statistika Pro plan tələb edir. /upgrade",
    stats_code_required: "❌ Kod tələb olunur. /stats <kod>",
    stats_not_found: "❌ Tapılmadı.",
    stats_detail: "📊 <b>{short}</b>\n📎 {original}\n👁 Klik: {clicks}\n📅 Tarix: {created}\n\n🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    select_lang: "🌐 <b>Select language / Dil seçin / Выберите язык:</b>",
    lang_updated: "✅ Dil Azərbaycan dili olaraq yeniləndi."
  },
  ru: {
    welcome_linked: "👋 С возвращением, <b>{name}</b>!\n\n🔗 <b>Ovlink Bot</b> — {tier}\n📊 Лимит: {dailyLinks} ссылок/день\n📈 Сегодня: {dailyCount}/{dailyLinks} использовано\n\n📌 <b>Команды:</b>\n/short &lt;url&gt; — Сократить URL\n/qr &lt;url/код&gt; — QR код\n/limit — Проверить лимиты\n/mylinks — Последние ссылки\n/search &lt;поиск&gt; — Поиск по ссылкам\n/export — Экспорт ссылок\n/delete &lt;код&gt; — Удалить ссылку\n/stats &lt;код&gt; — Статистика (⭐ Pro)\n/help — Все команды\n/lang — Язык\n/unlink — Отвязать\n\n💡 Отправьте ссылки для сокращения!\n\n🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    welcome_guest: "👋 <b>Ovlink Bot</b> — Сервис сокращения ссылок!\n\n📌 <b>Возможности:</b>\n• Сократить ссылку (Гость: 5 в день)\n• Генерация QR кодов\n• 4 языка\n\n⚡ Отправьте ссылку для проверки!\n\n🔑 <b>Привязать аккаунт</b> (50 ссылок в день + панель):\n<a href=\"{authUrl}\">→ Привязать аккаунт</a>\n\n🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    welcome_guest_btn: "🔗 Привязать аккаунт",
    help: "📖 <b>Команды Ovlink Bot:</b>\n/short &lt;url&gt; — Сократить URL\n/qr &lt;url/код&gt; — QR код\n/limit — Лимиты\n/mylinks — Последние ссылки\n/search &lt;слово&gt; — Поиск ссылок\n/export — Список ссылок\n/delete &lt;код&gt; — Удалить ссылку\n/stats &lt;код&gt; — Статистика (⭐ Pro)\n/unlink — Отвязать\n/lang — Язык\n/upgrade — Pro тариф\n\n🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    upgrade: "⭐ <b>Ovlink Pro — $2/мес</b>\n\n🆓 Бесплатно: 50 ссылок в день + 5 пачкой\n⭐ Pro: 500 ссылок в день + 50 пачкой + алиас + статистика\n\n🌐 <a href=\"{baseUrl}/pricing\">ovlink.sbs/pricing</a>",
    url_required: "❌ Требуется URL. /short <url>",
    invalid_url: "❌ Неверный URL.",
    daily_limit_reached: "❌ Дневной лимит ({limit}) исчерпан.",
    guest_limit_reached: "⚠️ Гостевой лимит (5/5) исчерпан. Привяжите аккаунт через /start для 50 ссылок/день!",
    bulk_guest_blocked: "⚠️ Массовое сокращение доступно после привязки аккаунта.",
    bulk_limit_exceeded: "⚠️ Максимум {max} ссылок за раз!",
    phishing_detected: "🚨 Ссылка заблокирована (фишинг/вредоносное ПО).",
    custom_alias_pro: "❌ Свой алиас доступен в Pro. /upgrade",
    invalid_alias: "❌ Неверный алиас (3-50 симв.).",
    alias_taken: "❌ Алиас уже занят.",
    db_error: "❌ Ошибка сервера.",
    link_created: "✅ <b>{shortUrl}</b>\n📎 {original}\n\n🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    link_created_guest: "✅ <b>{shortUrl}</b>\n📎 {original}\n\n<i>Для 50 ссылок в день используйте /start</i>\n\n🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    no_links: "📭 Ссылок пока нет.",
    recent_links: "📋 <b>Ваши последние ссылки:</b>\n\n{lines}\n\n🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    not_linked: "⚠️ Аккаунт не привязан. Используйте /start.",
    unlinked_success: "✅ Аккаунт отключен.",
    already_unlinked: "⚠️ Не привязан.",
    deleted_success: "🗑️ Ссылка /{short} удалена.",
    qr_btn: "📷 QR Код",
    del_btn: "🗑️ Удалить",
    stats_pro: "🔒 Статистика в тарифе Pro. /upgrade",
    stats_code_required: "❌ Укажите код. /stats <код>",
    stats_not_found: "❌ Ссылка не найдена.",
    stats_detail: "📊 <b>{short}</b>\n📎 {original}\n👁 Кликов: {clicks}\n📅 Создана: {created}\n\n🌐 <a href=\"{baseUrl}\">ovlink.sbs</a>",
    select_lang: "🌐 <b>Select language / Dil seçin / Выберите язык:</b>",
    lang_updated: "✅ Язык изменен на Русский."
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
  const { isProAccessActive } = options;
  const shared = require('./shared').createBotShared(db, options);

  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
  const BOT_USERNAME = (process.env.TELEGRAM_BOT_USERNAME || '').toLowerCase().replace('@', '');
  const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;
  const BASE_URL = process.env.PUBLIC_BASE_URL || 'https://ovlink.sbs';

  async function sendMessage(chatId, text, opts = {}) {
    if (!BOT_TOKEN) return null;
    try {
      const payload = {
        chat_id: chatId,
        text: text.slice(0, 4096),
        disable_web_page_preview: true,
        parse_mode: 'HTML'
      };
      if (opts.replyToMessageId) payload.reply_to_message_id = opts.replyToMessageId;
      if (opts.keyboard) payload.reply_markup = JSON.stringify({ inline_keyboard: opts.keyboard });
      const res = await fetch(`${API_BASE}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      return await res.json();
    } catch (err) {
      console.error('[telegram-bot] sendMessage error:', err.message);
      return null;
    }
  }

  async function sendPhoto(chatId, imageBuffer, caption = '', opts = {}) {
    if (!BOT_TOKEN) return null;
    try {
      const formData = new FormData();
      formData.append('chat_id', String(chatId));
      if (caption) {
        formData.append('caption', caption);
        formData.append('parse_mode', 'HTML');
      }
      formData.append('photo', new Blob([imageBuffer], { type: 'image/png' }), 'qr.png');
      if (opts.replyToMessageId) formData.append('reply_to_message_id', String(opts.replyToMessageId));
      const res = await fetch(`${API_BASE}/sendPhoto`, { method: 'POST', body: formData });
      return await res.json();
    } catch (err) {
      console.error('[telegram-bot] sendPhoto error:', err.message);
      return null;
    }
  }

  async function answerCallbackQuery(callbackQueryId, text) {
    if (!BOT_TOKEN) return;
    try {
      await fetch(`${API_BASE}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId, text })
      });
    } catch (e) {}
  }

  function esc(t) {
    return (t || '').toString().replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }

  async function handleStart(chat, args) {
    const lang = await shared.getBotLanguage('telegram', chat.id);
    const botUser = await shared.getBotUser('telegram', chat.id);
    if (botUser) {
      const isPro = isProAccessActive ? isProAccessActive(botUser) : false;
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
    const text = t(lang, 'welcome_guest', { name: esc(chat.first_name), authUrl, baseUrl: BASE_URL });
    const keyboard = [[{ text: t(lang, 'welcome_guest_btn'), url: authUrl }]];
    await sendMessage(chat.id, text, { replyToMessageId: args.messageId, keyboard });
  }

  const guestDailyMap = new Map();

  function getGuestDailyCount(chatId) {
    const key = `${chatId}:${new Date().toISOString().slice(0, 10)}`;
    return guestDailyMap.get(key) || 0;
  }

  function incrementGuestDailyCount(chatId, count = 1) {
    const key = `${chatId}:${new Date().toISOString().slice(0, 10)}`;
    const cur = guestDailyMap.get(key) || 0;
    guestDailyMap.set(key, cur + count);
  }

  function extractUrls(text) {
    const matches = (text || '').match(/(https?:\/\/[^\s]+|[\w.-]+\.[a-z]{2,}[^\s]*)/gi) || [];
    return [...new Set(matches.map(u => u.trim()))];
  }

  async function handleShort(chat, args) {
    const lang = await shared.getBotLanguage('telegram', chat.id);
    const rawText = (args.text || '').replace(/^\/short\s*/i, '').trim();
    const foundUrls = extractUrls(rawText);

    if (!foundUrls.length) {
      await sendMessage(chat.id, t(lang, 'url_required'));
      return;
    }

    const botUser = await shared.getBotUser('telegram', chat.id);
    const isPro = botUser && isProAccessActive ? isProAccessActive(botUser) : false;

    if (foundUrls.length > 1) {
      if (!botUser) {
        await sendMessage(chat.id, t(lang, 'bulk_guest_blocked'));
        return;
      }
      const maxBulk = isPro ? 50 : 5;
      if (foundUrls.length > maxBulk) {
        await sendMessage(chat.id, t(lang, 'bulk_limit_exceeded', { max: maxBulk }));
        return;
      }
      const userId = botUser.user_id;
      const limits = shared.getTierLimits(botUser);
      const dailyCount = await shared.getDailyLinkCount(userId);

      if (dailyCount + foundUrls.length > limits.dailyLinks) {
        await sendMessage(chat.id, t(lang, 'daily_limit_reached', { limit: limits.dailyLinks }));
        return;
      }

      const results = [];
      for (let i = 0; i < foundUrls.length; i++) {
        const u = foundUrls[i];
        const res = await shared.createShortLink(userId, u);
        if (res && res.short) {
          results.push(`${i + 1}. 🔗 <b>${BASE_URL}/${res.short}</b>\n   📎 <code>${esc(res.original.slice(0, 45))}</code>`);
        }
      }
      const summaryText = `📦 <b>${results.length}/${foundUrls.length} Toplu Link Kısaltıldı:</b>\n\n` +
        results.join('\n\n') + `\n\n🌐 <a href="${BASE_URL}">ovlink.sbs</a>`;
      await sendMessage(chat.id, summaryText, { replyToMessageId: args.messageId });
      return;
    }

    const parts = rawText.split(/\s+/);
    const url = parts[0] || '';
    const alias = parts[1] || '';

    const userId = botUser ? botUser.user_id : null;
    const limits = botUser ? shared.getTierLimits(botUser) : { dailyLinks: 5, maxLinks: 50, customAlias: false };

    if (userId) {
      const dailyCount = await shared.getDailyLinkCount(userId);
      if (dailyCount >= limits.dailyLinks) {
        await sendMessage(chat.id, t(lang, 'daily_limit_reached', { limit: limits.dailyLinks }));
        return;
      }
    } else {
      const guestCount = getGuestDailyCount(chat.id);
      if (guestCount >= 5) {
        await sendMessage(chat.id, t(lang, 'guest_limit_reached', { limit: 5 }));
        return;
      }
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
        phishing_detected: 'phishing_detected',
        db_error: 'db_error',
      };
      const key = errorMap[result.error] || 'db_error';
      await sendMessage(chat.id, t(lang, key));
      return;
    }

    if (!userId) incrementGuestDailyCount(chat.id);

    const shortUrl = `${BASE_URL}/${result.short}`;
    const text = userId
      ? t(lang, 'link_created', { shortUrl, original: esc(result.original.slice(0, 80)), baseUrl: BASE_URL })
      : t(lang, 'link_created_guest', { shortUrl, original: esc(result.original.slice(0, 80)), baseUrl: BASE_URL });

    const keyboard = [[{ text: t(lang, 'qr_btn'), callback_data: `qr_${result.short}` }]];
    await sendMessage(chat.id, text, { replyToMessageId: args.messageId, keyboard });
  }

  async function handlePlainUrl(chat, args) {
    const rawText = (args.text || '').trim();
    if (!extractUrls(rawText).length) return;
    return handleShort(chat, { text: rawText, messageId: args.messageId });
  }

  async function handleMyLinks(chat) {
    const lang = await shared.getBotLanguage('telegram', chat.id);
    const botUser = await shared.getBotUser('telegram', chat.id);
    if (!botUser) return sendMessage(chat.id, t(lang, 'not_linked'));

    return new Promise((resolve) => {
      db.all(
        'SELECT short, original, created_at FROM urls WHERE user_id = ? ORDER BY created_at DESC LIMIT 10',
        [botUser.user_id],
        async (err, rows) => {
          if (err || !rows.length) {
            await sendMessage(chat.id, t(lang, 'no_links'));
            return resolve();
          }
          const lines = rows.map((r, i) => `${i + 1}. <b>${BASE_URL}/${esc(r.short)}</b>\n   📎 <code>${esc(r.original.slice(0, 45))}</code>`).join('\n\n');
          const keyboard = rows.slice(0, 5).map(r => ([
            { text: `📷 QR: /${r.short}`, callback_data: `qr_${r.short}` },
            { text: `🗑️ Sil: /${r.short}`, callback_data: `del_${r.short}` }
          ]));
          await sendMessage(chat.id, t(lang, 'recent_links', { lines, baseUrl: BASE_URL }), { keyboard });
          resolve();
        }
      );
    });
  }

  async function handleQrCommand(chat, args) {
    const lang = await shared.getBotLanguage('telegram', chat.id);
    const raw = (args.text || '').replace(/^\/qr\s*/i, '').trim();
    if (!raw) {
      const usage = lang === 'az'
        ? '📱 <b>QR Kod Yaratmaq:</b>\nİstifadə: <code>/qr &lt;url və ya qısa kod&gt;</code>\nNümunə: <code>/qr https://google.com</code>'
        : (lang === 'tr'
          ? '📱 <b>QR Kod Oluşturma:</b>\nKullanım: <code>/qr &lt;url veya kısa kod&gt;</code>\nÖrnek: <code>/qr https://google.com</code>'
          : '📱 <b>Generate QR Code:</b>\nUsage: <code>/qr &lt;url or short code&gt;</code>\nExample: <code>/qr https://google.com</code>');
      return sendMessage(chat.id, usage);
    }

    let targetUrl = raw;
    if (!/^https?:\/\//i.test(raw)) {
      const shortCode = raw.split('/').pop().trim();
      targetUrl = `${BASE_URL}/${shortCode}`;
    }

    try {
      const qrBuffer = await QRCode.toBuffer(targetUrl, {
        errorCorrectionLevel: 'M',
        type: 'png',
        margin: 2,
        width: 400,
        color: { dark: '#0f172a', light: '#ffffff' }
      });
      await sendPhoto(chat.id, qrBuffer, `📱 <b>${esc(targetUrl)}</b>\n\n🌐 <a href="${BASE_URL}">ovlink.sbs</a>`, { replyToMessageId: args.messageId });
    } catch (err) {
      await sendMessage(chat.id, '❌ QR kod yaradıla bilmədi.');
    }
  }

  async function handleLimitsCommand(chat) {
    const lang = await shared.getBotLanguage('telegram', chat.id);
    const botUser = await shared.getBotUser('telegram', chat.id);
    if (!botUser) {
      const guestCount = getGuestDailyCount(chat.id);
      const authUrl = `${BASE_URL}/bot/auth?platform=telegram&id=${chat.id}&name=${encodeURIComponent(chat.username || chat.first_name || '')}`;
      const msg = lang === 'az'
        ? `📊 <b>Limit Vəziyyətiniz (Qonaq):</b>\n\n• Gündəlik Limit: <b>5 link</b>\n• Bu gün istifadə edilən: <b>${guestCount}/5</b>\n• Toplu Qısaltma: ❌ (Hesab tələb olunur)\n\n🔑 <i>Limiti 50-yə qaldırmaq və Paneldən idarə etmək üçün hesabınızı bağlayın:</i>\n<a href="${authUrl}">→ Hesabımı Bağla</a>`
        : (lang === 'tr'
          ? `📊 <b>Limit Durumunuz (Misafir):</b>\n\n• Günlük Limit: <b>5 link</b>\n• Bugün kullanılan: <b>${guestCount}/5</b>\n• Toplu Kısaltma: ❌ (Hesap gerekli)\n\n🔑 <i>Limiti 50'ye yükseltmek ve Paneli kullanmak için hesabınızı bağlayın:</i>\n<a href="${authUrl}">→ Hesabımı Bağla</a>`
          : `📊 <b>Your Limits (Guest):</b>\n\n• Daily Limit: <b>5 links</b>\n• Used today: <b>${guestCount}/5</b>\n• Bulk shorten: ❌ (Account required)\n\n🔑 <i>Link account for 50 links/day & Dashboard:</i>\n<a href="${authUrl}">→ Link Account</a>`);
      const keyboard = [[{ text: t(lang, 'welcome_guest_btn'), url: authUrl }]];
      return sendMessage(chat.id, msg, { keyboard });
    }

    const isPro = isProAccessActive ? isProAccessActive(botUser) : false;
    const limits = shared.getTierLimits(botUser);
    const dailyCount = await shared.getDailyLinkCount(botUser.user_id);
    const tier = isPro ? '⭐ PRO Plan' : '🆓 Free Plan';

    const msg = lang === 'az'
      ? `📊 <b>Hesab Limitləriniz (${tier}):</b>\n\n• Gündəlik Limit: <b>${limits.dailyLinks} link</b>\n• Bu gün istifadə edilən: <b>${dailyCount}/${limits.dailyLinks}</b>\n• Tək Səfərdə Toplu: <b>${limits.bulkLimit} link</b>\n• Ümumi Maksimum Link: <b>${limits.maxLinks}</b>\n• Xüsusi Alias: <b>${limits.customAlias ? '✅ Aktiv' : '❌ Pro Tələb Olunur'}</b>\n\n` +
        (isPro ? `👑 <i>Pro abunəliyiniz aktivdir.</i>` : `⭐ <i>Gündə 500 link və xüsusi alias üçün /upgrade yazın.</i>\n🌐 <a href="${BASE_URL}/pricing">ovlink.sbs/pricing</a>`)
      : (lang === 'tr'
        ? `📊 <b>Hesap Limitleriniz (${tier}):</b>\n\n• Günlük Limit: <b>${limits.dailyLinks} link</b>\n• Bugün kullanılan: <b>${dailyCount}/${limits.dailyLinks}</b>\n• Tek Seferde Toplu: <b>${limits.bulkLimit} link</b>\n• Toplam Maksimum Link: <b>${limits.maxLinks}</b>\n• Özel Alias: <b>${limits.customAlias ? '✅ Aktif' : '❌ Pro Gerekli'}</b>\n\n` +
          (isPro ? `👑 <i>Pro üyeliğiniz aktif.</i>` : `⭐ <i>Günde 500 link ve özel alias için /upgrade yazın.</i>\n🌐 <a href="${BASE_URL}/pricing">ovlink.sbs/pricing</a>`)
        : `📊 <b>Account Limits (${tier}):</b>\n\n• Daily Limit: <b>${limits.dailyLinks} links</b>\n• Used today: <b>${dailyCount}/${limits.dailyLinks}</b>\n• Bulk at once: <b>${limits.bulkLimit} links</b>\n• Total Max Links: <b>${limits.maxLinks}</b>\n• Custom Alias: <b>${limits.customAlias ? '✅ Active' : '❌ Pro Required'}</b>\n\n` +
          (isPro ? `👑 <i>Pro subscription is active.</i>` : `⭐ <i>For 500 links/day and custom alias, type /upgrade</i>\n🌐 <a href="${BASE_URL}/pricing">ovlink.sbs/pricing</a>`));

    await sendMessage(chat.id, msg);
  }

  async function handleExportCommand(chat) {
    const lang = await shared.getBotLanguage('telegram', chat.id);
    const botUser = await shared.getBotUser('telegram', chat.id);
    if (!botUser) return sendMessage(chat.id, t(lang, 'not_linked'));

    db.all('SELECT short, original, created_at FROM urls WHERE user_id = ? ORDER BY created_at DESC LIMIT 20', [botUser.user_id], async (err, rows) => {
      if (err || !rows || !rows.length) {
        return sendMessage(chat.id, t(lang, 'no_links'));
      }

      const summary = `📁 <b>Linklərinizin Siyahısı (${rows.length}):</b>\n\n` +
        rows.map((r, i) => `${i + 1}. 🔗 <b>${BASE_URL}/${esc(r.short)}</b>\n   📎 <code>${esc(r.original.slice(0, 45))}</code>\n   📅 <i>${(r.created_at || '').slice(0, 10)}</i>`).join('\n\n') +
        `\n\n🌐 <a href="${BASE_URL}/dashboard">Panelə Get & CSV İndir</a>`;

      await sendMessage(chat.id, summary);
    });
  }

  async function handleSearchCommand(chat, args) {
    const lang = await shared.getBotLanguage('telegram', chat.id);
    const botUser = await shared.getBotUser('telegram', chat.id);
    if (!botUser) return sendMessage(chat.id, t(lang, 'not_linked'));

    const query = (args.text || '').replace(/^\/search\s*/i, '').trim();
    if (!query) {
      return sendMessage(chat.id, '🔍 Axtarış üçün söz yazın. Nümunə: <code>/search youtube</code>');
    }

    const searchPattern = `%${query}%`;
    db.all(
      'SELECT short, original, created_at FROM urls WHERE user_id = ? AND (short LIKE ? OR original LIKE ?) ORDER BY created_at DESC LIMIT 8',
      [botUser.user_id, searchPattern, searchPattern],
      async (err, rows) => {
        if (err || !rows || !rows.length) {
          return sendMessage(chat.id, `🔍 "<b>${esc(query)}</b>" üzrə heç bir link tapılmadı.`);
        }

        const lines = rows.map((r, i) => `${i + 1}. 🔗 <b>${BASE_URL}/${esc(r.short)}</b>\n   📎 <code>${esc(r.original.slice(0, 45))}</code>`).join('\n\n');
        const keyboard = rows.slice(0, 4).map(r => ([
          { text: `📷 QR: /${r.short}`, callback_data: `qr_${r.short}` },
          { text: `🗑️ Sil: /${r.short}`, callback_data: `del_${r.short}` }
        ]));

        await sendMessage(chat.id, `🔍 "<b>${esc(query)}</b>" Axtarış Nəticələri (${rows.length}):\n\n${lines}\n\n🌐 <a href="${BASE_URL}">ovlink.sbs</a>`, { keyboard });
      }
    );
  }

  async function handleDeleteCommand(chat, args) {
    const lang = await shared.getBotLanguage('telegram', chat.id);
    const botUser = await shared.getBotUser('telegram', chat.id);
    if (!botUser) return sendMessage(chat.id, t(lang, 'not_linked'));

    const raw = (args.text || '').replace(/^\/(delete|del)\s*/i, '').trim();
    const shortCode = raw.split('/').pop().trim();
    if (!shortCode) {
      return sendMessage(chat.id, '❌ Silmək istədiyiniz qısa kodu yazın. Nümunə: <code>/delete ab12cd</code>');
    }

    db.run('DELETE FROM urls WHERE short = ? AND user_id = ?', [shortCode, botUser.user_id], function (err) {
      if (err) {
        return sendMessage(chat.id, '❌ Silinmə zamanı xəta baş verdi.');
      }
      sendMessage(chat.id, t(lang, 'deleted_success', { short: shortCode }));
    });
  }

  async function handleStats(chat, args) {
    const lang = await shared.getBotLanguage('telegram', chat.id);
    const botUser = await shared.getBotUser('telegram', chat.id);
    if (!botUser) return sendMessage(chat.id, t(lang, 'not_linked'));
    if (isProAccessActive && !isProAccessActive(botUser)) return sendMessage(chat.id, t(lang, 'stats_pro'));

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
      [{ text: '🇬🇧 English', callback_data: 'lang_en' }, { text: '🇹🇷 Türkçe', callback_data: 'lang_tr' }],
      [{ text: '🇦🇿 Azərbaycan', callback_data: 'lang_az' }, { text: '🇷🇺 Русский', callback_data: 'lang_ru' }]
    ];
    await sendMessage(chat.id, t(lang, 'select_lang'), { keyboard });
  }

  async function processUpdate(update) {
    if (update.callback_query) {
      const callbackQueryId = update.callback_query.id;
      const data = update.callback_query.data || '';
      const message = update.callback_query.message;
      if (!message || !message.chat) return;

      const lang = await shared.getBotLanguage('telegram', message.chat.id);

      if (data.startsWith('lang_')) {
        const selectedLang = data.replace('lang_', '');
        await shared.setBotLanguage('telegram', message.chat.id, selectedLang);
        const successMsg = t(selectedLang, 'lang_updated');
        await answerCallbackQuery(callbackQueryId, successMsg);
        await sendMessage(message.chat.id, successMsg);
        return;
      }

      if (data.startsWith('qr_')) {
        const shortCode = data.replace('qr_', '').trim();
        const shortUrl = `${BASE_URL}/${shortCode}`;
        try {
          const qrBuffer = await QRCode.toBuffer(shortUrl, {
            errorCorrectionLevel: 'M',
            type: 'png',
            margin: 2,
            width: 400,
            color: { dark: '#0f172a', light: '#ffffff' }
          });
          await answerCallbackQuery(callbackQueryId, 'QR Code ready!');
          await sendPhoto(message.chat.id, qrBuffer, `📱 <b>${shortUrl}</b>\n\n🌐 <a href="${BASE_URL}">ovlink.sbs</a>`);
        } catch (e) { await answerCallbackQuery(callbackQueryId, 'Error'); }
        return;
      }

      if (data.startsWith('del_')) {
        const shortCode = data.replace('del_', '').trim();
        const botUser = await shared.getBotUser('telegram', message.chat.id);
        if (!botUser) return answerCallbackQuery(callbackQueryId, t(lang, 'not_linked'));
        db.run('DELETE FROM urls WHERE short = ? AND user_id = ?', [shortCode, botUser.user_id], function (err) {
          if (err) {
            answerCallbackQuery(callbackQueryId, 'Xəta');
          } else {
            answerCallbackQuery(callbackQueryId, t(lang, 'deleted_success', { short: shortCode }));
            sendMessage(message.chat.id, t(lang, 'deleted_success', { short: shortCode }));
          }
        });
        return;
      }
      return;
    }

    const message = update.message || update.edited_message;
    if (!message) return;
    const chat = message.chat;
    const text = (message.text || '').trim();
    if (!text) return;
    const cmd = text.split(/\s+/)[0].toLowerCase().replace('@' + BOT_USERNAME, '');

    switch (cmd) {
      case '/start': return handleStart(chat, { text, messageId: message.message_id });
      case '/short': return handleShort(chat, { text, messageId: message.message_id });
      case '/qr': return handleQrCommand(chat, { text, messageId: message.message_id });
      case '/limit':
      case '/limits':
      case '/quota':
      case '/kota': return handleLimitsCommand(chat);
      case '/export': return handleExportCommand(chat);
      case '/search': return handleSearchCommand(chat, { text, messageId: message.message_id });
      case '/delete':
      case '/del': return handleDeleteCommand(chat, { text, messageId: message.message_id });
      case '/mylinks': return handleMyLinks(chat);
      case '/stats': return handleStats(chat, { text, messageId: message.message_id });
      case '/help': return handleHelp(chat);
      case '/unlink': return handleUnlink(chat);
      case '/upgrade': return handleUpgrade(chat);
      case '/lang':
      case '/language': return handleLang(chat);
      default: return handlePlainUrl(chat, { text, messageId: message.message_id });
    }
  }

  let isPolling = false;
  let pollingOffset = 0;

  async function startPolling() {
    if (!BOT_TOKEN || isPolling) return;
    isPolling = true;
    console.log('[startup] Telegram bot polling mode started.');
    try {
      await fetch(`${API_BASE}/deleteWebhook?drop_pending_updates=false`, { signal: AbortSignal.timeout(10000) });
    } catch (e) {}

    (async () => {
      while (isPolling) {
        try {
          const res = await fetch(`${API_BASE}/getUpdates?offset=${pollingOffset}&timeout=20`, { signal: AbortSignal.timeout(30000) });
          const data = await res.json();
          if (data.ok && Array.isArray(data.result)) {
            for (const update of data.result) {
              pollingOffset = update.update_id + 1;
              try {
                console.log('[telegram-bot] Mesaj işleniyor update_id:', update.update_id);
                await processUpdate(update);
              } catch (err) {
                console.error('[telegram-bot] processUpdate error:', err);
              }
            }
          } else {
            const retryAfter = (data && data.parameters && data.parameters.retry_after) || 3;
            await new Promise(r => setTimeout(r, retryAfter * 1000));
          }
        } catch (err) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    })();
  }

  function stopPolling() { isPolling = false; }
  return { processUpdate, startPolling, stopPolling, isEnabled: !!BOT_TOKEN };
}

module.exports = { createTelegramBot };
