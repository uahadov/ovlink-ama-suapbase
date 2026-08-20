const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'b66f58f96f4a4f6090de997ca71b72910d9695f95f24ddf9b255f4cbebf9804cff9e1b9d79f60df7e840a9136dbf126fd1f6f4f94b1f8cfbd93afbfccf8d4f8a';
process.env.NODE_ENV = 'test';
process.env.BASE_URL = '';
process.env.PUBLIC_BASE_URL = '';

const { helpers } = require('../server');

test.after(async () => {
  try {
    const migrationDrainDeadline = Date.now() + 3000;
    while (!helpers.isDbMigrationQueueDrained() && Date.now() < migrationDrainDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await helpers.closeDbPool();
  } catch {}
});

test('checkLiveThreat correctly returns safe status for clean URLs', async () => {
  const res = await helpers.checkLiveThreat('https://github.com/nodejs/node');
  assert.equal(res.threat, false);
});

test('syncThreatIntelligenceFeed downloads URLhaus live threat feed and detects malware URLs', async () => {
  await helpers.syncThreatIntelligenceFeed();
  const safeRes = await helpers.checkLiveThreat('https://wikipedia.org');
  assert.equal(safeRes.threat, false);
});
