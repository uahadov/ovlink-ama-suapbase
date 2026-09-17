const homeTranslations = {
  az: {
    /* Nav */
    nav_login: "Daxil ol",
    nav_register: "Qeydiyyat",
    nav_logout: "Çıxış",
    nav_my_account: "Hesabım",
    navx_how: "Necə işləyir",
    navx_why: "Niyə Ovlink",
    navx_pro: "Pro",
    navx_faq: "FAQ",
    nav_pricing: "Pro Plan",
    skip_to_content: "Məzmuna keç",

    /* Hero */
    hero_eyebrow: "Daha sürətli linklər, daha ağıllı nəticələr",
    hero_display: "Qısaldın. İzləyin. Paylaşın.",
    hero_display_1: "Qısaldın.",
    hero_display_2: "İzləyin. Paylaşın.",
    hero_sub: "Hər link, gözəl idarəolunma ilə. Fərdi alias, şifrə, bitmə tarixi və analitika ilə qısa linklər yaradın — pulsuz.",
    hero_link_how: "Necə işlədiyini gör",
    hero_link_why: "Niyə Ovlink",

    /* Composer */
    composer_title: "Qısa link yarat",
    composer_guest: "Qonaqlar gündə 2 link yarada bilər.",
    composer_guest_cta: "Pulsuz hesab yarat",
    composer_trust: "Hər hədəf təhlükəsizlik üçün skan edilir — zərərli linklər avtomatik karantinə alınır.",
    input_placeholder: "https://example.com/cox-uzun-linkiniz",
    shorten_btn: "Qısalt",
    advanced_settings: "Ətraflı Tənzimləmələr",
    alias_label: "Fərdi alias",
    alias_placeholder: "menim-linkim",
    pass_label: "Şifrə",
    pass_placeholder: "••••••••",
    expiry_date: "Son İstifadə Tarixi",
    max_clicks: "Maksimum Klik",
    shorten_domain_label: "Qısa link alan adı",
    shorten_domain_default: "Varsayılan (ovlink.sbs)",
    shorten_domain_hint: "Aktiv etdiyiniz domenlər burada görünür.",
    shorten_domain_manage_link: "Xüsusi domen əlavə et",

    /* Advanced / UTM */
    adv_tab_general: "Ümumi",
    adv_tab_utm: "UTM",
    adv_tab_ab: "A/B Test",
    adv_tab_device: "Cihaz",
    adv_utm_params_title: "UTM Parametrləri",
    adv_utm_template_select: "Şablon Seç",
    adv_utm_save: "Saxla",
    adv_utm_save_tooltip: "Mövcud UTM tənzimləmələrini saxla",
    adv_utm_source: "Mənbə (Source)",
    adv_utm_source_ph: "məs. instagram",
    adv_utm_medium: "Kanal (Medium)",
    adv_utm_medium_ph: "məs. social",
    adv_utm_campaign: "Kampaniya (Campaign)",
    adv_utm_campaign_ph: "məs. yay_endirimi",
    adv_utm_popular_templates: "Populyar Şablonlar",
    adv_utm_custom_templates: "Şəxsi Şablonlarım",
    adv_utm_no_params_alert: "Yadda saxlanılacaq UTM parametri tapılmadı!",
    adv_utm_prompt_name: "Bu şablon üçün ad daxil edin (Məs: Yay Endirimi):",
    adv_utm_save_error: "Şablon yadda saxlanılarkən xəta baş verdi.",
    adv_ab_title: "A/B Testi (Link Rotator)",
    adv_ab_url_b: "Hədəf URL B (İkinci Link)",
    adv_ab_url_b_ph: "https://… (URL B)",
    adv_ab_split: "Link A trafiki (%)",
    adv_ab_hint: "Qalan trafik Link B-yə yönləndirilir.",
    adv_device_title: "Cihaz Hədəfləməsi",
    adv_device_ios: "iOS Yönləndirməsi",
    adv_device_ios_ph: "https://apps.apple.com/…",
    adv_device_android: "Android Yönləndirməsi",
    adv_device_android_ph: "https://play.google.com/…",
    pro_badge: "PRO",
    pro_feature_required: "A/B Test və Cihaz Hədəfləməsi yalnız PRO istifadəçilər üçündür. Zəhmət olmasa Pro plana keçin.",
    pro_feature_required_ab: "A/B Test yalnız PRO istifadəçilər üçündür. Zəhmət olmasa Pro plana keçin.",
    pro_feature_required_device: "Cihaz Hədəfləməsi yalnız PRO istifadəçilər üçündür. Zəhmət olmasa Pro plana keçin.",

    /* Result */
    shorten_btn: "Qısalt",
    generated_title: "Linkiniz hazırdır!",
    copy_btn: "Kopyala",
    copied_msg: "Kopyalandı!",
    send_qr_btn: "QR-a Göndər",

    /* Feature tiles */
    feat_kicker: "Xüsusiyyətlər",
    feat_title: "Linkin ehtiyacı olan hər şey.",
    feat_sub: "Bir saniyəlik qısaldıcıdan enterprise dərəcəli idarəetməyə — linkləriniz işini görsün, dizayn görünməz qalsın.",
    feat_instant_title: "Ani qısaltma",
    feat_instant_text: "URL-nizi yapışdırın və dərhal qısa kod alın — başlamaq üçün hesab lazım deyil.",
    feat_analytics_title: "Məxfilik mərkəzli statistika",
    feat_analytics_text: "Yalnız vacib statistikalar toplanır. Real vaxt kliklər, referrer və cihazlar — başqa heç nə.",
    feat_safety_title: "Daxili təhlükəsizlik",
    feat_safety_text: "Real vaxt təhlükə skanları, həftəlik yenidən skan və icma şikayətləri platformanı təmiz saxlayır.",
    feat_domains_title: "Xüsusi domenlər",
    feat_domains_text: "Öz domeninizi gətirin — hər paylaşdığınız linkdə brendiniz qalsın.",
    feat_vis_clicks: "12.408 klik",
    feat_vis_regions: "Ən çox region",
    feat_vis_devices: "Cihazlar",
    feat_dashboard_title: "Sizi izləyən panel",
    feat_dashboard_text: "Canlı klik axını, komandalar üçün workspace-lər, teqlər və qovluqlar — hamısı real vaxtda.",
    feat_dashboard_link: "Panelinizi açın",
    feat_workspaces_title: "İş Sahələri (Workspaces)",
    feat_workspaces_text: "Komandanızla əməkdaşlıq edin. Hər iş sahəsi üçün ayrıca linklər, analitika və tənzimləmələr — hər şey səliqəli və təcrid olunmuş.",
    feat_workspaces_link: "İş sahələrini idarə edin",
    feat_ws_stat: "3 üzv · 2 iş sahəsi",
    feat_ws_invite: "Üzv dəvət et →",

    /* How it works */
    how_kicker: "Necə işləyir",
    how_title: "Üç addım. Bütün məsələ bu.",
    how_step1_title: "Linkinizi yapışdırın",
    how_step1_text: "İstənilən uzun URL-ni yuxarıdakı komposerə atın — ilk linklər üçün qeydiyyat lazım deyil.",
    how_step2_title: "Fərdiləşdirin",
    how_step2_text: "Alias seçin, şifrə qoyun, UTM parametrləri əlavə edin və ya cihazları hədəfləyin.",
    how_step3_title: "Paylaşın və izləyin",
    how_step3_text: "Hər yerdə paylaşın. Kliklərin panelinizdə real vaxtda gəlişini izləyin.",
    how_cta: "Pulsuz hesab yarat",
    how_link: "Axın haqqında daha çox",

    /* Stats */
    stat_ms: "Millisaniyədə qısaldır",
    stat_uptime: "Əlçatanlıq hədəfi (%)",
    stat_langs: "İnterfeys dili",
    stat_watch: "Təhlükəsizlik nəzarəti (s/gün)",

    /* Tools */
    tools_kicker: "Alətlər",
    tools_title: "İş üçün iki yol daha.",
    qr_customize: "QR Kodu Özəlləşdir",
    qr_generate_btn: "QR Kod Yarat",
    qr_sub: "İstənilən qısa linki öz rənglərinizlə brend QR koda çevirin.",
    qr_alias_label: "Qısa link",
    qr_alias_placeholder: "abc123",
    qr_fg_color: "QR Rəngi",
    qr_bg_color: "Arxa Fon Rəngi",
    qr_theme_presets: "Mövzular:",
    qr_theme_classic: "Klassik",
    qr_theme_dark: "Monolith Qara",
    qr_theme_slate: "Qrafit",
    qr_palette_title: "Monoxrom & Tonlar",
    qr_custom_color: "Xüsusi rəng…",
    qr_download_hint: "QR kodunuzu PNG kimi endirin.",
    qr_download_btn: "QR Endir",
    report_title: "Link Şikayət Et",
    report_sub: "Qaydaları pozan link tapdınız? Bizə yazın — moderasiya sürətlə reactsiya verir.",
    report_placeholder: "Şikayət ediləcək qısa link",
    report_link_label: "Şikayət ediləcək qısa link",
    report_link_placeholder: "abc123 və ya qısa link URL",
    report_reason_label: "Səbəb",
    report_reason: "Şikayət səbəbini yazın…",
    report_btn: "Şikayəti Göndər",
    report_login_hint: "Şikayət göndərmək üçün hesabınıza daxil olmalısınız.",

    /* Workspace */
    ws_title: "Workspace",
    workspace_personal: "Şəxsi hesab",
    ws_role_owner: "Sahib",
    ws_role_editor: "Redaktor",
    ws_role_viewer: "Baxıcı",

    /* Accessibility / Aria */
    aria_nav_main: "Əsas naviqasiya",
    aria_home: "Ovlink ana səhifə",
    aria_lang: "Dil",
    aria_menu: "Menyu",
    aria_close_menu: "Menyunu bağla",
    aria_user_menu: "Hesab menyusu",
    aria_qr_color: "QR rəngi",
    aria_qr_bg: "Arxa fon rəngi",
    aria_promo: "Ovlink Pro təklifi",
    aria_promo_close: "Təklifi bağla",
    aria_save_utm: "UTM şablonunu yadda saxla",
    aria_utm_template: "UTM şablonu",
    aria_long_url: "Qısaldılacaq uzun URL",
    aria_custom_alias: "Fərdi alias",
    aria_link_pass: "Link şifrəsi",
    aria_expiry_date: "Bitmə tarixi",
    aria_max_clicks: "Maksimum klik sayı",
    aria_ios_redirect: "iOS yönləndirmə linki",
    aria_android_redirect: "Android yönləndirmə linki",
    aria_target_b: "Hədəf URL B",
    aria_split_percent: "Link A trafik faizi",
    aria_qr_link: "QR qısa linki",
    aria_report_link: "Şikayət ediləcək link",
    aria_report_reason: "Şikayət səbəbi",
    aria_stats: "Platforma statistikaları",
    aria_qr_code_alt: "QR kod",
    aria_logo_alt: "Ovlink Logosu",

    /* Notifications */
    dashboard_stats_link: "Statistika",
    profile_settings_title: "Profil Parametrləri",
    notif_center_title: "Bildiriş Mərkəzi",
    notif_short_label: "Qısa link:",
    notif_original_label: "Orijinal link:",

    /* Footer */
    footer_group_company: "Şirkət",
    footer_group_legal: "Hüquqi",
    footer_group_resources: "Resurslar",
    home_foot_note_intro: "Ovlink etibarlı və idarəolunan qısa linklər üçün hazırlanıb. Legitim paylaşım üçün nəzərdə tutulub; təhlükəsizlik və ya siyasət qaydalarını pozan linklər məhdudlaşdırıla bilər.",
    home_foot_note_link: "Daha çox öyrən",
    privacy_policy: "Məxfilik Siyasəti",
    terms_policy: "İstifadə Şərtləri",
    cookie_policy: "Cookie Siyasəti",
    about_policy: "Haqqımızda",
    why_ovlink_link: "Niyə Ovlink?",
    contact_policy: "Əlaqə",
    faq_link: "FAQ",
    help_link: "Yardım",
    docs_link: "Sənədlər",
    api_guide_link: "API Bələdçisi",
    abuse_safety_link: "Sui-istifadə və Təhlükəsizlik",
    updates_link: "Yeniliklər",
    pricing_link: "Pro Qiymətlər",
    footer_text: "© 2026 · Hazırladı və Təmin Etdi: Ulvi Ahadov",

    /* Promo chip */
    floating_pricing_badge: "PRO",
    floating_pricing_title: "Premium funksiyaları açın",
    floating_pricing_text: "$4.99/ay · API + Webhook · 3 Gün Pulsuz",

    /* Cookie */
    cookie_text: "Bu sayt təcrübənizi yaxşılaşdırmaq üçün kukilərdən istifadə edir.",
    cookie_more_info: "Daha Çox Məlumat",
    cookie_accept: "OK",

    /* Errors */
    error_alias_taken: "Bu xüsusi link artıq istifadə olunub.",
    error_invalid_url: "Zəhmət olmasa düzgün bir URL daxil edin.",
    error_link_not_found: "Belə bir link tapılmadı."
  },
  tr: {
    /* Nav */
    nav_login: "Giriş yap",
    nav_register: "Kayıt ol",
    nav_logout: "Çıkış",
    nav_my_account: "Hesabım",
    navx_how: "Nasıl çalışır",
    navx_why: "Neden Ovlink",
    navx_pro: "Pro",
    navx_faq: "SSS",
    nav_pricing: "Pro Plan",
    skip_to_content: "İçeriğe atla",

    /* Hero */
    hero_eyebrow: "Daha hızlı linkler, daha akıllı sonuçlar",
    hero_display: "Kısaltın. İzleyin. Paylaşın.",
    hero_display_1: "Kısaltın.",
    hero_display_2: "İzleyin. Paylaşın.",
    hero_sub: "Her link, zarif yönetimle. Özel alias, şifre, bitiş tarihi ve analitik ile kısa linkler oluşturun — ücretsiz.",
    hero_link_how: "Nasıl çalıştığını gör",
    hero_link_why: "Neden Ovlink",

    /* Composer */
    composer_title: "Kısa link oluştur",
    composer_guest: "Misafirler günde 2 link oluşturabilir.",
    composer_guest_cta: "Ücretsiz hesap oluştur",
    composer_trust: "Her hedef güvenlik için taranır — zararlı linkler otomatik karantinaya alınır.",
    input_placeholder: "https://example.com/cok-uzun-linkiniz",
    shorten_btn: "Kısalt",
    advanced_settings: "Gelişmiş Ayarlar",
    alias_label: "Özel alias",
    alias_placeholder: "benim-linkim",
    pass_label: "Şifre",
    pass_placeholder: "••••••••",
    expiry_date: "Son Kullanım Tarihi",
    max_clicks: "Maksimum Tıklama",
    shorten_domain_label: "Kısa link alan adı",
    shorten_domain_default: "Varsayılan (ovlink.sbs)",
    shorten_domain_hint: "Aktifleştirdiğiniz alan adları burada görünür.",
    shorten_domain_manage_link: "Özel alan adı ekle",

    /* Advanced / UTM */
    adv_tab_general: "Genel",
    adv_tab_utm: "UTM",
    adv_tab_ab: "A/B Test",
    adv_tab_device: "Cihaz",
    adv_utm_params_title: "UTM Parametreleri",
    adv_utm_template_select: "Şablon Seç",
    adv_utm_save: "Kaydet",
    adv_utm_save_tooltip: "Mevcut UTM ayarlarını kaydet",
    adv_utm_source: "Kaynak (Source)",
    adv_utm_source_ph: "örn. instagram",
    adv_utm_medium: "Araç (Medium)",
    adv_utm_medium_ph: "örn. social",
    adv_utm_campaign: "Kampanya (Campaign)",
    adv_utm_campaign_ph: "örn. yaz_indirimi",
    adv_utm_popular_templates: "Popüler Şablonlar",
    adv_utm_custom_templates: "Özel Şablonlarım",
    adv_utm_no_params_alert: "Kaydedilecek bir UTM parametresi bulunamadı!",
    adv_utm_prompt_name: "Bu şablon için bir isim girin (Örn: Yaz İndirimi):",
    adv_utm_save_error: "Şablon kaydedilirken bir hata oluştu.",
    adv_ab_title: "A/B Testi (Link Rotatör)",
    adv_ab_url_b: "Hedef URL B (İkinci Link)",
    adv_ab_url_b_ph: "https://… (URL B)",
    adv_ab_split: "Link A trafiği (%)",
    adv_ab_hint: "Kalan trafik Link B'ye gider.",
    adv_device_title: "Cihaz Hedefleme",
    adv_device_ios: "iOS Yönlendirme",
    adv_device_ios_ph: "https://apps.apple.com/…",
    adv_device_android: "Android Yönlendirme",
    adv_device_android_ph: "https://play.google.com/…",
    pro_badge: "PRO",
    pro_feature_required: "A/B Test ve Cihaz Hedefleme yalnızca PRO kullanıcılar içindir. Lütfen Pro plana yükseltin.",
    pro_feature_required_ab: "A/B Test yalnızca PRO kullanıcılar içindir. Lütfen Pro plana geçin.",
    pro_feature_required_device: "Cihaz Hedeflemesi yalnızca PRO kullanıcılar içindir. Lütfen Pro plana geçin.",

    /* Result */
    shorten_btn: "Kısalt",
    generated_title: "Linkiniz hazır!",
    copy_btn: "Kopyala",
    copied_msg: "Kopyalandı!",
    send_qr_btn: "QR'a Gönder",

    /* Feature tiles */
    feat_kicker: "Özellikler",
    feat_title: "Bir linkin ihtiyacı olan her şey.",
    feat_sub: "Bir saniyelik kısaltıcıdan kurumsal düzeyde kontrollere — linkleriniz işini yapsın, tasarım görünmez kalsın.",
    feat_instant_title: "Anında kısaltma",
    feat_instant_text: "URL'nizi yapıştırın ve hemen kısa kodu alın — başlamak için hesap gerekmez.",
    feat_analytics_title: "Gizlilik odaklı analitik",
    feat_analytics_text: "Sadece gerekli metrikler toplanır. Gerçek zamanlı tıklamalar, yönlendirenler ve cihazlar — başka hiçbir şey.",
    feat_safety_title: "Yerleşik güvenlik",
    feat_safety_text: "Gerçek zamanlı tehdit taramaları, haftalık yeniden tarama ve topluluk bildirimleri platformu temiz tutar.",
    feat_domains_title: "Özel alan adları",
    feat_domains_text: "Kendi alan adınızı getirin — paylaştığınız her linkte markanız kalsın.",
    feat_vis_clicks: "12.408 tıklama",
    feat_vis_regions: "En çok bölge",
    feat_vis_devices: "Cihazlar",
    feat_dashboard_title: "Sizi takip eden panel",
    feat_dashboard_text: "Canlı tıklama akışı, ekipler için çalışma alanları, etiketler ve klasörler — hepsi gerçek zamanlı.",
    feat_dashboard_link: "Panelinizi açın",
    feat_workspaces_title: "Çalışma Alanları (Workspaces)",
    feat_workspaces_text: "Ekibinizle iş birliği yapın. Her çalışma alanı için ayrı linkler, istatistikler ve ayarlar — hepsi düzenli ve izole.",
    feat_workspaces_link: "Çalışma alanlarını yönetin",
    feat_ws_stat: "3 üye · 2 çalışma alanı",
    feat_ws_invite: "Üye davet et →",

    /* How it works */
    how_kicker: "Nasıl çalışır",
    how_title: "Üç adım. Hepsi bu.",
    how_step1_title: "Linkinizi yapıştırın",
    how_step1_text: "Uzun URL'yi yukarıdaki oluşturucuya bırakın — ilk linkler için kayıt gerekmez.",
    how_step2_title: "Kişiselleştirin",
    how_step2_text: "Alias seçin, şifre koyun, UTM parametreleri ekleyin ya da cihazları hedefleyin.",
    how_step3_title: "Paylaşın ve izleyin",
    how_step3_text: "Her yerde paylaşın. Tıklamaların panelinizde gerçek zamanlı gelişini izleyin.",
    how_cta: "Ücretsiz hesap oluştur",
    how_link: "Akış hakkında daha fazla",

    /* Stats */
    stat_ms: "Milisaniyede kısaltır",
    stat_uptime: "Erişilebilirlik hedefi (%)",
    stat_langs: "Arayüz dili",
    stat_watch: "Güvenlik izleme (s/gün)",

    /* Tools */
    tools_kicker: "Araçlar",
    tools_title: "İş için iki yol daha.",
    qr_customize: "QR Kodu Özelleştir",
    qr_generate_btn: "QR Kod Oluştur",
    qr_sub: "Herhangi bir kısa linki kendi renklerinizle markalı QR koda dönüştürün.",
    qr_alias_label: "Kısa link",
    qr_alias_placeholder: "abc123",
    qr_fg_color: "QR Rengi",
    qr_bg_color: "Arka Plan Rengi",
    qr_theme_presets: "Temalar:",
    qr_theme_classic: "Klasik",
    qr_theme_dark: "Monolith Koyu",
    qr_theme_slate: "Grafit",
    qr_palette_title: "Monokrom & Tonlar",
    qr_custom_color: "Özel renk…",
    qr_download_hint: "QR kodunuzu PNG olarak indirin.",
    qr_download_btn: "QR İndir",
    report_title: "Link Bildir",
    report_sub: "Kurallara aykırı bir link mi buldunuz? Bize yazın — moderasyon hızla müdahale eder.",
    report_placeholder: "Bildirilecek kısa link",
    report_link_label: "Bildirilecek kısa link",
    report_link_placeholder: "abc123 veya kısa link URL",
    report_reason_label: "Sebep",
    report_reason: "Bildirim nedenini yazın…",
    report_btn: "Bildirimi Gönder",
    report_login_hint: "Bildirim göndermek için hesabınıza giriş yapmalısınız.",

    /* Workspace */
    ws_title: "Workspace",
    workspace_personal: "Kişisel hesap",
    ws_role_owner: "Sahip",
    ws_role_editor: "Düzenleyici",
    ws_role_viewer: "İzleyici",

    /* Accessibility / Aria */
    aria_nav_main: "Ana gezinme",
    aria_home: "Ovlink ana sayfa",
    aria_lang: "Dil",
    aria_menu: "Menü",
    aria_close_menu: "Menüyü kapat",
    aria_user_menu: "Hesap menüsü",
    aria_qr_color: "QR rengi",
    aria_qr_bg: "Arka plan rengi",
    aria_promo: "Ovlink Pro tanıtımı",
    aria_promo_close: "Tanıtımı kapat",
    aria_save_utm: "UTM şablonunu kaydet",
    aria_utm_template: "UTM şablonu",
    aria_long_url: "Kısaltılacak uzun URL",
    aria_custom_alias: "Özel alias",
    aria_link_pass: "Link şifresi",
    aria_expiry_date: "Son kullanma tarihi",
    aria_max_clicks: "Maksimum tıklama sayısı",
    aria_ios_redirect: "iOS yönlendirme linki",
    aria_android_redirect: "Android yönlendirme linki",
    aria_target_b: "Hedef URL B",
    aria_split_percent: "Link A trafik yüzdesi",
    aria_qr_link: "QR kısa linki",
    aria_report_link: "Bildirilecek link",
    aria_report_reason: "Bildirim sebebi",
    aria_stats: "Platform istatistikleri",
    aria_qr_code_alt: "QR kod",
    aria_logo_alt: "Ovlink Logosu",

    /* Notifications */
    dashboard_stats_link: "İstatistik",
    profile_settings_title: "Profil Ayarları",
    notif_center_title: "Bildirim Merkezi",
    notif_short_label: "Kısa link:",
    notif_original_label: "Orijinal link:",

    /* Footer */
    footer_group_company: "Şirket",
    footer_group_legal: "Yasal",
    footer_group_resources: "Kaynaklar",
    home_foot_note_intro: "Ovlink güvenilir ve yönetilebilir kısa linkler için tasarlanmıştır. Meşru paylaşım içindir; güvenlik veya politika ihlali yapan linkler kısıtlanabilir.",
    home_foot_note_link: "Daha fazla bilgi",
    privacy_policy: "Gizlilik Politikası",
    terms_policy: "Kullanım Şartları",
    cookie_policy: "Çerez Politikası",
    about_policy: "Hakkımızda",
    why_ovlink_link: "Neden Ovlink?",
    contact_policy: "İletişim",
    faq_link: "SSS",
    help_link: "Yardım",
    docs_link: "Dokümanlar",
    api_guide_link: "API Rehberi",
    abuse_safety_link: "Kötüye Kullanım ve Güvenlik",
    updates_link: "Güncellemeler",
    pricing_link: "Pro Fiyatlar",
    footer_text: "© 2026 · Geliştirildi ve Sunuldu: Ulvi Ahadov",

    /* Promo chip */
    floating_pricing_badge: "PRO",
    floating_pricing_title: "Premium özellikleri aç",
    floating_pricing_text: "$4.99/ay · API + Webhook · 3 Gün Ücretsiz",

    /* Cookie */
    cookie_text: "Bu site deneyiminizi iyileştirmek için çerezlerden yararlanır.",
    cookie_more_info: "Daha Fazla Bilgi",
    cookie_accept: "Tamam",

    /* Errors */
    error_alias_taken: "Bu özel link zaten kullanılıyor.",
    error_invalid_url: "Lütfen geçerli bir URL girin.",
    error_link_not_found: "Böyle bir link bulunamadı."
  },
  en: {
    /* Nav */
    nav_login: "Log in",
    nav_register: "Sign up",
    nav_logout: "Log out",
    nav_my_account: "My Account",
    navx_how: "How it works",
    navx_why: "Why Ovlink",
    navx_pro: "Pro",
    navx_faq: "FAQ",
    nav_pricing: "Pro Plan",
    skip_to_content: "Skip to content",

    /* Hero */
    hero_eyebrow: "Faster links, smarter results",
    hero_display: "Shorten. Track. Share.",
    hero_display_1: "Shorten.",
    hero_display_2: "Track. Share.",
    hero_sub: "Every link, beautifully managed. Create short links with custom aliases, passwords, expiry and analytics — free.",
    hero_link_how: "See how it works",
    hero_link_why: "Why Ovlink",

    /* Composer */
    composer_title: "Create a short link",
    composer_guest: "Guests can create 2 links per day.",
    composer_guest_cta: "Create free account",
    composer_trust: "Every destination is scanned for safety — malicious links are quarantined automatically.",
    input_placeholder: "https://example.com/your-very-long-link",
    shorten_btn: "Shorten",
    advanced_settings: "Advanced Settings",
    alias_label: "Custom alias",
    alias_placeholder: "my-link",
    pass_label: "Password",
    pass_placeholder: "••••••••",
    expiry_date: "Expiration Date",
    max_clicks: "Maximum Clicks",
    shorten_domain_label: "Short link domain",
    shorten_domain_default: "Default (ovlink.sbs)",
    shorten_domain_hint: "Your active domains appear here.",
    shorten_domain_manage_link: "Add custom domain",

    /* Advanced / UTM */
    adv_tab_general: "General",
    adv_tab_utm: "UTM",
    adv_tab_ab: "A/B Test",
    adv_tab_device: "Device",
    adv_utm_params_title: "UTM Parameters",
    adv_utm_template_select: "Select Template",
    adv_utm_save: "Save",
    adv_utm_save_tooltip: "Save current UTM settings",
    adv_utm_source: "Source",
    adv_utm_source_ph: "e.g. instagram",
    adv_utm_medium: "Medium",
    adv_utm_medium_ph: "e.g. social",
    adv_utm_campaign: "Campaign",
    adv_utm_campaign_ph: "e.g. summer_sale",
    adv_utm_popular_templates: "Popular Templates",
    adv_utm_custom_templates: "Custom Templates",
    adv_utm_no_params_alert: "No UTM parameter found to save!",
    adv_utm_prompt_name: "Enter a name for this template (e.g., Summer Sale):",
    adv_utm_save_error: "Error occurred while saving the template.",
    adv_ab_title: "A/B Testing (Link Rotator)",
    adv_ab_url_b: "Target URL B (Second Link)",
    adv_ab_url_b_ph: "https://… (URL B)",
    adv_ab_split: "Link A traffic (%)",
    adv_ab_hint: "Remaining traffic goes to Link B.",
    adv_device_title: "Device Targeting",
    adv_device_ios: "iOS Redirect",
    adv_device_ios_ph: "https://apps.apple.com/…",
    adv_device_android: "Android Redirect",
    adv_device_android_ph: "https://play.google.com/…",
    pro_badge: "PRO",
    pro_feature_required: "A/B Testing and Device Targeting are only available for PRO users. Please upgrade to Pro.",
    pro_feature_required_ab: "A/B Testing is only available for PRO users. Please upgrade to Pro.",
    pro_feature_required_device: "Device Targeting is only available for PRO users. Please upgrade to Pro.",

    /* Result */
    shorten_btn: "Shorten",
    generated_title: "Your link is ready!",
    copy_btn: "Copy",
    copied_msg: "Copied!",
    send_qr_btn: "Send to QR",

    /* Feature tiles */
    feat_kicker: "Features",
    feat_title: "Everything a link needs.",
    feat_sub: "From a one-second shortener to enterprise-grade controls — designed to disappear so your links do the work.",
    feat_instant_title: "Instant shortening",
    feat_instant_text: "Paste your URL and get a short code instantly — no account required to start.",
    feat_analytics_title: "Privacy-first analytics",
    feat_analytics_text: "Only essential stats are collected. Real-time clicks, referrers and devices — nothing more.",
    feat_safety_title: "Safety built-in",
    feat_safety_text: "Real-time threat scans, weekly re-scans and community reports keep the platform clean.",
    feat_domains_title: "Custom domains",
    feat_domains_text: "Bring your own domain and keep your brand in every link you share.",
    feat_vis_clicks: "12,408 clicks",
    feat_vis_regions: "Top region",
    feat_vis_devices: "Devices",
    feat_dashboard_title: "A dashboard that keeps up",
    feat_dashboard_text: "Live click streams, workspaces for teams, tags and folders — all in real time.",
    feat_dashboard_link: "Open your dashboard",
    feat_workspaces_title: "Workspaces",
    feat_workspaces_text: "Collaborate with your team. Separate links, stats and settings per workspace — everything scoped and clean.",
    feat_workspaces_link: "Manage workspaces",
    feat_ws_stat: "3 members · 2 workspaces",
    feat_ws_invite: "Invite member →",

    /* How it works */
    how_kicker: "How it works",
    how_title: "Three steps. That's it.",
    how_step1_title: "Paste your link",
    how_step1_text: "Drop any long URL into the composer above — no signup needed for your first links.",
    how_step2_title: "Customize it",
    how_step2_text: "Choose an alias, set a password, add UTM parameters or target devices.",
    how_step3_title: "Share & track",
    how_step3_text: "Share it anywhere. Watch clicks arrive in real time on your dashboard.",
    how_cta: "Create free account",
    how_link: "More about the flow",

    /* Stats */
    stat_ms: "Milliseconds to shorten",
    stat_uptime: "Uptime target (%)",
    stat_langs: "Interface languages",
    stat_watch: "Safety watch (h/day)",

    /* Tools */
    tools_kicker: "Tools",
    tools_title: "Two more ways to work.",
    qr_customize: "Customize QR Code",
    qr_generate_btn: "Generate QR",
    qr_sub: "Turn any short link into a branded QR code with your own colors.",
    qr_alias_label: "Short link",
    qr_alias_placeholder: "abc123",
    qr_fg_color: "QR Color",
    qr_bg_color: "Background Color",
    qr_theme_presets: "Themes:",
    qr_theme_classic: "Classic",
    qr_theme_dark: "Monolith Dark",
    qr_theme_slate: "Slate",
    qr_palette_title: "Monochrome & Tones",
    qr_custom_color: "Custom color…",
    qr_download_hint: "Download your QR as PNG.",
    qr_download_btn: "Download QR",
    report_title: "Report Link",
    report_sub: "Found a link that violates the rules? Tell us — moderation acts fast.",
    report_placeholder: "Short link to report",
    report_link_label: "Short link to report",
    report_link_placeholder: "abc123 or short link URL",
    report_reason_label: "Reason",
    report_reason: "Reason for reporting…",
    report_btn: "Submit Report",
    report_login_hint: "You must be logged in to submit a report.",

    /* Workspace */
    ws_title: "Workspace",
    workspace_personal: "Personal account",
    ws_role_owner: "Owner",
    ws_role_editor: "Editor",
    ws_role_viewer: "Viewer",

    /* Accessibility / Aria */
    aria_nav_main: "Main navigation",
    aria_home: "Ovlink home",
    aria_lang: "Language",
    aria_menu: "Menu",
    aria_close_menu: "Close menu",
    aria_user_menu: "Account menu",
    aria_qr_color: "QR color",
    aria_qr_bg: "Background color",
    aria_promo: "Ovlink Pro promotion",
    aria_promo_close: "Close promotion",
    aria_save_utm: "Save UTM template",
    aria_utm_template: "UTM template",
    aria_long_url: "Long URL to shorten",
    aria_custom_alias: "Custom alias",
    aria_link_pass: "Link password",
    aria_expiry_date: "Expiration date",
    aria_max_clicks: "Maximum clicks",
    aria_ios_redirect: "iOS redirect URL",
    aria_android_redirect: "Android redirect URL",
    aria_target_b: "Target URL B",
    aria_split_percent: "Link A traffic percent",
    aria_qr_link: "QR short link",
    aria_report_link: "Short link to report",
    aria_report_reason: "Report reason",
    aria_stats: "Platform statistics",
    aria_qr_code_alt: "QR code",
    aria_logo_alt: "Ovlink Logo",

    /* Notifications */
    dashboard_stats_link: "Statistics",
    profile_settings_title: "Profile Settings",
    notif_center_title: "Notification Center",
    notif_short_label: "Short link:",
    notif_original_label: "Original link:",

    /* Footer */
    footer_group_company: "Company",
    footer_group_legal: "Legal",
    footer_group_resources: "Resources",
    home_foot_note_intro: "Ovlink is built for trustworthy, manageable short links. Intended for legitimate sharing; links that violate safety or policy rules may be restricted.",
    home_foot_note_link: "Learn more",
    privacy_policy: "Privacy Policy",
    terms_policy: "Terms of Use",
    cookie_policy: "Cookie Policy",
    about_policy: "About",
    why_ovlink_link: "Why Ovlink?",
    contact_policy: "Contact",
    faq_link: "FAQ",
    help_link: "Help",
    docs_link: "Docs",
    api_guide_link: "API Guide",
    abuse_safety_link: "Abuse & Safety",
    updates_link: "Updates",
    pricing_link: "Pro Pricing",
    footer_text: "© 2026 · Developed & Powered by Ulvi Ahadov",

    /* Promo chip */
    floating_pricing_badge: "PRO",
    floating_pricing_title: "Unlock Premium features",
    floating_pricing_text: "$4.99/mo · API + Webhooks · 3-Day Free Trial",

    /* Cookie */
    cookie_text: "This site uses cookies to improve your experience.",
    cookie_more_info: "Learn more",
    cookie_accept: "OK",

    /* Errors */
    error_alias_taken: "This custom alias is already in use.",
    error_invalid_url: "Please enter a valid URL.",
    error_link_not_found: "Link not found."
  }
};

