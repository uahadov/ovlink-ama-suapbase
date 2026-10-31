'use strict';

/**
 * Programmatic SEO landing pages (A17).
 *
 * Two things are true about every entry below:
 *  1. It is an allowlist. A slug that is not listed here falls through to the
 *     normal router and 404s, so robots.txt and sitemap.xml can never
 *     advertise a page the application refuses to render.
 *  2. The trilingual copy mirrors the `seo_landing_*` keys in public/lang.js.
 *     The dictionary is what the language switcher applies on the client;
 *     this copy is what the server renders, so crawlers and link previews
 *     get real text without executing JS. test/seo-pages.test.js fails if
 *     either side drifts.
 */

const SEO_LANDING_PAGES = Object.freeze([
  {
    slug: "free-link-shortener",
    titleKey: "seo_landing_free_link_shortener_title",
    leadKey: "seo_landing_free_link_shortener_lead",
    pointKeys: ["seo_landing_free_link_shortener_p1", "seo_landing_free_link_shortener_p2", "seo_landing_free_link_shortener_p3"],
    copy: {
      title: { az: "Pulsuz link qısaltma — qeydiyyat olmadan | Ovlink", tr: "Ücretsiz link kısaltma — kayıtsız | Ovlink", en: "Free link shortener without sign-up | Ovlink" },
      lead: { az: "Uzun linkləri bir saniyədə qısaltmaq. Sürətli yönləndirmə, klik sayımı və QR kod hamısı pulsuzdur.", tr: "Uzun bağlantıları saniyeler içinde kısaltın. Hızlı yönlendirme, tık sayımı ve QR kod tamamen ücretsiz.", en: "Shorten any long link in a second. Fast redirects, click counts and a QR code are all free." },
      points: [
        { az: "Heç bir reklam paneli və ya gözləmə sayfağı yoxdur — istifadəçi bir dəfə klikləyib bir dəfə yönləndirilir.", tr: "Reklam paneli veya bekleme sayfası yok — kullanıcı tek tıkla hedefe ulaşır.", en: "No interstitial ads or waiting pages — one click takes the visitor straight to the target." },
        { az: "Hər link üçün günlük klik, unikal istifadəçi və mənbə statistikası.", tr: "Her bağlantı için günlük tık, tekil kullanıcı ve kaynak istatistiği.", en: "Daily clicks, unique visitors and referrers for every link." },
        { az: "Link yaratmaq üçün e-poçt təsdiqi tələb olunmur; hesab yaratmaq istəsəniz 30 saniyə çəkir.", tr: "Bağlantı oluşturmak için e-posta doğrulaması gerekmez; hesap açmak 30 saniye sürer.", en: "Links need no e-mail verification; creating an account takes about 30 seconds." },
      ],
    },
  },
  {
    slug: "qr-code-generator",
    titleKey: "seo_landing_qr_code_generator_title",
    leadKey: "seo_landing_qr_code_generator_lead",
    pointKeys: ["seo_landing_qr_code_generator_p1", "seo_landing_qr_code_generator_p2", "seo_landing_qr_code_generator_p3"],
    copy: {
      title: { az: "QR kod yaradıcı — dinamik və rəngli | Ovlink", tr: "QR kod oluşturucu — dinamik ve renkli | Ovlink", en: "Dynamic QR code generator with colours | Ovlink" },
      lead: { az: "Qısaldılmış linkiniz üçün dərhal QR kod yaradın. Rəngləri dəyişin, PNG yükləyin və ya skanları izləyin.", tr: "Kısaltılmış bağlantınız için anında QR kod oluşturun. Renkleri değiştirin, PNG indirin veya taramaları izleyin.", en: "Generate a QR code for any shortened link instantly. Recolour it, download a PNG and track scans." },
      points: [
        { az: "QR kodu yönləndirmə linkinə deyil, Ovlink sluginə işarə edir — hədəfi sonradan dəyişə bilərsiniz.", tr: "QR kod yönlendirme bağlantısına değil Ovlink slug'ına işaret eder; hedefi sonra değiştirebilirsiniz.", en: "The code points at your Ovlink slug, not the destination, so you can change the target later." },
        { az: "Hər QR kodun neçə dəfə skanlandığını ümumi say və gündəlik bölgülər ilə görürsünüz.", tr: "Her QR kodun kaç kez tarandığını toplam ve günlük kırılımla görün.", en: "See total and per-day scan counts for every code you publish." },
        { az: "Çap üçün yüksək kontrastlı tema, rəqəmsal ekranlar üçün tünd tema.", tr: "Baskı için yüksek kontrastlı tema, ekranlar için koyu tema.", en: "A high-contrast theme for print and a dark theme for screens." },
      ],
    },
  },
  {
    slug: "url-shortener-analytics",
    titleKey: "seo_landing_url_shortener_analytics_title",
    leadKey: "seo_landing_url_shortener_analytics_lead",
    pointKeys: ["seo_landing_url_shortener_analytics_p1", "seo_landing_url_shortener_analytics_p2", "seo_landing_url_shortener_analytics_p3"],
    copy: {
      title: { az: "Link statistiki — klik, coxaliya, UTM | Ovlink", tr: "Bağlantı istatistikleri — tık, cihaz, UTM | Ovlink", en: "Link analytics — clicks, devices, UTM | Ovlink" },
      lead: { az: "Kimin, harada və hansı qurğuda linkinizi açdığını bir paneldə görün. Statistika pulsuz plandadır.", tr: "Bağlantınızı kimin, nerede ve hangi cihazda açtığını tek panelde görün. Raporlama ücretsiz planda da var.", en: "See who opened your link, where and on which device — reporting is included on the free plan." },
      points: [
        { az: "Ümumi klik, unikal ziyarətçi, dönüşüm və geri sıçrama faizi.", tr: "Toplam tık, tekil ziyaretçi, dönüşüm ve hemen çıkma oranı.", en: "Total clicks, unique visitors, conversions and bounce rate." },
        { az: "Brauzer, əməliyyat sistemi və ölkə üzrə bölgü; xəritə ilə.", tr: "Tarayıcı, işletim sistemi ve ülkeye göre kırılım; harita ile.", en: "Breakdown by browser, operating system and country, with a map." },
        { az: "UTM parametrləri avtomatik saxlanılır — məhsul linkini kopyalayıb yapışdırmaq kifayətdir.", tr: "UTM parametreleri otomatik korunur; bağlantıyı yapıştırmanız yeterli.", en: "UTM parameters are preserved automatically — paste the link and you are done." },
      ],
    },
  },
  {
    slug: "custom-domain-shortener",
    titleKey: "seo_landing_custom_domain_shortener_title",
    leadKey: "seo_landing_custom_domain_shortener_lead",
    pointKeys: ["seo_landing_custom_domain_shortener_p1", "seo_landing_custom_domain_shortener_p2", "seo_landing_custom_domain_shortener_p3"],
    copy: {
      title: { az: "Öz domen ilə link qısaltma | Ovlink", tr: "Kendi alan adıyla link kısaltma | Ovlink", en: "Shorten links on your own domain | Ovlink" },
      lead: { az: "Marka adınızı linklərinizdə göstərin: öz domenin, DNS ilə təsdiq və avtomatik TLS sertifikati.", tr: "Marka adınızı bağlantılarınızda gösterin: kendi alan adınız, DNS doğrulaması ve otomatik TLS.", en: "Put your brand in every link: your own domain, DNS verification and automatic TLS." },
      points: [
        { az: "DNS TXT qeydi ilə sahiblik təsdiqi — təsdiq olunmadan domen aktivləşmir.", tr: "DNS TXT kaydıyla sahiplik doğrulaması — doğrulanmadan alan adı etkinleşmez.", en: "Ownership is verified with a DNS TXT record before the domain goes live." },
        { az: "Köhnə linklər işləməyə davam edir; domeni dəyişsəniz belə slug-lar itmir.", tr: "Eski bağlantılar çalışmaya devam eder; alan adını değiştirseniz bile slug'lar kaybolmaz.", en: "Existing links keep working — switching domains never loses a slug." },
        { az: "Sertifikat və HTTPS sizin tərəfinizdən idarə olunmur — bu, xəta ehtimalını azaldır.", tr: "Sertifika ve HTTPS yönetimi size bırakılmaz; hata olasılığı azalır.", en: "Certificate and HTTPS handling stays on our side, which removes a common failure point." },
      ],
    },
  },
  {
    slug: "telegram-link-shortener",
    titleKey: "seo_landing_telegram_link_shortener_title",
    leadKey: "seo_landing_telegram_link_shortener_lead",
    pointKeys: ["seo_landing_telegram_link_shortener_p1", "seo_landing_telegram_link_shortener_p2", "seo_landing_telegram_link_shortener_p3"],
    copy: {
      title: { az: "Telegram üçün link qısaltma botu | Ovlink", tr: "Telegram için link kısaltma botu | Ovlink", en: "URL shortener bot for Telegram | Ovlink" },
      lead: { az: "@OvlinkBOT ilə Telegram-da link göndərin, qısa linki və statistiki oradan alın — vebsəifəyə ehtiyac yoxdur.", tr: "@OvlinkBOT ile Telegram'da bağlantı gönderin, kısa bağlantıyı ve istatistikleri oradan alın.", en: "Send a link to @OvlinkBOT in Telegram and get the short link and its stats back — no browser needed." },
      points: [
        { az: "Link yaratmaq, siyahıya baxmaq və silmək əmrləri botta mövcuddur.", tr: "Bağlantı oluşturma, listeleme ve silme komutları botta mevcut.", en: "Create, list and delete links without leaving the chat." },
        { az: "Hesab eyni olduğu üçün botda yaradılan link paneldə də görünür.", tr: "Aynı hesap kullanıldığı için bottaki bağlantılar panelde de görünür.", en: "Because it is the same account, bot links show up in the dashboard too." },
        { az: "Discord istifadəçiləri üçün eyni funksionallıq Discord botu ilə verilir.", tr: "Discord kullanıcıları için aynı işlevsellik Discord botu ile sunulur.", en: "Discord users get the same workflow from the Discord bot." },
      ],
    },
  },
]);

