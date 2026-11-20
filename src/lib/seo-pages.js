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
  {
    slug: "agency-client-reporting",
    titleKey: "seo_landing_agency_client_reporting_title",
    leadKey: "seo_landing_agency_client_reporting_lead",
    pointKeys: ["seo_landing_agency_client_reporting_p1", "seo_landing_agency_client_reporting_p2", "seo_landing_agency_client_reporting_p3"],
    copy: {
      title: {
        az: "Rəqəmsal agentliklər üçün müştəri hesabatı və portalı | Ovlink",
        tr: "Dijital ajanslar için müşteri raporlaması ve portalı | Ovlink",
        en: "Client reporting & portals for digital agencies | Ovlink",
      },
      lead: {
        az: "Hər ay cədvəl yığmağı dayandırın: hər müştəri üçün ayrıca iş sahəsi, bot-filtrli kampaniya analitikası, paylaşılabilən portal və bir kliklə PDF hesabat.",
        tr: "Her ay manuel tablo hazırlamayı bırakın: her müşteri için ayrı çalışma alanı, bot filtreli kampanya analitiği, paylaşılabilir portal ve tek tıkla PDF rapor.",
        en: "Stop assembling spreadsheets every month: isolated client workspaces, bot-filtered campaign analytics, shareable client portals, and one-click PDF reports.",
      },
      points: [
        {
          az: "Problem: Agentliklər ay sonu 10+ müştəri üçün link, QR və UTM nəticələrini əl ilə toplayıb PDF hazırlamağa saatlar itirir.",
          tr: "Sorun: Ajanslar ay sonunda 10+ müşteri için link, QR ve UTM sonuçlarını elle toplayıp PDF hazırlamaya saatler harcar.",
          en: "Problem: Agencies lose hours every month manually stitching links, QR scans, and UTM results into client PDFs.",
        },
        {
          az: "İş axını: Müştəri portfeli yaradın, kampaniya linklərini və QR-ları UTM şablonu ilə buraxın, sonra yalnız oxumaq üçün təhlükəsiz portal linki və ya planlı PDF paylaşın.",
          tr: "İş akışı: Müşteri portföyü açın, kampanya linklerini ve QR kodlarını UTM şablonuyla yayınlayın, ardından salt okunur portal veya planlı PDF paylaşın.",
          en: "Workflow: Create a client workspace, launch tagged links and QR codes with UTM presets, then share a revocable read-only portal or scheduled PDF.",
        },
        {
          az: "Sübut: Hər hesabat kriptoqrafik snapshot ID, son məlumat tarixi və CSV/PDF 1:1 rəqəm uyğunluğu ilə çıxır — rəqiblərin $99–$300 paketlərinə qarşı $19–$49 aralığında.",
          tr: "Kanıt: Her rapor kriptografik snapshot ID, son veri zamanı ve 1:1 CSV/PDF uyumu ile üretilir — rakiplerin $99–$300 paketlerine karşı $19–$49 aralığında.",
          en: "Proof: Every report includes a cryptographic snapshot ID, data freshness timestamp, and 1:1 CSV/PDF parity — at $19–$49/mo instead of $99–$300.",
        },
      ],
    },
    solution: {
      syntheticNotice: {
        az: "Nümunə görünüş (sintetik demo məlumatı): Aşağıdakı rəqəmlər real müştəri deyil, məhsulun hesabat strukturunu göstərən sınaq nümunəsidir.",
        tr: "Örnek görünüm (sentetik demo verisi): Aşağıdaki rakamlar gerçek müşteri değil, ürünün rapor yapısını gösteren örnek verilerdir.",
        en: "Sample view (synthetic demo dataset): Figures below are illustrative test data showing the real report format, not a live customer.",
      },
      proofTitle: {
        az: "Müştəri Portalı & PDF Hesabat Nümunəsi (Sintetik Demo)",
        tr: "Müşteri Portalı & PDF Rapor Örneği (Sentetik Demo)",
        en: "Client Portal & PDF Report Sample (Synthetic Demo)",
      },
      proofRows: {
        az: [
          "Kampaniya: Yaz Aksiya 2026 · Snapshot #rev-4 · Son yenilənmə: 2 dəq əvvəl",
          "İnsan klikləri (bot filtri aktiv): 14,820 · Unikal ziyarətçi: 11,340 · QR skan: 1,920",
          "Paylaşım: Yalnız baxış portal linki (ləğv edilə bilən) + Aylıq avtomatik A4 PDF",
        ],
        tr: [
          "Kampanya: Bahar Kampanyası 2026 · Snapshot #rev-4 · Son veri: 2 dk önce",
          "İnsan tıklamaları (bot filtresi aktif): 14.820 · Tekil ziyaretçi: 11.340 · QR tarama: 1.920",
          "Paylaşım: Salt okunur portal bağlantısı (iptal edilebilir) + Aylık otomatik A4 PDF",
        ],
        en: [
          "Campaign: Spring Promo 2026 · Snapshot #rev-4 · Freshness: 2m ago",
          "Human clicks (bot filter on): 14,820 · Unique visitors: 11,340 · QR scans: 1,920",
          "Delivery: Revocable read-only client portal + scheduled monthly A4 PDF",
        ],
      },
      faq: [
        {
          q: { az: "Müştərilərim panelə daxil olmaq üçün ayrıca ödəniş etməlidir?", tr: "Müşterilerim portala erişmek için ek ücret öder mi?", en: "Do my clients pay extra to view their report portal?" },
          a: { az: "Xeyr. Müştəri portalı yalnız baxış üçündür və paketə daxildir; siz linki istənilən vaxt ləğv edə bilərsiniz.", tr: "Hayır. Müşteri portalı salt okunurdur ve pakete dahildir; bağlantıyı dilediğiniz zaman iptal edebilirsiniz.", en: "No. Read-only client portals are included in your plan and can be revoked anytime." },
        },
        {
          q: { az: "Abunəlik dayansa, müştəri reklamlarındakı linklər qırılır?", tr: "Abonelik biterse müşteri reklamlarındaki linkler bozulur mu?", en: "If a subscription stops, do existing client campaign links break?" },
          a: { az: "Xeyr. Mövcud qısa linklər ədalətli istifadə çərçivəsində reklamsız yönləndirməyə davam edir.", tr: "Hayır. Mevcut kısa linkler adil kullanım sınırları içinde reklamsız yönlendirmeye devam eder.", en: "No. Existing short links keep redirecting without ads within fair-use bounds." },
        },
      ],
      trialCta: { az: "Agentlik sınağına başla", tr: "Ajans denemesini başlat", en: "Start agency trial" },
      demoCta: { az: "Canlı demo istə", tr: "Canlı demo iste", en: "Request live demo" },
    },
  },
  {
    slug: "ecommerce-campaign-tracking",
    titleKey: "seo_landing_ecommerce_campaign_tracking_title",
    leadKey: "seo_landing_ecommerce_campaign_tracking_lead",
    pointKeys: ["seo_landing_ecommerce_campaign_tracking_p1", "seo_landing_ecommerce_campaign_tracking_p2", "seo_landing_ecommerce_campaign_tracking_p3"],
    copy: {
      title: {
        az: "E-ticarət üçün kampaniya və satış (konversiya) izləmə | Ovlink",
        tr: "E-ticaret için kampanya ve dönüşüm (satış) takibi | Ovlink",
        en: "Campaign & conversion tracking for e-commerce | Ovlink",
      },
      lead: {
        az: "Instagram, TikTok, influencer və SMS kampaniyalarından hansının real sifariş gətirdiyini görün — bot kliklərini ayıraraq və konversiya API ilə.",
        tr: "Instagram, TikTok, influencer ve SMS kampanyalarından hangisinin gerçek sipariş getirdiğini görün — bot tıklamalarını ayırarak ve dönüşüm API'si ile.",
        en: "See which Instagram, TikTok, influencer, and SMS campaigns drive real orders — with bot filtering and server-side conversion tracking.",
      },
      points: [
        {
          az: "Problem: E-ticarət mağazaları klik sayını görür, amma bot trafiki, qarışıq UTM-lər və mənbəsiz sifarişlər səbəbindən hansı kanalın satış gətirdiyini bilmir.",
          tr: "Sorun: E-ticaret mağazaları tıklamaları görür ancak bot trafiği, dağınık UTM'ler ve kaynaksız siparişler yüzünden hangi kanalın sattığını bilemez.",
          en: "Problem: E-commerce teams see raw clicks but cannot tell which channel drove orders due to bots, messy UTMs, and unattributed checkouts.",
        },
        {
          az: "İş axını: Hər influencer və ya kanal üçün standart UTM-li brend link yaradın, server-side Conversion API (və ya yüngül JS SDK) qoşun və 7–30 günlük atribusiyanı izləyin.",
          tr: "İş akışı: Her influencer veya kanal için standart UTM'li markalı link oluşturun, sunucu tarafı Conversion API (veya hafif JS SDK) bağlayın ve 7–30 günlük ilişkilendirmeyi izleyin.",
          en: "Workflow: Launch standardized UTM branded links per influencer or channel, connect the server-side Conversion API (or lightweight JS SDK), and track 7–30 day attribution.",
        },
        {
          az: "Sübut: Kanal müqayisəsi valyutaları (AZN/USD/TRY) qarışdırmadan ayrı göstərir, ölçülə bilməyən klikləri gizlətmir və uydurma ROI yazmır.",
          tr: "Kanıt: Kanal karşılaştırması para birimlerini (AZN/USD/TRY) karıştırmadan ayrı gösterir, ölçülemeyen tıklamaları gizlemez ve yapay ROI üretmez.",
          en: "Proof: Channel comparisons keep currencies (AZN/USD/TRY) separate, show unattributed traffic transparently, and never fabricate ROI.",
        },
      ],
    },
    solution: {
      syntheticNotice: {
        az: "Nümunə görünüş (sintetik demo məlumatı): Aşağıdakı sifariş və gəlir rəqəmləri yalnız ölçmə modelini göstərən sınaq nümunəsidir.",
        tr: "Örnek görünüm (sentetik demo verisi): Aşağıdaki sipariş ve gelir rakamları yalnızca ölçüm modelini gösteren örnek verilerdir.",
        en: "Sample view (synthetic demo dataset): Order and revenue figures below are illustrative test data showing the attribution model, not live store data.",
      },
      proofTitle: {
        az: "E-Ticarət Kanal & Konversiya Müqayisəsi (Sintetik Demo)",
        tr: "E-Ticaret Kanal & Dönüşüm Karşılaştırması (Sentetik Demo)",
        en: "E-Commerce Channel & Conversion Breakdown (Synthetic Demo)",
      },
      proofRows: {
        az: [
          "Instagram Story (UTM preset): 4,120 insan klik · 138 sifariş · 8,420 AZN (7 gün last-touch)",
          "Influencer A (özəl alias): 1,890 insan klik · 94 sifariş · 6,110 AZN (7 gün last-touch)",
          "Ölçülə bilməyən / icazəsiz kliklər: 6.4% (ayrıca göstərilir, uydurma paylanmır)",
        ],
        tr: [
          "Instagram Story (UTM şablonu): 4.120 insan tıklama · 138 sipariş · 8.420 AZN (7 gün last-touch)",
          "Influencer A (özel alias): 1.890 insan tıklama · 94 sipariş · 6.110 AZN (7 gün last-touch)",
          "Ölçülemeyen / izinsiz tıklamalar: %6,4 (ayrıca gösterilir, yapay dağıtılmaz)",
        ],
        en: [
          "Instagram Story (UTM preset): 4,120 human clicks · 138 orders · 8,420 AZN (7d last-touch)",
          "Influencer A (custom alias): 1,890 human clicks · 94 orders · 6,110 AZN (7d last-touch)",
          "Unmeasurable / no-consent traffic: 6.4% (shown explicitly, never fabricated)",
        ],
      },
      faq: [
        {
          q: { az: "Shopify, WooCommerce və ya öz saytımızla işləyir?", tr: "Shopify, WooCommerce veya özel sitemizle çalışır mı?", en: "Does it work with Shopify, WooCommerce, or custom storefronts?" },
          a: { az: "Bəli. İstənilən mağaza server-side Conversion API, webhook və ya yüngül cookie-siz JS SDK ilə qoşula bilər.", tr: "Evet. Her mağaza sunucu tarafı Conversion API, webhook veya hafif çerezsiz JS SDK ile bağlanabilir.", en: "Yes. Any storefront can connect via the server-side Conversion API, webhooks, or our lightweight cookie-free JS SDK." },
        },
        {
          q: { az: "iOS və Android istifadəçilərini fərqli səhifəyə yönləndirmək olur?", tr: "iOS ve Android kullanıcılarını farklı sayfalara yönlendirebilir miyiz?", en: "Can we route iOS and Android shoppers to different app or store URLs?" },
          a: { az: "Bəli. Tək qısa link daxilində iOS, Android və A/B test yönləndirməsi dəstəklənir.", tr: "Evet. Tek kısa link içinde iOS, Android ve A/B test yönlendirmesi desteklenir.", en: "Yes. Device targeting (iOS/Android) and A/B split routing are built into every short link." },
        },
      ],
      trialCta: { az: "Mağaza sınağına başla", tr: "Mağaza denemesini başlat", en: "Start store trial" },
      demoCta: { az: "Demo görüşü al", tr: "Demo görüşmesi al", en: "Book a demo" },
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
  const solution = page.solution
    ? {
        syntheticNotice: page.solution.syntheticNotice[l],
        proofTitle: page.solution.proofTitle[l],
        proofRows: page.solution.proofRows[l],
        faq: page.solution.faq.map((item) => ({ q: item.q[l], a: item.a[l] })),
        trialCta: page.solution.trialCta[l],
        demoCta: page.solution.demoCta[l],
      }
    : null;
  return {
    title: page.copy.title[l],
    lead: page.copy.lead[l],
    points: page.copy.points.map((p) => p[l]),
    titleKey: page.titleKey,
    leadKey: page.leadKey,
    pointKeys: page.pointKeys,
    solution,
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
});

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
