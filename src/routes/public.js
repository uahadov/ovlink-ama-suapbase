const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { db } = require('../db/index');
const { dbGetAsync } = require('../db/helpers');
const { buildSeoMeta: buildSeo } = require('../lib/seo');
const { normalizeLang, pickLang } = require('../lib/i18n');
const { decryptAES256GCM } = require('../../utils/crypto');
const { requireSignedIn } = require('../middleware/auth');
const { getEffectivePlanForUser, isProAccessActive } = require('../lib/plans');

const router = express.Router();

const publicDir = path.join(__dirname, '../../public');

async function loadUserPlanRow(userId) {
  if (!Number.isInteger(userId) || userId <= 0) return null;
  return dbGetAsync(
    'SELECT id, plan_tier, plan_status, pro_expires_at, pro_paused_at, polar_customer_id FROM users WHERE id = ?',
    [userId]
  );
}

async function getWorkspaceById(workspaceId) {
  const id = Number.parseInt(workspaceId, 10);
  if (!Number.isInteger(id) || id <= 0) return null;
  return dbGetAsync('SELECT id, name, owner_user_id, created_at FROM workspaces WHERE id = ?', [id]);
}

async function isWorkspaceProActive(workspace) {
  if (!workspace || !workspace.owner_user_id) return false;
  const ownerPlanRow = await loadUserPlanRow(workspace.owner_user_id);
  return isProAccessActive(ownerPlanRow);
}

function isIsoTimeExpired(isoString) {
  if (!isoString) return false;
  const ms = Date.parse(isoString);
  if (Number.isNaN(ms)) return false;
  return ms < Date.now();
}

// Sayfa Rotaları
router.get('/', (req, res) => {
  const seo = buildSeo(req, {
    path: '/',
    titleAz: 'Link Qısaltmaq - Pulsuz URL Qısaltma və QR Kod Yarat | Ovlink',
    titleTr: 'Link Kısaltma - Ücretsiz URL Kısaltıcı & QR Kod Oluşturucu | Ovlink',
    titleEn: 'URL Shortener - Free Link Shortening & QR Code Generator | Ovlink',
    descAz: 'Ovlink ilə uzun linkləri 1 saniyədə pulsuz qısaldın, xüsusi QR kodlar yaradın, klik analitikasını izləyin və @OvlinkBOT Telegram botu ilə idarə edin.',
    descTr: 'Ovlink ile uzun linklerinizi saniyeler içinde ücretsiz kısaltın, özel QR kodlar oluşturun, anlık tıklama analitiğini takip edin ve @OvlinkBOT Telegram botu ile yönetin.',
    descEn: 'Shorten long URLs in seconds, generate custom QR codes, track real-time click analytics, and use our instant @OvlinkBOT Telegram bot with Ovlink.'
  });
  res.render('index', { csrfToken: res.locals._csrf, seo });
});
router.get('/login', (req, res) => res.render('login', { csrfToken: res.locals._csrf }));
router.get('/register', (req, res) => res.render('register', { csrfToken: res.locals._csrf }));
router.get('/stats', (req, res) => res.render('stats', { csrfToken: res.locals._csrf, short: req.query.short || '' }));

router.get('/login.html', (req, res) => res.redirect(301, '/login'));
router.get('/register.html', (req, res) => res.redirect(301, '/register'));
router.get('/dashboard.html', (req, res) => res.redirect(301, '/dashboard'));
router.get('/stats.html', (req, res) => {
  const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  return res.redirect(301, '/stats' + q);
});

