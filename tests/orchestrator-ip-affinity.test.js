// tests/orchestrator-ip-affinity.test.js
// BATCH-PER-IP CONCURRENCY: the parallel pool runs up to settings.realIpMaxConcurrent accounts per exit IP at
// once (a "batch") and NEVER more, while accounts on DIFFERENT IPs run in parallel on top of that. With cap=2 and
// three accounts A,B,C sharing ONE IP plus D on another, at most 2 of A/B/C may run together (the 3rd waits for a
// slot) and the per-IP count must never exceed the cap. Set realIpMaxConcurrent=1 to restore strict one-account-
// per-IP anti-link — that mode is proven in orchestrator-ip-affinity-port.test.js.
// In its OWN file so node --test runs it in a fresh process (the orchestrator/store/worker singletons are shared
// within a process, so co-running with the pool test would cross-contaminate the concurrency measurement).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('batch-per-IP: up to realIpMaxConcurrent per IP at once, never more; other IPs parallelize', async () => {
  const worker = require('../automation/worker');
  const CAP = 2;                        // realIpMaxConcurrent — the per-IP batch size
  const ip1 = new Set(['A', 'B', 'C']); // A,B,C share IP1; D is on IP2
  const onIp1 = new Set();
  let maxOnIp1 = 0;                      // peak concurrent accounts FROM IP1 — must be ≤ CAP, and should REACH CAP (proves it batches, not serializes)
  const posted = new Set();
  const durations = { A: 500, B: 500, C: 500, D: 1200 };
  worker.runAccount = async (o) => {
    const name = o.account.name;
    if (ip1.has(name)) { onIp1.add(name); maxOnIp1 = Math.max(maxOnIp1, onIp1.size); }
    await new Promise((r) => setTimeout(r, durations[name] || 100));
    if (ip1.has(name)) onIp1.delete(name);
    posted.add(name);
    return { posted: 1, errors: 0, pendingApproval: 0, noRetry: false, flag: null, postedIds: ['p1'], dealtIds: ['p1'], fullyPosted: true, offline: false, progressed: true };
  };

  const store = require('../lib/store');
  const { Orchestrator } = require('../automation/orchestrator');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-ipbatch-'));
  store.init(tmp);
  store.save({
    posts: [{ id: 'p1', caption: 'x', comment: '', imagePaths: [] }],
    groups: [{ id: 'g1', name: 'G1', groupId: '111' }],
    accounts: [
      { name: 'A', enabled: true, assignedGroups: ['g1'], postingOrder: 'post-centric', proxy: 'http://1.1.1.1:8000:u:p' },
      { name: 'B', enabled: true, assignedGroups: ['g1'], postingOrder: 'post-centric', proxy: 'http://1.1.1.1:8000:u:p' }, // SAME IP as A
      { name: 'C', enabled: true, assignedGroups: ['g1'], postingOrder: 'post-centric', proxy: 'http://1.1.1.1:8000:u:p' }, // SAME IP as A & B
      { name: 'D', enabled: true, assignedGroups: ['g1'], postingOrder: 'post-centric', proxy: 'http://2.2.2.2:8000:u:p' }, // different IP
    ],
    settings: { parallelAccounts: 8, realIpMaxConcurrent: CAP, accountDelay: 0, waitInterval: 0, groupDelay: 0, maxCycles: 1, staggerAccounts: false, varyImages: false, postsPerGroup: 0 },
    proxies: [], useProxies: false,
  });

  let doneResolve; const done = new Promise((r) => { doneResolve = r; });
  const emit = (event) => { if (event === 'automation-stopped') doneResolve(); };
  const orch = new Orchestrator(emit, {});
  orch.start(() => store.load());
  await Promise.race([done, new Promise((r) => setTimeout(r, 30000))]);
  try { orch.stop(); } catch {}

  assert.ok(maxOnIp1 <= CAP, `IP1 must never exceed the per-IP batch cap ${CAP}; saw ${maxOnIp1}`);
  assert.equal(maxOnIp1, CAP, `IP1 should batch up to ${CAP} at once (not serialize to 1); saw ${maxOnIp1}`);
  assert.deepEqual([...posted].sort(), ['A', 'B', 'C', 'D'], 'all accounts eventually post');
  fs.rmSync(tmp, { recursive: true, force: true });
});
