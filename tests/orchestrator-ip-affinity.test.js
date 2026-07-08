// tests/orchestrator-ip-affinity.test.js
// ANTI-LINK CONCURRENCY: the parallel pool must never run two accounts that exit from the SAME proxy IP at
// the same time (Facebook links accounts seen simultaneously on one IP), while accounts on DIFFERENT IPs
// still run in parallel. A & B share one proxy, C has its own; with poolSize 3 the guard must yield peak
// concurrency 2 (C + one of A/B) and A&B never overlapping.
// In its OWN file so node --test runs it in a fresh process (the orchestrator/store/worker singletons are
// shared within a process, so co-running with the pool test would cross-contaminate).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('anti-link: same-IP accounts never run concurrently; different-IP accounts do', async () => {
  const worker = require('../automation/worker');
  const running = new Set();
  let abOverlap = false;   // A & B share an IP → must NEVER be running at the same instant
  let maxConcurrent = 0;   // peak concurrency — A/B same IP + C different → guard allows exactly 2 (C + A/B)
  const durations = { A: 400, B: 400, C: 900 };
  worker.runAccount = async (o) => {
    const name = o.account.name;
    running.add(name);
    maxConcurrent = Math.max(maxConcurrent, running.size);
    if (running.has('A') && running.has('B')) abOverlap = true;
    await new Promise((r) => setTimeout(r, durations[name] || 100));
    running.delete(name);
    return { posted: 1, errors: 0, pendingApproval: 0, noRetry: false, flag: null, postedIds: ['p1'], dealtIds: ['p1'], fullyPosted: true, offline: false, progressed: true };
  };

  const store = require('../lib/store');
  const { Orchestrator } = require('../automation/orchestrator');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-ip-'));
  store.init(tmp);
  store.save({
    posts: [{ id: 'p1', caption: 'x', comment: '', imagePaths: [] }],
    groups: [{ id: 'g1', name: 'G1', groupId: '111' }],
    accounts: [
      { name: 'A', enabled: true, assignedGroups: ['g1'], postingOrder: 'post-centric', proxy: 'http://1.1.1.1:8000:u:p' },
      { name: 'B', enabled: true, assignedGroups: ['g1'], postingOrder: 'post-centric', proxy: 'http://1.1.1.1:8000:u:p' }, // SAME IP as A
      { name: 'C', enabled: true, assignedGroups: ['g1'], postingOrder: 'post-centric', proxy: 'http://2.2.2.2:8000:u:p' }, // different IP
    ],
    settings: { parallelAccounts: 3, accountDelay: 0, waitInterval: 0, groupDelay: 0, maxCycles: 1, staggerAccounts: false, varyImages: false, postsPerGroup: 0 },
    proxies: [], useProxies: false,
  });

  let doneResolve; const done = new Promise((r) => { doneResolve = r; });
  const emit = (event) => { if (event === 'automation-stopped') doneResolve(); };
  const orch = new Orchestrator(emit, {});
  orch.start(() => store.load());
  await Promise.race([done, new Promise((r) => setTimeout(r, 30000))]);
  try { orch.stop(); } catch {}

  assert.equal(abOverlap, false, 'A and B (same proxy IP) must NOT run at the same time');
  assert.equal(maxConcurrent, 2, 'peak 2 (C + one of A/B): different IPs parallelize, same IP serializes');
  fs.rmSync(tmp, { recursive: true, force: true });
});
