const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');

process.env.SESSION_SECRET = 'test_session_secret_for_tests_only_very_long_string_must_be_64_bytes_12345678901234567890123456789012';
process.env.NODE_ENV = 'test';
process.env.PORT = '0';

const bulk = require('../src/lib/bulk-import');

test('P18 unit: CSV parsing, formula-injection neutralization, row validation and windowed preview cap', () => {
  // Formula injection protection
  assert.equal(bulk.escapeCsvCell('=HYPERLINK("http://evil.com","click")'), '"\'=HYPERLINK(""http://evil.com"",""click"")"');
  assert.equal(bulk.escapeCsvCell('+1+1'), '"\'+1+1"');
  assert.equal(bulk.escapeCsvCell('-cmd'), '"\'-cmd"');
  assert.equal(bulk.escapeCsvCell('@SUM(A1:A2)'), '"\'@SUM(A1:A2)"');
  assert.equal(bulk.escapeCsvCell('safe'), '"safe"');

  // CSV with valid, bad protocol, private SSRF host, duplicate custom short
  const csv = [
    'url,custom_short,utm_source,utm_medium',
    'https://example.com/a,promoA,instagram,social',
    'javascript:alert(1),bad1,web,x',
    'http://127.0.0.1/secret,bad2,web,x',
    'https://example.com/b,promoA,tiktok,social',
  ].join('\n');

  const preview = bulk.previewBulkImport({ csv, windowLimit: 2 });
  assert.equal(preview.processed_rows, 4);
  assert.equal(preview.valid_count, 1);
  assert.equal(preview.invalid_count, 3);
  assert.equal(preview.rows_window.length, 2, 'preview window caps DOM payload cleanly');
  assert.equal(preview.evaluated_rows[1].error_code, 'invalid_protocol');
  assert.equal(preview.evaluated_rows[2].error_code, 'blocked_host');
  assert.equal(preview.evaluated_rows[3].error_code, 'duplicate_short_in_batch');
});