router.get('/privacy', (req, res) => {
  const seo = buildSeo(req, {
    path: '/privacy',
    titleAz: 'Məxfilik Siyasəti - Ovlink',
    titleTr: 'Gizlilik Politikası - Ovlink',
    titleEn: 'Privacy Policy - Ovlink',
    descAz: 'Ovlink məxfilik siyasəti və şəxsi məlumatların işlənməsi haqqında məlumat.',
    descTr: 'Ovlink gizlilik politikası ve kişisel verilerin işlenmesi hakkında bilgi.',
    descEn: 'Ovlink privacy policy and how we process personal data.'
  });
  res.render('privacy', { csrfToken: res.locals._csrf, seo });
});
router.get('/privacy.html', (req, res) => {
  const seo = buildSeo(req, {
    path: '/privacy',
    titleAz: 'Məxfilik Siyasəti - Ovlink',
    titleTr: 'Gizlilik Politikası - Ovlink',
    titleEn: 'Privacy Policy - Ovlink',
    descAz: 'Ovlink məxfilik siyasəti və şəxsi məlumatların işlənməsi haqqında məlumat.',
    descTr: 'Ovlink gizlilik politikası ve kişisel verilerin işlenmesi hakkında bilgi.',
    descEn: 'Ovlink privacy policy and how we process personal data.'
  });
  res.render('privacy', { csrfToken: res.locals._csrf, seo });
});

router.get('/terms', (req, res) => {
  const seo = buildSeo(req, {
    path: '/terms',
    titleAz: 'İstifadə Şərtləri - Ovlink',
    titleTr: 'Kullanım Şartları - Ovlink',
    titleEn: 'Terms of Service - Ovlink',
    descAz: 'Ovlink xidmətindən istifadə şərtləri və qaydaları.',
    descTr: 'Ovlink kullanım şartları ve hizmet kuralları.',
    descEn: 'Ovlink terms of service and usage rules.'
  });
  res.render('terms', { csrfToken: res.locals._csrf, seo });
});
router.get('/terms.html', (req, res) => {
  const seo = buildSeo(req, {
    path: '/terms',
    titleAz: 'İstifadə Şərtləri - Ovlink',
    titleTr: 'Kullanım Şartları - Ovlink',
    titleEn: 'Terms of Service - Ovlink',
    descAz: 'Ovlink xidmətindən istifadə şərtləri və qaydaları.',
    descTr: 'Ovlink kullanım şartları ve hizmet kuralları.',
    descEn: 'Ovlink terms of service and usage rules.'
  });
  res.render('terms', { csrfToken: res.locals._csrf, seo });
});

router.get('/contact', (req, res) => {
  const seo = buildSeo(req, {
    path: '/contact',
    titleAz: 'Əlaqə - Ovlink',
    titleTr: 'İletişim - Ovlink',
    titleEn: 'Contact - Ovlink',
    descAz: 'Dəstək və əlaqə üçün Ovlink ilə əlaqə saxlayın.',
    descTr: 'Destek ve iletişim için Ovlink ile iletişime geçin.',
    descEn: 'Contact Ovlink support and get help.'
  });
  res.render('contact', { csrfToken: res.locals._csrf, seo });
});
router.get('/contact.html', (req, res) => {
  const seo = buildSeo(req, {
    path: '/contact',
    titleAz: 'Əlaqə - Ovlink',
    titleTr: 'İletişim - Ovlink',
    titleEn: 'Contact - Ovlink',
    descAz: 'Dəstək və əlaqə üçün Ovlink ilə əlaqə saxlayın.',
    descTr: 'Destek ve iletişim için Ovlink ile iletişime geçin.',
    descEn: 'Contact Ovlink support and get help.'
  });
  res.render('contact', { csrfToken: res.locals._csrf, seo });
});

router.get('/pricing', (req, res) => {
  const seo = buildSeo(req, {
    path: '/pricing',
    titleAz: 'Pro Plan Qiymətləri - Ovlink',
    titleTr: 'Pro Plan Fiyatlandırma - Ovlink',
    titleEn: 'Pro Plan Pricing - Ovlink',
    descAz: 'Ovlink Free və Pro planlarını müqayisə edin. Pro plan üçün qiymət $4.99/ay.',
    descTr: 'Ovlink Free ve Pro planlarını karşılaştırın. Pro plan fiyatı $4.99/ay.',
    descEn: 'Compare Ovlink Free and Pro plans. Pro pricing is $4.99/month with 3-day free trial.',
  });
  
  const isLoggedIn = !!(req.session && req.session.userId);
  res.render('pricing', { csrfToken: res.locals._csrf, seo, isLoggedIn });
});
router.get('/pricing.html', (req, res) => res.redirect(301, '/pricing'));

