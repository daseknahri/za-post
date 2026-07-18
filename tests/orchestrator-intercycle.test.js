// tests/orchestrator-intercycle.test.js
// Locks Orchestrator._interCycleMs — the wait BETWEEN cycles (used by both continuous mode and the daily inter-cycle
// gap). A regression that dropped the jitter, ignored cycleGapMin, or collapsed the waitInterval range would let the
// fleet's cycles fire back-to-back on the ONE shared residential IP (burst posting = a spam signal). Previously untested.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { Orchestrator } = require('../automation/orchestrator');

test('_interCycleMs: cycleGapMin honored (+≤30% jitter); else the waitInterval range; explicit 0 → back-to-back', () => {
  const o = Object.create(Orchestrator.prototype);

  // An explicit cycleGapMin (minutes) wins, with up to +30% jitter so the cadence isn't a fixed spam tell.
  for (let i = 0; i < 300; i++) {
    const ms = o._interCycleMs({ cycleGapMin: 10 });
    assert.ok(ms >= 10 * 60000 && ms < 10 * 60000 * 1.3 + 1, `cycleGapMin=10 → [10min, 13min): got ${(ms / 60000).toFixed(2)}min`);
  }
  const draws = new Set();
  for (let i = 0; i < 100; i++) draws.add(o._interCycleMs({ cycleGapMin: 10 }));
  assert.ok(draws.size > 5, 'the inter-cycle gap is jittered, not a constant');

  // No cycleGapMin → the speed preset's waitInterval range (minutes → ms).
  for (let i = 0; i < 300; i++) {
    const ms = o._interCycleMs({ cycleGapMin: 0, waitIntervalMin: 2, waitIntervalMax: 4 });
    assert.ok(ms >= 2 * 60000 && ms <= 4 * 60000, `waitInterval 2-4min: got ${(ms / 60000).toFixed(2)}min`);
  }

  // Instant / explicit 0 range → 0 (back-to-back cycles honored). The multi-cycle DAILY gate applies its OWN ≥30s
  // floor elsewhere (via an absolute per-cycle fire time it counts down to); _interCycleMs itself must not floor, so
  // continuous + daily-N=1 can honor a deliberately-fast 0.
  assert.equal(o._interCycleMs({ cycleGapMin: 0, waitIntervalMin: 0, waitIntervalMax: 0 }), 0, 'an explicit 0 range is honored (no floor here)');
});