test('P18 integration: dry-run preview, 50+ link partial-success execute, strict idempotency replay and safe CSV report', async (t) => {
  const { app, helpers } = require('../server');
  const { blindIndex, encryptAES256GCM } = require('../utils/crypto');

  let hasPostgres = false;
  try {
    await helpers.dbGetAsync('SELECT 1');
    hasPostgres = true;
  } catch {
    hasPostgres = false;
  }
  if (!hasPostgres) {
    t.skip('PostgreSQL database not reachable in test environment');
    return;
  }

  const deadline = Date.now() + 20000;
  while (!helpers.isDbMigrationQueueDrained() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const createdUserIds = [];
  const createdShorts = [];
  const createdJobIds = [];

  t.after(async () => {
    for (const short of createdShorts) {
      try { await helpers.dbRunAsync('DELETE FROM urls WHERE short = ?', [short]); } catch {}
    }
    for (const jid of createdJobIds) {
      try { await helpers.dbRunAsync('DELETE FROM bulk_import_jobs WHERE id = ?', [jid]); } catch {}
    }
    for (const uid of createdUserIds) {
      try {
        await helpers.dbRunAsync('DELETE FROM analytics_audit_log WHERE user_id = ?', [uid]);
        await helpers.dbRunAsync('DELETE FROM user_sessions WHERE user_id = ?', [uid]);
        await helpers.dbRunAsync('DELETE FROM users WHERE id = ?', [uid]);
      } catch {}
    }
    try { await helpers.closeDbPool(); } catch {}
  });

  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const password = 'P18BulkTest!2026';
  const email = `p18-bulk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  const passwordHash = await bcrypt.hash(password, 10);
  await helpers.dbRunAsync(
    'INSERT INTO users (email, email_hash, password, email_verified, plan_tier, plan_status, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)',
    [encryptAES256GCM(email), blindIndex(email), passwordHash, 'pro', 'active', new Date().toISOString()]
  );
  const user = await helpers.dbGetAsync('SELECT id FROM users WHERE email_hash = ?', [blindIndex(email)]);
  createdUserIds.push(user.id);

  // Login
  const bootstrap = await fetch(`${baseUrl}/api/csrf`);
  const cookies = (typeof bootstrap.headers.getSetCookie === 'function' ? bootstrap.headers.getSetCookie() : [bootstrap.headers.get('set-cookie')]) || [];
  const sid = cookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('connect.sid='));
  const { csrfToken } = await bootstrap.json();

  const loginRes = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { cookie: sid, 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, lang: 'az' }),
  });
  assert.equal(loginRes.status, 200);
  const after = (typeof loginRes.headers.getSetCookie === 'function' ? loginRes.headers.getSetCookie() : [loginRes.headers.get('set-cookie')]) || [];
  const authCookie = after.map((c) => c.split(';')[0]).find((c) => c.startsWith('connect.sid=')) || sid;
  const csrfRes = await fetch(`${baseUrl}/api/csrf`, { headers: { cookie: authCookie } });
  const { csrfToken: freshCsrf } = await csrfRes.json();

  const apiJson = async (method, path, body, extraHeaders = {}) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { cookie: authCookie, 'x-csrf-token': freshCsrf, 'content-type': 'application/json', ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { res, data: await res.json().catch(() => ({})) };
  };

  // Build 50 valid rows + 2 faulty rows (including formula-like invalid string)
  const csvLines = ['url,utm_source,utm_medium'];
  for (let i = 1; i <= 50; i += 1) {
    csvLines.push(`https://example.com/p18-item-${i},instagram,paid_social`);
  }
  csvLines.push('=CMD|"/C calc"!A0,web,bad');
  csvLines.push('javascript:alert(1),web,bad');
  const csvPayload = csvLines.join('\n');

  // 1. Dry-run preview (0 writes)
  const dryRun = await apiJson('POST', '/api/links/bulk/preview', { csv: csvPayload, window_limit: 20 });
  assert.equal(dryRun.res.status, 200);
  assert.equal(dryRun.data.processed_rows, 52);
  assert.equal(dryRun.data.valid_count, 50);
  assert.equal(dryRun.data.invalid_count, 2);
  assert.equal(dryRun.data.rows.length, 20);

  const countBefore = await helpers.dbGetAsync('SELECT COUNT(*) AS cnt FROM urls WHERE user_id = ?', [user.id]);
  assert.equal(Number(countBefore.cnt), 0, 'dry-run must not write any URLs');

  // 2. Execute with Idempotency-Key -> 207 partial (50 created, 2 failed)
  const idemKey = `p18-batch-${Date.now()}`;
  const exec1 = await apiJson('POST', '/api/links/bulk/execute', { csv: csvPayload }, { 'Idempotency-Key': idemKey });
  assert.equal(exec1.res.status, 207, JSON.stringify(exec1.data));
  assert.equal(exec1.data.status, 'partial');
  assert.equal(exec1.data.idempotent_replay, false);
  assert.equal(exec1.data.summary.created, 50);
  assert.equal(exec1.data.summary.failed, 2);
  createdJobIds.push(exec1.data.job_id);
  for (const r of exec1.data.results) {
    if (r.status === 'created' && r.short) createdShorts.push(r.short);
  }

  // 3. Re-submit exact same file + Idempotency-Key -> 200 idempotent_replay, 0 duplicates created
  const exec2 = await apiJson('POST', '/api/links/bulk/execute', { csv: csvPayload }, { 'Idempotency-Key': idemKey });
  assert.equal(exec2.res.status, 200);
  assert.equal(exec2.data.idempotent_replay, true);
  assert.equal(exec2.data.job_id, exec1.data.job_id);
  const countAfter = await helpers.dbGetAsync('SELECT COUNT(*) AS cnt FROM urls WHERE user_id = ?', [user.id]);
  assert.equal(Number(countAfter.cnt), 50, 'idempotent replay must not create duplicate links');

  // 4. Same Idempotency-Key with different payload -> 409 conflict
  const conflict = await apiJson('POST', '/api/links/bulk/execute', { csv: 'https://example.com/other' }, { 'Idempotency-Key': idemKey });
  assert.equal(conflict.res.status, 409);
  assert.equal(conflict.data.code, 'idempotency_key_conflict');

  // 5. Downloadable CSV operation report neutralizes formula injection
  const reportRes = await fetch(`${baseUrl}/api/links/bulk/jobs/${exec1.data.job_id}/report.csv`, {
    headers: { cookie: authCookie },
  });
  assert.equal(reportRes.status, 200);
  assert.match(reportRes.headers.get('content-type') || '', /text\/csv/);
  const reportText = await reportRes.text();
  assert.match(reportText, /"'=CMD\|/);
  assert.doesNotMatch(reportText, /"=CMD\|/);
});