// Polar checkout success page: the checkout success_url returns here after payment.
router.get('/pro', (req, res) => {
  const seo = buildSeo(req, {
    path: '/pro',
    titleAz: 'Pro aktivləşdirilir - Ovlink',
    titleTr: 'Pro etkinleştiriliyor - Ovlink',
    titleEn: 'Pro activation - Ovlink',
    descAz: 'Ovlink Pro ödənişi tamamlandı; abunəlik avtomatik aktivləşdirilir.',
    descTr: 'Ovlink Pro ödemesi tamamlandı; abonelik otomatik etkinleştirilir.',
    descEn: 'Ovlink Pro payment completed; the subscription is activated automatically.'
  });
  res.render('pro', { csrfToken: res.locals._csrf, seo, isLoggedIn: !!(req.session && req.session.userId) });
});

router.get('/cookie-policy', (req, res) => {
  const seo = buildSeo(req, {
    path: '/cookie-policy',
    titleAz: 'Cookie Siyasəti - Ovlink',
    titleTr: 'Çerez Politikası - Ovlink',
    titleEn: 'Cookie Policy - Ovlink',
    descAz: 'Ovlink kuki siyasəti və kukilərin istifadəsi haqqında məlumat.',
    descTr: 'Ovlink çerez politikası ve çerez kullanımı hakkında bilgi.',
    descEn: 'Ovlink cookie policy and how cookies are used.'
  });
  res.render('cookie-policy', { csrfToken: res.locals._csrf, seo });
});
router.get('/cookie-policy.html', (req, res) => {
  const seo = buildSeo(req, {
    path: '/cookie-policy',
    titleAz: 'Cookie Siyasəti - Ovlink',
    titleTr: 'Çerez Politikası - Ovlink',
    titleEn: 'Cookie Policy - Ovlink',
    descAz: 'Ovlink kuki siyasəti və kukilərin istifadəsi haqqında məlumat.',
    descTr: 'Ovlink çerez politikası ve çerez kullanımı hakkında bilgi.',
    descEn: 'Ovlink cookie policy and how cookies are used.'
  });
  res.render('cookie-policy', { csrfToken: res.locals._csrf, seo });
});

router.get('/about', (req, res) => {
  const seo = buildSeo(req, {
    path: '/about',
    titleAz: 'Haqqımızda - Ovlink',
    titleTr: 'Hakkımızda - Ovlink',
    titleEn: 'About - Ovlink',
    descAz: 'Ovlink xidmətinin məqsədi və operator məlumatları.',
    descTr: 'Ovlink hizmetinin amacı ve işletmeci bilgileri.',
    descEn: 'Purpose of Ovlink and operator information.'
  });
  res.render('about', { csrfToken: res.locals._csrf, seo });
});
router.get('/about.html', (req, res) => {
  const seo = buildSeo(req, {
    path: '/about',
    titleAz: 'Haqqımızda - Ovlink',
    titleTr: 'Hakkımızda - Ovlink',
    titleEn: 'About - Ovlink',
    descAz: 'Ovlink xidmətinin məqsədi və operator məlumatları.',
    descTr: 'Ovlink hizmetinin amacı ve işletmeci bilgileri.',
    descEn: 'Purpose of Ovlink and operator information.'
  });
  res.render('about', { csrfToken: res.locals._csrf, seo });
});

