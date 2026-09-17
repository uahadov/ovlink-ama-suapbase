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

function formatBanInfo(untilIso, lang) {
  if (!untilIso) return { untilText: 'Daimi', remainingText: '' };
  try {
    const d = new Date(untilIso);
    if (isNaN(d.getTime())) return { untilText: untilIso, remainingText: '' };
    const diff = d.getTime() - Date.now();
    if (diff <= 0) return { untilText: 'Bitti', remainingText: '0 dk' };
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff / (1000 * 60 * 60)) % 24);
    const mins = Math.floor((diff / 1000 / 60) % 60);
    let rem = '';
    if (days > 0) rem += days + ' gun ';
    if (hours > 0) rem += hours + ' saat ';
    rem += mins + ' dk';
    return {
      untilText: d.toLocaleString('az-AZ'),
      remainingText: rem.trim()
    };
  } catch(e) {
    return { untilText: untilIso, remainingText: '' };
  }
}

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
  if (!jsonStr) return [];
  if (Array.isArray(jsonStr)) {
    return jsonStr.map(t => (t || '').toString().trim()).filter(Boolean);
  }
  try {
    const arr = JSON.parse(jsonStr);
    if (Array.isArray(arr)) {
      return arr.map(t => (t || '').toString().trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    }
    if (typeof arr === 'string') {
      return arr.split(/[,;\n]+/).map(t => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    }
  } catch {}
  if (typeof jsonStr === 'string') {
    return jsonStr.split(/[,;\n]+/).map(t => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  return [];
}

router.get('/dashboard', (req, res) => {
  if (!req.session.userId) return res.redirect('/');

  db.get('SELECT email, banned, ban_until, ban_reason, ui_lang, ui_theme, notify_report, notify_limit, notify_disabled, plan_tier, plan_status, pro_expires_at FROM users WHERE id = ?', [req.session.userId], (uErr, uRow) => {
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
      const perPage = Math.min(100, Math.max(1, Number.parseInt(req.query && req.query.limit, 10) || 50));
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
          const isPro = isProAccessActive(uRow);
          const uiLang = (uRow && uRow.ui_lang) ? uRow.ui_lang : (req.cookies && req.cookies.lang_default ? req.cookies.lang_default : 'az');
          const announcementHtml = buildAnnouncementHtml();
          const csrfToken = res.locals._csrf || '';
          const nonce = res.locals.nonce || '';
          const assetVersion = res.locals.assetVersion || ASSET_VERSION;

          const paginationUrl = (p) => {
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

          const buildShortUrlHelper = (code, domainHost) => {
            return buildShortUrl(req, code, domainHost);
          };

          return res.render('dashboard', {
            user: {
              id: req.session.userId,
              email: uRow.email,
              isPro: isPro,
            },
            uRow,
            isPro,
            uiLang,
            defaultLang: uiLang,
            announcementHtml,
            memberships,
            activeWorkspace,
            totalLinks,
            totalReports,
            totalPages,
            currentPage,
            perPage,
            displayRows,
            q,
            filter,
            folder,
            tag,
            sort,
            paginationUrl,
            buildShortUrl: buildShortUrlHelper,
            normalizeFolderName,
            parseTagsJson,
            csrfToken,
            nonce,
            assetVersion
          });
        });
      });
    });
  });
});

// Diğer tüm isteklerde index.ejs render edilir (fallback)
module.exports = router;
