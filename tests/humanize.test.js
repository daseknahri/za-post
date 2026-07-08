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

test('clampSettings: speedMode is coerced to a valid preset name (incl. turbo)', () => {
  assert.equal(store.clampSettings({ speedMode: 'slow' }).speedMode, 'slow');
  assert.equal(store.clampSettings({ speedMode: 'fast' }).speedMode, 'fast');
  assert.equal(store.clampSettings({ speedMode: 'turbo' }).speedMode, 'turbo', 'turbo (super-experienced-user preset) is valid');
  assert.equal(store.clampSettings({ speedMode: 'bogus' }).speedMode, 'normal', 'invalid → normal');
});

test('isFastMode: turbo + fast + humanize-off take the instant path; normal/slow do not', () => {
  assert.equal(w.isFastMode({ speedMode: 'turbo' }), true, 'turbo → instant typing + skipped dwells');
  assert.equal(w.isFastMode({ speedMode: 'fast' }), true);
  assert.equal(w.isFastMode({ humanizeMaster: false }), true);
  assert.equal(w.isFastMode({ speedMode: 'normal' }), false);
  assert.equal(w.isFastMode({ speedMode: 'slow' }), false);
  assert.equal(w.isFastMode({}), false, 'default is not fast');
});

test('normalizeAccount: pace=instant + postSetId SURVIVE a load (were being silently wiped before)', () => {
  const n = store.normalize({ accounts: [
    { name: 'a', pace: 'instant', postSetId: 'setA', assignedGroups: ['g1', 'g2'] },
    { name: 'b', pace: 'turbo' },
    { name: 'c', pace: 'bogus', postSetId: '', assignedGroups: 'corrupt' },
  ] });
  assert.equal(n.accounts[0].pace, 'instant', 'instant pace is preserved (not reset to inherit)');
  assert.equal(n.accounts[0].postSetId, 'setA', 'account postSetId is preserved');
  assert.deepEqual(n.accounts[0].assignedGroups, ['g1', 'g2'], 'assignedGroups preserved');
  assert.equal(n.accounts[1].pace, 'turbo');
  assert.equal(n.accounts[2].pace, undefined, 'a genuinely invalid pace still drops to inherit');
  assert.equal(n.accounts[2].postSetId, null, 'a blank postSetId coerces to null (never an empty-set filter)');
  assert.deepEqual(n.accounts[2].assignedGroups, [], 'a corrupt non-array assignedGroups coerces to []');
});

test('clampSettings: sanitizes postSets (drops malformed entries, coerces id/name to strings, non-array→[])', () => {
  const out = store.clampSettings({ postSets: [{ id: 1, name: 'A' }, { id: 'x' }, null, { name: 'no-id' }, 'garbage'] });
  assert.deepEqual(out.postSets, [{ id: '1', name: 'A' }], 'only the complete entry survives, id stringified');
  assert.deepEqual(store.clampSettings({ postSets: 'nope' }).postSets, [], 'non-array → []');
});

