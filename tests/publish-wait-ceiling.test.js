// tests/publish-wait-ceiling.test.js
// #time-waste: the publish-confirmation wait is FULL (70s) on a fresh/healthy account, but drops to a shorter
// "throttle" ceiling once FB has silently dropped a publish this run (consecPubTimeouts>0) so a throttled account
// reaches its 2-in-a-row backoff fast instead of idling ~70s per post. The FIRST post keeps the full ceiling — that
// long wait is the false-timeout → re-post → DOUBLE-POST guard, and must never be shortened before a throttle is seen.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { publishWaitCeilingMs, composerOpenAttempts, watchdogTickDecision } = require('../automation/worker');

test('publishWaitCeilingMs: the FIRST post (no prior silent-throttle) waits the FULL 70s ceiling', () => {
  assert.equal(publishWaitCeilingMs(0), 70000, 'consecPubTimeouts=0 → full ceiling (max false-timeout / double-post protection)');
});

test('publishWaitCeilingMs: after a silent-throttle timeout, the next post uses the SHORT throttle ceiling', () => {
  assert.equal(publishWaitCeilingMs(1), 35000, 'consecPubTimeouts=1 → shortened (throttle strongly suspected; timeout-path guards still run)');
  assert.equal(publishWaitCeilingMs(2), 35000, 'still shortened at 2 (unreachable in practice — backoff fires at 2 — but must not regress to the full wait)');
});

test('publishWaitCeilingMs: never shortens BELOW the documented 35-45s slow-publish window', () => {
  // The shortened ceiling + the ~15s of post-timeout landing guards (H3 capture + dialog poll + rescan) must still
  // cover a genuinely slow publish, or a slow SUCCESS would be re-posted = a duplicate.
  assert.ok(publishWaitCeilingMs(1) >= 30000, 'throttle ceiling stays ≥30s so the guards cover a slow-but-real publish');
});

test('publishWaitCeilingMs: a reset streak (confirmed publish → 0) returns to the full ceiling', () => {
  // consecPubTimeouts is reset to 0 on any confirmed/held publish, so a recovered account waits the full 70s again.
  assert.equal(publishWaitCeilingMs(0), 70000);
});

test('publishWaitCeilingMs: tolerates a non-numeric streak (defensive → full ceiling)', () => {
  assert.equal(publishWaitCeilingMs(undefined), 70000, 'undefined → treated as 0 → full ceiling (never accidentally short)');
  assert.equal(publishWaitCeilingMs(null), 70000);
});

// #3: composer-open attempts — FULL (4) on a healthy account (a slow feed needs the retries); cut to 2 once FB is
// already pushing the account back so it reaches backoff fast instead of idling ~30s on an unloadable group.
test('composerOpenAttempts: healthy account (no pushback) gets the FULL retry budget', () => {
  assert.equal(composerOpenAttempts(0), 4);
});

test('composerOpenAttempts: once FB is pushing back (pushback>0), attempts are cut so the account bails fast', () => {
  assert.equal(composerOpenAttempts(1), 2);
  assert.equal(composerOpenAttempts(3), 2);
});

test('composerOpenAttempts: always makes at least the first attempt, and tolerates a non-numeric count', () => {
  assert.ok(composerOpenAttempts(1) >= 1 && composerOpenAttempts(0) >= 1, 'never zero attempts');
  assert.equal(composerOpenAttempts(undefined), 4, 'undefined → treated as 0 → full budget (never accidentally short)');
});

// #5: the per-account watchdog no longer re-extends the full budget FOREVER on a live-but-stuck browser. It extends while
// the account is advancing (a group started), grants ONE grace window (for a rare sleep-resume), then aborts a browser
// that made ZERO group progress across 2 consecutive budget windows — a reserve then covers its groups.
test('watchdogTickDecision: a DEAD browser aborts (progress irrelevant)', () => {
  assert.equal(watchdogTickDecision(false, false, 0).action, 'abort');
  assert.equal(watchdogTickDecision(false, true, 5).action, 'abort');
});

test('watchdogTickDecision: alive + advancing → extend and RESET the no-progress streak', () => {
  assert.deepEqual(watchdogTickDecision(true, true, 3), { action: 'extend', noProgressTicks: 0 });
});

test('watchdogTickDecision: alive + no progress → ONE grace extend, then ABORT on the 2nd consecutive window (stuck)', () => {
  const d1 = watchdogTickDecision(true, false, 0);
  assert.deepEqual(d1, { action: 'extend', noProgressTicks: 1 }, 'grace: extend once — could be a sleep-resume');
  assert.equal(watchdogTickDecision(true, false, d1.noProgressTicks).action, 'abort', 'stuck: no infinite re-extend');
});

test('watchdogTickDecision: a progress window between stalls resets the grace (needs 2 CONSECUTIVE no-progress)', () => {
  const stuck1 = watchdogTickDecision(true, false, 0);                       // n=1, extend
  const recovered = watchdogTickDecision(true, true, stuck1.noProgressTicks); // progressed → reset
  assert.equal(recovered.noProgressTicks, 0);
  assert.equal(watchdogTickDecision(true, false, recovered.noProgressTicks).action, 'extend', 'streak reset → a lone stall still gets its grace');
});
