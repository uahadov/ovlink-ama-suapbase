'use strict';

const bcrypt = require('bcrypt');
const QRCode = require('qrcode');
const { dbGetAsync, dbAllAsync, dbRunAsync, withTransaction } = require('../../db/helpers');
const {
  WORKSPACE_SCOPED_LINK_OWNERSHIP_SQL,
  WORKSPACE_LINK_MUTATION_SQL,
} = require('../link-access');
const linkPurge = require('../link-purge');
const {
  isReservedShortAlias,
  generateSafeShortCode,
  normalizeHostName,
  buildShortUrl,
} = require('../url-helpers');
const { appendUtmParams } = require('../utm');
const campaignLib = require('../campaigns');
const { getMcpQuotaStatus } = require('./quota');
const {
  validateDestinationUrlSafe,
  assertNoGeoParameters,
  sanitizePayload,
} = require('./security');

const SHORT_CODE_RE = /^[A-Za-z0-9_-]{1,50}$/;

const TOOL_DEFINITIONS = [
  {
    name: 'ovlink_shorten_link',
    description: 'Create a secure, trackable Ovlink short URL. Supports custom alias, expiration, click limits, password protection, UTM parameters, deep linking, and split A/B testing. Security note: All untrusted strings in outputs are wrapped in <ovlink_untrusted_data> tags.',
    requiredScope: 'shorten:write',
    rateLimitTier: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        original_url: {
          type: 'string',
          description: 'The target destination URL (http:// or https://).'
        },
        custom_alias: {
          type: 'string',
          description: 'Optional custom alias for the link (1-50 characters: alphanumeric, underscore, hyphen).'
        },
        title: {
          type: 'string',
          description: 'Optional descriptive title for the short link.'
        },
        max_clicks: {
          type: 'integer',
          description: 'Optional maximum allowed clicks before the link deactivates.'
        },
        expires_at: {
          type: 'string',
          description: 'Optional expiration timestamp in ISO 8601 format (e.g. 2026-12-31T23:59:59Z).'
        },
        password: {
          type: 'string',
          description: 'Optional password protection required before redirecting visitors.'
        },
        domain: {
          type: 'string',
          description: 'Optional custom domain linked and active in your Ovlink account.'
        },
        campaign_id: {
          type: 'integer',
          description: 'Optional campaign ID to organize this link under.'
        },
        utm_source: { type: 'string', description: 'Optional UTM source tag.' },
        utm_medium: { type: 'string', description: 'Optional UTM medium tag.' },
        utm_campaign: { type: 'string', description: 'Optional UTM campaign tag.' },
        utm_term: { type: 'string', description: 'Optional UTM term tag.' },
        utm_content: { type: 'string', description: 'Optional UTM content tag.' },
        original_b: {
          type: 'string',
          description: 'Optional second URL for split A/B testing.'
        },
        ab_split_percent: {
          type: 'integer',
          description: 'Optional traffic split percentage for destination B (1-99, default 50).'
        },
        ios_url: {
          type: 'string',
          description: 'Optional custom redirect URL for iOS mobile devices.'
        },
        android_url: {
          type: 'string',
          description: 'Optional custom redirect URL for Android mobile devices.'
        }
      },
      required: ['original_url'],
      additionalProperties: false
    }
  },
  {
    name: 'ovlink_bulk_shorten_links',
    description: 'Bulk create up to 100 trackable Ovlink short URLs with Partial Success (1.A) support. If some URLs fail validation or SSRF checks, valid URLs are created and failed items are reported with specific error codes. Security note: All untrusted strings in outputs are wrapped in <ovlink_untrusted_data> tags.',
    requiredScope: 'shorten:write',
    rateLimitTier: 'bulk',
    inputSchema: {
      type: 'object',
      properties: {
        links: {
          type: 'array',
          description: 'Array of link objects to shorten (up to 100 items).',
          items: {
            type: 'object',
            properties: {
              original_url: { type: 'string', description: 'Destination URL to shorten.' },
              custom_alias: { type: 'string', description: 'Optional custom alias.' },
              title: { type: 'string', description: 'Optional link title.' },
              campaign_id: { type: 'integer', description: 'Optional campaign ID.' },
              utm_source: { type: 'string' },
              utm_medium: { type: 'string' },
              utm_campaign: { type: 'string' }
            },
            required: ['original_url'],
            additionalProperties: false
          }
        },
        common_campaign_id: {
          type: 'integer',
          description: 'Optional default campaign ID applied to all links in this batch if not specified individually.'
        }
      },
      required: ['links'],
      additionalProperties: false
    }
  },
  {
    name: 'ovlink_list_links',
    description: 'List and search URLs owned by the authenticated Pro user with pagination, status filters, and click analytics summary. Security note: All untrusted strings in outputs are wrapped in <ovlink_untrusted_data> tags.',
    requiredScope: 'account:read',
    rateLimitTier: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'Maximum number of items to return (1-100, default 25).'
        },
        cursor: {
          type: 'string',
          description: 'Pagination cursor from a previous response.'
        },
        query: {
          type: 'string',
          description: 'Search filter matching short code or original URL.'
        },
        status: {
          type: 'string',
          enum: ['all', 'active', 'disabled'],
          description: 'Filter links by status (default: all).'
        },
        campaign_id: {
          type: 'integer',
          description: 'Filter links belonging to a specific campaign.'
        },
        days: {
          type: 'integer',
          description: 'Time window in days for aggregate click analytics (default: 30).'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'ovlink_get_link',
    description: 'Retrieve detailed configuration and statistics for a specific short link. Fails closed with masked 404 (-32004) if not found or unauthorized (IDOR defense). Security note: All untrusted strings in outputs are wrapped in <ovlink_untrusted_data> tags.',
    requiredScope: 'account:read',
    rateLimitTier: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        identifier: {
          type: 'string',
          description: 'The short code (slug) or numeric ID of the link.'
        },
        days: {
          type: 'integer',
          description: 'Number of past days for click statistics (default: 30).'
        }
      },
      required: ['identifier'],
      additionalProperties: false
    }
  },
  {
    name: 'ovlink_update_link',
    description: 'Update destination URL, title, campaign association, click cap, or active status of an existing short link. Fails closed with masked 404 (-32004) on unauthorized access (IDOR defense). Security note: All untrusted strings in outputs are wrapped in <ovlink_untrusted_data> tags.',
    requiredScope: 'shorten:write',
    rateLimitTier: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        identifier: {
          type: 'string',
          description: 'The short code (slug) or numeric ID of the link to update.'
        },
        original_url: {
          type: 'string',
          description: 'New destination URL (SSRF validated).'
        },
        title: {
          type: 'string',
          description: 'New title for the link.'
        },
        campaign_id: {
          type: 'integer',
          description: 'New campaign ID (or 0 / null to unassign).'
        },
        disabled: {
          type: 'boolean',
          description: 'True to disable/deactivate redirect, false to enable.'
        },
        max_clicks: {
          type: 'integer',
          description: 'Maximum click limit (or 0 to remove limit).'
        }
      },
      required: ['identifier'],
      additionalProperties: false
    }
  },
  {
    name: 'ovlink_delete_link',
    description: 'Permanently delete a short link and its complete analytics history. Fails closed with masked 404 (-32004) on unauthorized access (IDOR defense). Security note: All untrusted strings in outputs are wrapped in <ovlink_untrusted_data> tags.',
    requiredScope: 'shorten:write',
    rateLimitTier: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        identifier: {
          type: 'string',
          description: 'The short code (slug) or numeric ID of the link to delete.'
        }
      },
      required: ['identifier'],
      additionalProperties: false
    }
  },
  {
    name: 'ovlink_get_account_stats',
    description: 'Retrieve authenticated Pro user account details, current plan status, MCP quota consumption, and total links/clicks summary. Security note: All untrusted strings in outputs are wrapped in <ovlink_untrusted_data> tags.',
    requiredScope: 'account:read',
    rateLimitTier: 'read',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'ovlink_list_campaigns',
    description: 'List all campaigns owned by the authenticated Pro user with link counts and total click metrics. Security note: All untrusted strings in outputs are wrapped in <ovlink_untrusted_data> tags.',
    requiredScope: 'account:read',
    rateLimitTier: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        include_archived: {
          type: 'boolean',
          description: 'Whether to include archived campaigns (default: false).'
        },
        days: {
          type: 'integer',
          description: 'Number of days for click metrics (default: 30).'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'ovlink_create_qr',
    description: 'Generate customized high-resolution QR code (PNG data URL or SVG) for any short link owned by the authenticated user. Security note: All untrusted strings in outputs are wrapped in <ovlink_untrusted_data> tags.',
    requiredScope: 'account:read',
    rateLimitTier: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        identifier: {
          type: 'string',
          description: 'The short code (slug) or numeric ID of the link.'
        },
        format: {
          type: 'string',
          enum: ['png', 'svg'],
          description: 'Output format (default: png).'
        },
        dark_color: {
          type: 'string',
          description: 'Hex color code for the QR code modules (e.g. #000000).'
        },
        light_color: {
          type: 'string',
          description: 'Hex color code for the QR code background (e.g. #ffffff).'
        }
      },
      required: ['identifier'],
      additionalProperties: false
    }
  }
];

