// tests/unified-wait.test.js
// THE UNIFIED WAIT — one hold, replacing three "is EVERYONE blocked the SAME way?" unanimity tests.
//
// The old cap-hold returned false for any COOLING account; the old cool-down hold returned false for any CAPPED one;
// the rotation hold only looked at daily-rotation/campaign-plan. So a MIXED fleet (3 capped, 2 cooling, 1 resting)
// satisfied NONE, fell through to the stall-breaker, and the run STOPPED when it only needed to wait — a
// days-unattended product dying overnight, hours before it would have recovered on its own.
// And NOTHING read nextAttnRetry, so the attention ladder's promise ("it retries automatically after the rest") was
// never true: an attention-rested fleet stopped instead of retrying.
//
// The right question: not "is everyone blocked identically?" but "can ANYONE act now, and if not, when is the soonest
// anyone could?" — one wake-time per account, hold until the EARLIEST.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { Orchestrator } = require('../automation/orchestrator');

const mk = () => new Orchestrator(() => {}, {});
const NOW = 1_600_000_000_000;
const midnight = (now) => { const d = new Date(now); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 30).getTime(); };
const acct = (name, extra = {}) => ({ name, postingOrder: 'post-centric', enabled: true, ...extra });

test('a rate-limit cool-down yields its expiry as the wake time', () => {
  const o = mk();
  const a = acct('A');
  assert.equal(o._accountWakeAt(a, { ...a, rateLimitedUntil: NOW + 4 * 3600e3 }, NOW, {}), NOW + 4 * 3600e3);
});

test('an ATTENTION rest yields nextAttnRetry — nothing used to read it, so the ladder never actually retried', () => {
  const o = mk();
  const a = acct('A');
  assert.equal(o._accountWakeAt(a, { ...a, nextAttnRetry: NOW + 30 * 60e3 }, NOW, {}), NOW + 30 * 60e3,
    'a logged-out/checkpointed/delivered-nothing account is WAITING, not dead — the run must hold for it, not stop');
});

test('the daily cap yields the next LOCAL midnight (the cap window rolls locally, not in UTC)', () => {
  const o = mk();
  const a = acct('A');
  assert.equal(o._accountWakeAt(a, { ...a, daily: { date: o._localDayKey(), count: 5 } }, NOW, { dailyCap: 5 }), midnight(NOW));
});

test('a rotation agent that already posted today waits for tomorrow', () => {
  const o = mk();
  const a = acct('A', { postingOrder: 'daily-rotation' });
  o._perAccountRotation = { A: { lastPostedDate: o._localDayKey() } };
  assert.equal(o._accountWakeAt(a, { ...a }, NOW, {}), midnight(NOW));
});

test('an account that CAN act now yields 0 — so the hold can never fire while real work is possible', () => {
  const o = mk();
  const a = acct('A');
  assert.equal(o._accountWakeAt(a, { ...a }, NOW, {}), 0);
  assert.equal(o._accountWakeAt(a, { ...a, rateLimitedUntil: NOW - 1, nextAttnRetry: NOW - 1 }, NOW, {}), 0, 'expired rests do not block');
  assert.equal(o._accountWakeAt(a, { ...a, daily: { date: o._localDayKey(), count: 2 } }, NOW, { dailyCap: 5 }), 0, 'under the cap → can act');
});

test('THE BUG: a MIXED fleet now holds — every account is blocked, so the run waits instead of stopping', () => {
  const o = mk();
  o._perAccountRotation = {};
  const today = o._localDayKey();
  const settings = { dailyCap: 5 };
  const fleet = [
    { a: acct('capped'), live: { daily: { date: today, count: 5 } } },                 // at the cap  → midnight
    { a: acct('cooling'), live: { rateLimitedUntil: NOW + 90 * 60e3 } },               // cooling     → +90min
    { a: acct('resting'), live: { nextAttnRetry: NOW + 20 * 60e3 } },                  // attn rest   → +20min  (the earliest)
  ];
  const wakes = fleet.map(({ a, live }) => o._accountWakeAt(a, { ...a, ...live }, NOW, settings));
  assert.ok(wakes.every((w) => w > NOW), 'EVERY account is blocked by a timed limit — the old code matched none of its three tests and stopped the run');
  assert.equal(Math.min(...wakes), NOW + 20 * 60e3, 'the hold waits for the EARLIEST recovery, not the longest');
});

test('one healthy account defeats the hold (a real stall must still reach the stall-breaker)', () => {
  const o = mk();
  o._perAccountRotation = {};
  const settings = { dailyCap: 5 };
  const wakes = [
    o._accountWakeAt(acct('capped'), { daily: { date: o._localDayKey(), count: 5 } }, NOW, settings),
    o._accountWakeAt(acct('healthy'), {}, NOW, settings), // could act now
  ];
  assert.ok(!wakes.every((w) => w > NOW), 'work is still possible → do NOT hold; a genuinely dead fleet must still stop with its named cause');
});

test('_waitPosters excludes surplus-idle campaign agents (idle BY DESIGN, not blocked by a timed limit)', () => {
  const o = mk();
  o._campaignPlan = { batchId: 'b', agentLists: { WORKER: ['P1'], SURPLUS: [] }, clusters: [] };
  o._perAccountRotation = {};
  o._data = { posts: [{ id: 'P1' }], accounts: [], groups: [], settings: {} };
  o._active = [acct('WORKER', { postingOrder: 'campaign-plan' }), acct('SURPLUS', { postingOrder: 'campaign-plan' }), acct('MOD', { isModerator: true })];
  const names = o._waitPosters().map((a) => a.name);
  assert.deepEqual(names, ['WORKER'], 'a campaign agent with an EMPTY slice never posts — demanding a wake-time from it would block the hold forever and hand the run to the stall-breaker');
});
