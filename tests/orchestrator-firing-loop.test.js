// tests/orchestrator-firing-loop.test.js
// Regression guard for the v1.0.78 multi-cycle FIRING bug: in daily mode with cyclesPerDay>1, cycle 1 fired then
// cycles 2..N never started — the subsequent-cycle branch re-derived a fresh inter-cycle gap on EVERY loop re-entry
// (waitMs always > 0), so it never reached the fire path. Fix: arm an ABSOLUTE fire time (_nextCycleAt) once and count
// DOWN to it. This drives the extracted decision (_dailyCycleWaitMs) exactly as the real loop does.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { Orchestrator } = require('../automation/orchestrator');

const mk = () => { const o = new Orchestrator(() => {}, {}); o._lastDailyRunDate = o._localDayKey(); o._nextCycleAt = 0; return o; };
const NOW0 = 1700000000000; // fixed base ms (deterministic; no Date.now in the assertions)

// The EXACT "rest until tomorrow" target: ms timestamp of the day AFTER baseMs's LOCAL day at HH:MM local.
// Mirrors _msUntilDailyFire's tomorrow branch, so the assertion is exact AND timezone/DST-independent (it does
// not assume any particular wall-clock time-of-day — the old `> 20h` bound only held at certain run times).
function nextDayFireMs(baseMs, hh, mm) {
  const d = new Date(baseMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, hh, mm, 0, 0).getTime();
}

// Drive the loop exactly like _mainLoop: compute waitMs; if 0 → FIRE (doneToday++, clear _nextCycleAt); else advance
// simulated time by the wait and re-enter. A guard trips if it can't converge (the v1.0.78 symptom).
function drive(o, settings, N) {
  const fired = []; let now = NOW0, doneToday = 0, runNow = true, guard = 0;
  while (doneToday < N && guard++ < 500) {
    const waitMs = o._dailyCycleWaitMs(settings, N, doneToday, runNow, now);
    runNow = false;
    if (waitMs === 0) { fired.push(now); doneToday += 1; o._nextCycleAt = 0; } // mirror the loop's post-fire bookkeeping
    else now += waitMs; // mirror _waitWithCountdown then `continue`
  }
  return { fired, doneToday, guard };
}

test('firing loop: all N cycles FIRE in sequence — subsequent cycles reach waitMs=0 (no infinite re-wait)', () => {
  const o = mk();
  const settings = { scheduleMode: 'daily', dailyPostTime: '05:23', cyclesPerDay: 3, cycleGapMin: 0.5 };
  const { fired, doneToday } = drive(o, settings, 3);
  assert.equal(doneToday, 3, 'all 3 cycles fired (the bug got stuck at 1 forever)');
  assert.equal(fired.length, 3);
  const gap1 = fired[1] - fired[0], gap2 = fired[2] - fired[1];
  assert.ok(gap1 >= 30000 && gap1 <= 39000, `cycle 1→2 gap ~30-39s (cycleGapMin 0.5 + ≤30% jitter), got ${gap1}ms`);
  assert.ok(gap2 >= 30000 && gap2 <= 39000, `cycle 2→3 gap ~30-39s, got ${gap2}ms`);
});

test('firing loop: a subsequent cycle COUNTS DOWN to its fire time — it does NOT re-arm a fresh gap each re-entry', () => {
  const o = mk();
  const settings = { dailyPostTime: '05:23', cycleGapMin: 0.5 };
  const w1 = o._dailyCycleWaitMs(settings, 3, 1, false, NOW0);           // arm once
  assert.ok(w1 >= 30000 && w1 <= 39000, `armed ~30-39s, got ${w1}`);
  const armed = o._nextCycleAt;
  const w2 = o._dailyCycleWaitMs(settings, 3, 1, false, NOW0 + 10000);   // 10s later, SAME doneToday (a loop re-entry)
  assert.equal(o._nextCycleAt, armed, 'the fire time is NOT re-armed on re-entry');
  assert.ok(Math.abs(w2 - (w1 - 10000)) <= 1, `counted DOWN by 10s (got ${w2}, ~${w1 - 10000}) — not reset to a fresh ~30s`);
  const w3 = o._dailyCycleWaitMs(settings, 3, 1, false, armed + 5);      // past the fire time
  assert.equal(w3, 0, 'armed time passed → waitMs 0 = FIRE (the fire path the v1.0.78 bug never reached)');
});

test('firing loop: runNow (Save & Start) fires the first cycle immediately', () => {
  const o = mk();
  assert.equal(o._dailyCycleWaitMs({ dailyPostTime: '05:23' }, 3, 0, true, NOW0), 0, 'doneToday=0 + runNow → 0');
  assert.equal(o._nextCycleAt, 0, 'no armed gap for an immediate fire');
});

test('firing loop: after the last cycle (doneToday>=N) it rests until tomorrow + disarms the gap', () => {
  const o = mk();
  const w = o._dailyCycleWaitMs({ dailyPostTime: '05:23', cyclesPerDay: 3 }, 3, 3, false, NOW0);
  assert.equal(NOW0 + w, nextDayFireMs(NOW0, 5, 23), 'doneToday>=N → rests until EXACTLY tomorrow 05:23 local (not the 30s inter-cycle gap)');
  assert.equal(o._nextCycleAt, 0, 'the subsequent-cycle fire time is disarmed once the day is done');
});

test('firing loop: cyclesPerDay=1 fires once then rests (byte-identical classic behavior)', () => {
  const o = mk();
  const settings = { dailyPostTime: '05:23', cyclesPerDay: 1 };
  // cycle 1
  assert.equal(o._dailyCycleWaitMs(settings, 1, 0, true, NOW0), 0, 'runNow first cycle fires');
  // after firing, doneToday=1 >= N=1 → rest
  const w = o._dailyCycleWaitMs(settings, 1, 1, false, NOW0);
  assert.equal(NOW0 + w, nextDayFireMs(NOW0, 5, 23), 'N=1: one cycle then rest until EXACTLY tomorrow 05:23 local (no subsequent-cycle path)');
});
