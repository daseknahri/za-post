// tests/behavior-personality.test.js
// Locks the per-account behavioral personality (worker.behaviorFor): each account gets a STABLE-but-DISTINCT
// typing speed / reading dwell / gap tempo / typo-proneness so many accounts on one host don't share one identical
// timing distribution (a cross-account behavioral cluster). Bounds are what keep a "fast" personality from ever
// posting below the anti-spam floors (the gaps are still floored by withFloor at the call sites).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { behaviorFor } = require('../automation/worker');

test('behaviorFor: deterministic per name (a stable personality across runs/restarts)', () => {
  assert.deepEqual(behaviorFor('account1'), behaviorFor('account1'));
  assert.deepEqual(behaviorFor('B7'), behaviorFor('B7'));
  assert.deepEqual(behaviorFor(''), behaviorFor('')); // empty/edge name is still stable
});

test('behaviorFor: distinct across accounts (breaks the cross-account timing cluster)', () => {
  const names = ['account1', 'account2', 'account3', 'B4', 'B7', 'B15', 'reserve1', 'mod'];
  const sigs = new Set(names.map((n) => JSON.stringify(behaviorFor(n))));
  assert.ok(sigs.size >= names.length - 1, `expected near-unique profiles, got ${sigs.size}/${names.length}`);
});

test('behaviorFor: every multiplier stays within safe bounds for any name', () => {
  for (const n of ['a', 'account17', 'B15', 'x'.repeat(40), '', '❤️unicode', '  spaces  ']) {
    const b = behaviorFor(n);
    assert.ok(b.typeMult >= 0.72 && b.typeMult <= 1.45, `typeMult ${b.typeMult} for "${n}"`);
    assert.ok(b.dwellMult >= 0.7 && b.dwellMult <= 1.4, `dwellMult ${b.dwellMult} for "${n}"`);
    assert.ok(b.gapMult >= 0.85 && b.gapMult <= 1.3, `gapMult ${b.gapMult} for "${n}"`);
    assert.ok(b.fumbleRate >= 0.05 && b.fumbleRate <= 0.14, `fumbleRate ${b.fumbleRate} for "${n}"`);
    assert.ok(Number.isFinite(b.typeMult) && Number.isFinite(b.gapMult), 'all finite (no NaN into the gap math)');
  }
});
