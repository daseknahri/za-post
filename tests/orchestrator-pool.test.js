// tests/orchestrator-pool.test.js
// E-N5: the dynamic concurrency pool must reclaim idle slots — launch the next account the instant
// one finishes, instead of a batch barrier that waits for the slowest account in each batch. With
// accounts of uneven duration and poolSize 2, the slow account (C) must START as soon as a slot
// frees (when A finishes), BEFORE B finishes — which a batch barrier could never do.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('E-N5: pool launches the next account as a slot frees (no batch barrier)', async () => {
  const worker = require('../automation/worker');
  const durations = { A: 250, B: 600, C: 1000 };
  let concurrent = 0, maxConcurrent = 0;
  const order = [];
  worker.runAccount = async (o) => {
    const name = o.account.name;
    concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent); order.push('start:' + name);
    await new Promise((r) => setTimeout(r, durations[name] || 100));
    concurrent--; order.push('end:' + name);
    const ids = o.post && o.post.id ? [o.post.id] : ['p1'];
    return { posted: 1, errors: 0, pendingApproval: 0, noRetry: false, flag: null, postedIds: ids, dealtIds: ids, fullyPosted: true, offline: false, progressed: true };
  };

  const store = require('../lib/store');
  const { Orchestrator } = require('../automation/orchestrator');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-pool-'));
  store.init(tmp);
  store.save({
    posts: [{ id: 'p1', caption: 'x', comment: '', imagePaths: [] }],
    groups: [{ id: 'g1', name: 'G1', groupId: '111' }],
    accounts: ['A', 'B', 'C'].map((n) => ({ name: n, enabled: true, assignedGroups: ['g1'], postingOrder: 'post-centric' })),
    settings: { parallelAccounts: 2, accountDelay: 0, waitInterval: 0, groupDelay: 0, maxCycles: 1, staggerAccounts: false, varyImages: false, postsPerGroup: 0 },
    proxies: [], useProxies: false,
  });

  let doneResolve; const done = new Promise((r) => { doneResolve = r; });
  const emit = (event) => { if (event === 'automation-stopped') doneResolve(); };
  const orch = new Orchestrator(emit, {});
  orch.start(() => store.load());
  await Promise.race([done, new Promise((r) => setTimeout(r, 30000))]);
  try { orch.stop(); } catch {}

  assert.equal(maxConcurrent, 2, 'at most poolSize=2 accounts run at once');
  assert.ok(order.includes('start:C') && order.includes('end:C'), 'C ran to completion');
  // The discriminator: in the POOL, C starts (slot freed by A finishing ~250ms) BEFORE B finishes
  // (~600ms). A batch barrier would only start C after the whole [A,B] batch drained.
  assert.ok(order.indexOf('start:C') < order.indexOf('end:B'), 'C starts before B finishes — no batch barrier');
  fs.rmSync(tmp, { recursive: true, force: true });
});
