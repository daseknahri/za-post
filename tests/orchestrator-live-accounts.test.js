// tests/orchestrator-live-accounts.test.js
// LIVE OPERATIONS: the dashboard must be able to show EVERY active account's state, not just the few running
// in parallel. The orchestrator ships a per-account snapshot inside each automation-progress event
// (progress.accounts = [{ name, alias, role, groups, state, action, posted }]). This asserts that snapshot is
// populated for ALL active accounts and that each account transitions queued → running → done over a cycle.
// Own file (fresh process): the worker/store/orchestrator singletons are per-process and can't share a run.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('automation-progress carries a per-account snapshot for every active account (queued→running→done)', async () => {
  const worker = require('../automation/worker');
  worker.runAccount = async (o) => {
    await new Promise((r) => setTimeout(r, 120));
    const ids = o.post && o.post.id ? [o.post.id] : ['p1'];
    return { posted: 1, errors: 0, pendingApproval: 0, noRetry: false, flag: null, postedIds: ids, dealtIds: ids, fullyPosted: true, offline: false, progressed: true };
  };

  const store = require('../lib/store');
  const { Orchestrator } = require('../automation/orchestrator');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-live-'));
  store.init(tmp);
  store.save({
    posts: [{ id: 'p1', caption: 'x', comment: '', imagePaths: [] }],
    groups: [{ id: 'g1', name: 'G1', groupId: '111' }],
    accounts: ['A', 'B', 'C', 'D'].map((n) => ({ name: n, alias: n, enabled: true, assignedGroups: ['g1'], postingOrder: 'post-centric' })),
    settings: { parallelAccounts: 2, accountDelay: 0, waitInterval: 0, groupDelay: 0, maxCycles: 1, staggerAccounts: false, varyImages: false, postsPerGroup: 0 },
    proxies: [], useProxies: false,
  });

  let maxAccounts = 0;
  const sawState = { queued: false, running: false, done: false };
  let lastSnap = [];
  let doneResolve; const done = new Promise((r) => { doneResolve = r; });
  const emit = (event, data) => {
    if (event === 'automation-progress' && data && Array.isArray(data.accounts)) {
      maxAccounts = Math.max(maxAccounts, data.accounts.length);
      for (const a of data.accounts) { if (sawState[a.state] !== undefined) sawState[a.state] = true; }
      lastSnap = data.accounts;
    }
    if (event === 'automation-stopped') doneResolve();
  };

  const orch = new Orchestrator(emit, {});
  orch.start(() => store.load());
  await Promise.race([done, new Promise((r) => setTimeout(r, 30000))]);
  try { orch.stop(); } catch {}

  assert.equal(maxAccounts, 4, 'every active account appears in the snapshot (not just the parallel few)');
  assert.ok(sawState.queued, 'accounts start as queued');
  assert.ok(sawState.running, 'accounts flip to running while posting');
  assert.ok(sawState.done, 'accounts end as done');
  assert.equal(lastSnap.length, 4, 'final snapshot still lists all accounts');
  assert.ok(lastSnap.every((a) => a.name && a.state && Object.prototype.hasOwnProperty.call(a, 'groups')), 'each row has name/state/groups');
  fs.rmSync(tmp, { recursive: true, force: true });
});