test('INSTANT mode: valid preset; fast+turbo paths on; tiny-but-nonzero anti-spam floors; pace overrides speedMode', () => {
  // clampSettings accepts it (so a saved instant config survives a reload)
  assert.equal(store.clampSettings({ speedMode: 'instant' }).speedMode, 'instant', 'instant is a valid preset');
  // paste-everything + skip-dwells path
  assert.equal(w.isFastMode({ speedMode: 'instant' }), true, 'instant pastes all text + skips dwells');
  // collapses the post-publish settle (the single isTurboMode gate)
  assert.equal(w.isTurboMode({ speedMode: 'instant' }), true, 'instant collapses the post-publish settle');
  // floors are aggressively small but NEVER zero (a truly-instant post→link is FB's top ban trigger)
  const f = w.antiSpamFloors({ speedMode: 'instant' });
  assert.equal(f.group, 1500, 'instant group floor');
  assert.equal(f.comment, 4000, 'instant comment floor — never a truly-instant post→link');
  assert.ok(f.comment >= 4000, 'comment floor stays >= 4s for instant (de-risk note)');
  // per-account pace 'instant' overrides speedMode (unless a deliberate global slow)
  assert.equal(w.applyPace({ speedMode: 'normal' }, 'instant').speedMode, 'instant', 'pace=instant sets speedMode=instant');
  assert.equal(w.applyPace({ speedMode: 'slow' }, 'instant').speedMode, 'slow', 'a deliberate global slow is respected');
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

test('applyPace: normal/absent/invalid inherit the global tempo unchanged (no per-account effect)', () => {
  const s = { groupDelayMin: 120, groupDelayMax: 300, commentDelayMin: 60, commentDelayMax: 180, humanizeMaster: true, speedMode: 'normal' };
  assert.strictEqual(w.applyPace(s, 'normal'), s, 'explicit normal → SAME object (so callers/tests without a pace are unaffected)');
  assert.strictEqual(w.applyPace(s), s, 'absent pace + no defaultPace → unchanged');
  assert.strictEqual(w.applyPace(s, 'bogus'), s, 'invalid pace → treated as normal');
});

test('applyPace: SAFE doubles every per-post window + forces human behavior on', () => {
  const s = { groupDelayMin: 120, groupDelayMax: 300, commentDelayMin: 60, commentDelayMax: 180, pageScrollDwellSecMin: 3, pageScrollDwellSecMax: 15, speedMode: 'fast', humanizeMaster: false, waitIntervalMin: 90, waitIntervalMax: 180, accountDelayMin: 1, accountDelayMax: 4 };
  const o = w.applyPace(s, 'safe');
  assert.equal(o.groupDelayMin, 240); assert.equal(o.groupDelayMax, 600);
  assert.equal(o.commentDelayMin, 120); assert.equal(o.commentDelayMax, 360);
  assert.equal(o.pageScrollDwellSecMin, 6); assert.equal(o.pageScrollDwellSecMax, 30);
  assert.equal(o.humanizeMaster, true, 'safe forces humanization ON even if the global preset had it off');
  assert.equal(o.speedMode, 'normal', 'safe pulls a fast/turbo global back to normal so the human dwells actually run');
  assert.equal(o.waitIntervalMin, 90); assert.equal(o.waitIntervalMax, 180); // pool-topology gaps NOT scaled
  assert.equal(o.accountDelayMin, 1); assert.equal(o.accountDelayMax, 4);
  assert.equal(s.groupDelayMin, 120, 'applyPace is pure — original settings untouched');
});

test('applyPace: FAST halves per-post windows + takes the instant path', () => {
  const s = { groupDelayMin: 120, groupDelayMax: 300, commentDelayMin: 60, commentDelayMax: 180, speedMode: 'normal' };
  const o = w.applyPace(s, 'fast');
  assert.equal(o.groupDelayMin, 60); assert.equal(o.groupDelayMax, 150);
  assert.equal(o.commentDelayMin, 30); assert.equal(o.commentDelayMax, 90);
  assert.equal(o.speedMode, 'fast', 'fast enables the instant typing / dwell-skip path');
  assert.equal(w.isFastMode(o), true);
});

test('applyPace: fast respects a conservative global slow + never undercuts the composer floor', () => {
  // 'fast' must NOT flip a deliberately-slow global to the instant path — but the gaps still halve.
  const slow = w.applyPace({ groupDelayMin: 200, groupDelayMax: 400, speedMode: 'slow' }, 'fast');
  assert.equal(slow.speedMode, 'slow', 'fast keeps a global slow preset (max-caution intent preserved)');
  assert.equal(slow.groupDelayMin, 100, 'gaps still halve under fast even when speedMode stays slow');
  // composerOpenInitialDelayMs has an 800ms render floor — a 0.5× scale (→750) must clamp up.
  assert.equal(w.applyPace({ composerOpenInitialDelayMs: 1500, speedMode: 'normal' }, 'fast').composerOpenInitialDelayMs, 800, '750 floored up to 800');
  assert.equal(w.applyPace({ composerOpenInitialDelayMs: 1500 }, 'safe').composerOpenInitialDelayMs, 3000, 'safe 2× → 3000 (no floor conflict)');
});

test('applyPace: account pace overrides settings.defaultPace; explicit normal wins', () => {
  const s = { groupDelayMin: 100, groupDelayMax: 200, defaultPace: 'safe' };
  assert.equal(w.applyPace(s, undefined).groupDelayMin, 200, 'absent account pace → falls back to defaultPace (safe → 2×)');
  assert.strictEqual(w.applyPace(s, 'normal'), s, 'an explicit normal on the account beats a safe global default (unchanged)');
  assert.equal(w.applyPace(s, 'fast').groupDelayMin, 50, 'explicit fast on the account beats the safe default');
});

test('applyPace: an inherit account resolves to a turbo/instant fleet defaultPace (both scaling AND speedMode)', () => {
  const base = { groupDelayMin: 120, groupDelayMax: 300, speedMode: 'normal' };
  const inh = w.applyPace({ ...base, defaultPace: 'instant' }, undefined);
  assert.equal(inh.groupDelayMin, 12, 'inherit → instant scales the gaps by 0.1×');
  assert.equal(inh.speedMode, 'instant', 'inherit → instant sets the paste-and-fire speedMode');
  assert.equal(w.isTurboMode(inh), true, 'inherit → instant is a turbo-class mode');
  const tur = w.applyPace({ ...base, defaultPace: 'turbo' }, undefined);
  assert.equal(tur.groupDelayMin, 30, 'inherit → turbo scales the gaps by 0.25×');
  assert.equal(tur.speedMode, 'turbo', 'inherit → turbo sets speedMode');
  const explicit = { ...base, defaultPace: 'instant' };
  assert.strictEqual(w.applyPace(explicit, 'normal'), explicit, 'an explicit account pace=normal still beats defaultPace=instant (object unchanged)');
  const gslow = w.applyPace({ groupDelayMin: 120, speedMode: 'slow', defaultPace: 'instant' }, undefined);
  assert.equal(gslow.speedMode, 'slow', 'inherit → instant still respects a deliberate global slow');
});

test('store: per-account pace + global defaultPace are validated (all 5 tiers; invalid → drop/normal)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-pace-'));
  store.init(tmp);
  store.save({ posts: [], groups: [], proxies: [], useProxies: false, settings: {}, accounts: [
    { name: 'safe1', pace: 'safe' }, { name: 'fast1', pace: 'fast' }, { name: 'bad', pace: 'ludicrous' }, { name: 'none' },
  ] });
  const accts = store.load().accounts;
  assert.equal(accts.find((a) => a.name === 'safe1').pace, 'safe');
  assert.equal(accts.find((a) => a.name === 'fast1').pace, 'fast');
  assert.equal(accts.find((a) => a.name === 'bad').pace, undefined, 'invalid pace dropped → inherit global');
  assert.equal(accts.find((a) => a.name === 'none').pace, undefined, 'absent stays absent (inherit)');
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.equal(store.clampSettings({ defaultPace: 'safe' }).defaultPace, 'safe');
  assert.equal(store.clampSettings({ defaultPace: 'fast' }).defaultPace, 'fast');
  assert.equal(store.clampSettings({ defaultPace: 'turbo' }).defaultPace, 'turbo', 'turbo is a valid fleet default');
  assert.equal(store.clampSettings({ defaultPace: 'instant' }).defaultPace, 'instant', 'instant is a valid fleet default');
  assert.equal(store.clampSettings({ defaultPace: 'bogus' }).defaultPace, 'normal', 'invalid → normal');
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
