'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');

const backgroundJobs = require('../src/lib/background-jobs');

test('P30 unit: exponential backoff is bounded and deterministic', () => {
  assert.equal(backgroundJobs.computeBackoffMs(1, 1000, 60000), 1000);
  assert.equal(backgroundJobs.computeBackoffMs(2, 1000, 60000), 2000);
  assert.equal(backgroundJobs.computeBackoffMs(3, 1000, 60000), 4000);
  assert.equal(backgroundJobs.computeBackoffMs(20, 1000, 60000), 60000);
});

const dbUrl = process.env.DATABASE_URL || '';
const safeDb = /\/ovlink_[\w]*qa[\w]*$/.test(dbUrl.split('?')[0]);

test('P30 integration: parallel workers SKIP LOCKED, crash->lease recovery, dead_letter cap & Ops API', { skip: !safeDb && 'Requires isolated QA DB', timeout: 30000 }, async () => {
  const express = require('express');
  const { dbRunAsync } = require('../src/db/helpers');
  const campaignsRouter = require('../src/routes/api/campaigns');

  const suffix = crypto.randomBytes(4).toString('hex');
  const nowIso = new Date().toISOString();
  const uRes = await dbRunAsync(
    "INSERT INTO users (email, email_verified, plan_tier, plan_status, created_at) VALUES (?, 1, 'pro', 'active', ?)",
    [`p30-${suffix}@example.com`, nowIso]
  );
  const userId = Number(uRes.lastID);

  // 1. Idempotent enqueue: duplicate key returns deduplicated = true
  const k1 = `p30_k1_${suffix}`;
  const k2 = `p30_k2_${suffix}`;
  const e1 = await backgroundJobs.enqueueJob({ jobType: 'report_export', idempotencyKey: k1, ownerUserId: userId, payload: { n: 1 } });
  const e1Dup = await backgroundJobs.enqueueJob({ jobType: 'report_export', idempotencyKey: k1, ownerUserId: userId, payload: { n: 1 } });
  assert.equal(e1.deduplicated, false);
  assert.equal(e1Dup.deduplicated, true);
  assert.equal(e1Dup.job.id, e1.job.id);

  await backgroundJobs.enqueueJob({ jobType: 'audit_export', idempotencyKey: k2, ownerUserId: userId, payload: { n: 2 } });

  // 2. Two parallel workers claim strictly disjoint jobs via FOR UPDATE SKIP LOCKED
  const [cA, cB] = await Promise.all([
    backgroundJobs.claimNextJob({ workerId: 'worker-A', ownerUserId: userId, leaseMs: 60000 }),
    backgroundJobs.claimNextJob({ workerId: 'worker-B', ownerUserId: userId, leaseMs: 60000 }),
  ]);
  assert.ok(cA && cB);
  assert.notEqual(cA.id, cB.id, 'Parallel workers must never claim the same job');
  await backgroundJobs.completeJob({ jobId: cA.id, result: { ok: true } });
  await backgroundJobs.completeJob({ jobId: cB.id, result: { ok: true } });

  // 3. Crash -> Lease expiry -> Recovery by second worker
  const kCrash = `p30_crash_${suffix}`;
  const crashEnq = await backgroundJobs.enqueueJob({ jobType: 'scheduled_report', idempotencyKey: kCrash, ownerUserId: userId, payload: { crash: true } });
  const crashedClaim = await backgroundJobs.claimNextJob({
    workerId: 'dead-worker',
    ownerUserId: userId,
    leaseMs: 1, // expires immediately
    now: new Date(Date.now() - 5000),
  });
  assert.equal(crashedClaim.id, crashEnq.job.id);
  // Dead worker never completes -> healthy worker recovers expired lease
  const recovered = await backgroundJobs.claimNextJob({
    workerId: 'healthy-worker',
    ownerUserId: userId,
    leaseMs: 60000,
  });
  assert.ok(recovered);
  assert.equal(recovered.id, crashEnq.job.id);
  assert.equal(recovered.attempts, 2);
  await backgroundJobs.completeJob({ jobId: recovered.id, result: { recovered: true } });

  // 4. Dead-letter cap: max_attempts = 2 never enters an infinite retry loop
  const kDead = `p30_dead_${suffix}`;
  const deadEnq = await backgroundJobs.enqueueJob({ jobType: 'alert_dispatch', idempotencyKey: kDead, ownerUserId: userId, maxAttempts: 2 });
  const dClaim1 = await backgroundJobs.claimNextJob({ workerId: 'w1', ownerUserId: userId });
  assert.equal(dClaim1.id, deadEnq.job.id);
  const fail1 = await backgroundJobs.failJob({ job: dClaim1, errorMessage: 'err1', baseBackoffMs: 1 });
  assert.equal(fail1.status, 'queued');

  const dClaim2 = await backgroundJobs.claimNextJob({ workerId: 'w2', ownerUserId: userId, now: new Date(Date.now() + 5000) });
  assert.equal(dClaim2.id, deadEnq.job.id);
  const fail2 = await backgroundJobs.failJob({ job: dClaim2, errorMessage: 'err2', baseBackoffMs: 1 });
  assert.equal(fail2.status, 'dead_letter');

  const dClaim3 = await backgroundJobs.claimNextJob({ workerId: 'w3', ownerUserId: userId, now: new Date(Date.now() + 10000) });
  assert.equal(dClaim3, null, 'Dead-letter job must not loop infinitely');

  // 5. Ops HTTP endpoints (list + requeue dead_letter)
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { userId }; next(); });
  app.use(campaignsRouter);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const opsList = await fetch(`${baseUrl}/api/ops/jobs`);
    assert.equal(opsList.status, 200);
    const opsBody = await opsList.json();
    assert.equal(opsBody.counts.completed, 3);
    assert.equal(opsBody.counts.dead_letter, 1);

    const requeueRes = await fetch(`${baseUrl}/api/ops/jobs/${deadEnq.job.id}/requeue`, { method: 'POST' });
    assert.equal(requeueRes.status, 200);
    const requeueBody = await requeueRes.json();
    assert.equal(requeueBody.status, 'queued');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