router.get('/how-it-works', (req, res) => {
  const seo = buildSeo(req, {
    path: '/how-it-works',
    titleAz: 'Link Qısaltma Necə İşləyir? - Ovlink',
    titleTr: 'Link Kısaltma Nasıl Çalışır? - Ovlink',
    titleEn: 'How URL Shortening Works - Ovlink',
    descAz: 'Qısa linklərin yaradılması, paylaşılması və statistika izahı.',
    descTr: 'Kısa link oluşturma, paylaşım ve istatistik açıklaması.',
    descEn: 'How short links are created, shared, and measured.'
  });
  res.render('how-it-works', { csrfToken: res.locals._csrf, seo });
});
router.get('/how-it-works.html', (req, res) => {
  const seo = buildSeo(req, {
    path: '/how-it-works',
    titleAz: 'Link Qısaltma Necə İşləyir? - Ovlink',
    titleTr: 'Link Kısaltma Nasıl Çalışır? - Ovlink',
    titleEn: 'How URL Shortening Works - Ovlink',
    descAz: 'Qısa linklərin yaradılması, paylaşılması və statistika izahı.',
    descTr: 'Kısa link oluşturma, paylaşım ve istatistik açıklaması.',
    descEn: 'How short links are created, shared, and measured.'
  });
  res.render('how-it-works', { csrfToken: res.locals._csrf, seo });
});
router.get('/why-ovlink', (req, res) => {
  const seo = buildSeo(req, {
    path: '/why-ovlink',
    titleAz: 'Niyə Ovlink? - Ovlink',
    titleTr: 'Neden Ovlink? - Ovlink',
    titleEn: 'Why Ovlink? - Ovlink',
    descAz: 'Ovlink-in dəyəri, təhlükəsizlik və idarəetmə prinsipləri.',
    descTr: "Ovlink'in değeri, güvenlik ve yönetim yaklaşımı.",
    descEn: "Ovlink's value, safety model, and link management approach."
  });
  res.render('why-ovlink', { csrfToken: res.locals._csrf, seo });
});
router.get('/why-ovlink.html', (req, res) => res.redirect(301, '/why-ovlink'));

router.get('/faq', (req, res) => {
  const seo = buildSeo(req, {
    path: '/faq',
    titleAz: 'FAQ - Ovlink',
    titleTr: 'SSS - Ovlink',
    titleEn: 'FAQ - Ovlink',
    descAz: 'Ovlink haqqında tez-tez verilən suallar və qısa cavablar.',
    descTr: 'Ovlink hakkında sıkça sorulan sorular ve kısa cevaplar.',
    descEn: 'Frequently asked questions about Ovlink.'
  });
  res.render('faq', { csrfToken: res.locals._csrf, seo });
});
router.get('/faq.html', (req, res) => res.redirect(301, '/faq'));
router.get('/sss', (req, res) => res.redirect(301, '/faq'));

router.get('/help', (req, res) => {
  const seo = buildSeo(req, {
    path: '/help',
    titleAz: 'Yardım Mərkəzi - Ovlink',
    titleTr: 'Yardım Merkezi - Ovlink',
    titleEn: 'Help Center - Ovlink',
    descAz: 'Ovlink üçün addım-addım istifadə və problem həlli bələdçisi.',
    descTr: 'Ovlink için adım adım kullanım ve sorun giderme rehberi.',
    descEn: 'Step-by-step help and troubleshooting for Ovlink.'
  });
  res.render('help', { csrfToken: res.locals._csrf, seo });
});
router.get('/help.html', (req, res) => res.redirect(301, '/help'));

router.get('/docs', (req, res) => {
  const seo = buildSeo(req, {
    path: '/docs',
    titleAz: 'Sənədlər - Ovlink',
    titleTr: 'Dokümanlar - Ovlink',
    titleEn: 'Documentation - Ovlink',
    descAz: 'Ovlink iş prinsipi, mövcud funksiyalar və məsuliyyətli istifadə sənədləri.',
    descTr: 'Ovlink çalışma modeli, mevcut özellikler ve sorumlu kullanım dokümanları.',
    descEn: 'Ovlink redirect model, available features, and responsible-use docs.'
  });
  res.render('docs', { csrfToken: res.locals._csrf, seo });
});
router.get('/docs.html', (req, res) => res.redirect(301, '/docs'));

