// tests/orchestrator-ip-affinity-port.test.js
// PER-IP KEY is the EXIT IP, not the full proxy string: two proxy entries that share ONE exit IP but use a
// DIFFERENT PORT/AUTH (a residential provider's rotating ports on one IP) map to the SAME per-IP slot — Facebook
// links accounts by the IP it sees, not the port. Under a string-keyed gate they'd get distinct keys and run on the
// one IP together (the "IP gets duplicated" hole). Here we pin realIpMaxConcurrent=1 (STRICT one-account-per-IP)
// so the batch cap is 1: A and B (same IP, different port) must never overlap, proving both the host-based keying
// AND that realIpMaxConcurrent=1 restores strict anti-link. In its OWN file (own process) so the shared
// orchestrator/store/worker singletons don't cross-contaminate the concurrency measurement.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('anti-link (cap=1): SAME IP, DIFFERENT PORT still serializes (keyed on the exit IP, not the port)', async () => {
  const worker = require('../automation/worker');
  const running = new Set();
  let abOverlap = false, maxConcurrent = 0;
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-ipport-'));
  store.init(tmp);
  store.save({
    posts: [{ id: 'p1', caption: 'x', comment: '', imagePaths: [] }],
    groups: [{ id: 'g1', name: 'G1', groupId: '111' }],
    accounts: [
      { name: 'A', enabled: true, assignedGroups: ['g1'], postingOrder: 'post-centric', proxy: 'http://1.1.1.1:8000:u:p' },
      { name: 'B', enabled: true, assignedGroups: ['g1'], postingOrder: 'post-centric', proxy: 'http://1.1.1.1:9999:u:p' }, // SAME IP as A, DIFFERENT PORT
      { name: 'C', enabled: true, assignedGroups: ['g1'], postingOrder: 'post-centric', proxy: 'http://2.2.2.2:8000:u:p' }, // different IP
    ],
    // realIpMaxConcurrent: 1 → strict one-account-per-IP (batch cap 1). Without it the default cap (3) would let A & B batch.
    settings: { parallelAccounts: 3, realIpMaxConcurrent: 1, accountDelay: 0, waitInterval: 0, groupDelay: 0, maxCycles: 1, staggerAccounts: false, varyImages: false, postsPerGroup: 0 },
    proxies: [], useProxies: false,
  });
  let doneResolve; const done = new Promise((r) => { doneResolve = r; });
  const emit = (event) => { if (event === 'automation-stopped') doneResolve(); };
  const orch = new Orchestrator(emit, {});
  orch.start(() => store.load());
  await Promise.race([done, new Promise((r) => setTimeout(r, 30000))]);
  try { orch.stop(); } catch {}
  assert.equal(abOverlap, false, 'A & B (same exit IP, different port) must NOT run at the same time under cap=1 — keyed on IP, not port');
  assert.equal(maxConcurrent, 2, 'peak 2 (C different IP + one of A/B same IP): concurrency = distinct IPs when cap=1');
  fs.rmSync(tmp, { recursive: true, force: true });
});
