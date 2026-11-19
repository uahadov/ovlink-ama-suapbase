'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');

const reportProvenance = require('../src/lib/report-provenance');
const campaignReport = require('../public/campaign-report');
const decisionAnalytics = require('../src/lib/decision-analytics');

// ---------------------------------------------------------------------------
// 1. Unit Tests — Provenance Contract, Freshness, Retry Diff & PII Gate
// ---------------------------------------------------------------------------

test('P24 unit: buildReportProvenance separates generated_at from last_data_at and computes stable hash', () => {
  const generatedAt = '2026-11-20T00:30:00.000Z';
  const lastDataAt = '2026-11-19T22:00:00.000Z';
  const campaign = { id: 42, user_id: 7, workspace_id: null };

  const p1 = reportProvenance.buildReportProvenance({
    campaign,
    actorUserId: 7,
    surface: 'csv',
    reportType: 'campaign_stats',
    dateRange: { days: 30, from: '2026-10-21T00:30:00.000Z', to: generatedAt },
    filters: { bots: 'exclude' },
    lastDataAt,
    generatedAt,
    payloadForHash: { clicks: 120, uniques: 80 },
  });

  // Same payload with different key order and later generated_at must produce identical content_hash
  const p2 = reportProvenance.buildReportProvenance({
    campaign,
    actorUserId: 7,
    surface: 'pdf',
    reportType: 'campaign_stats',
    dateRange: { days: 30, from: '2026-10-21T00:30:00.000Z', to: '2026-11-20T01:00:00.000Z' },
    filters: { bots: 'exclude' },
    lastDataAt,
    generatedAt: '2026-11-20T01:00:00.000Z',
    payloadForHash: { uniques: 80, clicks: 120 },
    previousSnapshot: p1,
  });

  // Changed data on retry must bump revision and flag data_changed_since_previous = true
  const p3 = reportProvenance.buildReportProvenance({
    campaign,
    actorUserId: 7,
    surface: 'csv',
    reportType: 'campaign_stats',
    dateRange: { days: 30, from: '2026-10-21T00:30:00.000Z', to: '2026-11-20T01:05:00.000Z' },
    filters: { bots: 'exclude' },
    lastDataAt: '2026-11-20T01:04:00.000Z',
    generatedAt: '2026-11-20T01:05:00.000Z',
    payloadForHash: { clicks: 125, uniques: 83 },
    previousSnapshot: p2,
  });

  assert.equal(p1.contract_version, 'report-provenance-v1');
  assert.match(p1.snapshot_id, /^rpt_[a-f0-9]{16}$/);
  assert.equal(p1.timestamps.generated_at, generatedAt);
  assert.equal(p1.timestamps.last_data_at, lastDataAt);
  assert.notEqual(p1.timestamps.generated_at, p1.timestamps.last_data_at);
  assert.equal(p1.freshness.status, 'fresh');
  assert.equal(p1.freshness.is_stale, false);
  assert.equal(p1.revision, 1);
  assert.equal(p1.data_changed_since_previous, null);

  assert.equal(p2.content_hash, p1.content_hash);
  assert.equal(p2.revision, 2);
  assert.equal(p2.previous_snapshot_id, p1.snapshot_id);
  assert.equal(p2.data_changed_since_previous, false);

  assert.notEqual(p3.content_hash, p2.content_hash);
  assert.equal(p3.revision, 3);
  assert.equal(p3.previous_snapshot_id, p2.snapshot_id);
  assert.equal(p3.data_changed_since_previous, true);
});

test('P24 unit: evaluateFreshness distinguishes no_data, fresh, and explicit stale', () => {
  const noData = reportProvenance.evaluateFreshness({
    generatedAt: '2026-11-20T00:00:00.000Z',
    lastDataAt: null,
  });
  assert.equal(noData.status, 'no_data');
  assert.equal(noData.is_stale, false);

  const stale = reportProvenance.evaluateFreshness({
    generatedAt: '2026-11-20T00:00:00.000Z',
    lastDataAt: '2026-11-17T00:00:00.000Z',
    staleThresholdSeconds: 3600,
  });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.is_stale, true);
  assert.ok(stale.lag_seconds > 3600);
});