router.get('/api-guide', (req, res) => {
  const seo = buildSeo(req, {
    path: '/api-guide',
    titleAz: 'API İstifadə Bələdçisi - Ovlink',
    titleTr: 'API Kullanım Rehberi - Ovlink',
    titleEn: 'API Usage Guide - Ovlink',
    descAz: 'Ovlink API key istifadə qaydaları və Node.js, Python, C#, C++ nümunələri.',
    descTr: 'Ovlink API key kullanım adımları ve Node.js, Python, C#, C++ örnekleri.',
    descEn: 'Ovlink API key usage guide with Node.js, Python, C#, and C++ examples.'
  });
  res.render('api-guide', { csrfToken: res.locals._csrf, seo });
});
router.get('/api-guide.html', (req, res) => res.redirect(301, '/api-guide'));

router.get('/abuse-safety', (req, res) => {
  const seo = buildSeo(req, {
    path: '/abuse-safety',
    titleAz: 'Abuse & Safety - Ovlink',
    titleTr: 'Abuse & Safety - Ovlink',
    titleEn: 'Abuse & Safety - Ovlink',
    descAz: 'Sui-istifadə, təhlükəsizlik siyasəti və icra tədbirləri barədə məlumat.',
    descTr: 'Kötüye kullanım, güvenlik politikası ve yaptırım süreci hakkında bilgi.',
    descEn: 'Abuse policy, safety standards, and enforcement actions.'
  });
  res.render('abuse-safety', { csrfToken: res.locals._csrf, seo });
});
router.get('/abuse-safety.html', (req, res) => res.redirect(301, '/abuse-safety'));

router.get('/updates', (req, res) => {
  const seo = buildSeo(req, {
    path: '/updates',
    titleAz: 'Yeniliklər - Ovlink',
    titleTr: 'Güncellemeler - Ovlink',
    titleEn: 'Updates - Ovlink',
    descAz: 'Ovlink üçün son ictimai yeniliklər, performans düzəlişləri və buraxılış qeydləri.',
    descTr: 'Ovlink için son herkese açık güncellemeler, performans iyileştirmeleri ve sürüm notları.',
    descEn: 'Latest public updates, performance improvements, and release notes for Ovlink.'
  });
  res.render('updates', { csrfToken: res.locals._csrf, seo });
});
router.get('/updates.html', (req, res) => res.redirect(301, '/updates'));


router.get('/account', async (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  const plan = await getEffectivePlanForUser(req.session.userId).catch(() => null);
  return res.render('account', { csrfToken: res.locals._csrf, plan: plan || {}, showSubManage: !!(plan && plan.tier === 'pro' && plan.polar_linked) });
});
router.get('/notifications', (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  return res.render('notifications', { csrfToken: res.locals._csrf });
});
router.get('/forgot-password', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.render('forgot-password', { csrfToken: res.locals._csrf });
});
router.get('/reset-password', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.render('reset-password', { csrfToken: res.locals._csrf, token: req.query.token || '' });
});

router.get('/workspaces', async (req, res) => {
  if (!req.session.userId) return res.redirect('/login');
  const plan = await getEffectivePlanForUser(req.session.userId).catch(() => null);
  return res.render('workspaces', { csrfToken: res.locals._csrf, plan: plan || {} });
});

// Resolve + validate an invitation token into everything the accept flow needs.
async function loadValidWorkspaceInvitation(token) {
  const rawToken = (token || '').toString().trim();
  if (!rawToken || rawToken.length > 200) return { error: 'invalid' };
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const invitation = await dbGetAsync('SELECT * FROM workspace_invitations WHERE token_hash = ?', [tokenHash]);
  if (!invitation) return { error: 'invalid' };
  if (invitation.revoked_at) return { error: 'revoked' };
  if (invitation.accepted_at) return { error: 'accepted', invitation };
  if (isIsoTimeExpired(invitation.expires_at)) return { error: 'expired', invitation };
  const workspace = await getWorkspaceById(invitation.workspace_id);
  if (!workspace) return { error: 'invalid' };
  return { invitation, workspace };
}

