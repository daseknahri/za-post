// tests/orchestrator-realip-serial.test.js
// NO-PROXY (real-IP) concurrency. Accounts without a proxy all exit from the operator's ONE real home IP. A genuine
// residential line legitimately runs SEVERAL accounts at once — operators post from multiple browsers on one home
// connection and it holds up for the long run — so the pool runs no-proxy accounts CONCURRENTLY up to parallelAccounts
// (hardware-capped), NOT one at a time. (Earlier the pool serialized them to 1 as an over-cautious default; field
// evidence shows a real residential IP tolerates a handful at once.) PROXY accounts stay strictly one-per-distinct-proxy
// (anti-link) — covered by ip-affinity.test.js. In its OWN file so node --test runs it in a fresh process.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('no-proxy (real-IP) accounts run CONCURRENTLY up to parallelAccounts (not serialized to one)', async () => {
  const worker = require('../automation/worker');
  let maxConcurrent = 0, running = 0;
  worker.runAccount = async () => {
    running++; maxConcurrent = Math.max(maxConcurrent, running);
    await new Promise((r) => setTimeout(r, 350));
    running--;
    return { posted: 1, errors: 0, pendingApproval: 0, noRetry: false, flag: null, postedIds: ['p1'], dealtIds: ['p1'], fullyPosted: true, offline: false, progressed: true };
  };

  const store = require('../lib/store');
  const { Orchestrator } = require('../automation/orchestrator');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-realip-'));
  store.init(tmp);
  store.save({
    posts: [{ id: 'p1', caption: 'x', comment: '', imagePaths: [] }],
    groups: [{ id: 'g1', name: 'G1', groupId: '111' }],
    accounts: ['A', 'B', 'C'].map((n) => ({ name: n, enabled: true, assignedGroups: ['g1'], postingOrder: 'post-centric' })), // NO proxies → all on the operator's real IP
    settings: { parallelAccounts: 3, accountDelay: 0, waitInterval: 0, groupDelay: 0, maxCycles: 1, staggerAccounts: false, varyImages: false, postsPerGroup: 0 },
    proxies: [], useProxies: false,
  });

  let doneResolve; const done = new Promise((r) => { doneResolve = r; });
  const orch = new Orchestrator((event) => { if (event === 'automation-stopped') doneResolve(); }, {});
  orch.start(() => store.load());
  await Promise.race([done, new Promise((r) => setTimeout(r, 30000))]);
  try { orch.stop(); } catch {}

  // Real-IP accounts now run concurrently (the residential-IP behavior operators actually use), capped by
  // parallelAccounts (3) and hardware. The essential change is that they are NO LONGER pinned to one at a time.
  assert.ok(maxConcurrent > 1, `no-proxy accounts should run concurrently on a real IP (got maxConcurrent=${maxConcurrent})`);
  assert.ok(maxConcurrent <= 3, `never more than parallelAccounts=3 (got maxConcurrent=${maxConcurrent})`);
  fs.rmSync(tmp, { recursive: true, force: true });
});
