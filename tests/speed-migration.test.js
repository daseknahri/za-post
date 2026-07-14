// tests/speed-migration.test.js
// End-to-end: a legacy data.json (old speedMode / pace tokens) migrates to the canonical 3 tiers on LOAD, and the
// migrated config behaves IDENTICALLY through applyPace (behavior-preserving migration). This locks the store↔speed
// wiring so an existing install upgrades with no surprise and no data loss. Own file → fresh process (store singleton).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/store');
const w = require('../automation/worker');

test('legacy data.json migrates speedMode + account pace to the 3 canonical tiers on load', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-speedmig-'));
  store.init(tmp);
  store.save({
    posts: [], groups: [], proxies: [], useProxies: false,
    settings: { speedMode: 'instant' }, // legacy fleet token
    accounts: [
      { name: 'a', pace: 'turbo' },    // legacy → max
      { name: 'b', pace: 'instant' },  // legacy → max
      { name: 'c', pace: 'normal' },   // legacy 1× / follow-global → inherit (field dropped)
      { name: 'd', pace: 'safe' },     // already canonical
      { name: 'e' },                   // no pace → inherit
      { name: 'f', pace: 'slow' },     // legacy slow → safe
    ],
  });
  const d = store.load();
  assert.equal(d.settings.speedMode, 'max', 'legacy fleet instant → max');
  const byName = Object.fromEntries(d.accounts.map((a) => [a.name, a.pace]));
  assert.equal(byName.a, 'max', 'turbo pace → max');
  assert.equal(byName.b, 'max', 'instant pace → max');
  assert.equal(byName.c, undefined, 'normal pace → inherit (field dropped)');
  assert.equal(byName.d, 'safe', 'safe pace preserved');
  assert.equal(byName.e, undefined, 'no pace stays inherit');
  assert.equal(byName.f, 'safe', 'slow pace → safe');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a migrated fleet tier behaves IDENTICALLY through applyPace (behavior-preserving)', () => {
  // The legacy 'instant' config and the new 'max' config resolve to the same effective settings the worker reads.
  const legacy = w.applyPace({ speedMode: 'instant' }, undefined);
  const migrated = w.applyPace({ speedMode: 'max' }, undefined);
  assert.deepEqual(legacy, migrated);
  assert.equal(migrated.speedMode, 'instant', 'max → the worker-internal instant token (Sacred floors read this)');
});