/**
 * Encodes cursor for list pagination
 */
function encodeCursor(row) {
  if (!row) return null;
  const createdAt = (row.created_at || '').toString();
  const id = Number.parseInt(row.id, 10);
  if (!createdAt || !Number.isInteger(id)) return null;
  return Buffer.from(`${createdAt}|${id}`, 'utf8').toString('base64url');
}

/**
 * Decodes cursor for list pagination
 */
function decodeCursor(raw) {
  const text = (raw || '').toString().trim();
  if (!text || text.length > 200) return null;
  let decoded = '';
  try {
    decoded = Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const separator = decoded.lastIndexOf('|');
  if (separator <= 0 || separator === decoded.length - 1) return null;
  const createdAt = decoded.slice(0, separator).trim();
  const id = Number.parseInt(decoded.slice(separator + 1), 10);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(createdAt) || !Number.isInteger(id) || id <= 0) return null;
  return { createdAt, id };
}

/**
 * Resolves a link row strictly owned by userId or active workspace member. Fails closed with masked 404 (-32004).
 */
async function resolveOwnedLinkOrThrow(identifier, userId, accessType = 'read') {
  const ident = String(identifier || '').trim();
  if (!ident) {
    const err = new Error('Link identifier is required.');
    err.jsonRpcCode = -32602;
    throw err;
  }

  const accessClause = (accessType === 'write' || accessType === 'delete')
    ? WORKSPACE_LINK_MUTATION_SQL
    : WORKSPACE_SCOPED_LINK_OWNERSHIP_SQL;

  let row = null;
  const numId = Number.parseInt(ident, 10);
  if (Number.isInteger(numId) && String(numId) === ident && numId > 0) {
    row = await dbGetAsync(`SELECT * FROM urls WHERE id = ? AND ${accessClause} LIMIT 1`, [numId, userId, userId]);
  }
  if (!row) {
    row = await dbGetAsync(`SELECT * FROM urls WHERE short = ? AND ${accessClause} LIMIT 1`, [ident, userId, userId]);
  }

  if (!row) {
    // Masked 404: Never confirm if the link exists under another user/workspace (IDOR prevention)
    const err = new Error('Link not found or access denied.');
    err.code = -32004;
    err.jsonRpcCode = -32004;
    throw err;
  }

  return row;
}

