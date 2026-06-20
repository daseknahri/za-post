// tests/orchestrator-rotation.test.js
// M1-02: if the rotation/dealt-state write fails, the run must HALT — not keep posting. A post
// that published but whose dealt-id wasn't saved would be re-dealt and RE-POSTED on the next
// resume (duplicate posts). We force saveRotation to fail and assert the run stops before the
// next account runs, with a critical operator-facing message.
//
// NOTE: like scripts/test-antispam.js, the worker stub MUST be installed before the orchestrator
// is required, because the orchestrator destructures runAccount at module load.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('M1-02: a rotation-state write failure halts the run before the next account', async () => {
  const worker = require('../automation/worker');
  const calls = [];
  worker.runAccount = async (o) => {
    calls.push(o.account.name);
    const ids = o.post && o.post.id ? [o.post.id] : ['p1'];
    return { posted: 1, errors: 0, pendingApproval: 0, noRetry: false, flag: null, postedIds: ids, dealtIds: ids, fullyPosted: true, offline: false, progressed: true };
  };
  const store = require('../lib/store');
  const { Orchestrator } = require('../automation/orchestrator');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-rot-'));
  store.init(tmp);
  store.save({
    posts: [{ id: 'p1', caption: 'hi', comment: '', imagePaths: [] }],
    groups: [{ id: 'g1', name: 'G1', groupId: '111' }],
    accounts: [
      { name: 'a1', enabled: true, assignedGroups: ['g1'], postingOrder: 'post-centric' },
      { name: 'a2', enabled: true, assignedGroups: ['g1'], postingOrder: 'post-centric' },
    ],
    // parallelAccounts:1 → batch1=[a1], batch2=[a2]. The a1 dealt-persist fails → halt before a2.
    settings: { parallelAccounts: 1, accountDelay: 0, waitInterval: 0, groupDelay: 0, maxCycles: 5, staggerAccounts: false, varyImages: false },
    proxies: [], useProxies: false,
  });

  const realSave = store.saveRotation;
  store.saveRotation = () => false; // simulate disk full / file locked

  const logs = [];
  let doneResolve; const done = new Promise((r) => { doneResolve = r; });
  const emit = (event, payload) => { if (event === 'automation-log') logs.push(String(payload)); if (event === 'automation-stopped') doneResolve(); };
  const orch = new Orchestrator(emit, {});
  orch.start(() => store.load());
  const finished = await Promise.race([done.then(() => true), new Promise((r) => setTimeout(() => r(false), 45000))]);
  try { orch.stop(); } catch {}
  store.saveRotation = realSave;

  assert.equal(finished, true, 'the run must stop (not hang) after the write failure');
  assert.ok(calls.includes('a1'), 'the first account should have run');
  assert.ok(!calls.includes('a2'), 'the second account must NOT run after the rotation-write halt');
  assert.ok(logs.some((l) => /CRITICAL/i.test(l) && /rotation state/i.test(l)), 'a critical rotation-failure message should be logged');

  fs.rmSync(tmp, { recursive: true, force: true });
});
