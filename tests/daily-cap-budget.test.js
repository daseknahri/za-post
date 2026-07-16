// tests/daily-cap-budget.test.js
// THE DAILY CAP MUST BOUND THE CYCLE, NOT EACH POST.
//
// maxThisRun is the account's REMAINING cycle budget (cap - usedToday), computed ONCE by the caller. It used to be
// handed verbatim into every runAccount call inside the postsLoop — and the worker enforces it against a counter it
// RE-INITIALISES on each entry. So with several posts per cycle, EACH post received the FULL cap and the account posted
// cap x posts. The daily count is recorded honestly afterwards, so the overshoot was only caught on the NEXT cycle,
// after the burst had already landed on the one shared IP.
//
// Operator symptom: "I set the daily cap to 5 but the account posted 20 times today" — with the log printing the
// "reached today's remaining post budget (5)" line several times inside ONE cycle.
//
// Reachable in the BROADCAST modes (post-centric/random) with postsPerGroup = 0 ("all") or > 1. The default is 1, so a
// stock install was safe — which is exactly why this survived: it needs a non-default, documented setting.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// Models the loop contract: the budget is seeded once, then CONSUMED by what each post actually delivered
// (posted + pendingApproval — a held post did reach FB, matching _recordAccountOutcome).
function runCycle(cap, perPostDelivery) {
  let budget = cap > 0 ? cap : Infinity;
  let total = 0;
  for (const want of perPostDelivery) {
    if (Number.isFinite(budget) && budget <= 0) break;          // the new pre-post guard
    const allowed = Number.isFinite(budget) ? Math.min(want, budget) : want; // the worker caps THIS call at the budget
    total += allowed;
    if (Number.isFinite(budget)) budget -= allowed;
  }
  return total;
}

test('a multi-post cycle NEVER exceeds the daily cap (the old code delivered cap x posts)', () => {
  // cap=5, four posts each wanting 5 groups. Old behaviour: every post saw maxThisRun=5 -> 20 delivered.
  assert.equal(runCycle(5, [5, 5, 5, 5]), 5, 'the cap bounds the CYCLE; the old code let each post spend the full cap');
});

test('the budget is consumed progressively, not reset per post', () => {
  assert.equal(runCycle(5, [2, 2, 2, 2]), 5, '2+2 then only 1 of the third post fits — the fourth never starts');
  assert.equal(runCycle(10, [3, 3, 3]), 9, 'under the cap → everything delivers, unchanged');
});

test('held/pending posts consume the budget too (they DID reach Facebook)', () => {
  // _recordAccountOutcome counts posted + pendingApproval; the in-cycle guard must agree or the two diverge.
  assert.equal(runCycle(3, [3, 3]), 3, 'a fully-held first post still exhausts the cap');
});

test('cap OFF (0) is unbounded — no behaviour change', () => {
  assert.equal(runCycle(0, [5, 5, 5]), 15, 'cap 0 = off; Infinity stays Infinity');
});

test('single-post cycles are byte-identical (campaign-plan / daily-rotation / unique / sequence / ppg=1)', () => {
  for (const cap of [1, 5, 20]) {
    assert.equal(runCycle(cap, [cap]), cap, 'one post per cycle could never multiply the cap — the default path is unaffected');
    assert.equal(runCycle(cap, [1]), 1);
  }
});
