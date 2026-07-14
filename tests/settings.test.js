// tests/settings.test.js
// M2-07: settings clamping must keep every numeric setting in range (no negative sleeps, no Min>Max
// window, no disabled cap from a hand-edited file). M2-02: a concurrent status check must not clear
// a still-active attention flag.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const store = require('../lib/store');

test('clampSettings: clamps out-of-range numerics and coerces garbage to defaults', () => {
  const c = store.clampSettings({
    parallelAccounts: 0, waitInterval: -5, groupDelay: 999999, dailyCap: -3,
    warmupRuns: -1, rateLimitCooldownHours: 9999, maxCycles: 'abc',
  });
  assert.equal(c.parallelAccounts, 1, 'min 1');
  assert.equal(c.waitInterval, 0, 'no negative');
  assert.equal(c.groupDelay, 3600, 'max 3600s');
  assert.equal(c.dailyCap, 0, 'no negative cap');
  assert.equal(c.warmupRuns, 0);
  assert.equal(c.rateLimitCooldownHours, 168, 'max 7 days');
  assert.equal(c.maxCycles, 0, 'garbage → default 0');
});

test('clampSettings: swaps a reversed comment-delay window', () => {
  const c = store.clampSettings({ commentDelayMin: 200, commentDelayMax: 50 });
  assert.equal(c.commentDelayMin, 50);
  assert.equal(c.commentDelayMax, 200);
});

test('clampSettings: only touches keys present in the patch', () => {
  const c = store.clampSettings({ waitInterval: 30 });
  assert.deepEqual(Object.keys(c), ['waitInterval']);
  assert.equal(c.waitInterval, 30);
});

test('clampSettings: tabsPerBrowser is clamped to 1..4 (0/garbage → 1, over-max → 4, floats round)', () => {
  // Out of range would open 0 tabs (nothing posts → missed posts) or many tabs (RAM blowout → crash mid-run).
  assert.equal(store.clampSettings({ tabsPerBrowser: 0 }).tabsPerBrowser, 1, '0 → 1 (never zero tabs)');
  assert.equal(store.clampSettings({ tabsPerBrowser: -3 }).tabsPerBrowser, 1, 'negative → 1');
  assert.equal(store.clampSettings({ tabsPerBrowser: 'abc' }).tabsPerBrowser, 1, 'garbage → 1');
  assert.equal(store.clampSettings({ tabsPerBrowser: 99 }).tabsPerBrowser, 4, 'over-max → 4');
  assert.equal(store.clampSettings({ tabsPerBrowser: 3.7 }).tabsPerBrowser, 4, 'rounds then clamps');
  assert.equal(store.clampSettings({ tabsPerBrowser: 2 }).tabsPerBrowser, 2, 'a valid value passes through');
  // the "only touches keys present" invariant must hold for the new key too
  assert.deepEqual(Object.keys(store.clampSettings({ waitInterval: 30 })), ['waitInterval'], 'no tabsPerBrowser key emitted when absent');
});

test('clampSettings: skipInlineVerify coerces to a strict boolean (default-on v1.0.46)', () => {
  // The worker gates the verify-later skip on `settings.skipInlineVerify === true` (strict).
  assert.equal(store.clampSettings({ skipInlineVerify: 1 }).skipInlineVerify, true, 'truthy → true');
  assert.equal(store.clampSettings({ skipInlineVerify: 0 }).skipInlineVerify, false, 'falsy → false');
  assert.equal(store.DEFAULT_SETTINGS.skipInlineVerify, true, 'defaults ON (inline reload redundant with Phase-2 feed-scan)');
  assert.deepEqual(Object.keys(store.clampSettings({ waitInterval: 30 })), ['waitInterval'], 'no skipInlineVerify key emitted when absent');
});

test('normalize: migrates a STALE skipInlineVerify=false (old opt-in default) to true, once, respecting a later deliberate toggle', () => {
  // A persisted `false` is ALWAYS the old stale default (false WAS the default; opting IN meant true) → flip it on.
  assert.equal(store.normalize({ settings: { skipInlineVerify: false } }).settings.skipInlineVerify, true, 'stale false → true');
  // Absent → the new default (true).
  assert.equal(store.normalize({ settings: {} }).settings.skipInlineVerify, true, 'absent → default true');
  // Marked (already migrated) → a DELIBERATE false is preserved (not re-flipped).
  assert.equal(store.normalize({ settings: { skipInlineVerify: false, sivMigrated: true } }).settings.skipInlineVerify, false, 'marked false → stays false');
  // The migration stamps the marker so it is idempotent across loads.
  assert.equal(store.normalize({ settings: { skipInlineVerify: false } }).settings.sivMigrated, true, 'marker stamped');
});

test('clampSettings: fastPublish coerces to a strict boolean (opt-in fast post-publish settle)', () => {
  // The worker gates the reduced held-toast settle on `settings.fastPublish === true` (strict).
  assert.equal(store.clampSettings({ fastPublish: 1 }).fastPublish, true, 'truthy → true');
  assert.equal(store.clampSettings({ fastPublish: 0 }).fastPublish, false, 'falsy → false');
  assert.equal(store.DEFAULT_SETTINGS.fastPublish, false, 'defaults OFF (byte-identical unless enabled)');
});

test('preserveAttentionStatus: keeps an ACTIVE rate-limit flag against a status check', () => {
  const future = Date.now() + 3600000;
  assert.equal(store.preserveAttentionStatus('rate_limited', future, 'logged_in'), true);
  assert.equal(store.preserveAttentionStatus('rate_limited', future, 'checking'), true);
});

test('preserveAttentionStatus: allows clearing once the rate-limit has EXPIRED', () => {
  const past = Date.now() - 1000;
  assert.equal(store.preserveAttentionStatus('rate_limited', past, 'logged_in'), false);
});

test('preserveAttentionStatus: protects checkpoint/verification/disabled from a clearing write', () => {
  assert.equal(store.preserveAttentionStatus('checkpoint', 0, 'logged_in'), true);
  assert.equal(store.preserveAttentionStatus('needs_verification', 0, 'logged_in'), true);
  assert.equal(store.preserveAttentionStatus('account_disabled', 0, 'error'), true);
});

test('preserveAttentionStatus: lets a higher/equal attention status overwrite, and never blocks normal transitions', () => {
  // rate_limited → checkpoint (an escalation, not a clearing status) is allowed through
  assert.equal(store.preserveAttentionStatus('rate_limited', Date.now() + 1000, 'checkpoint'), false);
  // normal logged-in/out transitions are never blocked
  assert.equal(store.preserveAttentionStatus('logged_in', 0, 'rate_limited'), false);
  assert.equal(store.preserveAttentionStatus('not_logged_in', 0, 'logged_in'), false);
});
