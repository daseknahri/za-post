// tests/store.test.js
// M4-01: store durability guarantees — the serialized update() mutex (no lost updates across
// concurrent read-modify-write cycles) and .bak recovery when the primary file is corrupt.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/store');

test('update() serializes concurrent mutations — no lost updates', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-conc-'));
  store.init(tmp);
  store.save({ posts: [], groups: [], accounts: [{ name: 'a', n: 0 }], settings: {}, proxies: [], useProxies: false });
  await Promise.all(Array.from({ length: 50 }, () => store.update((d) => {
    const a = d.accounts.find((x) => x.name === 'a');
    a.n = (Number(a.n) || 0) + 1; // read-modify-write across an await point
  })));
  assert.equal(store.load().accounts[0].n, 50, 'all 50 increments must land (mutex prevents lost updates)');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('load() recovers from .bak when the primary file is corrupt', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-rec-'));
  store.init(tmp);
  store.save({ posts: [], groups: [{ id: 'g1', groupId: '1', name: 'G' }], accounts: [], settings: {}, proxies: [], useProxies: false });
  store.save({ posts: [], groups: [{ id: 'g1', groupId: '1', name: 'G' }, { id: 'g2', groupId: '2', name: 'H' }], accounts: [], settings: {}, proxies: [], useProxies: false });
  // The .bak now holds the 1-group snapshot. Corrupt the primary.
  fs.writeFileSync(store.paths.DATA_FILE, '{ this is not json');
  const d = store.load();
  assert.equal(d.groups.length, 1, 'should recover the last good snapshot from .bak');
  assert.equal(store.consumeLoadIssue(), 'recovered-from-backup');
  fs.rmSync(tmp, { recursive: true, force: true });
});