const BY_SLUG = new Map(SEO_LANDING_PAGES.map((page) => [page.slug, page]));

/**
 * Hub page for the cluster. Two segments like every other landing page: a
 * one-segment path would collide with the one-character short-code namespace.
 */
const LANDING_INDEX_PATH = '/l/guides';

function findLandingPage(slug) {
  const key = (slug || '').toString().toLowerCase();
  return BY_SLUG.get(key) || null;
}

/** Indexable paths for robots.txt / sitemap.xml: the hub first, then the pages. */
function landingPagePaths() {
  return [LANDING_INDEX_PATH, ...SEO_LANDING_PAGES.map((page) => `/l/${page.slug}`)];
}

/**
 * Resolve the page copy for one language. Missing language falls back to
 * Azerbaijani, matching normalizeLang()'s own default.
 */
function landingCopy(page, lang) {
  if (!page || !page.copy) return null;
  const l = (lang === 'tr' || lang === 'en') ? lang : 'az';
  return {
    title: page.copy.title[l],
    lead: page.copy.lead[l],
    points: page.copy.points.map((p) => p[l]),
    titleKey: page.titleKey,
    leadKey: page.leadKey,
    pointKeys: page.pointKeys,
  };
}

/**
 * Labels shared by every landing page. Same rule as the per-slug copy:
 * these mirror the `seo_landing_*` keys in public/lang.js and test/seo-pages.test.js
 * fails if the two drift apart.
 */
