// tests/orchestrator-isolation.test.js
// E-N1: account isolation under PARALLEL execution. One account throwing (or hitting a no-retry
// rate-limit) in the same batch must never stop a sibling from completing. This is critical NOW
// (parallelAccounts runs accounts concurrently) and is the safety baseline the dynamic pool (E-N5)
// must preserve. Worker stub installed before requiring the orchestrator (it destructures runAccount).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('E-N1: a crashing/rate-limited account does not stop its parallel sibling', async () => {
  const worker = require('../automation/worker');
  const calls = [];
  worker.runAccount = async (o) => {
    const name = o.account.name;
    calls.push(name);
    if (name === 'A') throw new Error('simulated crash in A');
    if (name === 'B') return { posted: 0, errors: 1, pendingApproval: 0, noRetry: true, flag: 'rate_limited', postedIds: [], dealtIds: [], fullyPosted: false, offline: false, progressed: false };
    // C posts normally
    const ids = o.post && o.post.id ? [o.post.id] : ['p1'];
    return { posted: 1, errors: 0, pendingApproval: 0, noRetry: false, flag: null, postedIds: ids, dealtIds: ids, fullyPosted: true, offline: false, progressed: true };
  };

  const store = require('../lib/store');
  const { Orchestrator } = require('../automation/orchestrator');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-iso-'));
  store.init(tmp);
  store.save({
    posts: [{ id: 'p1', caption: 'x', comment: '', imagePaths: [] }],
    groups: [{ id: 'g1', name: 'G1', groupId: '111' }],
    accounts: [
      { name: 'A', enabled: true, assignedGroups: ['g1'], postingOrder: 'post-centric' },
      { name: 'B', enabled: true, assignedGroups: ['g1'], postingOrder: 'post-centric' },
      { name: 'C', enabled: true, assignedGroups: ['g1'], postingOrder: 'post-centric' },
    ],
    // parallelAccounts:3 → A, B, C all run concurrently in one batch.
    settings: { parallelAccounts: 3, accountDelay: 0, waitInterval: 0, groupDelay: 0, maxCycles: 1, staggerAccounts: false, varyImages: false, postsPerGroup: 0 },
    proxies: [], useProxies: false,
  });

  let lastPosted = 0;
  let doneResolve; const done = new Promise((r) => { doneResolve = r; });
  const emit = (event, payload) => {
    if (event === 'automation-progress' && payload) lastPosted = Math.max(lastPosted, payload.posted || 0);
    if (event === 'automation-stopped') doneResolve();
  };
  const orch = new Orchestrator(emit, {});
  orch.start(() => store.load());
  const finished = await Promise.race([done.then(() => true), new Promise((r) => setTimeout(() => r(false), 45000))]);
  try { orch.stop(); } catch {}

  assert.equal(finished, true, 'run should complete (maxCycles=1), not hang');
  assert.ok(calls.includes('A') && calls.includes('B') && calls.includes('C'), 'all three accounts must run despite A crashing and B rate-limiting');
  assert.ok(lastPosted >= 1, 'account C must post normally even though A crashed and B was rate-limited in the same batch');

  // Independent persisted state: C's post is dealt; B is in cool-down; statuses didn't cross-contaminate.
  const after = store.load();
  const b = after.accounts.find((a) => a.name === 'B');
  assert.ok(b && Number(b.rateLimitedUntil) > Date.now(), 'B independently recorded its rate-limit cool-down');
  fs.rmSync(tmp, { recursive: true, force: true });
});
