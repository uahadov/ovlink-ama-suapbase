'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { randomBytes } = require('crypto');
const url = process.env.DATABASE_URL || '';
const safeDb = /\/ovlink_[\w]*qa[\w]*$/.test(url.split('?')[0]);

test('opt-in weekly report: exactly one send across overlapping workers and recover failed sends', {
  skip: !safeDb && 'Requires a dedicated Ovlink QA PostgreSQL database', timeout: 25000,
}, async () => {
  const client = new Client({ connectionString: url });
  await client.connect();
  const { encryptAES256GCM, blindIndex } = require('../utils/crypto');
  const emailLib = require('../src/lib/email');
  const statsReport = require('../src/lib/stats-report');
  const originalSend = emailLib.sendStatsReportEmail;
  const unique = randomBytes(6).toString('hex');
  const email = `weekly-qa-${unique}@example.test`;
  const now = new Date();
  let userId, urlId, sends = 0;
  try {
    const inserted = await client.query('INSERT INTO users(email,email_hash,email_verified,stats_report_enabled,created_at) ' +
      'VALUES($1,$2,1,1,$3) RETURNING id',
    [encryptAES256GCM(email), blindIndex(email), now.toISOString()]);
    userId = inserted.rows[0].id;
    const link = await client.query('INSERT INTO urls(original,short,user_id,created_at) VALUES($1,$2,$3,$4) RETURNING id',
      ['https://example.test', `weeklyqa${unique}`, userId, now.toISOString()]);
    urlId = link.rows[0].id;
    await client.query('INSERT INTO link_stats_daily(url_id,day,clicks,uniques,bots,conversions) VALUES($1,$2,3,2,0,1)',
      [urlId, now.toISOString().slice(0, 10)]);

    emailLib.sendStatsReportEmail = async (address, report) => {
      assert.equal(address, email);
      assert.equal(report.clicks, 3);
      sends += 1;
      await new Promise(resolve => setTimeout(resolve, 50));
    };

    const [a, b] = await Promise.all([
      statsReport.sendWeeklyStatsReports({ now, limit: 100 }),
      statsReport.sendWeeklyStatsReports({ now, limit: 100 }),
    ]);
    assert.equal(sends, 1, 'two concurrent workers must claim once');
    assert.equal(a.sent + b.sent, 1);
    assert.equal(a.failed + b.failed, 0);
    let stamp = await client.query('SELECT stats_report_last_sent_at FROM users WHERE id=$1', [userId]);
    assert.equal(stamp.rows[0].stats_report_last_sent_at, now.toISOString());

    await client.query('UPDATE users SET stats_report_last_sent_at=NULL WHERE id=$1', [userId]);
    emailLib.sendStatsReportEmail = async () => { sends += 1; throw new Error('QA simulated delivery failure'); };
    const failedRun = await statsReport.sendWeeklyStatsReports({ now: new Date(now.getTime() + 120000), limit: 100 });
    assert.equal(failedRun.failed, 1);
    stamp = await client.query('SELECT stats_report_last_sent_at FROM users WHERE id=$1', [userId]);
    assert.equal(stamp.rows[0].stats_report_last_sent_at, null, 'failed send must release claim');

    emailLib.sendStatsReportEmail = async () => { sends += 1; };
    const retry = await statsReport.sendWeeklyStatsReports({ now: new Date(now.getTime() + 180000), limit: 100 });
    assert.equal(retry.sent, 1);
    assert.equal(sends, 3);
  } finally {
    emailLib.sendStatsReportEmail = originalSend;
    if (urlId) {
      await client.query('DELETE FROM link_stats_daily WHERE url_id=$1', [urlId]).catch(() => {});
      await client.query('DELETE FROM urls WHERE id=$1', [urlId]).catch(() => {});
    }
    if (userId) await client.query('DELETE FROM users WHERE id=$1', [userId]).catch(() => {});
    await client.end();
    await require('../src/db/pool').pool.end().catch(() => {});
  }
});
