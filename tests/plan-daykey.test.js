// tests/plan-daykey.test.js
// plan.localDayKey / dayLabel — the LOCAL calendar-day bucketing that governs the daily-rotation / campaign-plan
// "one post per LOCAL day" boundary (localDayKey MUST match orchestrator._localDayKey, else an agent could post
// twice in a day or skip one). dayLabel drives the dashboard's past→today→future navigation. Pins the key format
// + the relative-label boundaries. Deterministic (explicit Date args; only the locale-independent prefix is asserted).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { localDayKey, dayLabel } = require('../lib/plan');

test('localDayKey: local Y-M-D with zero-padded month + day', () => {
  assert.equal(localDayKey(new Date(2026, 0, 5)), '2026-01-05');   // Jan (month index 0) + single-digit day → both padded
  assert.equal(localDayKey(new Date(2026, 11, 31)), '2026-12-31'); // Dec, two-digit
  assert.equal(localDayKey(new Date(2026, 8, 9)), '2026-09-09');   // both single-digit → both padded
});

test('dayLabel: relative prefix only at the ±1-day boundaries', () => {
  assert.ok(dayLabel('2026-01-05', '2026-01-05').startsWith('Today ·'), 'same day → Today');
  assert.ok(dayLabel('2026-01-06', '2026-01-05').startsWith('Tomorrow ·'), '+1 → Tomorrow');
  assert.ok(dayLabel('2026-01-04', '2026-01-05').startsWith('Yesterday ·'), '-1 → Yesterday');
  const far = dayLabel('2026-01-12', '2026-01-05');
  assert.ok(!/^(Today|Tomorrow|Yesterday) ·/.test(far), `+7 days → no relative prefix, got: ${far}`);
});

test('dayLabel: relative boundaries hold across a month rollover', () => {
  assert.ok(dayLabel('2026-02-01', '2026-01-31').startsWith('Tomorrow ·'), 'Jan 31 → Feb 1 is Tomorrow');
  assert.ok(dayLabel('2026-01-31', '2026-02-01').startsWith('Yesterday ·'), 'Feb 1 → Jan 31 is Yesterday');
});
