// tests/humanize.test.js
// HT-1: the humanization primitives (rand/rangeMs/humanDelay) and the new timing settings
// (clamp + min/max swap + legacy-key migration). The point is unpredictable-but-safe cadence:
// every value is random within a range, never below the floor.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const w = require('../automation/worker');
const store = require('../lib/store');

test('rand: integer within [min,max], order-tolerant, never negative', () => {
  for (let i = 0; i < 1000; i++) { const v = w.rand(100, 200); assert.ok(Number.isInteger(v) && v >= 100 && v <= 200); }
  for (let i = 0; i < 100; i++) { const v = w.rand(200, 100); assert.ok(v >= 100 && v <= 200); } // swapped args
  assert.equal(w.rand(50, 50), 50);
  assert.ok(w.rand(-10, -5) >= 0); // clamped non-negative
});

test('rangeMs: draws within the settings range (sec→ms) and respects the floor', () => {
  const s = { groupDelayMin: 120, groupDelayMax: 300 };
  for (let i = 0; i < 1000; i++) {
    const ms = w.rangeMs(s, 'groupDelayMin', 'groupDelayMax', 120, 300, 0);
    assert.ok(ms >= 120000 && ms <= 300000, `out of range: ${ms}`);
  }
  // An EXPLICIT operator setting now APPLIES (down to a 1s floor) — they can deliberately post fast.
  for (let i = 0; i < 200; i++) {
    assert.equal(w.rangeMs({ groupDelayMin: 5, groupDelayMax: 5 }, 'groupDelayMin', 'groupDelayMax', 120, 300, 120), 5000, 'explicit fast value applies, not floored to the safety default');
  }
  // The safety floor still guards UNSET values (a fresh install can't accidentally burst-post).
  for (let i = 0; i < 50; i++) {
    assert.ok(w.rangeMs({}, 'groupDelayMin', 'groupDelayMax', 120, 300, 120) >= 120000, 'unset → safety floor applies');
  }
  // A 1s absolute floor still prevents a zero/instant gap even on an explicit 0.
  assert.ok(w.rangeMs({ groupDelayMin: 0, groupDelayMax: 0 }, 'groupDelayMin', 'groupDelayMax', 120, 300, 120) >= 1000);
});

test('humanDelay: master=false → exact base; else within ±variance, never negative', () => {
  assert.equal(w.humanDelay(1000, { humanizeMaster: false }, 'settle'), 1000);
  for (let i = 0; i < 500; i++) {
    const v = w.humanDelay(1000, { timingVariance: { settle: 0.3 } }, 'settle');
    assert.ok(v >= 700 && v <= 1300, `out of band: ${v}`);
  }
});

test('clampSettings: clamps + swaps the new humanization ranges', () => {
  const c = store.clampSettings({
    groupDelayMin: 9999, groupDelayMax: -5,            // out of range + reversed
    prePublishDwellSecMin: 50, prePublishDwellSecMax: 2, // reversed
    composerOpenInitialDelayMs: 100,                    // below floor
    humanizeMaster: 0,
    timingVariance: { settle: 5, pause: -1 },
  });
  assert.ok(c.groupDelayMin <= c.groupDelayMax && c.groupDelayMax <= 3600);
  assert.ok(c.prePublishDwellSecMin <= c.prePublishDwellSecMax);
  assert.equal(c.composerOpenInitialDelayMs, 800);  // clamped up to its floor
  assert.equal(c.humanizeMaster, false);            // coerced to bool
  assert.ok(c.timingVariance.settle <= 0.6 && c.timingVariance.pause >= 0);
});