function getCookieLangHome() {
  const match = document.cookie.match(/(?:^|;\s*)(?:lang_default|lang|ovlink_lang)=([^;]+)/);
  return match ? decodeURIComponent(match[1]).trim().toLowerCase() : '';
}

const isValidHomeLang = (v) => v === 'az' || v === 'tr' || v === 'en';

function detectBrowserLangHome() {
  const navLangs = (typeof navigator !== 'undefined' && (navigator.languages || [navigator.language || ''])) || [];
  for (const l of navLangs) {
    if (!l) continue;
    const prefix = l.toLowerCase().slice(0, 2);
    if (isValidHomeLang(prefix)) return prefix;
  }
  return 'az';
}

const storedHomeLang = typeof localStorage !== 'undefined' ? (localStorage.getItem('lang') || localStorage.getItem('ovlink_lang')) : null;
const cookieHomeLang = getCookieLangHome();
let currentHomeLang = isValidHomeLang(storedHomeLang)
  ? storedHomeLang
  : (isValidHomeLang(cookieHomeLang) ? cookieHomeLang : detectBrowserLangHome());

try {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('lang', currentHomeLang);
    localStorage.setItem('ovlink_lang', currentHomeLang);
  }
  if (typeof document !== 'undefined') {
    document.cookie = 'lang_default=' + encodeURIComponent(currentHomeLang) + '; path=/; max-age=31536000; SameSite=Lax';
  }
} catch(_) {}

