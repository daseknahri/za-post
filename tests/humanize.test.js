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

test('clampSettings: speedMode is coerced to a valid preset name', () => {
  assert.equal(store.clampSettings({ speedMode: 'slow' }).speedMode, 'slow');
  assert.equal(store.clampSettings({ speedMode: 'fast' }).speedMode, 'fast');
  assert.equal(store.clampSettings({ speedMode: 'bogus' }).speedMode, 'normal', 'invalid → normal');
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