const LANDING_SHARED = Object.freeze({
  badge: { az: "Təlimat", tr: "Rehber", en: "Guide" },
  cta: { az: "İndi qısaltmağa başla", tr: "Şimdi kısaltmaya başla", en: "Start shortening" },
  more_title: { az: "Digər təlimatlar", tr: "Diğer rehberler", en: "More guides" },
  back_title: { az: "Bütün təlimatlar", tr: "Tüm rehberler", en: "All guides" },
]);

/** Shared labels resolved for one language. */
function landingShared(lang) {
  const l = (lang === 'tr' || lang === 'en') ? lang : 'az';
  return {
    badge: LANDING_SHARED.badge[l],
    cta: LANDING_SHARED.cta[l],
    moreTitle: LANDING_SHARED.more_title[l],
    backTitle: LANDING_SHARED.back_title[l],
  };
}

/** Per-slug key prefix (`seo_landing_<slug-with-underscores>`). */
function keyPrefix(slug) {
  return `seo_landing_${(slug || '').toString().replace(/-/g, '_')}`;
}

module.exports = {
  SEO_LANDING_PAGES,
  LANDING_INDEX_PATH,
  findLandingPage,
  landingPagePaths,
  landingCopy,
  landingShared,
  LANDING_SHARED,
  keyPrefix,
};
