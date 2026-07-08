// tests/orchestrator-scale-hardening.test.js
// 400-account scale hardening (2026-07-06): (1) per-account outcome write ELISION — a no-op outcome must not rewrite
// data.json, but a real delivery / flag still persists immediately (no durability loss). (2) live-ops emit coalescing
// keeps _progress.accounts current SYNCHRONOUSLY so the final state is never lost to the throttle. (3) disk-space
// preflight warns (non-blocking, throttled) before a full disk halts the fleet.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('_recordAccountOutcome ELIDES the write on a no-op outcome but persists a real delivery (and a flag)', async () => {
  const store = require('../lib/store');
  const { Orchestrator } = require('../automation/orchestrator');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-elide-'));
  store.init(tmp);
  const today = store.todayKey();
  store.save({ posts: [], groups: [], accounts: [{ name: 'a', daily: { date: today, count: 5 } }], settings: {}, proxies: [], useProxies: false });

  const o = Object.create(Orchestrator.prototype);
  o.log = () => {};
  const realUpdate = store.update;
  let writes = 0;
  store.update = (...args) => { writes++; return realUpdate.apply(store, args); };
  try {
    // no-op: posted nothing, no flag → nothing to persist → NO write
    await o._recordAccountOutcome('a', { posted: 0, pendingApproval: 0, errors: 0, flag: null }, {});
    assert.equal(writes, 0, 'a no-op outcome must NOT rewrite data.json');
    // real delivery → writes once, count 5+2=7
    await o._recordAccountOutcome('a', { posted: 2, pendingApproval: 0, errors: 0, flag: null }, {});
    assert.equal(writes, 1, 'a real delivery writes once');
    // a flag with 0 posts still writes (cooldown / warm-up / status handling must persist)
    await o._recordAccountOutcome('a', { posted: 0, pendingApproval: 0, errors: 0, flag: 'needs_login' }, {});
    assert.equal(writes, 2, 'a flagged outcome persists even with 0 posts');
  } finally { store.update = realUpdate; }

  const after = store.load();
  assert.equal(after.accounts[0].daily.count, 7, 'the delivery incremented the daily count (5+2); the elided no-op did not touch it');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('_emitLiveOps keeps _progress.accounts current synchronously (final state is never lost to the throttle)', () => {
  const { Orchestrator } = require('../automation/orchestrator');
  const o = Object.create(Orchestrator.prototype);
  o._progress = { accounts: [] };
  o._cycleAccts = [{ name: 'A', alias: 'A', assignedGroups: ['g'] }];
  o._acctLive = {};
  o._data = { proxies: [], useProxies: false };
  o.emit = () => {}; // swallow the (throttled) IPC emit
  try {
    o._setAcctState('A', 'running', { action: 'x' });
    assert.equal(o._progress.accounts[0].state, 'running', 'state reflected synchronously');
    o._setAcctState('A', 'done', { posted: 1 }); // this one may be throttled (emit deferred) — but _progress must still update
    assert.equal(o._progress.accounts[0].state, 'done', 'the latest state is in _progress.accounts even when the emit is deferred');
    assert.equal(o._progress.accounts[0].posted, 1, 'extra fields reflected too');
  } finally {
    if (o._progressTimer) { try { clearTimeout(o._progressTimer); } catch {} }
  }
});

test('_diskPreflight warns (non-blocking, throttled) when disk is low, and stays silent when ample', () => {
  const { Orchestrator } = require('../automation/orchestrator');
  const GB = 1024 * 1024 * 1024;
  const fleet = (n) => () => ({ accounts: Array.from({ length: n }, (_, i) => ({ name: 'a' + i, enabled: true })) });

  // under the 2GB hard floor → LOW DISK
  let o = Object.create(Orchestrator.prototype);
  let logs = []; o.log = (m) => logs.push(String(m)); o._lastDiskWarn = 0;
  o._freeDiskBytes = () => 0.5 * GB;
  o._diskPreflight(fleet(1));
  assert.ok(logs.some((m) => /LOW DISK/.test(m)), 'warns under the 2GB floor');
  const n = logs.length;
  o._diskPreflight(fleet(1)); // immediate repeat → throttled
  assert.equal(logs.length, n, 'throttled — no repeat warning within ~15min');

  // above the floor but below the fleet estimate (50 × 200MB = 10GB) → fleet warning
  o = Object.create(Orchestrator.prototype);
  logs = []; o.log = (m) => logs.push(String(m)); o._lastDiskWarn = 0;
  o._freeDiskBytes = () => 5 * GB;
  o._diskPreflight(fleet(50));
  assert.ok(logs.some((m) => /DISK/.test(m)), 'warns when free < fleet estimate');

  // ample disk → silent
  o = Object.create(Orchestrator.prototype);
  logs = []; o.log = (m) => logs.push(String(m)); o._lastDiskWarn = 0;
  o._freeDiskBytes = () => 500 * GB;
  o._diskPreflight(fleet(50));
  assert.equal(logs.length, 0, 'no warning when disk is ample');

  // statfs unavailable (null) → silent, never throws
  o = Object.create(Orchestrator.prototype);
  logs = []; o.log = (m) => logs.push(String(m)); o._lastDiskWarn = 0;
  o._freeDiskBytes = () => null;
  o._diskPreflight(fleet(400));
  assert.equal(logs.length, 0, 'no warning (and no throw) when free space can not be read');
});