test('migration: a legacy single timing key derives the min/max range on load', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-mig-'));
  store.init(tmp);
  store.save({ posts: [], groups: [], accounts: [], settings: { groupDelay: 200 }, proxies: [], useProxies: false });
  const s = store.load().settings;
  assert.equal(s.groupDelayMin, 160, 'floor(0.8*200)');
  assert.equal(s.groupDelayMax, 240, 'ceil(1.2*200)');
  assert.equal(s.groupDelay, 200, 'legacy key kept for back-compat');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('clampSettings: speedMode migrates legacy tokens to the canonical tier (safe/fast/max)', () => {
  assert.equal(store.clampSettings({ speedMode: 'slow' }).speedMode, 'safe', 'legacy slow → safe');
  assert.equal(store.clampSettings({ speedMode: 'normal' }).speedMode, 'safe', 'legacy normal → safe');
  assert.equal(store.clampSettings({ speedMode: 'fast' }).speedMode, 'fast');
  assert.equal(store.clampSettings({ speedMode: 'turbo' }).speedMode, 'max', 'legacy turbo → max');
  assert.equal(store.clampSettings({ speedMode: 'instant' }).speedMode, 'max', 'legacy instant → max');
  assert.equal(store.clampSettings({ speedMode: 'safe' }).speedMode, 'safe'); // canonical passthrough
  assert.equal(store.clampSettings({ speedMode: 'max' }).speedMode, 'max');
  assert.equal(store.clampSettings({ speedMode: 'bogus' }).speedMode, 'safe', 'invalid → safe');
});

test('isFastMode: turbo + fast + humanize-off take the instant path; normal/slow do not', () => {
  assert.equal(w.isFastMode({ speedMode: 'turbo' }), true, 'turbo → instant typing + skipped dwells');
  assert.equal(w.isFastMode({ speedMode: 'fast' }), true);
  assert.equal(w.isFastMode({ humanizeMaster: false }), true);
  assert.equal(w.isFastMode({ speedMode: 'normal' }), false);
  assert.equal(w.isFastMode({ speedMode: 'slow' }), false);
  assert.equal(w.isFastMode({}), false, 'default is not fast');
});

test('normalizeAccount: pace migrates to a canonical override tier + postSetId SURVIVES a load', () => {
  const n = store.normalize({ accounts: [
    { name: 'a', pace: 'instant', postSetId: 'setA', assignedGroups: ['g1', 'g2'] },
    { name: 'b', pace: 'turbo' },
    { name: 'c', pace: 'bogus', postSetId: '', assignedGroups: 'corrupt' },
  ] });
  assert.equal(n.accounts[0].pace, 'max', 'legacy instant pace → max (migrated, not wiped)');
  assert.equal(n.accounts[0].postSetId, 'setA', 'account postSetId is preserved');
  assert.deepEqual(n.accounts[0].assignedGroups, ['g1', 'g2'], 'assignedGroups preserved');
  assert.equal(n.accounts[1].pace, 'max', 'legacy turbo pace → max');
  assert.equal(n.accounts[2].pace, undefined, 'a genuinely invalid pace still drops to inherit');
  assert.equal(n.accounts[2].postSetId, null, 'a blank postSetId coerces to null (never an empty-set filter)');
  assert.deepEqual(n.accounts[2].assignedGroups, [], 'a corrupt non-array assignedGroups coerces to []');
});

test('clampSettings: sanitizes postSets (drops malformed entries, coerces id/name to strings, non-array→[])', () => {
  const out = store.clampSettings({ postSets: [{ id: 1, name: 'A' }, { id: 'x' }, null, { name: 'no-id' }, 'garbage'] });
  assert.deepEqual(out.postSets, [{ id: '1', name: 'A' }], 'only the complete entry survives, id stringified');
  assert.deepEqual(store.clampSettings({ postSets: 'nope' }).postSets, [], 'non-array → []');
});

test('MAX tier: clamps to max; the worker-internal token pastes/collapses/floors; a per-account override wins', () => {
  // clampSettings migrates the legacy instant preset to the canonical max tier (a saved config survives a reload)
  assert.equal(store.clampSettings({ speedMode: 'instant' }).speedMode, 'max', 'legacy instant → max');
  assert.equal(store.clampSettings({ speedMode: 'max' }).speedMode, 'max');
  // max maps to the worker's INTERNAL token 'instant' — the behavior helpers + Sacred floors read THAT and are unchanged
  assert.equal(w.isFastMode({ speedMode: 'instant' }), true, 'internal max token pastes all text + skips dwells');
  const f = w.antiSpamFloors({ speedMode: 'instant' });
  assert.equal(f.group, 1500, 'internal max group floor (helper value)');
  assert.equal(f.comment, 4000, 'internal max comment floor (helper value; the call sites intentionally bypass it for max)');
  // a per-account override ALWAYS wins now (no more asymmetric "global slow protection") — override selects the tier
  assert.equal(w.applyPace({ speedMode: 'safe' }, 'max').speedMode, 'instant', 'pace=max → internal instant token, over a safe fleet');
  assert.equal(w.applyPace({ speedMode: 'safe' }, 'instant').speedMode, 'instant', 'legacy pace=instant migrates to max → internal instant');
});

test('two-phase post→link floor: safe/fast keep the 30s floor; postLinkFloorOwed waits only the shortfall', () => {
  const now = 1_000_000;
  // TIER CONTRACT: safe (internal 'normal') and fast (internal 'fast') keep the FULL 30s comment floor; max does not.
  assert.equal(w.antiSpamFloors({ speedMode: 'normal' }).comment, 30000, 'safe keeps the 30s comment floor');
  assert.equal(w.antiSpamFloors({ speedMode: 'fast' }).comment, 30000, 'fast keeps the full 30s comment floor (paste, but NOT reduced gaps)');
  // A FRESH deferred post (published 5s ago) owes the remainder to reach the tier floor.
  assert.equal(w.postLinkFloorOwed({ speedMode: 'normal' }, now - 5000, now), 25000, 'safe fresh post owes 25s');
  assert.equal(w.postLinkFloorOwed({ speedMode: 'fast' }, now - 10000, now), 20000, 'fast fresh post owes 20s');
  // A WELL-AGED post (published 60s ago in Phase 1 — the common multi-group case) owes 0: the fix never over-waits.
  assert.equal(w.postLinkFloorOwed({ speedMode: 'normal' }, now - 60000, now), 0, 'aged post owes nothing');
  // MAX (internal 'instant') owes 0 — its small gaps are by design and natural aging clears its ~1s minimum.
  assert.equal(w.postLinkFloorOwed({ speedMode: 'instant' }, now - 500, now), 0, 'max owes 0 (small gaps by design)');
  // Missing/invalid inputs → 0 (no data must never block the comment).
  assert.equal(w.postLinkFloorOwed({ speedMode: 'normal' }, undefined, now), 0, 'no publishedAt → owes 0');
  assert.equal(w.postLinkFloorOwed(null, now - 5000, now), 0, 'no settings → owes 0');
});

test('rangeMs: a TURBO-style small explicit range actually applies to the real gap (numbers take effect)', () => {
  // The turbo preset sets groupDelayMin:20, groupDelayMax:45 — the loop must draw within that exact window
  // (sec→ms), not fall back to the 120s safety default. This is the "speed numbers apply to the work" guarantee.
  for (let i = 0; i < 500; i++) {
    const ms = w.rangeMs({ groupDelayMin: 20, groupDelayMax: 45 }, 'groupDelayMin', 'groupDelayMax', 120, 300, 120);
    assert.ok(ms >= 20000 && ms <= 45000, `turbo group gap out of range: ${ms}`);
  }
  // And the randomized cadence is genuinely spread across the window (not a fixed value).
  const draws = new Set();
  for (let i = 0; i < 200; i++) draws.add(w.rangeMs({ commentDelayMin: 8, commentDelayMax: 20 }, 'commentDelayMin', 'commentDelayMax', 60, 180, 1));
  assert.ok(draws.size > 5, 'comment-delay draws are randomized across the range, not constant');
});

test('clampSettings: scheduleMode + dailyPostTime are validated (daily-schedule feature)', () => {
  assert.equal(store.clampSettings({ scheduleMode: 'daily' }).scheduleMode, 'daily');
  assert.equal(store.clampSettings({ scheduleMode: 'continuous' }).scheduleMode, 'continuous');
  assert.equal(store.clampSettings({ scheduleMode: 'bogus' }).scheduleMode, 'continuous', 'invalid → continuous');
  assert.equal(store.clampSettings({ dailyPostTime: '07:30' }).dailyPostTime, '07:30');
  assert.equal(store.clampSettings({ dailyPostTime: '23:59' }).dailyPostTime, '23:59');
  assert.equal(store.clampSettings({ dailyPostTime: '9:05' }).dailyPostTime, '9:05', 'single-digit hour ok');
  assert.equal(store.clampSettings({ dailyPostTime: '25:99' }).dailyPostTime, '09:00', 'out-of-range → default');
  assert.equal(store.clampSettings({ dailyPostTime: 'garbage' }).dailyPostTime, '09:00', 'invalid → default');
});

test('clampSettings: held-repost rescue settings (repostEnabled bool, repostGraceSec clamp)', () => {
  assert.equal(store.clampSettings({ repostEnabled: 1 }).repostEnabled, true);
  assert.equal(store.clampSettings({ repostEnabled: 0 }).repostEnabled, false);
  assert.equal(store.clampSettings({ repostGraceSec: 300 }).repostGraceSec, 300);
  assert.equal(store.clampSettings({ repostGraceSec: -5 }).repostGraceSec, 0, 'floored at 0');
  assert.equal(store.clampSettings({ repostGraceSec: 999999 }).repostGraceSec, 86400, 'capped at 1 day');
});

test('moderation: state round-trips, fail-closed defaults, fbDisplayName trimmed (MOD-1)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-mod-'));
  store.init(tmp);
  assert.deepEqual(store.loadModeration(), { held: [] }, 'missing file → empty held list');
  store.saveModeration({ held: [{ postId: 'p1', gid: 'g1', status: 'held' }] });
  assert.equal(store.loadModeration().held.length, 1);
  store.saveModeration({ junk: true }); // invalid shape → coerced safe
  assert.deepEqual(store.loadModeration(), { held: [] }, 'invalid shape → empty held list');
  store.save({ posts: [], groups: [], proxies: [], useProxies: false, settings: {}, accounts: [{ name: 'm', isModerator: 1, fbDisplayName: '  Abdo Abdo  ' }, { name: 'p' }] });
  const accts = store.load().accounts;
  const m = accts.find((a) => a.name === 'm');
  assert.equal(m.isModerator, true, 'truthy → moderator');
  assert.equal(m.fbDisplayName, 'Abdo Abdo', 'display name trimmed');
  const p = accts.find((a) => a.name === 'p');
  assert.ok(!p.isModerator, 'absent → not moderator (fail-closed)');
  assert.equal(store.clampSettings({ moderationEnabled: 1 }).moderationEnabled, true);
  assert.equal(store.clampSettings({ moderationEnabled: 0 }).moderationEnabled, false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('reserve + comment-rescue store: reserveAccounts clamps; pending-comments round-trips fail-closed', () => {
  // reserveAccounts is a non-negative integer (rounded, clamped 0–100).
  assert.equal(store.clampSettings({ reserveAccounts: 3 }).reserveAccounts, 3);
  assert.equal(store.clampSettings({ reserveAccounts: 2.7 }).reserveAccounts, 3, 'rounded');
  assert.equal(store.clampSettings({ reserveAccounts: -5 }).reserveAccounts, 0, 'floored at 0');
  assert.equal(store.clampSettings({ reserveAccounts: 999 }).reserveAccounts, 100, 'capped');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-cq-'));
  store.init(tmp);
  assert.deepEqual(store.loadComments(), { pending: [] }, 'missing file → empty pending list');
  store.saveComments({ pending: [{ gid: 'g1', captionSnip: 'abc', comment: 'link', status: 'pending' }] });
  assert.equal(store.loadComments().pending.length, 1);
  store.saveComments({ junk: true }); // invalid shape → coerced safe
  assert.deepEqual(store.loadComments(), { pending: [] }, 'invalid shape → empty pending list');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('applyPace: delegates to the canonical resolver — override SELECTS a tier (no compounding), cadence stays fleet-level', () => {
  // (Full model coverage is in tests/speed-model.test.js; this asserts the worker's applyPace export wires to it.)
  // Inherit (no per-account override) → the FLEET tier: safe fleet → internal 'normal' token + safe ranges.
  const inherit = w.applyPace({ speedMode: 'safe' }, undefined);
  assert.equal(inherit.speedMode, 'normal', 'safe fleet → internal normal token');
  assert.equal(inherit.groupDelayMax, 300, 'safe per-post ranges');
  assert.equal(inherit.humanizeMaster, true, 'safe forces full human behavior on');
  // Per-account MAX override under a SAFE fleet → internal 'instant' token + max per-post ranges, but cycle cadence stays safe.
  const over = w.applyPace({ speedMode: 'safe' }, 'max');
  assert.equal(over.speedMode, 'instant', 'override selects max → internal instant token');
  assert.equal(over.groupDelayMax, 7, 'per-post cadence = the override tier (max)');
  assert.equal(over.waitIntervalMax, 180, 'cycle cadence stays the fleet baseline (safe), never the per-account override');
  // NO compounding: a fast override under a fast fleet yields fast ranges — NOT fast halved again like the old multiplier.
  assert.equal(w.applyPace({ speedMode: 'fast' }, 'fast').groupDelayMax, 180, 'override selects the tier; it does NOT multiply');
  // Pure: the input object is never mutated.
  const src = { speedMode: 'safe', groupDelayMax: 999 };
  w.applyPace(src, 'max');
  assert.equal(src.groupDelayMax, 999, 'applyPace never mutates its input');
});

test('store: per-account pace is validated + migrated on load (safe/fast/max; invalid → inherit)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-pace-'));
  store.init(tmp);
  store.save({ posts: [], groups: [], proxies: [], useProxies: false, settings: {}, accounts: [
    { name: 'safe1', pace: 'safe' }, { name: 'fast1', pace: 'fast' }, { name: 'max1', pace: 'instant' }, { name: 'bad', pace: 'ludicrous' }, { name: 'none' },
  ] });
  const accts = store.load().accounts;
  assert.equal(accts.find((a) => a.name === 'safe1').pace, 'safe');
  assert.equal(accts.find((a) => a.name === 'fast1').pace, 'fast');
  assert.equal(accts.find((a) => a.name === 'max1').pace, 'max', 'legacy instant pace → max');
  assert.equal(accts.find((a) => a.name === 'bad').pace, undefined, 'invalid pace dropped → inherit the fleet speed');
  assert.equal(accts.find((a) => a.name === 'none').pace, undefined, 'absent stays absent (inherit)');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('normalizeAccount: corrupt daily / rateLimitedUntil are sanitized on load (DI-3/DI-4)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-acc-'));
  store.init(tmp);
  const absurdFuture = Date.now() + 10 * 365 * 24 * 3600 * 1000; // 10 years out
  store.save({
    posts: [], groups: [], proxies: [], useProxies: false, settings: {},
    accounts: [
      { name: 'a1', daily: { date: 'garbage', count: -5 }, rateLimitedUntil: absurdFuture },
      { name: 'a2', daily: { date: '2026-06-21', count: 3 }, rateLimitedUntil: Date.now() + 3600 * 1000 },
    ],
  });
  const accts = store.load().accounts;
  const a1 = accts.find((a) => a.name === 'a1');
  assert.equal(a1.daily.count, 0, 'negative count floored to 0 (cap not skewed)');
  assert.equal(a1.daily.date, '', 'garbage date reset (cap not frozen)');
  assert.equal(a1.rateLimitedUntil, 0, 'absurd far-future cooldown reset (account not blocked forever)');
  const a2 = accts.find((a) => a.name === 'a2');
  assert.equal(a2.daily.count, 3, 'valid count preserved');
  assert.equal(a2.daily.date, '2026-06-21', 'valid date preserved');
  assert.ok(a2.rateLimitedUntil > Date.now(), 'valid near-future cooldown preserved');
  fs.rmSync(tmp, { recursive: true, force: true });
});