/**
 * Tool execution handlers
 */
const TOOL_HANDLERS = {
  // 1. ovlink_shorten_link
  async ovlink_shorten_link(args, context) {
    assertNoGeoParameters(args);
    const { userId, req } = context;

    // Validate original_url
    const ssrfCheck = await validateDestinationUrlSafe(args.original_url);
    if (!ssrfCheck.valid) {
      const err = new Error(ssrfCheck.error);
      err.jsonRpcCode = -32008;
      err.code = ssrfCheck.code;
      throw err;
    }

    let originalAbs = ssrfCheck.cleanUrl;

    // Apply UTM parameters if provided
    const utmFields = {
      utm_source: args.utm_source,
      utm_medium: args.utm_medium,
      utm_campaign: args.utm_campaign,
      utm_term: args.utm_term,
      utm_content: args.utm_content,
    };
    originalAbs = appendUtmParams(originalAbs, utmFields);

    // Validate original_b if provided
    let originalB = null;
    let abSplitPercent = 50;
    if (args.original_b) {
      const bCheck = await validateDestinationUrlSafe(args.original_b);
      if (!bCheck.valid) {
        const err = new Error(`Split URL B: ${bCheck.error}`);
        err.jsonRpcCode = -32008;
        err.code = bCheck.code;
        throw err;
      }
      originalB = bCheck.cleanUrl;
      const pct = Number.parseInt(args.ab_split_percent, 10);
      if (Number.isInteger(pct) && pct >= 1 && pct <= 99) {
        abSplitPercent = pct;
      }
    }

    // Validate custom domain if specified
    let domainHost = null;
    if (args.domain) {
      const cleanDomain = normalizeHostName(args.domain);
      const domRow = await dbGetAsync(
        'SELECT id, domain, status FROM custom_domains WHERE user_id = ? AND domain = ? LIMIT 1',
        [userId, cleanDomain]
      );
      if (!domRow || domRow.status !== 'active') {
        const err = new Error('Custom domain is not linked to your account or is not active.');
        err.jsonRpcCode = -32602;
        throw err;
      }
      domainHost = cleanDomain;
    }

    // Validate custom alias if provided
    let shortCode = '';
    if (args.custom_alias) {
      const alias = String(args.custom_alias).trim();
      if (!SHORT_CODE_RE.test(alias)) {
        const err = new Error('Invalid custom_alias format (must be 1-50 alphanumeric, hyphen or underscore characters).');
        err.jsonRpcCode = -32602;
        throw err;
      }
      if (isReservedShortAlias(alias)) {
        const err = new Error('custom_alias is reserved by system.');
        err.jsonRpcCode = -32602;
        throw err;
      }
      const existing = await dbGetAsync('SELECT id FROM urls WHERE short = ? LIMIT 1', [alias]);
      if (existing) {
        const err = new Error('custom_alias is already in use.');
        err.jsonRpcCode = -32009;
        throw err;
      }
      shortCode = alias;
    } else {
      shortCode = generateSafeShortCode();
    }

    // Campaign validation
    let campaignId = null;
    if (args.campaign_id) {
      const cid = Number.parseInt(args.campaign_id, 10);
      if (Number.isInteger(cid) && cid > 0) {
        const cRow = await dbGetAsync('SELECT id FROM campaigns WHERE id = ? AND user_id = ? LIMIT 1', [cid, userId]);
        if (cRow) campaignId = cid;
      }
    }

    // Password hashing
    let passwordHash = null;
    if (args.password && typeof args.password === 'string' && args.password.trim()) {
      passwordHash = await bcrypt.hash(args.password.trim(), 10);
    }

    // Max clicks
    let maxClicks = null;
    if (args.max_clicks) {
      const mc = Number.parseInt(args.max_clicks, 10);
      if (Number.isInteger(mc) && mc > 0) maxClicks = mc;
    }

    // Expiry date
    let expiresAt = null;
    if (args.expires_at) {
      const d = new Date(args.expires_at);
      if (!Number.isNaN(d.getTime())) {
        expiresAt = d.toISOString();
      }
    }

    // iOS and Android deep links
    const iosUrl = args.ios_url ? String(args.ios_url).trim().slice(0, 2048) : null;
    const androidUrl = args.android_url ? String(args.android_url).trim().slice(0, 2048) : null;
    const title = args.title ? String(args.title).trim().slice(0, 255) : null;
    const nowIso = new Date().toISOString();

    await dbRunAsync(
      'INSERT INTO urls (original, short, created_at, user_id, title, max_clicks, expires_at, password, domain_host, campaign_id, original_b, ab_split_percent, ios_url, android_url) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        originalAbs,
        shortCode,
        nowIso,
        userId,
        title,
        maxClicks,
        expiresAt,
        passwordHash,
        domainHost,
        campaignId,
        originalB,
        abSplitPercent,
        iosUrl,
        androidUrl,
      ]
    );

    const inserted = await dbGetAsync('SELECT id FROM urls WHERE short = ? LIMIT 1', [shortCode]);
    const shortUrl = buildShortUrl(req, shortCode, domainHost);

    return sanitizePayload({
      id: inserted ? inserted.id : null,
      short: shortCode,
      short_url: shortUrl,
      original_url: originalAbs,
      title: title || null,
      domain_host: domainHost,
      campaign_id: campaignId,
      max_clicks: maxClicks,
      expires_at: expiresAt,
      is_password_protected: !!passwordHash,
      is_ab_test: !!originalB,
      original_b: originalB,
      ab_split_percent: originalB ? abSplitPercent : null,
      ios_url: iosUrl,
      android_url: androidUrl,
      created_at: nowIso,
    });
  },

  // 2. ovlink_bulk_shorten_links (Decision 1.A: Partial Success)
  async ovlink_bulk_shorten_links(args, context) {
    assertNoGeoParameters(args);
    const { userId, req } = context;

    if (!args || !Array.isArray(args.links) || args.links.length === 0) {
      const err = new Error('links array is required and must contain at least 1 item.');
      err.jsonRpcCode = -32602;
      throw err;
    }

    if (args.links.length > 100) {
      const err = new Error('links array exceeds maximum limit of 100 items.');
      err.jsonRpcCode = -32602;
      throw err;
    }

    const created = [];
    const failed = [];
    const defaultCampaignId = args.common_campaign_id ? Number.parseInt(args.common_campaign_id, 10) : null;

    for (let i = 0; i < args.links.length; i += 1) {
      const item = args.links[i];
      if (!item || !item.original_url) {
        failed.push({
          index: i,
          original_url: '',
          error: 'original_url is required.',
          code: 'INVALID_URL'
        });
        continue;
      }

      // Check SSRF
      const ssrfCheck = await validateDestinationUrlSafe(item.original_url);
      if (!ssrfCheck.valid) {
        failed.push({
          index: i,
          original_url: item.original_url,
          error: ssrfCheck.error,
          code: ssrfCheck.code || 'SSRF_BLOCKED'
        });
        continue;
      }

      let originalAbs = ssrfCheck.cleanUrl;
      const utmFields = {
        utm_source: item.utm_source,
        utm_medium: item.utm_medium,
        utm_campaign: item.utm_campaign,
      };
      originalAbs = appendUtmParams(originalAbs, utmFields);

      // Check alias if provided
      let shortCode = '';
      if (item.custom_alias) {
        const alias = String(item.custom_alias).trim();
        if (!SHORT_CODE_RE.test(alias)) {
          failed.push({
            index: i,
            original_url: item.original_url,
            custom_alias: alias,
            error: 'Invalid custom_alias format.',
            code: 'INVALID_ALIAS'
          });
          continue;
        }
        if (isReservedShortAlias(alias)) {
          failed.push({
            index: i,
            original_url: item.original_url,
            custom_alias: alias,
            error: 'custom_alias is reserved.',
            code: 'RESERVED_ALIAS'
          });
          continue;
        }
        const existing = await dbGetAsync('SELECT id FROM urls WHERE short = ? LIMIT 1', [alias]);
        if (existing) {
          failed.push({
            index: i,
            original_url: item.original_url,
            custom_alias: alias,
            error: 'custom_alias is already in use.',
            code: 'ALIAS_IN_USE'
          });
          continue;
        }
        shortCode = alias;
      } else {
        shortCode = generateSafeShortCode();
      }

      const campaignId = item.campaign_id ? Number.parseInt(item.campaign_id, 10) : defaultCampaignId;
      const title = item.title ? String(item.title).trim().slice(0, 255) : null;
      const nowIso = new Date().toISOString();

      try {
        await dbRunAsync(
          'INSERT INTO urls (original, short, created_at, user_id, title, campaign_id) VALUES (?, ?, ?, ?, ?, ?)',
          [originalAbs, shortCode, nowIso, userId, title, campaignId]
        );
        const row = await dbGetAsync('SELECT id FROM urls WHERE short = ? LIMIT 1', [shortCode]);
        const shortUrl = buildShortUrl(req, shortCode);

        created.push({
          index: i,
          id: row ? row.id : null,
          short: shortCode,
          short_url: shortUrl,
          original_url: originalAbs,
          title: title || null,
          campaign_id: campaignId || null,
          created_at: nowIso,
        });
      } catch (insertErr) {
        failed.push({
          index: i,
          original_url: originalAbs,
          error: insertErr.message,
          code: 'DATABASE_ERROR'
        });
      }
    }

    return sanitizePayload({
      total: args.links.length,
      succeeded_count: created.length,
      failed_count: failed.length,
      created,
      failed,
    });
  },

  // 3. ovlink_list_links
  async ovlink_list_links(args, context) {
    assertNoGeoParameters(args);
    const { userId } = context;

    const limitInput = Number.parseInt(args.limit, 10);
    const limit = Number.isInteger(limitInput) ? Math.min(100, Math.max(1, limitInput)) : 25;

    const cursor = args.cursor ? decodeCursor(args.cursor) : null;
    const days = Number.parseInt(args.days, 10) || 30;
    const startDay = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

    const duScope = WORKSPACE_SCOPED_LINK_OWNERSHIP_SQL.replace(/user_id/g, 'du.user_id').replace(/workspace_id/g, 'du.workspace_id');
    const uScope = WORKSPACE_SCOPED_LINK_OWNERSHIP_SQL.replace(/user_id/g, 'u.user_id').replace(/workspace_id/g, 'u.workspace_id');

    const params = [userId, userId, startDay, userId, userId];
    let sql =
      'SELECT u.id, u.short, u.original, u.title, u.created_at, u.max_clicks, COALESCE(u.disabled, 0) AS disabled, ' +
      'u.campaign_id, u.domain_host, COALESCE(st.clicks, 0) AS clicks, COALESCE(st.uniques, 0) AS uniques, ' +
      'COALESCE(st.conversions, 0) AS conversions ' +
      'FROM urls u LEFT JOIN (' +
      'SELECT d.url_id, SUM(d.clicks) AS clicks, SUM(d.uniques) AS uniques, SUM(d.conversions) AS conversions ' +
      `FROM link_stats_daily d JOIN urls du ON du.id = d.url_id ` +
      `WHERE (${duScope}) AND d.day >= ? GROUP BY d.url_id` +
      ') st ON st.url_id = u.id ' +
      `WHERE (${uScope})`;

    if (args.campaign_id) {
      sql += ' AND u.campaign_id = ?';
      params.push(args.campaign_id);
    }
    if (args.query) {
      const q = String(args.query).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
      if (q) {
        sql += " AND (u.short LIKE ? ESCAPE '\\' OR u.original LIKE ? ESCAPE '\\')";
        params.push(`%${q}%`, `%${q}%`);
      }
    }
    if (args.status === 'active') {
      sql += ' AND COALESCE(u.disabled, 0) = 0';
    } else if (args.status === 'disabled') {
      sql += ' AND COALESCE(u.disabled, 0) = 1';
    }

    if (cursor) {
      sql += ' AND (u.created_at < ? OR (u.created_at = ? AND u.id < ?))';
      params.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }

    sql += ' ORDER BY u.created_at DESC, u.id DESC LIMIT ?';
    params.push(limit + 1);

    const rows = await dbAllAsync(sql, params);
    const hasMore = (rows || []).length > limit;
    const items = (rows || []).slice(0, limit).map((r) => ({
      id: Number(r.id),
      short: r.short,
      original_url: r.original,
      title: r.title || null,
      created_at: r.created_at,
      disabled: Number(r.disabled || 0) === 1,
      campaign_id: r.campaign_id ? Number(r.campaign_id) : null,
      domain_host: r.domain_host || null,
      stats: {
        days,
        clicks: Number(r.clicks || 0),
        uniques: Number(r.uniques || 0),
        conversions: Number(r.conversions || 0),
      }
    }));

    return sanitizePayload({
      links: items,
      has_more: hasMore,
      next_cursor: hasMore ? encodeCursor(items[items.length - 1]) : null,
    });
  },

  // 4. ovlink_get_link (IDOR protected)
  async ovlink_get_link(args, context) {
    assertNoGeoParameters(args);
    const { userId, req } = context;

    const row = await resolveOwnedLinkOrThrow(args.identifier, userId, 'read');
    const days = Number.parseInt(args.days, 10) || 30;
    const startDay = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

    const statsRow = await dbGetAsync(
      'SELECT SUM(clicks) AS clicks, SUM(uniques) AS uniques, SUM(conversions) AS conversions ' +
      'FROM link_stats_daily WHERE url_id = ? AND day >= ?',
      [row.id, startDay]
    );

    const shortUrl = buildShortUrl(req, row.short, row.domain_host);

    return sanitizePayload({
      id: row.id,
      short: row.short,
      short_url: shortUrl,
      original_url: row.original,
      title: row.title || null,
      created_at: row.created_at,
      disabled: Number(row.disabled || 0) === 1,
      max_clicks: row.max_clicks ? Number(row.max_clicks) : null,
      expires_at: row.expires_at || null,
      campaign_id: row.campaign_id ? Number(row.campaign_id) : null,
      domain_host: row.domain_host || null,
      is_password_protected: !!row.password,
      original_b: row.original_b || null,
      ab_split_percent: row.original_b ? Number(row.ab_split_percent || 50) : null,
      ios_url: row.ios_url || null,
      android_url: row.android_url || null,
      stats: {
        days,
        clicks: Number(statsRow && statsRow.clicks || 0),
        uniques: Number(statsRow && statsRow.uniques || 0),
        conversions: Number(statsRow && statsRow.conversions || 0),
      }
    });
  },

  // 5. ovlink_update_link (IDOR protected)
  async ovlink_update_link(args, context) {
    assertNoGeoParameters(args);
    const { userId } = context;

    const row = await resolveOwnedLinkOrThrow(args.identifier, userId, 'write');

    const updates = [];
    const params = [];

    if (args.original_url !== undefined) {
      const ssrfCheck = await validateDestinationUrlSafe(args.original_url);
      if (!ssrfCheck.valid) {
        const err = new Error(ssrfCheck.error);
        err.jsonRpcCode = -32008;
        err.code = ssrfCheck.code;
        throw err;
      }
      updates.push('original = ?');
      params.push(ssrfCheck.cleanUrl);
    }

    if (args.title !== undefined) {
      updates.push('title = ?');
      params.push(args.title ? String(args.title).trim().slice(0, 255) : null);
    }

    if (args.campaign_id !== undefined) {
      const cid = Number.parseInt(args.campaign_id, 10);
      updates.push('campaign_id = ?');
      params.push(Number.isInteger(cid) && cid > 0 ? cid : null);
    }

    if (args.disabled !== undefined) {
      updates.push('disabled = ?');
      params.push(args.disabled ? 1 : 0);
    }

    if (args.max_clicks !== undefined) {
      const mc = Number.parseInt(args.max_clicks, 10);
      updates.push('max_clicks = ?');
      params.push(Number.isInteger(mc) && mc > 0 ? mc : null);
    }

    if (updates.length > 0) {
      params.push(row.id);
      await dbRunAsync(`UPDATE urls SET ${updates.join(', ')} WHERE id = ?`, params);
    }

    const updated = await dbGetAsync('SELECT * FROM urls WHERE id = ?', [row.id]);
    return sanitizePayload({
      id: updated.id,
      short: updated.short,
      original_url: updated.original,
      title: updated.title || null,
      disabled: Number(updated.disabled || 0) === 1,
      max_clicks: updated.max_clicks ? Number(updated.max_clicks) : null,
      campaign_id: updated.campaign_id ? Number(updated.campaign_id) : null,
      updated: true
    });
  },

  // 6. ovlink_delete_link (IDOR protected, uses purgeLinkAnalyticsRows(tx, [urlRow.id]))
  async ovlink_delete_link(args, context) {
    assertNoGeoParameters(args);
    const { userId } = context;

    const row = await resolveOwnedLinkOrThrow(args.identifier, userId, 'delete');

    // FIX CRITICAL REQUIREMENT:
    // purgeLinkAnalyticsRows(tx, urlIds) takes tx FIRST and urlIds SECOND.
    await withTransaction(async (tx) => {
      await linkPurge.purgeLinkAnalyticsRows(tx, [row.id]);
      await tx.run('DELETE FROM urls WHERE id = ?', [row.id]);
    });

    return sanitizePayload({
      success: true,
      message: 'Link and all associated analytics rows were permanently deleted.',
      id: row.id,
      short: row.short
    });
  },

  // 7. ovlink_get_account_stats
  async ovlink_get_account_stats(args, context) {
    assertNoGeoParameters(args);
    const { userId, auth } = context;

    const userRow = await dbGetAsync('SELECT id, plan_tier, plan_status, pro_expires_at FROM users WHERE id = ?', [userId]);
    const linkCountRow = await dbGetAsync('SELECT COUNT(*) AS total_links FROM urls WHERE user_id = ?', [userId]);
    const clicksRow = await dbGetAsync(
      'SELECT SUM(d.clicks) AS total_clicks FROM link_stats_daily d JOIN urls u ON u.id = d.url_id WHERE u.user_id = ?',
      [userId]
    );

    const quota = await getMcpQuotaStatus(userId);

    return sanitizePayload({
      user_id: userId,
      plan: {
        tier: (userRow && userRow.plan_tier) || 'pro',
        status: (userRow && userRow.plan_status) || 'active',
        expires_at: userRow && userRow.pro_expires_at,
      },
      quota: {
        monthly_limit: quota.limit,
        used: quota.used,
        remaining: quota.remaining,
        year_month: quota.yearMonth
      },
      metrics: {
        total_links: linkCountRow ? Number(linkCountRow.total_links || 0) : 0,
        total_clicks: clicksRow ? Number(clicksRow.total_clicks || 0) : 0,
      }
    });
  },

  // 8. ovlink_list_campaigns
  async ovlink_list_campaigns(args, context) {
    assertNoGeoParameters(args);
    const { userId } = context;

    const campaigns = await campaignLib.listCampaigns({
      userId,
      days: args.days || 30,
      includeArchived: !!args.include_archived
    });

    return sanitizePayload({
      campaigns: campaigns || []
    });
  },

  // 9. ovlink_create_qr
  async ovlink_create_qr(args, context) {
    assertNoGeoParameters(args);
    const { userId, req } = context;

    let targetUrl = '';
    let linkId = null;
    let linkShort = null;

    const ident = (args.identifier || '').toString().trim();
    if (/^https?:\/\//i.test(ident)) {
      const urlCheck = await validateDestinationUrlSafe(ident);
      if (!urlCheck.valid) {
        const err = new Error(urlCheck.error);
        err.jsonRpcCode = -32008;
        err.code = urlCheck.code;
        throw err;
      }
      targetUrl = urlCheck.cleanUrl;
    } else {
      const row = await resolveOwnedLinkOrThrow(ident, userId, 'read');
      targetUrl = buildShortUrl(req, row.short, row.domain_host);
      linkId = row.id;
      linkShort = row.short;
    }

    const format = args.format === 'svg' ? 'svg' : 'png';
    const colorDark = args.dark_color && /^#[0-9a-fA-F]{6}$/.test(args.dark_color) ? args.dark_color : '#000000';
    const colorLight = args.light_color && /^#[0-9a-fA-F]{6}$/.test(args.light_color) ? args.light_color : '#ffffff';

    let qrOutput = '';
    if (format === 'svg') {
      qrOutput = await QRCode.toString(targetUrl, {
        type: 'svg',
        color: { dark: colorDark, light: colorLight },
        margin: 2
      });
    } else {
      qrOutput = await QRCode.toDataURL(targetUrl, {
        type: 'image/png',
        color: { dark: colorDark, light: colorLight },
        margin: 2,
        width: 512
      });
    }

    return sanitizePayload({
      id: linkId,
      short: linkShort,
      target_url: targetUrl,
      format,
      qr_code: qrOutput
    });
  }
};

