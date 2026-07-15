'use strict';
// #4 — mid-crash daily-cap reconstruction. A hard kill between a delivery and _recordAccountOutcome loses that cycle's
// acc.daily.count increment; on resume the account could over-post past its daily cap. _reconstructDailyCounts rebuilds
// TODAY's count from the per-delivery run-report (deduped by account|postId|groupId) and takes MAX with the persisted
// value — so it only ever RAISES the count (fails safe toward under-posting, never over).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/store');
const { Orchestrator } = require('../automation/orchestrator');

const iso = (offsetH = 0) => new Date(Date.now() + offsetH * 3600000).toISOString();

test('#4 _reconstructDailyCounts: raises to today deduped count, never lowers, ignores other days', async () => {
  store.init(fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-recon-')));
  const today = store.todayKey();
  await store.update((d) => {
    d.accounts = [
      { name: 'a1', daily: { date: today, count: 1 } }, // under-counted by a crash → run-report shows 3 → raise
      { name: 'a2', daily: { date: today, count: 5 } }, // run-report shows 2 → KEEP 5 (never lower)
      { name: 'a3', daily: { date: today, count: 0 } }, // only yesterday deliveries → stays 0
    ];
  });
  const rows = [
    { ts: iso(), account: 'a1', postId: 'p1', groupId: 'g1', result: 'posted' },
    { ts: iso(), account: 'a1', postId: 'p1', groupId: 'g1', result: 'posted' }, // two-phase DUP of the same delivery → deduped
    { ts: iso(), account: 'a1', postId: 'p1', groupId: 'g2', result: 'posted' },
    { ts: iso(), account: 'a1', postId: 'p2', groupId: 'g3', result: 'pending' }, // held counts too (matches daily.count += posted+pendingApproval)
    { ts: iso(-30), account: 'a1', postId: 'p9', groupId: 'g9', result: 'posted' }, // ~yesterday → ignored
    { ts: iso(), account: 'a2', postId: 'p1', groupId: 'g1', result: 'posted' },
    { ts: iso(), account: 'a2', postId: 'p2', groupId: 'g2', result: 'posted' },
    { ts: iso(), account: '(run summary)', result: 'summary:completed' }, // ignored
    { ts: iso(-30), account: 'a3', postId: 'p1', groupId: 'g1', result: 'posted' }, // a3 only yesterday
    { ts: iso(), account: 'a1', postId: 'p4', groupId: 'g4', result: 'error' }, // errors don't count
  ];
  fs.writeFileSync(store.reportFile(), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const o = new Orchestrator(() => {}, {});
  o.log = () => {};
  await o._reconstructDailyCounts();

  const d = store.load();
  const c = (n) => d.accounts.find((a) => a.name === n).daily.count;
  assert.strictEqual(c('a1'), 3, 'a1: 1→3 (p1/g1 deduped, p1/g2, p2/g3-held; yesterday + error ignored)');
  assert.strictEqual(c('a2'), 5, 'a2: kept 5 (reconstructed 2 < persisted 5 → never lowered)');
  assert.strictEqual(c('a3'), 0, 'a3: stays 0 (only yesterday deliveries)');
});
