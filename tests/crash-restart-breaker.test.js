// tests/crash-restart-breaker.test.js
// #1 (stall breaker): a throw in the cycle body used to kill the WHOLE run until a human relaunched. Now the loop
// auto-restarts IN-PROCESS (re-entering _loop reloads durable state from disk = a relaunch, minus the human). This pins
// crashRestartDecision — the breaker that (a) allows up to N rapid restarts with a growing backoff, then STOPS a
// deterministic crash-loop from hammering the shared IP, and (b) resets the streak after a long healthy run so isolated
// transient faults days apart never accumulate to the breaker.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { crashRestartDecision } = require('../automation/orchestrator');

test('crashRestartDecision: first rapid crash → restart with the base 30s backoff', () => {
  const d = crashRestartDecision(0, 1000);
  assert.deepEqual(d, { restart: true, restarts: 1, backoffMs: 30000 });
});

test('crashRestartDecision: backoff GROWS with each rapid restart', () => {
  assert.equal(crashRestartDecision(1, 1000).backoffMs, 60000);
  assert.equal(crashRestartDecision(2, 1000).backoffMs, 90000);
});

test('crashRestartDecision: the breaker trips after maxRestarts rapid crashes (no infinite crash-loop on the shared IP)', () => {
  const d = crashRestartDecision(3, 1000);
  assert.equal(d.restart, false, 'no 4th rapid restart — stop; the next launch resumes from disk');
});

test('crashRestartDecision: a crash after a long HEALTHY run RESETS the streak (transient fault, not a crash-loop)', () => {
  const d = crashRestartDecision(3, 20 * 60 * 1000); // ran 20 min, then hit a transient fault
  assert.equal(d.restart, true, 'healthy run → streak reset → restart, not breaker');
  assert.equal(d.restarts, 1, 'streak restarts at 1, not accumulated');
});

test('crashRestartDecision: backoff is CAPPED (never an unbounded sleep)', () => {
  assert.equal(crashRestartDecision(20, 1000, { maxRestarts: 99 }).backoffMs, 300000, 'capped at 5min');
});

test('crashRestartDecision: tolerates non-numeric inputs (defensive)', () => {
  const d = crashRestartDecision(undefined, undefined);
  assert.equal(d.restart, true);
  assert.equal(d.restarts, 1, 'undefined restarts → 0 → restart 1');
});
