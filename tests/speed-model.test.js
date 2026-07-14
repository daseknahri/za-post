// tests/speed-model.test.js
// Locks the canonical 3-tier speed model (lib/speed.js): the legacy→tier migration, the user-tier→worker-internal
// token mapping, and — critically — that a per-account override SELECTS a tier (NO compounding/multiplier) while
// cycle/stagger cadence always follows the FLEET baseline. These invariants are what make Settings / Quick Setup /
// Accounts-card "go hand in hand" and what keeps the Sacred anti-spam floors (keyed on the internal token) intact.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const S = require('../lib/speed');

test('normalizeSpeedMode migrates every legacy fleet token to a canonical tier', () => {
  assert.equal(S.normalizeSpeedMode('normal'), 'safe');
  assert.equal(S.normalizeSpeedMode('slow'), 'safe');
  assert.equal(S.normalizeSpeedMode('fast'), 'fast');
  assert.equal(S.normalizeSpeedMode('turbo'), 'max');
  assert.equal(S.normalizeSpeedMode('instant'), 'max');
  assert.equal(S.normalizeSpeedMode('safe'), 'safe'); // canonical passthrough
  assert.equal(S.normalizeSpeedMode('max'), 'max');
  assert.equal(S.normalizeSpeedMode('garbage'), 'safe'); // unknown → safe default
  assert.equal(S.normalizeSpeedMode(undefined), 'safe');
});

test('normalizePace maps legacy pace to an override tier or INHERIT(null)', () => {
  // inherit-the-fleet cases → null
  for (const v of ['', null, undefined, 'inherit', 'normal', 'garbage']) assert.equal(S.normalizePace(v), null, `${v} → inherit`);
  // explicit overrides
  assert.equal(S.normalizePace('safe'), 'safe');
  assert.equal(S.normalizePace('slow'), 'safe');
  assert.equal(S.normalizePace('fast'), 'fast');
  assert.equal(S.normalizePace('turbo'), 'max');
  assert.equal(S.normalizePace('instant'), 'max');
});

test('each user tier maps to its worker-internal token (Sacred floors read THIS)', () => {
  assert.equal(S.TIER_INTERNAL.safe, 'normal');
  assert.equal(S.TIER_INTERNAL.fast, 'fast');
  assert.equal(S.TIER_INTERNAL.max, 'instant');
});

test('fleet baseline (no override): tier ranges + internal token expand correctly', () => {
  const safe = S.resolveEffectiveSettings({ speedMode: 'safe' }, null);
  assert.equal(safe.speedMode, 'normal'); // internal token
  assert.equal(safe.groupDelayMax, 300);  // safe = old normal
  assert.equal(safe.composerOpenInitialDelayMs, 1500);
  assert.equal(safe.humanizeMaster, true); // safe forces full human

  const max = S.resolveEffectiveSettings({ speedMode: 'max' }, null);
  assert.equal(max.speedMode, 'instant');
  assert.equal(max.groupDelayMax, 7);     // max = old instant
  assert.equal(max.composerOpenInitialDelayMs, 800);
});

test('legacy fleet token resolves identically to its migrated tier (behavior-preserving migration)', () => {
  const legacy = S.resolveEffectiveSettings({ speedMode: 'instant' }, null); // old value still on disk
  const migrated = S.resolveEffectiveSettings({ speedMode: 'max' }, null);
  assert.deepEqual(legacy, migrated); // an un-migrated data.json behaves exactly like the migrated one
});

test('per-account override SELECTS the tier — NO compounding/multiplier', () => {
  // fleet=fast + override=fast must yield fast's ranges (NOT fast halved again like the old _PACE_MULT would).
  const eff = S.resolveEffectiveSettings({ speedMode: 'fast' }, 'fast');
  assert.equal(eff.groupDelayMax, 180); // exactly fast's value, not 90 (0.5×) or any product
  assert.equal(eff.commentDelayMax, 90);
  assert.equal(eff.speedMode, 'fast');
});

test('override changes per-post cadence but NOT cycle cadence (fleet-level stays)', () => {
  // fleet=max, account overridden to safe: per-post = safe, but waitInterval/accountDelay stay at the fleet(max) baseline.
  const eff = S.resolveEffectiveSettings({ speedMode: 'max' }, 'safe');
  assert.equal(eff.speedMode, 'normal');          // safe internal token
  assert.equal(eff.groupDelayMax, 300);           // per-post = safe
  assert.equal(eff.commentDelayMax, 180);         // per-post = safe
  assert.equal(eff.waitIntervalMax, 3);           // CYCLE cadence = fleet(max), NOT safe's 180
  assert.equal(eff.accountDelayMax, 0);           // CYCLE cadence = fleet(max), NOT safe's 4
  assert.equal(eff.humanizeMaster, true);         // effective tier is safe → full human
});

test('override can also speed a single account above a safe fleet', () => {
  const eff = S.resolveEffectiveSettings({ speedMode: 'safe' }, 'max');
  assert.equal(eff.speedMode, 'instant');         // max internal token
  assert.equal(eff.groupDelayMax, 7);             // per-post = max
  assert.equal(eff.waitIntervalMax, 180);         // CYCLE cadence = fleet(safe)
  assert.equal(eff.accountDelayMax, 4);
});

test('resolver does not mutate the input settings object', () => {
  const input = { speedMode: 'safe', groupDelayMax: 999, humanizeMaster: false };
  const eff = S.resolveEffectiveSettings(input, 'max');
  assert.equal(input.groupDelayMax, 999);   // untouched
  assert.equal(input.speedMode, 'safe');    // untouched
  assert.notEqual(eff.groupDelayMax, 999);  // resolved copy changed
});
