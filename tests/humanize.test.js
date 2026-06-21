// tests/humanize.test.js
// HT-1: the humanization primitives (rand/rangeMs/humanDelay) and the new timing settings
// (clamp + min/max swap + legacy-key migration). The point is unpredictable-but-safe cadence:
// every value is random within a range, never below the floor.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const w = require('../automation/worker');
const store = require('../lib/store');

test('rand: integer within [min,max], order-tolerant, never negative', () => {
  for (let i = 0; i < 1000; i++) { const v = w.rand(100, 200); assert.ok(Number.isInteger(v) && v >= 100 && v <= 200); }
  for (let i = 0; i < 100; i++) { const v = w.rand(200, 100); assert.ok(v >= 100 && v <= 200); } // swapped args
  assert.equal(w.rand(50, 50), 50);
  assert.ok(w.rand(-10, -5) >= 0); // clamped non-negative
});

test('rangeMs: draws within the settings range (sec→ms) and respects the floor', () => {
  const s = { groupDelayMin: 120, groupDelayMax: 300 };
  for (let i = 0; i < 1000; i++) {
    const ms = w.rangeMs(s, 'groupDelayMin', 'groupDelayMax', 120, 300, 0);
    assert.ok(ms >= 120000 && ms <= 300000, `out of range: ${ms}`);
  }
  // A dangerously-low setting can't breach the safe floor.
  for (let i = 0; i < 200; i++) {
    assert.ok(w.rangeMs({ groupDelayMin: 5, groupDelayMax: 5 }, 'groupDelayMin', 'groupDelayMax', 120, 300, 120) >= 120000);
  }
});

test('humanDelay: master=false → exact base; else within ±variance, never negative', () => {
  assert.equal(w.humanDelay(1000, { humanizeMaster: false }, 'settle'), 1000);
  for (let i = 0; i < 500; i++) {
    const v = w.humanDelay(1000, { timingVariance: { settle: 0.3 } }, 'settle');
    assert.ok(v >= 700 && v <= 1300, `out of band: ${v}`);
  }
});

test('clampSettings: clamps + swaps the new humanization ranges', () => {
  const c = store.clampSettings({
    groupDelayMin: 9999, groupDelayMax: -5,            // out of range + reversed
    prePublishDwellSecMin: 50, prePublishDwellSecMax: 2, // reversed
    composerOpenInitialDelayMs: 100,                    // below floor
    humanizeMaster: 0,
    timingVariance: { settle: 5, pause: -1 },
  });
  assert.ok(c.groupDelayMin <= c.groupDelayMax && c.groupDelayMax <= 3600);
  assert.ok(c.prePublishDwellSecMin <= c.prePublishDwellSecMax);
  assert.equal(c.composerOpenInitialDelayMs, 800);  // clamped up to its floor
  assert.equal(c.humanizeMaster, false);            // coerced to bool
  assert.ok(c.timingVariance.settle <= 0.6 && c.timingVariance.pause >= 0);
});

test('migration: a legacy single timing key derives the min/max range on load', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-mig-'));
  store.init(tmp);
  store.save({ posts: [], groups: [], accounts: [], settings: { groupDelay: 200 }, proxies: [], useProxies: false });
  const s = store.load().settings;
  assert.equal(s.groupDelayMin, 160, 'floor(0.8*200)');
  assert.equal(s.groupDelayMax, 240, 'ceil(1.2*200)');
  assert.equal(s.groupDelay, 200, 'legacy key kept for back-compat');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('clampSettings: speedMode is coerced to a valid preset name', () => {
  assert.equal(store.clampSettings({ speedMode: 'slow' }).speedMode, 'slow');
  assert.equal(store.clampSettings({ speedMode: 'fast' }).speedMode, 'fast');
  assert.equal(store.clampSettings({ speedMode: 'bogus' }).speedMode, 'normal', 'invalid → normal');
});