test('P24 unit: canExportRawPersonalData restricts raw PII export by role and surface', () => {
  // Portal surface is always forbidden even for owner or admin
  assert.equal(
    reportProvenance.canExportRawPersonalData({ actorUserId: 1, ownerUserId: 1, isAdmin: true, surface: 'portal' }).allowed,
    false
  );
  // Workspace member is forbidden
  const memberRes = reportProvenance.canExportRawPersonalData({
    actorUserId: 2,
    ownerUserId: 1,
    workspaceId: 10,
    workspaceRole: 'member',
    surface: 'csv',
  });
  assert.equal(memberRes.allowed, false);
  assert.equal(memberRes.reason, 'insufficient_role_for_raw_pii');

  // Workspace admin is allowed
  assert.equal(
    reportProvenance.canExportRawPersonalData({
      actorUserId: 2,
      ownerUserId: 1,
      workspaceId: 10,
      workspaceRole: 'admin',
      surface: 'csv',
    }).allowed,
    true
  );

  // Personal campaign non-owner is forbidden, owner is allowed
  assert.equal(
    reportProvenance.canExportRawPersonalData({ actorUserId: 9, ownerUserId: 1, surface: 'csv' }).allowed,
    false
  );
  assert.equal(
    reportProvenance.canExportRawPersonalData({ actorUserId: 1, ownerUserId: 1, surface: 'csv' }).allowed,
    true
  );
});

test('P24 unit: campaign CSV and decision CSV embed provenance metadata cleanly', () => {
  const prov = reportProvenance.buildReportProvenance({
    campaign: { id: 1, user_id: 5 },
    actorUserId: 5,
    surface: 'csv',
    reportType: 'campaign_stats',
    lastDataAt: '2026-11-19T12:00:00.000Z',
    generatedAt: '2026-11-19T13:00:00.000Z',
    payloadForHash: { clicks: 10 },
    auditEntryId: 99,
    auditAction: 'campaign.csv.export',
  });

  const csv = campaignReport.toCsv({
    campaign: { name: 'Test', slug: 'test' },
    range: { days: 30, from: '2026-10-20T00:00:00.000Z', to: '2026-11-19T13:00:00.000Z', bots: 'exclude' },
    links_count: 1,
    clicks: 10,
    uniques: 8,
    conversions: 1,
    conversion_rate: 10,
    clicks_by_day: [],
    top_links: [],
    top_sources: [],
    top_goals: [],
    generated_at: '2026-11-19T13:00:00.000Z',
    last_recorded_click_at: '2026-11-19T12:00:00.000Z',
    provenance: prov,
  });

  assert.ok(csv.includes(`"Report snapshot ID","${prov.snapshot_id}"`));
  assert.ok(csv.includes(`"Content hash (SHA-256)","${prov.content_hash}"`));
  assert.ok(csv.includes('"Audit entry ID","99"'));
  assert.ok(csv.includes('"Last data at (UTC)","2026-11-19T12:00:00.000Z"'));
  assert.ok(csv.includes('"Generated at (UTC)","2026-11-19T13:00:00.000Z"'));

  const decReport = decisionAnalytics.buildDecisionAnalyticsReport({
    campaign: { id: 1, name: 'Test', slug: 'test' },
    days: 30,
    includeBots: false,
    windowDays: 7,
    model: 'last_touch',
    currentRows: [{ utm_source: 'instagram', clicks: 10, uniques: 8 }],
    previousRows: [],
    attributionReport: { summary: { total_events: 0, attributed: 0, unattributed: 0 }, events: [] },
    lastRecordedClickAt: '2026-11-19T12:00:00.000Z',
    now: new Date('2026-11-19T13:00:00.000Z'),
  });
  decReport.provenance = prov;
  const decCsv = decisionAnalytics.buildDecisionCsv(decReport);
  assert.ok(decCsv.includes(`"Report snapshot ID","${prov.snapshot_id}"`));
  assert.ok(decCsv.includes(`"Content hash (SHA-256)","${prov.content_hash}"`));
});