async function executeTool(name, args, context) {
  const definition = TOOL_DEFINITIONS.find((t) => t.name === name);
  if (!definition) {
    const err = new Error(`Tool "${name}" not found.`);
    err.code = -32601;
    err.jsonRpcCode = -32601;
    throw err;
  }

  const requiredScope = definition.requiredScope;
  if (requiredScope && context && context.apiKey) {
    const rawScopes = context.apiKey.scopes || [];
    const userScopes = new Set(
      Array.isArray(rawScopes)
        ? rawScopes
        : String(rawScopes).split(',').map((s) => s.trim())
    );
    if (!userScopes.has(requiredScope)) {
      const err = new Error(`Missing required API scope: "${requiredScope}".`);
      err.code = -32003;
      err.jsonRpcCode = -32003;
      throw err;
    }
  }

  const handler = TOOL_HANDLERS[name];
  if (typeof handler !== 'function') {
    const err = new Error(`Tool "${name}" handler not implemented.`);
    err.code = -32601;
    err.jsonRpcCode = -32601;
    throw err;
  }

  const ctx = { ...context };
  ctx.userId = ctx.userId || (ctx.user && ctx.user.id);
  return handler(args, ctx);
}

module.exports = {
  TOOL_DEFINITIONS,
  MCP_TOOLS: TOOL_DEFINITIONS,
  TOOL_HANDLERS,
  executeTool,
  encodeCursor,
  decodeCursor,
  resolveOwnedLinkOrThrow
};
