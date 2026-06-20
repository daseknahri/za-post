// tests/orchestrator-crash.test.js
// M3-09: a crash-looping account must not burn the whole run. With a worker that always throws and
// a 3-post account, the run should give up after 2 crashed posts (2 attempts each = 4 worker calls)
// and flag the account — NOT churn through all 3 posts. (Worker stub installed before requiring the
// orchestrator, as the orchestrator destructures runAccount at load.)
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('M3-09: 2 crashed posts in a row skip the account and flag it', async () => {
  const worker = require('../automation/worker');
  let calls = 0;
  worker.runAccount = async () => { calls++; throw new Error('simulated browser crash'); };

  const store = require('../lib/store');
  const { Orchestrator } = require('../automation/orchestrator');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-crash-'));
  store.init(tmp);
  store.save({
    posts: [
      { id: 'p1', caption: 'a', comment: '', imagePaths: [] },
      { id: 'p2', caption: 'b', comment: '', imagePaths: [] },
      { id: 'p3', caption: 'c', comment: '', imagePaths: [] },
    ],
    groups: [{ id: 'g1', name: 'G1', groupId: '111' }],
    accounts: [{ name: 'broken', enabled: true, assignedGroups: ['g1'], postingOrder: 'post-centric' }],
    settings: { parallelAccounts: 1, accountDelay: 0, waitInterval: 0, groupDelay: 0, maxCycles: 1, staggerAccounts: false, varyImages: false, postsPerGroup: 0 },
    proxies: [], useProxies: false,
  });

  const attentions = [];
  let doneResolve; const done = new Promise((r) => { doneResolve = r; });
  const emit = (event, payload) => { if (event === 'account-attention') attentions.push(payload); if (event === 'automation-stopped') doneResolve(); };
  const orch = new Orchestrator(emit, {});
  orch.start(() => store.load());
  const finished = await Promise.race([done.then(() => true), new Promise((r) => setTimeout(() => r(false), 45000))]);
  try { orch.stop(); } catch {}

  assert.equal(finished, true, 'run should finish (maxCycles=1)');
  assert.equal(calls, 4, 'should stop after 2 crashed posts × 2 attempts = 4 calls, not all 3 posts');
  assert.ok(attentions.some((a) => a && a.name === 'broken'), 'the crash-looping account should be flagged for attention');

  fs.rmSync(tmp, { recursive: true, force: true });
});
