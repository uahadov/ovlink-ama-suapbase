const express = require('express');
const router = express.Router();

const { db } = require('../db/index');
const { dbGetAsync, dbAllAsync } = require('../db/helpers');
const { buildSeoMeta: buildSeo } = require('../lib/seo');
const { pickLang, normalizeLang } = require('../lib/i18n');
const { buildAbsoluteUrl, getPublicBaseUrl } = require('../lib/security');
const { ensureAbsoluteUrl, buildShortUrl } = require('../lib/url-helpers');
const { isProAccessActive, getEffectivePlanForUser } = require('../lib/plans');
const { ASSET_VERSION } = require('../config/index');
const { siteSettings } = require('../middleware/maintenance');

function escapeHtml(value) {
  return (value || '').toString().replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function buildAnnouncementHtml() {
  const s = siteSettings || {};
  if (s.announcement_enabled !== '1') return '';
  return '<div class="announcement-bar"><div class="container">' + escapeHtml(s.announcement_text_en || '') + '</div></div>';
}

function normalizeFolderName(folder) {
  if (!folder) return '';
  return (folder.toString().trim() || '').slice(0, 50);
}

function parseTagsJson(jsonStr) {
  try {
    const arr = JSON.parse(jsonStr);
    if (Array.isArray(arr)) return arr;
  } catch {}
  return [];
}

router.get('/dashboard', (req, res) => {
  if (!req.session.userId) return res.redirect('/');

  db.get('SELECT email, banned, ban_until, ban_reason, ui_lang, ui_theme, notify_report, notify_limit, notify_disabled FROM users WHERE id = ?', [req.session.userId], (uErr, uRow) => {
    if (uErr || !uRow) return res.redirect('/');

    // Auto-clear expired temp bans
    if (uRow.banned == 1 && uRow.ban_until) {
      const untilMs = Date.parse(uRow.ban_until);
      if (!Number.isNaN(untilMs) && untilMs <= Date.now()) {
        db.run(
          'UPDATE users SET banned = 0, ban_until = NULL, ban_reason = NULL, ban_set_at = NULL, ban_set_by_admin_id = NULL WHERE id = ?',
          [req.session.userId],
          () => {}
        );
        uRow.banned = 0;
      }
    }

    const banActive = (uRow.banned == 1) && (!uRow.ban_until || (Date.parse(uRow.ban_until) > Date.now()));
    if (banActive) {
      try { req.session.destroy(() => {}); } catch {}
      const banInfo = formatBanInfo(uRow.ban_until, 'az');
      return res.status(403).render('error-banned', {
        csrfToken: res.locals._csrf,
        until: banInfo.untilText || uRow.ban_until || '',
        untilIso: uRow.ban_until || '',
        remaining: banInfo.remainingText || '',
        reason: uRow.ban_reason || ''
      });
    }

    db.all(
      'SELECT w.id, w.name, wm.role FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id WHERE wm.user_id = ? ORDER BY w.created_at ASC',
      [req.session.userId],
      (wsErr, membershipRows) => {
      const memberships = wsErr || !Array.isArray(membershipRows) ? [] : membershipRows;
      const requestedWsId = Number.parseInt(req.query && req.query.ws, 10) || 0;
      const activeMembership = requestedWsId > 0 ? memberships.find((m) => m.id === requestedWsId) : null;
      const activeWorkspace = activeMembership
        ? { id: activeMembership.id, name: activeMembership.name, role: activeMembership.role }
        : null;

      const currentPage = Math.max(1, Number.parseInt(req.query && req.query.page, 10) || 1);
      const perPage = Math.min(100, Math.max(10, Number.parseInt(req.query && req.query.limit, 10) || 50));
      const offset = (currentPage - 1) * perPage;

      let whereClauses = [];
      let params = [];
      
      if (activeWorkspace) {
        whereClauses.push('workspace_id = ?');
        params.push(activeWorkspace.id);
      } else {
        whereClauses.push('user_id = ? AND workspace_id IS NULL');
        params.push(req.session.userId);
      }

      const q = (req.query && req.query.q || '').toString().trim().toLowerCase();
      if (q) {
        whereClauses.push('(LOWER(short) LIKE ? OR LOWER(original) LIKE ? OR LOWER(folder_name) LIKE ? OR LOWER(tags_json) LIKE ?)');
        const likeQ = `%${q}%`;
        params.push(likeQ, likeQ, likeQ, likeQ);
      }

      const filter = (req.query && req.query.filter || 'all').toString();
      if (filter === 'reported') whereClauses.push('reports > 0');
      else if (filter === 'password') whereClauses.push('(link_password IS NOT NULL AND link_password != \'\')');
      else if (filter === 'disabled') whereClauses.push('disabled = 1');

      const folder = (req.query && req.query.folder || 'all').toString();
      if (folder !== 'all') {
        whereClauses.push("LOWER(REPLACE(folder_name, ' ', '_')) = ?");
        params.push(folder.toLowerCase());
      }

      const tag = (req.query && req.query.tag || 'all').toString();
      if (tag !== 'all') {
        whereClauses.push("LOWER(REPLACE(tags_json, ' ', '_')) LIKE ?");
        params.push('%"' + tag.toLowerCase() + '"%');
      }

      const sort = (req.query && req.query.sort || 'newest').toString();
      let orderSql = 'ORDER BY created_at DESC';
      if (sort === 'oldest') orderSql = 'ORDER BY created_at ASC';
      else if (sort === 'reports') orderSql = 'ORDER BY reports DESC, created_at DESC';

      const whereSql = 'WHERE ' + whereClauses.join(' AND ');

      const countSql = `SELECT COUNT(*) AS total_count, COALESCE(SUM(reports), 0) AS total_reports FROM urls ${whereSql}`;

      db.get(countSql, params, (cErr, countRow) => {
        if (cErr) return res.status(500).send('Veritabanı hatası.');

        const totalLinks = countRow ? Number.parseInt(countRow.total_count, 10) || 0 : 0;
        const totalReports = countRow ? Number.parseInt(countRow.total_reports, 10) || 0 : 0;
        const totalPages = Math.max(1, Math.ceil(totalLinks / perPage));

        const linksSql = `SELECT short, original, created_at, reports, link_password, disabled, domain_host, folder_name, tags_json FROM urls ${whereSql} ${orderSql} LIMIT ? OFFSET ?`;

        db.all(linksSql, [...params, perPage, offset], (err, rows) => {
          if (err) return res.status(500).send('Veritabanı hatası.');

          // Özet İstatistikler
          const displayRows = Array.isArray(rows) ? rows : [];
    // Toplam tıklama sayısını hesaplamak için ayrı bir sorgu gerekir veya basitlik adına şimdilik pas geçebiliriz 
    // veya join ile alabiliriz. Şimdilik elimizdeki veriyi kullanalım.
    // Dashboard'a girildiğinde "Hoşgeldin X" ve Premium Tasarım

    const uiLang = (uRow && uRow.ui_lang) ? uRow.ui_lang : (req.cookies && req.cookies.lang_default ? req.cookies.lang_default : 'az');
    const announcementHtml = buildAnnouncementHtml();
    const csrfTokenSafe = escapeHtml(res.locals._csrf || '');
    const assetQuery = `?v=${encodeURIComponent(res.locals.assetVersion || ASSET_VERSION)}`;
    let html = `
      <!doctype html>
      <html lang="${escapeHtml(uiLang)}">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="csrf-token" content="${escapeHtml(res.locals._csrf || '')}">
          <title data-i18n="dashboard_title">Dashboard - URL Kısaltma</title>
          <link rel="icon" href="/logo.ico" />
          <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet" />
          <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" />
          <link rel="stylesheet" href="/style.css${assetQuery}" />
        </head>
        <body class="home-page app-page">
${announcementHtml}
          <!-- Navbar -->
          <nav class="navbar navbar-expand-lg navbar-light home-navbar shadow-sm">
            <div class="container">
              <a class="navbar-brand fw-bold d-flex align-items-center" href="/">
                <img src="/logo.webp" alt="Ovlink" class="home-brand-logo" />
              </a>
              <button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#dashboardNavbarContent" aria-controls="dashboardNavbarContent" aria-expanded="false" aria-label="Menu toggle">
                <span class="navbar-toggler-icon"></span>
              </button>
              <div class="collapse navbar-collapse" id="dashboardNavbarContent">
                <ul class="navbar-nav ms-auto align-items-lg-center">
                  <li class="nav-item d-none" id="navAuthGuestLogin">
                    <a class="nav-link" href="/login"><i class="fa-solid fa-right-to-bracket"></i> <span data-i18n="nav_login">Giriş</span></a>
                  </li>
                  <li class="nav-item d-none" id="navAuthGuestReg">
                    <a class="nav-link" href="/register"><i class="fa-solid fa-user-plus"></i> <span data-i18n="nav_register">Qeydiyyat</span></a>
                  </li>
                  <li class="nav-item" id="navPricingItem">
                    <a class="nav-link" href="/pricing"><i class="fa-solid fa-crown"></i> <span data-i18n="nav_pricing">Pro Plan</span></a>
                  </li>
                  <li class="nav-item dropdown nav-user-dropdown" id="navAuthUser">
                    <a class="nav-link dropdown-toggle position-relative" href="#" role="button" data-bs-toggle="dropdown" aria-expanded="false">
                      <i class="fa-solid fa-user-circle me-1"></i>
                      <span id="navUserEmail" data-i18n="nav_my_account">Hesabım</span>
                      <span id="navNotifBadge" class="notif-badge d-none">0</span>
                    </a>
                    <ul class="dropdown-menu dropdown-menu-end">
                      <li><a class="dropdown-item" href="/"><i class="fa-solid fa-house me-2"></i><span data-i18n="nav_home">Ana Səhifə</span></a></li>
                      <li><a class="dropdown-item" href="/account"><i class="fa-solid fa-user-gear me-2"></i><span data-i18n="profile_settings_title">Profil Parametrləri</span></a></li>
                      <li>
                        <a class="dropdown-item d-flex align-items-center justify-content-between" href="/notifications">
                          <span><i class="fa-solid fa-bell me-2"></i><span data-i18n="notif_center_title">Bildiriş Mərkəzi</span></span>
                          <span id="navNotifBadgeMenu" class="notif-menu-badge d-none">0</span>
                        </a>
                      </li>
                      <li><hr class="dropdown-divider" /></li>
                      <li><a id="navLogoutBtn" class="dropdown-item" href="#"><i class="fa-solid fa-right-from-bracket me-2"></i><span data-i18n="nav_logout">Çıxış</span></a></li>
                    </ul>
                  </li>
                </ul>

                <div class="dropdown ms-2 me-2">
                  <button id="langToggleBtn" class="btn btn-sm fw-bold dropdown-toggle lang-pill" type="button" data-bs-toggle="dropdown" aria-expanded="false">${uiLang.toUpperCase()}</button>
                  <ul class="dropdown-menu dropdown-menu-end">
                    <li><button class="dropdown-item lang-option" data-lang="az" type="button">AZ</button></li>
                    <li><button class="dropdown-item lang-option" data-lang="tr" type="button">TR</button></li>
                    <li><button class="dropdown-item lang-option" data-lang="en" type="button">EN</button></li>
                  </ul>
                </div>

                <button class="theme-toggle home-theme-btn" aria-label="Temayı Değiştir">
                  <i class="fa-solid fa-sun"></i>
                </button>
              </div>
            </div>
          </nav>

          <main class="app-main">
            <section class="container">
              <div class="app-shell" id="dashboardStats">
                <div class="policy-head">
                  <div class="badge hero-chip rounded-pill px-3 py-2 mb-3 shadow-sm fw-semibold">
                    <i class="fa-solid fa-chart-line me-1"></i><span data-i18n="hero_badge">Ovlink - Next-Gen Link Management</span>
                  </div>
                  <h1 class="policy-title" data-i18n="dashboard_title">Dashboard</h1>
                  <p class="hero-subtitle" data-i18n="dashboard_search_placeholder">Qısa / Orijinal Link</p>
                </div>
            <!-- İstatistik Kartları -->
            <div class="row mb-4">
              <div class="col-md-4">
                <div class="card app-card p-3 shadow-sm text-center border-0 border-primary border-start border-4 h-100">
                  <h6 class="text-muted" data-i18n="dashboard_total_links">Ümumi Link</h6>
                  <h2 class="fw-bold text-primary">${totalLinks}</h2>
                </div>
              </div>
              <div class="col-md-4">
                <div class="card app-card p-3 shadow-sm text-center border-0 border-danger border-start border-4 h-100">
                  <h6 class="text-muted" data-i18n="dashboard_total_reports">Ümumi Şikayət</h6>
                  <h2 class="fw-bold text-danger">${totalReports}</h2>
                </div>
              </div>
              <div class="col-md-4">
                 <!-- Buraya Toplam Tıklama gelebilir (şu an query yok, yer tutucu) -->
                 <div class="card app-card p-3 shadow-sm text-center border-0 border-success border-start border-4 h-100">
                  <h6 class="text-muted" data-i18n="dashboard_account_status">Hesab Vəziyyəti</h6>
                  <h2 class="fw-bold text-success" data-i18n="dashboard_active">Aktiv</h2>
                </div>
              </div>
            </div>

            <!-- Hızlı link oluşturma (aktif kapsama göre) -->
            <div class="policy-card app-card shadow-sm border-0 mb-4">
              <div class="card-body">
                <form id="dashboardQuickCreateForm" class="row g-2 align-items-end" onsubmit="return false;" data-workspace-id="${activeWorkspace ? activeWorkspace.id : ''}">
                  <div class="col-12 col-md-6">
                    <label class="form-label small fw-bold text-muted" for="dashboardQuickUrl" data-i18n="ws_quick_url_label">${escapeHtml(pickLang(uiLang, 'Hədəf URL', 'Hedef URL', 'Target URL'))}</label>
                    <input id="dashboardQuickUrl" class="form-control form-control-sm" type="url" placeholder="https://example.com" data-i18n-placeholder="ws_quick_url_placeholder" data-i18n="ws_quick_url_placeholder" required />
                  </div>
                  <div class="col-6 col-md-3">
                    <label class="form-label small fw-bold text-muted" for="dashboardQuickAlias" data-i18n="ws_quick_alias_label">${escapeHtml(pickLang(uiLang, 'Xüsusi alias (optional)', 'Özel alias (isteğe bağlı)', 'Custom alias (optional)'))}</label>
                    <input id="dashboardQuickAlias" class="form-control form-control-sm" type="text" maxlength="50" placeholder="${escapeHtml(pickLang(uiLang, 'kampaniya-2026', 'kampanya-2026', 'campaign-2026'))}" data-i18n-placeholder="ws_quick_alias_placeholder" data-i18n="ws_quick_alias_placeholder" />
                  </div>
                  <div class="col-6 col-md-3 d-grid">
                    <button type="submit" class="btn btn-primary btn-sm rounded-pill" data-i18n="ws_quick_create_btn">${escapeHtml(pickLang(uiLang, 'Qısalt', 'Kısalt', 'Shorten'))}</button>
                  </div>
                  <div class="col-12"><div id="dashboardQuickMsg" class="small"></div></div>
                </form>
              </div>
            </div>
            <!-- Link Tablosu -->
            <div class="policy-card app-card shadow-sm border-0">
              <div class="card-header py-3 d-flex justify-content-between align-items-center flex-wrap gap-2">
                <h5 class="mb-0 fw-bold"><i class="fa-solid fa-list me-2"></i><span data-i18n="dashboard_my_links">Linklərim</span>${activeWorkspace ? ` <span class="badge text-bg-primary ms-2"><i class="fa-solid fa-users me-1"></i>${escapeHtml(activeWorkspace.name)}</span>` : ''}</h5>
                <div class="d-flex align-items-center gap-2 flex-wrap justify-content-end">
                  <select id="workspaceScopeSelect" class="form-select form-select-sm w-auto" aria-label="Workspace" title="Workspace">
                    <option value="" data-i18n="ws_scope_personal">Şəxsi linklər</option>
                    ${memberships.map((m) => `<option value="${m.id}" ${activeWorkspace && activeWorkspace.id === m.id ? 'selected' : ''}>${escapeHtml((m.name || '').toString())}</option>`).join('')}
                  </select>
                  <a href="/workspaces" class="btn btn-outline-primary btn-sm rounded-pill"><i class="fa-solid fa-users-gear"></i> <span data-i18n="ws_manage_btn">Workspace</span></a>
                  <a href="/api/user/export?format=csv" class="btn btn-outline-secondary btn-sm rounded-pill" data-i18n="dashboard_export_csv">CSV export</a>
                  <button id="bulkImportBtn" type="button" class="btn btn-outline-secondary btn-sm rounded-pill" data-i18n="dashboard_import_btn">Toplu import</button>
                  <button id="bulkDeleteBtn" type="button" class="btn btn-outline-danger btn-sm rounded-pill" data-i18n="bulk_delete_btn">Seçilənləri sil</button>
                </div>
              </div>
              <div class="card-body border-bottom">
                <form class="row g-2 align-items-end" id="dashboardFilterForm" onsubmit="return false;">
                  <div class="col-12 col-md-5">
                    <label class="form-label small fw-bold text-muted" for="dashboardSearch" data-i18n="dashboard_search_label">Ara</label>
                    <input id="dashboardSearch" class="form-control form-control-sm" placeholder="Kısa / Orijinal Link" data-i18n="dashboard_search_placeholder" />
                  </div>
                  <div class="col-6 col-md-3">
                    <label class="form-label small fw-bold text-muted" for="dashboardFilter" data-i18n="dashboard_filter_label">Filtre</label>
                    <select id="dashboardFilter" class="form-select form-select-sm">
                      <option value="all" data-i18n="dashboard_filter_all">Hepsi</option>
                      <option value="reported" data-i18n="dashboard_filter_reported">Şikayetli</option>
                      <option value="password" data-i18n="dashboard_filter_password">Şifreli</option>
                      <option value="disabled" data-i18n="dashboard_filter_disabled">Devre dışı</option>
                    </select>
                  </div>
                  <div class="col-6 col-md-4">
                    <label class="form-label small fw-bold text-muted" for="dashboardSort" data-i18n="dashboard_sort_label">Sırala</label>
                    <select id="dashboardSort" class="form-select form-select-sm">
                      <option value="newest" data-i18n="dashboard_sort_newest">Yeni → Eski</option>
                      <option value="oldest" data-i18n="dashboard_sort_oldest">Eski → Yeni</option>
                      <option value="reports" data-i18n="dashboard_sort_reports">Şikayet Sayısı</option>
                    </select>
                  </div>
                </form>
              </div>
              <div class="card-body p-0">
                <div class="table-responsive app-table-wrap">
                  <table class="table table-hover align-middle mb-0 app-table">
                    <thead>
                      <tr>
                        <th class="ps-4"><input type="checkbox" id="bulkSelectAll" class="form-check-input" aria-label="Select all"></th>
                        <th data-i18n="th_short">Kısa Link</th>
                        <th data-i18n="th_original">Orijinal Link</th>
                        <th data-i18n="th_folder">Qovluq</th>
                        <th data-i18n="th_tags">Teqlər</th>
                        <th data-i18n="th_date">Tarih</th>
                        <th class="text-center" data-i18n="th_report">Şikayət</th>
                        <th class="text-end pe-4" data-i18n="th_actions">İşlemler</th>
                      </tr>
                    </thead>
                    <tbody id="dashboardTableBody">`;

    if (displayRows.length === 0) {
      html += `<tr><td colspan="8" class="text-center py-4 text-muted" data-i18n="empty_list">Hələ heç bir link yaratmamısınız.</td></tr>
                      <tr id="dashboardNoResults" class="d-none"><td colspan="8" class="text-center py-4 text-muted" data-i18n="dashboard_no_results">Nəticə tapılmadı.</td></tr>`;
    } else {
      displayRows.forEach(row => {
        const shortCode = (row.short || '').toString();
        const originalUrl = (row.original || '').toString();
        const shortUrl = buildShortUrl(req, shortCode, row.domain_host || '');
        const safeShort = escapeHtml(shortCode);
        const safeOriginal = escapeHtml(originalUrl);
        const safeShortUrl = escapeHtml(shortUrl);
        const safeCreatedAt = escapeHtml((row.created_at || '').toString());
        const safeCreatedDate = escapeHtml(row.created_at ? new Date(row.created_at).toLocaleDateString() : '');
        const safeStatsPath = '/stats-page/' + encodeURIComponent(shortCode);
        const safeOriginalEncoded = encodeURIComponent(originalUrl);
        const reportsCount = Number(row.reports || 0);
        const folderName = normalizeFolderName(row.folder_name || '');
        const tags = parseTagsJson(row.tags_json || '');
        const tagsJoined = tags.join(', ');
        const safeFolder = escapeHtml(folderName);
        const safeFolderSearch = escapeHtml(folderName.toLocaleLowerCase('en-US'));
        const safeTagsSearch = escapeHtml(tagsJoined.toLocaleLowerCase('en-US'));
        const safeTagsAttr = escapeHtml(JSON.stringify(tags));
        const folderHtml = safeFolder ? safeFolder : '<span class="text-muted small">-</span>';
        const tagsHtml = tags.length
          ? tags.map((tag) => `<span class="badge rounded-pill text-bg-light border me-1">${escapeHtml(tag)}</span>`).join('')
          : '<span class="text-muted small">-</span>';
        html += `
                      <tr data-short="${safeShort}" data-original="${safeOriginal}" data-folder="${safeFolderSearch}" data-tags="${safeTagsSearch}" data-folder-raw="${safeFolder}" data-tags-json="${safeTagsAttr}" data-reports="${reportsCount}" data-created="${safeCreatedAt}" data-password="${row.link_password ? 1 : 0}" data-disabled="${row.disabled ? 1 : 0}">
                        <td class="ps-4">
                          <input type="checkbox" class="form-check-input bulk-select" value="${safeShort}" aria-label="Select link">
                        </td>
                        <td class="fw-bold">
                           <a href="${safeShortUrl}" target="_blank" class="text-decoration-none">${safeShort}</a>
                           ${row.disabled ? ` <span class="badge bg-danger" data-i18n="link_quarantined">${escapeHtml(pickLang(uiLang, 'Karantin', 'Karantina', 'Quarantined'))}</span>` : ''}
                        </td>
                        <td style="max-width: 300px;" class="text-truncate">${safeOriginal}</td>
                        <td class="small">${folderHtml}</td>
                        <td style="max-width: 220px;" class="text-truncate">${tagsHtml}</td>
                        <td class="small text-muted">${safeCreatedDate}</td>
                        <td class="text-center">
                          ${reportsCount > 0 ? '<span class="badge bg-danger">' + reportsCount + '</span>' : '<span class="badge bg-light text-dark">0</span>'}
                        </td>
                        <td class="text-end pe-4">
                          <div class="d-inline-flex align-items-center gap-1 flex-nowrap">
                            <button type="button" class="btn btn-sm btn-light border d-inline-flex align-items-center gap-1" data-edit-short="${safeShort}" data-edit-original="${safeOriginalEncoded}" aria-label="Edit"><i class="fa-solid fa-pen"></i> <span data-i18n="edit_btn">Düzəliş</span></button>
                            <button type="button" class="btn btn-sm btn-light border d-inline-flex align-items-center gap-1" data-meta-short="${safeShort}" data-meta-folder="${safeFolder}" data-meta-tags="${safeTagsAttr}" aria-label="Metadata"><i class="fa-solid fa-tags"></i> <span data-i18n="dashboard_meta_btn">Qovluq/Teq</span></button>
                            <button type="button" class="btn btn-sm btn-light border d-inline-flex align-items-center gap-1" data-copy-text="${safeShortUrl}" aria-label="Copy"><i class="fa-solid fa-copy"></i> <span data-i18n="copy_btn">Kopyala</span></button>
                            <a href="${safeStatsPath}" class="btn btn-sm btn-light border" aria-label="Stats"><i class="fa-solid fa-chart-bar"></i></a>
                            <form method="POST" action="/api/user/delete" class="d-inline-block m-0">
                              <input type="hidden" name="short" value="${safeShort}">
                              <input type="hidden" name="_csrf" value="${csrfTokenSafe}">
                              <button type="submit" class="btn btn-danger btn-sm" data-i18n="delete_btn">Sil</button>
                            </form>
                          </div>
                        </td>
                      </tr>`;
      });
    }

    let paginationHtml = '';
    if (totalPages > 1) {
      const buildPageUrl = (p) => {
        const params = new URLSearchParams();
        if (activeWorkspace) params.set('ws', String(activeWorkspace.id));
        if (req.query.q) params.set('q', req.query.q);
        if (req.query.filter && req.query.filter !== 'all') params.set('filter', req.query.filter);
        if (req.query.sort && req.query.sort !== 'newest') params.set('sort', req.query.sort);
        if (req.query.folder && req.query.folder !== 'all') params.set('folder', req.query.folder);
        if (req.query.tag && req.query.tag !== 'all') params.set('tag', req.query.tag);
        params.set('page', String(p));
        if (perPage !== 50) params.set('limit', String(perPage));
        return '/dashboard?' + params.toString();
      };

      const prevDisabled = currentPage <= 1 ? ' disabled' : '';
      const nextDisabled = currentPage >= totalPages ? ' disabled' : '';
      const prevHref = currentPage > 1 ? buildPageUrl(currentPage - 1) : '#';
      const nextHref = currentPage < totalPages ? buildPageUrl(currentPage + 1) : '#';

      let pageItems = '';
      const maxVisible = 5;
      let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
      let endPage = Math.min(totalPages, startPage + maxVisible - 1);
      if (endPage - startPage + 1 < maxVisible) {
        startPage = Math.max(1, endPage - maxVisible + 1);
      }

      for (let p = startPage; p <= endPage; p++) {
        const activeClass = p === currentPage ? ' active' : '';
        pageItems += `<li class="page-item${activeClass}"><a class="page-link" href="${escapeHtml(buildPageUrl(p))}">${p}</a></li>`;
      }

      paginationHtml = `
        <div class="card-footer bg-transparent border-top d-flex justify-content-between align-items-center flex-wrap gap-2 py-3 px-4">
          <div class="small text-muted">
            <span>${escapeHtml(pickLang(uiLang, 'Səhifə', 'Sayfa', 'Page'))} ${currentPage} / ${totalPages}</span> (${totalLinks} ${escapeHtml(pickLang(uiLang, 'link', 'link', 'links'))})
          </div>
          <nav aria-label="Dashboard pagination">
            <ul class="pagination pagination-sm mb-0">
              <li class="page-item${prevDisabled}">
                <a class="page-link" href="${escapeHtml(prevHref)}" aria-label="Previous">
                  <i class="fa-solid fa-chevron-left"></i>
                </a>
              </li>
              ${pageItems}
              <li class="page-item${nextDisabled}">
                <a class="page-link" href="${escapeHtml(nextHref)}" aria-label="Next">
                  <i class="fa-solid fa-chevron-right"></i>
                </a>
              </li>
            </ul>
          </nav>
        </div>
      `;
    }

    html += `
                    </tbody>
                  </table>
                </div>
                ${paginationHtml}
              </div>
            </div>
              </div>
            </section>
          </main>

          <!-- Dashboard Edit Modal -->
          <div class="modal fade" id="dashboardEditLinkModal" tabindex="-1" aria-hidden="true">
            <div class="modal-dialog modal-dialog-centered">
              <div class="modal-content">
                <div class="modal-header">
                  <h5 class="modal-title" data-i18n="dashboard_edit_modal_title">Hədəf Linki Yenilə</h5>
                  <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                </div>
                <div class="modal-body">
                  <div class="mb-3">
                    <label class="form-label fw-semibold small text-muted">Qısa Kod</label>
                    <input id="dashboardEditShortDisplay" class="form-control bg-light" type="text" readonly disabled>
                  </div>
                  <div class="mb-3">
                    <label class="form-label fw-semibold" for="dashboardEditOriginalInput" data-i18n="dashboard_edit_url_label">Yeni Hədəf URL</label>
                    <input id="dashboardEditOriginalInput" class="form-control" type="url" placeholder="https://example.com/yeni-link" data-i18n="dashboard_edit_url_placeholder" required>
                  </div>
                  <div id="dashboardEditMsg" class="small"></div>
                </div>
                <div class="modal-footer">
                  <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal" data-i18n="cancel_btn">Ləğv et</button>
                  <button type="button" class="btn btn-primary" id="dashboardEditSaveBtn" data-i18n="dashboard_edit_save">Yenilə</button>
                </div>
              </div>
            </div>
          </div>

          <!-- Dashboard Meta Modal -->
          <div class="modal fade" id="dashboardMetaModal" tabindex="-1" aria-hidden="true">
            <div class="modal-dialog modal-dialog-centered">
              <div class="modal-content">
                <div class="modal-header">
                  <h5 class="modal-title" data-i18n="dashboard_meta_modal_title">Qovluq və teq düzəlişi</h5>
                  <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                </div>
                <div class="modal-body">
                  <div class="mb-3">
                    <label class="form-label" for="dashboardMetaFolderInput" data-i18n="dashboard_meta_folder_label">Qovluq</label>
                    <input id="dashboardMetaFolderInput" class="form-control" data-i18n-placeholder="dashboard_meta_folder_placeholder" placeholder="Məs: kampaniyalar">
                    <div id="dashboardMetaFolderPills" class="mt-2 d-flex flex-wrap gap-1"></div>
                  </div>
                  <div class="mb-2">
                    <label class="form-label" for="dashboardMetaTagsInput" data-i18n="dashboard_meta_tags_label">Teqlər</label>
                    <input id="dashboardMetaTagsInput" class="form-control" data-i18n-placeholder="dashboard_meta_tags_placeholder" placeholder="Məs: reklam, instagram, yaz">
                    <div id="dashboardMetaTagPills" class="mt-2 d-flex flex-wrap gap-1"></div>
                  </div>
                  <div id="dashboardMetaMsg" class="small"></div>
                </div>
                <div class="modal-footer">
                  <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal" data-i18n="dashboard_meta_cancel">Ləğv et</button>
                  <button type="button" class="btn btn-primary" id="dashboardMetaSaveBtn" data-i18n="dashboard_meta_save">Yadda saxla</button>
                </div>
              </div>
            </div>
          </div>

          <div class="modal fade" id="bulkImportModal" tabindex="-1" aria-hidden="true">
            <div class="modal-dialog modal-lg modal-dialog-centered">
              <div class="modal-content">
                <div class="modal-header">
                  <h5 class="modal-title" data-i18n="dashboard_import_title">Toplu link import</h5>
                  <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                </div>
                <div class="modal-body">
                  <p class="text-muted small mb-2" data-i18n="dashboard_import_help">Hər sətrə bir URL yazın və ya CSV yapışdırın. URL sütunu avtomatik oxunur.</p>
                  <textarea id="bulkImportInput" class="form-control" rows="10" data-i18n="dashboard_import_placeholder" placeholder="https://example.com/page-1
https://example.com/page-2"></textarea>
                  <div id="bulkImportMsg" class="small mt-2"></div>
                  <div id="bulkImportResults" class="mt-3 d-none">
                    <div class="d-flex align-items-center justify-content-between mb-2 flex-wrap gap-2">
                      <strong data-i18n="dashboard_import_created_links">Yaradılan linklər</strong>
                      <div class="d-flex gap-2">
                        <button type="button" id="bulkImportCopyAll" class="btn btn-sm btn-outline-primary rounded-pill" data-i18n="dashboard_import_copy_all"><i class="fa-solid fa-copy me-1"></i>Hamısını kopyala</button>
                        <button type="button" id="bulkImportDownloadCsv" class="btn btn-sm btn-outline-success rounded-pill" data-i18n="dashboard_import_download_csv"><i class="fa-solid fa-file-csv me-1"></i>CSV olaraq yüklə</button>
                      </div>
                    </div>
                    <div id="bulkImportLinks" class="list-group small mb-2"></div>
                  </div>
                </div>
                <div class="modal-footer">
                  <button type="button" class="btn btn-secondary" data-bs-dismiss="modal" data-i18n="cancel_btn">Ləğv et</button>
                  <button type="button" id="bulkImportSubmit" class="btn btn-primary" data-i18n="dashboard_import_submit">Import et</button>
                </div>
              </div>
            </div>
          </div>

          <!-- Footer Bölümü -->
          <footer class="site-footer mt-5">
            <div class="container text-center">
              <p class="mb-1" data-i18n="footer_text">&copy; 2026 · Developed & Powered by <span class="fw-bold">Ulvi Ahadov</span></p>
              <a href="/privacy" class="text-muted small text-decoration-none hover-primary" data-i18n="privacy_policy">Məxfilik Siyasəti</a>
              <span class="mx-2 text-muted small">·</span>
              <a href="/terms" class="text-muted small text-decoration-none hover-primary" data-i18n="terms_policy">İstifadə Şərtləri</a>
              <span class="mx-2 text-muted small">·</span>
              <a href="/cookie-policy" class="text-muted small text-decoration-none hover-primary" data-i18n="cookie_policy">Cookie Policy</a>
              <span class="mx-2 text-muted small">·</span>
              <a href="/about" class="text-muted small text-decoration-none hover-primary" data-i18n="about_policy">About</a>
              <span class="mx-2 text-muted small">·</span>
              <a href="/how-it-works" class="text-muted small text-decoration-none hover-primary" data-i18n="how_it_works_link">Necə işləyir?</a>
              <span class="mx-2 text-muted small">·</span>
              <a href="/why-ovlink" class="text-muted small text-decoration-none hover-primary" data-i18n="why_ovlink_link">Niyə Ovlink?</a>
              <span class="mx-2 text-muted small">·</span>
              <a href="/contact" class="text-muted small text-decoration-none hover-primary" data-i18n="contact_policy">Əlaqə</a>
              <span class="mx-2 text-muted small">·</span>
              <a href="/faq" class="text-muted small text-decoration-none hover-primary" data-i18n="faq_link">FAQ</a>
              <span class="mx-2 text-muted small">·</span>
              <a href="/help" class="text-muted small text-decoration-none hover-primary" data-i18n="help_link">Help</a>
              <span class="mx-2 text-muted small">·</span>
              <a href="/docs" class="text-muted small text-decoration-none hover-primary" data-i18n="docs_link">Docs</a>
              <span class="mx-2 text-muted small">·</span>
              <a href="/pricing" class="text-muted small text-decoration-none hover-primary" data-i18n="pricing_link">Pro Pricing</a>
              <span class="mx-2 text-muted small">·</span>
              <a href="/api-guide" class="text-muted small text-decoration-none hover-primary" data-i18n="api_guide_link">API Guide</a>
              <span class="mx-2 text-muted small">·</span>
              <a href="/abuse-safety" class="text-muted small text-decoration-none hover-primary" data-i18n="abuse_safety_link">Abuse & Safety</a>
              <span class="mx-2 text-muted small">·</span>
              <a href="/updates" class="text-muted small text-decoration-none hover-primary" data-i18n="updates_link">Updates</a>
            </div>
          </footer>
          <div id="floatingPricingBanner" class="floating-pricing-banner d-none">
            <button type="button" class="floating-pricing-banner-close" data-floating-pricing-close aria-label="Close pricing banner">&times;</button>
            <a class="floating-pricing-banner-link" href="/pricing" aria-label="Open Ovlink Pro pricing">
              <img class="floating-pricing-banner-image" src="/logo.webp" alt="Ovlink Pro" loading="lazy" decoding="async" />
              <div class="floating-pricing-banner-body">
                <span class="floating-pricing-banner-badge" data-i18n="floating_pricing_badge">PRO</span>
                <strong class="floating-pricing-banner-title" data-i18n="floating_pricing_title">Unlock Premium features</strong>
                <small class="floating-pricing-banner-text" data-i18n="floating_pricing_text">$2/mo · API + Webhooks</small>
              </div>
              <span class="floating-pricing-banner-arrow" aria-hidden="true"><i class="fa-solid fa-arrow-up-right-from-square"></i></span>
            </a>
          </div>

          <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
          <script src="/lang.js${assetQuery}"></script>
          <script src="/script.js${assetQuery}"></script>
        </body>
      </html>
    `;
    res.send(html);
        });
      });
    });
  });
});

// Diğer tüm isteklerde index.ejs render edilir (fallback)
module.exports = router;