function translateHome(lang, key) {
  return (homeTranslations[lang] && homeTranslations[lang][key]) || '';
}

function applyHomeLanguage() {
  const lang = currentHomeLang;
  const elements = document.querySelectorAll('[data-i18n]');
  elements.forEach((el) => {
    const key = el.getAttribute('data-i18n');
    const value = translateHome(lang, key);
    if (!value) return;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.placeholder = value;
    } else {
      el.textContent = value;
    }
  });

  const placeholders = document.querySelectorAll('[data-i18n-placeholder]');
  placeholders.forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder');
    const value = translateHome(lang, key);
    if (value) {
      el.placeholder = value;
      el.setAttribute('placeholder', value);
    }
  });

  const titles = document.querySelectorAll('[data-i18n-title]');
  titles.forEach((el) => {
    const key = el.getAttribute('data-i18n-title');
    const value = translateHome(lang, key);
    if (value) {
      el.title = value;
      el.setAttribute('data-bs-original-title', value);
    }
  });

  const arias = document.querySelectorAll('[data-i18n-aria]');
  arias.forEach((el) => {
    const key = el.getAttribute('data-i18n-aria');
    const value = translateHome(lang, key);
    if (value) {
      el.setAttribute('aria-label', value);
    }
  });

  const alts = document.querySelectorAll('[data-i18n-alt]');
  alts.forEach((el) => {
    const key = el.getAttribute('data-i18n-alt');
    const value = translateHome(lang, key);
    if (value) {
      el.setAttribute('alt', value);
    }
  });

  const getEl = (id) => (typeof document !== 'undefined' && typeof document.getElementById === 'function' ? document.getElementById(id) : null);
  const banner = getEl('siteAnnouncement');
  const bannerText = getEl('siteAnnouncementText');
  if (banner && bannerText) {
    const az = banner.getAttribute('data-az') || '';
    const tr = banner.getAttribute('data-tr') || '';
    const en = banner.getAttribute('data-en') || '';
    const textValue = lang === 'tr' ? (tr || az || en) : (lang === 'en' ? (en || az || tr) : (az || tr || en));
    bannerText.textContent = textValue;
    if (textValue) banner.removeAttribute('hidden');
    else banner.setAttribute('hidden', '');
  }

  const toggleBtn = getEl('langToggleBtn');
  if (toggleBtn) toggleBtn.textContent = lang.toUpperCase();
  const toggleBtnM = getEl('langToggleBtnMobile');
  if (toggleBtnM) toggleBtnM.textContent = lang.toUpperCase();

  const langOptions = typeof document !== 'undefined' && typeof document.querySelectorAll === 'function' ? document.querySelectorAll('.lang-option, .m-lang-item') : [];
  langOptions.forEach((option) => {
    const optionLang = option.getAttribute('data-lang') || '';
    option.textContent = optionLang.toUpperCase();
    const active = optionLang === lang;
    option.classList.toggle('active', active);
    option.classList.toggle('is-active', active);
    if (active) option.setAttribute('aria-current', 'true');
    else option.removeAttribute('aria-current');
  });

  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = lang;
  }

  if (typeof window !== 'undefined' && typeof window.refreshCustomDomainUi === 'function') {
    window.refreshCustomDomainUi();
  }

  if (typeof window !== 'undefined' && typeof window.loadUtmTemplatesUi === 'function') {
    window.loadUtmTemplatesUi();
  }
}