// ---------------------------------------------------------------------------
// 2. Real PostgreSQL + HTTP Integration Tests
// ---------------------------------------------------------------------------

const dbUrl = process.env.DATABASE_URL || '';
const safeDb = /\/ovlink_[\w]*qa[\w]*$/.test(dbUrl.split('?')[0]);

test('P24 integration: snapshot persistence, audit link, retry revision diff, cross-surface lookup, stale 503 & PII gate', { skip: !safeDb && 'Requires isolated QA DB', timeout: 40000 }, async () => {
  const express = require('express');
  const { dbRunAsync, dbGetAsync } = require('../src/db/helpers');
  const { buildApiKeyValue, hashApiKeyValue, getApiKeyPrefix, getApiKeyLast4 } = require('../src/lib/security');
  const campaignsRouter = require('../src/routes/api/campaigns');
  const proV1Router = require('../src/routes/api/pro-v1');

  const suffix = crypto.randomBytes(4).toString('hex');
  const nowIso = new Date().toISOString();
  const twoDaysAgoIso = new Date(Date.now() - 48 * 3600 * 1000).toISOString();

  // Create owner + workspace member
  const ownerRes = await dbRunAsync(
    "INSERT INTO users (email, email_verified, plan_tier, plan_status, pro_expires_at, created_at) VALUES (?, 1, 'pro', 'active', '2030-01-01T00:00:00.000Z', ?)",
    [`p24-owner-${suffix}@example.com`, nowIso]
  );
  const memberRes = await dbRunAsync(
    "INSERT INTO users (email, email_verified, plan_tier, plan_status, created_at) VALUES (?, 1, 'free', 'active', ?)",
    [`p24-member-${suffix}@example.com`, nowIso]
  );
  const ownerId = Number(ownerRes.lastID);
  const memberId = Number(memberRes.lastID);

  // Create workspace + membership (owner + ordinary member)
  const wsRes = await dbRunAsync(
    'INSERT INTO workspaces (name, owner_user_id, created_at) VALUES (?, ?, ?)',
    [`P24 WS ${suffix}`, ownerId, nowIso]
  );
  const wsId = Number(wsRes.lastID);
  await dbRunAsync(
    "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
    [wsId, ownerId, nowIso]
  );
  await dbRunAsync(
    "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)",
    [wsId, memberId, nowIso]
  );

  // Create workspace campaign + link + an older click (2 days ago -> stale for 1-minute threshold)
  const cmpRes = await dbRunAsync(
    "INSERT INTO campaigns (user_id, workspace_id, name, slug, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
    [ownerId, wsId, `P24 Campaign ${suffix}`, `p24-cmp-${suffix}`, nowIso]
  );
  const campaignId = Number(cmpRes.lastID);
  const urlRes = await dbRunAsync(
    'INSERT INTO urls (user_id, workspace_id, campaign_id, short, original, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [ownerId, wsId, campaignId, `p24${suffix}`, 'https://example.com/p24', nowIso]
  );
  const urlId = Number(urlRes.lastID);
  await dbRunAsync(
    "INSERT INTO clicks (url_id, click_time, ip_hash, referrer_host, utm_source, is_bot) VALUES (?, ?, 'h1', 'instagram.com', 'instagram', 0)",
    [urlId, twoDaysAgoIso]
  );

  const rawApiKey = buildApiKeyValue();
  await dbRunAsync(
    'INSERT INTO api_keys (user_id, name, scopes, key_hash, hash_version, key_prefix, last4, created_at) VALUES (?, ?, ?, ?, 2, ?, ?, ?)',
    [ownerId, 'p24-key', 'account:read,shorten:write', hashApiKeyValue(rawApiKey), getApiKeyPrefix(rawApiKey), getApiKeyLast4(rawApiKey), nowIso]
  );

  const testApp = express();
  testApp.use(express.json());
  testApp.use((req, _res, next) => {
    const uid = Number(req.headers['x-test-user'] || 0);
    req.session = uid ? { userId: uid } : {};
    next();
  });
  testApp.use(campaignsRouter);
  testApp.use(proV1Router);

  const server = http.createServer(testApp);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const ownerHeaders = { 'x-test-user': String(ownerId) };
  const memberHeaders = { 'x-test-user': String(memberId) };

  try {
    // 1. Export CSV #1 -> revision 1 + linked audit entry
    const res1 = await fetch(`${baseUrl}/api/campaigns/${campaignId}/export.csv?days=30&bots=exclude`, {
      headers: ownerHeaders,
    });
    assert.equal(res1.status, 200);
    const snap1Id = res1.headers.get('x-ovlink-snapshot-id');
    const hash1 = res1.headers.get('x-ovlink-content-hash');
    const audit1Id = res1.headers.get('x-ovlink-audit-id');
    assert.match(snap1Id, /^rpt_[a-f0-9]{16}$/);
    assert.equal(res1.headers.get('x-ovlink-snapshot-revision'), '1');
    assert.ok(hash1 && hash1.length === 64);
    assert.ok(Number(audit1Id) > 0);
    const csv1 = await res1.text();
    assert.ok(csv1.includes(`"Report snapshot ID","${snap1Id}"`));
    assert.ok(csv1.includes(`"Content hash (SHA-256)","${hash1}"`));
    assert.ok(csv1.includes(`"Audit entry ID","${audit1Id}"`));

    // Verify audit log row matches snapshot_id and content_hash
    const auditRow = await dbGetAsync('SELECT action, metadata_json FROM analytics_audit_log WHERE id = ?', [Number(audit1Id)]);
    assert.equal(auditRow.action, 'campaign.csv.export');
    const auditMeta = JSON.parse(auditRow.metadata_json);
    assert.equal(auditMeta.snapshot_id, snap1Id);
    assert.equal(auditMeta.content_hash, hash1);

    // 2. Retry Export CSV #2 with unchanged data -> revision 2, identical hash, data_changed_since_previous = false
    const res2 = await fetch(`${baseUrl}/api/campaigns/${campaignId}/export.csv?days=30&bots=exclude`, {
      headers: ownerHeaders,
    });
    assert.equal(res2.status, 200);
    assert.equal(res2.headers.get('x-ovlink-snapshot-revision'), '2');
    assert.equal(res2.headers.get('x-ovlink-content-hash'), hash1);

    // 3. Insert a fresh click -> Export CSV #3 -> revision 3, new hash, data_changed_since_previous = true
    await dbRunAsync(
      "INSERT INTO clicks (url_id, click_time, ip_hash, referrer_host, utm_source, is_bot) VALUES (?, ?, 'h2', 'google.com', 'google', 0)",
      [urlId, nowIso]
    );
    const res3 = await fetch(`${baseUrl}/api/campaigns/${campaignId}/export.csv?days=30&bots=exclude`, {
      headers: ownerHeaders,
    });
    assert.equal(res3.status, 200);
    const snap3Id = res3.headers.get('x-ovlink-snapshot-id');
    const hash3 = res3.headers.get('x-ovlink-content-hash');
    assert.equal(res3.headers.get('x-ovlink-snapshot-revision'), '3');
    assert.notEqual(hash3, hash1);

    // 4. List snapshots and verify previous snapshot can be referenced across surfaces (PDF & Portal)
    const listRes = await fetch(`${baseUrl}/api/campaigns/${campaignId}/snapshots`, {
      headers: ownerHeaders,
    });
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.equal(listBody.snapshots.length, 3);
    assert.equal(listBody.snapshots[0].snapshot_id, snap3Id);
    assert.equal(listBody.snapshots[0].data_changed_since_previous, true);
    assert.equal(listBody.snapshots[1].data_changed_since_previous, false);
    assert.equal(listBody.snapshots[2].snapshot_id, snap1Id);

    const pdfRefRes = await fetch(`${baseUrl}/api/campaigns/${campaignId}/snapshots/${snap1Id}?surface=pdf`, {
      headers: ownerHeaders,
    });
    assert.equal(pdfRefRes.status, 200);
    const pdfRef = await pdfRefRes.json();
    assert.equal(pdfRef.snapshot_id, snap1Id);
    assert.equal(pdfRef.requested_surface, 'pdf');
    assert.equal(pdfRef.same_snapshot_contract, true);
    assert.equal(pdfRef.provenance.content_hash, hash1);

    // 5. Explicit stale -> 503 when strict_freshness=1 and data is older than threshold
    const staleCmpRes = await dbRunAsync(
      "INSERT INTO campaigns (user_id, workspace_id, name, slug, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
      [ownerId, wsId, `P24 Stale ${suffix}`, `p24-stale-${suffix}`, nowIso]
    );
    const staleCmpId = Number(staleCmpRes.lastID);
    const staleUrlRes = await dbRunAsync(
      'INSERT INTO urls (user_id, workspace_id, campaign_id, short, original, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [ownerId, wsId, staleCmpId, `p24s${suffix}`, 'https://example.com/stale', nowIso]
    );
    await dbRunAsync(
      "INSERT INTO clicks (url_id, click_time, ip_hash, referrer_host, is_bot) VALUES (?, ?, 'h3', 'direct', 0)",
      [Number(staleUrlRes.lastID), twoDaysAgoIso]
    );
    const staleRes = await fetch(
      `${baseUrl}/api/campaigns/${staleCmpId}/export.csv?days=30&bots=exclude&stale_after_minutes=1&strict_freshness=1`,
      { headers: ownerHeaders }
    );
    assert.equal(staleRes.status, 503);
    assert.equal(staleRes.headers.get('x-ovlink-data-freshness'), 'stale');
    const staleBody = await staleRes.json();
    assert.equal(staleBody.stale, true);

    // 6. Raw PII export authorization gate: workspace member -> 403; portal surface -> 403 even for owner
    const memberPiiRes = await fetch(`${baseUrl}/api/campaigns/${campaignId}/export.csv?include_raw_pii=1`, {
      headers: memberHeaders,
    });
    assert.equal(memberPiiRes.status, 403);
    const memberPiiBody = await memberPiiRes.json();
    assert.equal(memberPiiBody.code, 'raw_pii_export_forbidden');

    const portalPiiRes = await fetch(`${baseUrl}/api/campaigns/${campaignId}/export.csv?include_raw_pii=1&surface=portal`, {
      headers: ownerHeaders,
    });
    assert.equal(portalPiiRes.status, 403);
    const portalPiiBody = await portalPiiRes.json();
    assert.equal(portalPiiBody.reason, 'portal_surface_pii_forbidden');

    // 7. Pro API v1 decision persist + snapshots lookup
    const proDecRes = await fetch(`${baseUrl}/api/pro/v1/campaigns/${campaignId}/decision?persist=1`, {
      headers: { 'x-api-key': rawApiKey },
    });
    assert.equal(proDecRes.status, 200);
    const proDecBody = await proDecRes.json();
    assert.equal(proDecBody.provenance.contract_version, 'report-provenance-v1');
    const proSnapId = proDecBody.provenance.snapshot_id;

    const proSnapRes = await fetch(`${baseUrl}/api/pro/v1/campaigns/${campaignId}/snapshots/${proSnapId}?surface=portal`, {
      headers: { 'x-api-key': rawApiKey },
    });
    assert.equal(proSnapRes.status, 200);
    const proSnapBody = await proSnapRes.json();
    assert.equal(proSnapBody.snapshot_id, proSnapId);
    assert.equal(proSnapBody.requested_surface, 'portal');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
