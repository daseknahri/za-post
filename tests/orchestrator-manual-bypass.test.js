// Regression guard: a manual Start ("run now") must bypass the daily per-account posting quota exactly ONCE per
// account (so clicking Start posts immediately even if the account already posted today), then respect the cadence
// on every later cycle. An earlier version left the bypass ON for the whole run → real over-posting on a Stop→Start.
// This pins the one-shot-per-account behavior AND that the one-shot is spent by the REAL run (claim=true), never by
// the read-only daily/campaign PLAN PREVIEW (claim=false) — consuming it on the preview made the actual run fall
// through to the cap so a daily/campaign account that already posted today posted NOTHING on a manual Start.
const { test } = require('node:test');
const assert = require('node:assert');
const { Orchestrator } = require('../automation/orchestrator');

test('manual-Start quota bypass is one-shot PER ACCOUNT and is spent by the REAL run, not a plan preview', () => {
  const o = Object.create(Orchestrator.prototype); // prototype methods only — no constructor side-effects
  o._localDayKey = () => '2026-07-01';
  o._data = { settings: { cyclesPerDay: 1 } };
  const posted = () => ({ postsToday: 1, postsTodayDate: '2026-07-01', lastPostedAt: Date.now() }); // already posted today (N=1)
  const fresh = () => ({});

  // NON-manual run → the daily quota is enforced (a claiming call is still capped).
  o._manualRun = false; o._manualBypassUsed = new Set();
  assert.strictEqual(o._dailyQuotaBlocks(posted(), 'A', true), true, 'non-manual: an account that already posted today is blocked');
  assert.strictEqual(o._dailyQuotaBlocks(fresh(), 'B', true), false, 'non-manual: a fresh account is not blocked');

  // MANUAL run, REAL claim (claim=true) → each account bypasses ONCE, then respects the quota.
  o._manualRun = true; o._manualBypassUsed = new Set();
  assert.strictEqual(o._dailyQuotaBlocks(posted(), 'A', true), false, 'manual+claim: A first real call bypasses (posts now despite posted-today)');
  assert.strictEqual(o._dailyQuotaBlocks(posted(), 'A', true), true, 'manual+claim: A second real call respects the quota (no over-post)');
  assert.strictEqual(o._dailyQuotaBlocks(posted(), 'B', true), false, 'manual+claim: B bypasses independently of A');
  assert.strictEqual(o._dailyQuotaBlocks(posted(), 'B', true), true, 'manual+claim: B second real call respects the quota');
  assert.strictEqual(o._dailyQuotaBlocks(posted(), null, true), true, 'manual: a missing account name never bypasses (safe default)');

  // THE FIX: a read-only PLAN PREVIEW (claim=false) must NOT consume the one-shot. Otherwise the real run finds the
  // bypass already spent → a daily/campaign account that already posted today posts NOTHING on a manual Start.
  o._manualBypassUsed = new Set();
  assert.strictEqual(o._dailyQuotaBlocks(posted(), 'C', false), false, 'manual+preview: the preview bypasses (for the plan readout)');
  assert.strictEqual(o._manualBypassUsed.has('C'), false, 'manual+preview: the preview did NOT consume the one-shot');
  assert.strictEqual(o._dailyQuotaBlocks(posted(), 'C', false), false, 'manual+preview: a second preview still finds it available');
  assert.strictEqual(o._dailyQuotaBlocks(posted(), 'C', true), false, 'manual: the REAL run still gets its one bypass after previews');
  assert.strictEqual(o._dailyQuotaBlocks(posted(), 'C', true), true, 'manual: and only once — the second real call respects the quota');
});
