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

test('clampSettings: campaignMinAgents is clamped to 0..100 (garbage → 0, over-max → 100, floats round)', () => {
  // ADR-0023 P1. This clamp is load-bearing, not hygiene: clampSettings has no key whitelist, so an unknown key
  // persists UNTOUCHED. A string reaching the campaign spread pass makes Keff NaN, and `rank < NaN` is false for
  // every rank → EVERY agent is benched → the campaign silently delivers nothing.
  assert.equal(store.clampSettings({ campaignMinAgents: 'abc' }).campaignMinAgents, 0, 'garbage → 0 (off), never NaN');
  assert.equal(store.clampSettings({ campaignMinAgents: -4 }).campaignMinAgents, 0, 'negative → 0');
  assert.equal(store.clampSettings({ campaignMinAgents: 999 }).campaignMinAgents, 100, 'over-max → 100');
  assert.equal(store.clampSettings({ campaignMinAgents: 3.7 }).campaignMinAgents, 4, 'rounds to a whole agent count');
  assert.equal(store.clampSettings({ campaignMinAgents: 6 }).campaignMinAgents, 6, 'a valid value passes through');
  assert.equal(store.clampSettings({ campaignMinAgents: 0 }).campaignMinAgents, 0, '0 = off is preserved');
  assert.deepEqual(Object.keys(store.clampSettings({ waitInterval: 30 })), ['waitInterval'], 'no campaignMinAgents key emitted when absent');
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

// ── posts-per-day: cyclesPerDay IS the per-account daily post quota ───────────────────────────────────
// campaign-plan/daily-rotation deliver exactly ONE post per account per cycle and _dailyQuotaBlocks stops the
// account at N — so these are the same number by construction. The old ceiling of 20 meant an operator who wanted
// 30 posts/day could not express it at all, and the obvious-looking alternative ("post more per cycle") is a
// re-burst: the pointer records dealtIds[0] and postsToday+1, both hardcoded to one-post-per-cycle.
test('dailyPostQuota: cyclesPerDay is the posts/account/day quota, clamped 1..MAX_POSTS_PER_DAY', () => {
  assert.equal(store.MAX_POSTS_PER_DAY, 50);
  assert.equal(store.dailyPostQuota({ cyclesPerDay: 30 }), 30, '30 posts/day must be expressible — this is the whole point');
  assert.equal(store.dailyPostQuota({ cyclesPerDay: 1 }), 1, 'the classic 1/day model is unchanged');
  assert.equal(store.dailyPostQuota({ cyclesPerDay: 999 }), 50, 'still railed — a typo must not mean 999 posts/day');
  assert.equal(store.dailyPostQuota({ cyclesPerDay: 0 }), 1, 'never zero (would post nothing)');
  assert.equal(store.dailyPostQuota({ cyclesPerDay: 'abc' }), 1, 'garbage → 1, never NaN');
  assert.equal(store.dailyPostQuota({}), 1, 'absent → 1');
  assert.equal(store.dailyPostQuota(undefined), 1, 'no settings at all → 1 (never throws)');
});

test('clampSettings: cyclesPerDay accepts 30 and rails at 50', () => {
  assert.equal(store.clampSettings({ cyclesPerDay: 30 }).cyclesPerDay, 30);
  assert.equal(store.clampSettings({ cyclesPerDay: 999 }).cyclesPerDay, 50);
  assert.equal(store.clampSettings({ cyclesPerDay: -5 }).cyclesPerDay, 1);
});

// postsPerCycle rides straight onto the delivery path (the picker's slice() bound and the daily-count arithmetic), so
// an unclamped NaN/huge value from a hand-edited data.json or the HTTP API must never reach it.
test('postsPerCycle: how many of its slice an agent walks per cycle, clamped 1..MAX', () => {
  assert.equal(store.postsPerCycle({ postsPerCycle: 10 }), 10);
  assert.equal(store.postsPerCycle({ postsPerCycle: 1 }), 1, 'classic one-per-cycle');
  assert.equal(store.postsPerCycle({ postsPerCycle: 999 }), 50, 'railed to the ceiling');
  assert.equal(store.postsPerCycle({ postsPerCycle: 0 }), 1, 'never zero (would deliver nothing)');
  assert.equal(store.postsPerCycle({ postsPerCycle: 'abc' }), 1, 'garbage → 1, never NaN onto the delivery path');
  assert.equal(store.postsPerCycle({}), 1, 'absent → 1 (default is the classic engine)');
});

test('clampSettings: postsPerCycle is clamped like the daily quota', () => {
  assert.equal(store.clampSettings({ postsPerCycle: 10 }).postsPerCycle, 10);
  assert.equal(store.clampSettings({ postsPerCycle: 999 }).postsPerCycle, 50);
  assert.equal(store.clampSettings({ postsPerCycle: 0 }).postsPerCycle, 1);
});

// ── full-batch-daily: the preset derives one daily volume from the batch (no dials) ───────────────────
test('campaignMaxSlice: derives the per-account batch share (the full-batch-daily volume)', () => {
  const mk = (names, groups, posts, setId) => ({
    accounts: names.map((n) => ({ name: n, enabled: true, isModerator: false, standby: false, postingOrder: 'campaign-plan', assignedGroups: groups, postSetId: setId || null })),
    posts: Array.from({ length: posts }, (_, i) => ({ id: 'P' + i, postSetId: setId || null })),
  });
  const slice = (names, groups, posts, setId) => { const f = mk(names, groups, posts, setId); return store.campaignMaxSlice(f.accounts, f.posts); };
  assert.equal(slice(['a', 'b', 'c'], ['g1', 'g2'], 30).maxSlice, 10, '30 posts / 3 accounts sharing a group-set = 10 each');
  assert.equal(slice(['a', 'b', 'c'], ['g1'], 3).maxSlice, 1, '3 posts / 3 accounts = 1 each — the operator\'s "1 post/day" case');
  assert.equal(slice(['a'], ['g1'], 0).maxSlice, 1, 'never below 1 (a zero-post batch floors to 1)');
  const capped = slice(['a', 'b'], ['g1'], 120);
  assert.equal(capped.maxSlice, 50, '60/account clamps to the 50/day hard ceiling');
  assert.ok(capped.capped, 'and flags capped=true so the UI can warn it can\'t finish in one day');
});

test('campaignMaxSlice: the LARGEST batch share drives the fleet value; disabled/non-campaign ignored', () => {
  const acct = (n, groups, extra) => ({ name: n, enabled: true, isModerator: false, standby: false, postingOrder: 'campaign-plan', assignedGroups: groups, ...(extra || {}) });
  const accounts = [
    acct('a', ['g1', 'g2']), acct('a2', ['g1', 'g2']),          // batch A: 2 share g1,g2
    acct('b', ['g3']),                                          // batch B: 1 on g3 (biggest share)
    acct('off', ['g1', 'g2'], { enabled: false }),              // disabled — ignored
    acct('mod', ['g1', 'g2'], { isModerator: true }),           // moderator — ignored
    { name: 'u', enabled: true, postingOrder: 'unique', assignedGroups: ['g4'] }, // not campaign-plan — ignored
  ];
  const posts = Array.from({ length: 12 }, (_, i) => ({ id: 'P' + i }));
  const r = store.campaignMaxSlice(accounts, posts);
  // batch A: 12/2 = 6 ; batch B: 12/1 = 12 → maxSlice = 12
  assert.equal(r.maxSlice, 12, 'the batch with the fewest accounts (biggest per-account share) sets the fleet value');
  assert.equal(r.batches.length, 2, 'only the two campaign batches count; disabled/mod/unique are excluded');
});
