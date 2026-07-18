// tests/mixed-pushback-backoff.test.js
// #hardening: a throttled account often fails DIFFERENT ways across its groups (a silent publish-timeout, then a
// composer that won't open, then a missing post-button). The per-type "2 in a row" counters each miss that, so the
// account flails every remaining group. `consecPushback` counts ANY pushback failure and resets on a confirmed/held
// publish; mixedPushbackDecision turns the count into the account-stop decision. This pins the threshold + the
// transient-vs-block branch so it can't silently regress (esp. that it stays ADDITIVE — never fires below 3).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { mixedPushbackDecision } = require('../automation/worker');

test('mixedPushbackDecision: below the threshold → null (keep posting — additive, never fires before same-type 2-in-a-row)', () => {
  assert.equal(mixedPushbackDecision(0, false), null);
  assert.equal(mixedPushbackDecision(1, false), null);
  assert.equal(mixedPushbackDecision(2, false), null, 'at 2 the per-type rule owns same-type; the unified rule must NOT fire yet');
});

test('mixedPushbackDecision: 3 mixed failures + NOT delivered today → block (rate-limit rest, reserve covers)', () => {
  assert.equal(mixedPushbackDecision(3, false), 'block');
  assert.equal(mixedPushbackDecision(5, false), 'block', 'stays block above the threshold');
});

test('mixedPushbackDecision: 3 mixed failures but ALREADY delivered today → transient (stop cycle, no 8h rest)', () => {
  // Mirrors the per-type #7 guard: an account that HAS posted today hitting a rough patch is a slow-IP/layout hiccup,
  // not a block — stop it this cycle but don't rest it for hours (it retries next cycle).
  assert.equal(mixedPushbackDecision(3, true), 'transient');
});

test('mixedPushbackDecision: custom threshold is honored', () => {
  assert.equal(mixedPushbackDecision(2, false, 2), 'block');
  assert.equal(mixedPushbackDecision(1, false, 2), null);
});

test('mixedPushbackDecision: tolerates a non-numeric count (defensive → treated as 0 → null)', () => {
  assert.equal(mixedPushbackDecision(undefined, false), null);
  assert.equal(mixedPushbackDecision(null, true), null);
});

// ── composerOpenAttempts: how many composer-open tries before skipping (v1.0.138: trimmed 4→2) ────────
// Measured over 3 live days: attempt 2 recovered 167 composers; attempts 3 & 4 recovered 3 & 0, while each terminal
// attempt burns a ~9s hard waitForSelector on a starved feed (~18s of dead wait before the skip). So FULL is now 2.
// Read-only pre-publish path (nothing clicked/submitted) → fewer attempts can NEVER double-post.
const { composerOpenAttempts } = require('../automation/worker');
test('composerOpenAttempts: healthy account gets 2 attempts (was 4) — keeps attempt 2, drops the ~0-recovery 3rd/4th', () => {
  assert.equal(composerOpenAttempts(0), 2, 'no pushback → 2 attempts (attempt 1 + the one that does the real recoveries)');
  assert.ok(composerOpenAttempts(0) >= 2, 'never fewer than 2 — attempt 2 does the bulk of composer recoveries');
});
test('composerOpenAttempts: a pushed-back account (pushback>=1) stays at 2 — reaches its backoff fast', () => {
  assert.equal(composerOpenAttempts(1), 2);
  assert.equal(composerOpenAttempts(5), 2);
});