function setHomeLanguage(lang) {
  if (!isValidHomeLang(lang)) return;
  currentHomeLang = lang;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('lang', lang);
      localStorage.setItem('ovlink_lang', lang);
    }
    if (typeof document !== 'undefined') {
      document.cookie = 'lang_default=' + encodeURIComponent(lang) + '; path=/; max-age=31536000; SameSite=Lax';
    }
  } catch {}
  applyHomeLanguage();
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('ovlink:languageChanged', { detail: { lang: currentHomeLang } }));
  }
}

window.ovlinkI18n = {
  getLang() {
    return currentHomeLang;
  },
  translate(key) {
    return translateHome(currentHomeLang, key);
  },
  translateLang(lang, key) {
    return translateHome(lang, key);
  },
  setLang(lang) {
    setHomeLanguage(lang);
  }
};

function initHomeLangUi() {
  applyHomeLanguage();
  const langOptions = typeof document !== 'undefined' && typeof document.querySelectorAll === 'function' ? document.querySelectorAll('.lang-option, .m-lang-item') : [];
  langOptions.forEach((option) => {
    option.addEventListener('click', (e) => {
      e.preventDefault();
      const selected = option.getAttribute('data-lang');
      setHomeLanguage(selected);
      if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
        document.querySelectorAll('.m-lang-panel, .lang-menu').forEach((panel) => {
          panel.classList.remove('open', 'is-open');
        });
        document.querySelectorAll('.m-lang-btn, [data-lang-btn]').forEach((btn) => {
          btn.setAttribute('aria-expanded', 'false');
        });
      }
    });
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', initHomeLangUi);
  } else {
    initHomeLangUi();
  }
}
