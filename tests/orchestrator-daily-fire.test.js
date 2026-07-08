// tests/orchestrator-daily-fire.test.js
// The 'daily' schedule fire-time math (_msUntilDailyFire). A wrong value here is exactly the "I set 20:00 and
// nothing fired" class of bug: it must return 0 the moment today's time has arrived (and we haven't run today),
// the ms-until-today's-time while it's still ahead, and ms-until-TOMORROW once today's run is done. Pure unit
// test of the method — no loop, no browser, no timers.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { Orchestrator } = require('../automation/orchestrator');

const mk = () => new Orchestrator(() => {}, {});
const MIN = 60 * 1000, HOUR = 60 * MIN;
const hhmm = (h, m = 0) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

test('daily-fire: time already passed today + NOT run today → fire NOW (0)', () => {
  const o = mk(); const now = new Date();
  if (now.getHours() >= 1) { // skip the 00:xx edge where hour-1 underflows
    assert.equal(o._msUntilDailyFire(hhmm(now.getHours() - 1), null), 0, 'past time, not run today → 0 (fire now)');
  }
});

test('daily-fire: time still AHEAD today → positive ms within the next ~hour', () => {
  const o = mk(); const now = new Date();
  if (now.getHours() <= 22) {
    const ms = o._msUntilDailyFire(hhmm(now.getHours() + 1), null);
    assert.ok(ms > 0 && ms <= HOUR + MIN, `future-today → positive and ≤ ~1h (got ${ms}ms)`);
  }
});

test('daily-fire: already ran TODAY → waits until TOMORROW (~24h for the same time)', () => {
  const o = mk(); const now = new Date();
  const ms = o._msUntilDailyFire(hhmm(now.getHours(), now.getMinutes()), o._localDayKey()); // lastRun = today
  assert.ok(ms > 23 * HOUR && ms <= 24 * HOUR + MIN, `ran today → ~24h to tomorrow's same time (got ${ms}ms)`);
});

test('daily-fire: a prior run on a DIFFERENT day does not block today', () => {
  const o = mk(); const now = new Date();
  if (now.getHours() >= 1) {
    assert.equal(o._msUntilDailyFire(hhmm(now.getHours() - 1), '2000-01-01'), 0, 'stale lastRun (old day) → today fires');
  }
});

test('daily-fire: malformed time → finite, non-negative wait (never NaN/negative)', () => {
  const o = mk();
  for (const t of ['not-a-time', '', null, undefined, '25:99', '7']) {
    const ms = o._msUntilDailyFire(t, null);
    assert.ok(Number.isFinite(ms) && ms >= 0, `"${t}" → finite & ≥0 (got ${ms})`);
  }
});