function maskEmailForDisplay(email) {
  const text = (email || '').toString();
  const at = text.indexOf('@');
  if (at <= 0) return text ? text.slice(0, 1) + '***' : '';
  const local = text.slice(0, at);
  const domain = text.slice(at + 1);
  const visible = local.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
}

router.get('/workspaces/accept', async (req, res) => {
  const uiLang = normalizeLang(req.query && req.query.lang, 'az');
  const token = (req.query && req.query.token || '').toString();
  const renderAccept = (state, extra = {}) => res.render('workspaces-accept', {
    csrfToken: res.locals._csrf,
    state,
    token,
    workspaceName: extra.workspaceName || '',
    invitedEmailMasked: extra.invitedEmailMasked || '',
    ...extra,
  });

  if (!req.session.userId) return renderAccept('login_required');

  const loaded = await loadValidWorkspaceInvitation(token).catch(() => ({ error: 'invalid' }));
  if (loaded.error === 'accepted') return renderAccept('accepted', { workspaceName: (await getWorkspaceById(loaded.invitation.workspace_id) || {}).name || '' });
  if (loaded.error) return renderAccept(loaded.error);

  const { invitation, workspace } = loaded;
  if (!(await isWorkspaceProActive(workspace))) return renderAccept('pro_expired', { workspaceName: workspace.name });

  const user = await dbGetAsync('SELECT id, email_hash, email FROM users WHERE id = ?', [req.session.userId]);
  if (!user || user.email_hash !== invitation.email_hash) {
    const invitedEmail = (() => { try { return decryptAES256GCM(invitation.email_encrypted); } catch { return ''; } })();
    return renderAccept('wrong_email', { workspaceName: workspace.name, invitedEmailMasked: maskEmailForDisplay(invitedEmail) });
  }

  const existingMember = await dbGetAsync('SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?', [workspace.id, user.id]);
  if (existingMember) return renderAccept('already_member', { workspaceName: workspace.name });

  return renderAccept('ready', { workspaceName: workspace.name });
});

// Deep-link bot authorization page
router.get('/bot/auth', (req, res) => {
  const platform = (req.query.platform || '').toString().trim().toLowerCase();
  const platformUserId = (req.query.id || '').toString().trim();
  const platformUsername = (req.query.name || '').toString().trim();

  if (!platform || !platformUserId || !['telegram', 'discord'].includes(platform)) {
    return res.status(400).render('error-disabled', { csrfToken: res.locals._csrf, reason: 'Geçersiz parametreler.' });
  }

  // If user is logged in, show confirmation screen (Never auto-link on GET to prevent CSRF)
  if (req.session && req.session.userId) {
    db.get('SELECT id, email FROM users WHERE id = ?', [req.session.userId], (uErr, user) => {
      if (uErr || !user) return res.redirect('/login');
      const emailPlain = user.email ? (user.email.includes(':') ? decryptAES256GCM(user.email) : user.email) : '';
      return res.render('bot-auth', {
        csrfToken: res.locals._csrf,
        platform,
        platformUserId,
        platformUsername,
        status: 'confirm',
        user: { id: user.id, email: emailPlain },
        errorMessage: null,
      });
    });
    return;
  }

  // Not logged in -> store pending auth in session, render beautiful login prompt
  req.session.pendingBotAuth = { platform, platformUserId, platformUsername, createdAt: Date.now() };
  req.session.save(() => {
    return res.render('bot-auth', {
      csrfToken: res.locals._csrf,
      platform,
      platformUserId,
      platformUsername,
      status: 'login_required',
      user: null,
      errorMessage: null,
    });
  });
});

// Safe redirect: ensure bot linking is only executed via confirmed POST /bot/auth/confirm
router.get('/bot/auth/complete', requireSignedIn, (req, res) => {
  const pending = req.session.pendingBotAuth;
  if (pending && pending.platform && pending.platformUserId) {
    const q = new URLSearchParams({
      platform: pending.platform,
      id: pending.platformUserId,
      name: pending.platformUsername || '',
    });
    delete req.session.pendingBotAuth;
    return res.redirect(`/bot/auth?${q.toString()}`);
  }
});

module.exports = router;

