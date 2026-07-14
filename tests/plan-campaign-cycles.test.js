// tests/plan-campaign-cycles.test.js
// Campaign-plan CYCLE view: the dashboard groups the plan by posting CYCLE (slice position), not by calendar day.
// Cycle 1 = every account's 1st slice-post, Cycle 2 the 2nd, etc. Delivered cells come from the ledger items tagged
// { round, cycle } at delivery, filtered to the CURRENT round (reset each round). Rows expand to full assigned groups.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildPlan } = require('../lib/plan');

const TODAY = '2026-07-13';
const posts = [{ id: 'p1', caption: 'one' }, { id: 'p2', caption: 'two' }, { id: 'p3', caption: 'three' }, { id: 'p4', caption: 'four' }];
const groups = [{ id: 'g1', groupId: 'gidA', name: 'Group A' }, { id: 'g2', groupId: 'gidB', name: 'Group B' }];
const cp = (name) => ({ name, alias: name, postingOrder: 'campaign-plan', assignedGroups: ['g1', 'g2'], enabled: true });

// One ledger item per (account, post, group), tagged with round + cycle (as the engine now stamps them).
function led(entries) {
  const items = {};
  for (const [account, postId, round, cycle, status] of entries) {
    for (const gid of ['gidA', 'gidB']) items[`${account}|${postId}|${gid}`] = { account, postId, groupId: gid, group: gid, status, round, cycle };
  }
  return { days: { [TODAY]: { posted: entries.length * 2, held: 0, errors: 0, items } } };
}

function plan(agentLists, roundOffset, progress) {
  return buildPlan({
    posts, groups, accounts: [cp('simo12'), cp('simo13')],
    settings: { completionMode: false, loopCampaign: true },
    rotation: { roundOffset, campaignPlan: { agentLists, roundOffset }, perAccountRotation: {} },
    progress, todayKey: TODAY,
  });
}

test('cycle view: two delivered cycles show as Cycle 1 (#1) and Cycle 2 (#2), both done', () => {
  const p = plan({ simo12: ['p1', 'p2'], simo13: ['p1', 'p2'] }, 0,
    led([['simo12', 'p1', 0, 1, 'done'], ['simo13', 'p1', 0, 1, 'done'], ['simo12', 'p2', 0, 2, 'done'], ['simo13', 'p2', 0, 2, 'done']]));
  assert.equal(p.method, 'campaign-plan');
  assert.equal(p.days.length, 2, 'two cycles, not one lumped day');
  const c1 = p.days.find((d) => d.offset === 0), c2 = p.days.find((d) => d.offset === 1);
  assert.deepEqual(c1.rows.map((r) => r.postNum).sort(), [1, 1], 'Cycle 1 = both accounts post #1');
  assert.deepEqual(c2.rows.map((r) => r.postNum).sort(), [2, 2], 'Cycle 2 = both accounts post #2');
  for (const d of [c1, c2]) for (const r of d.rows) { assert.equal(r.status, 'done'); assert.equal(r.groupsDone, 2); assert.equal(r.groupsTotal, 2); }
  assert.equal(c1.when, 'past'); assert.equal(c2.when, 'past');
});

test('cycle view: mid-run — cycle 1 delivered (past), cycle 2 pending (current/today)', () => {
  const p = plan({ simo12: ['p1', 'p2'], simo13: ['p1', 'p2'] }, 0,
    led([['simo12', 'p1', 0, 1, 'done'], ['simo13', 'p1', 0, 1, 'done']]));
  const c1 = p.days.find((d) => d.offset === 0), c2 = p.days.find((d) => d.offset === 1);
  assert.equal(c1.when, 'past', 'cycle 1 fully delivered → past');
  assert.ok(c1.rows.every((r) => r.status === 'done'));
  assert.equal(c2.when, 'today', 'cycle 2 not delivered → current');
  assert.ok(c2.rows.every((r) => r.status === 'upcoming'), 'cycle 2 cells pending');
  assert.equal(p.todayIndex, 1, 'view defaults to the current cycle');
});

test('keep-record: a just-completed round STAYS visible until the next round posts', () => {
  // roundOffset already advanced to 1, but round 1 hasn't delivered anything yet → the view must keep showing
  // round 0's completed cycles (NOT flip to an empty round 1). This is the "reput on finish" bug the operator hit.
  const p = plan({ simo12: ['p3', 'p4'], simo13: ['p3', 'p4'] }, 1,
    led([['simo12', 'p1', 0, 1, 'done'], ['simo13', 'p1', 0, 1, 'done'], ['simo12', 'p2', 0, 2, 'done'], ['simo13', 'p2', 0, 2, 'done']]));
  assert.equal(p.days.length, 2, 'still shows round 0\'s 2 completed cycles');
  const nums = [...new Set(p.days.flatMap((d) => d.rows).map((r) => r.postNum))].sort();
  assert.deepEqual(nums, [1, 2], 'round 0 posts #1/#2 remain (not reset to round 1\'s empty #3/#4)');
  assert.ok(p.days.every((d) => d.when === 'past'), 'the completed round reads as done');
});

test('reset ON next round: once round 1 delivers its first post, the view flips to round 1', () => {
  const p = plan({ simo12: ['p3', 'p4'], simo13: ['p3', 'p4'] }, 1,
    led([['simo12', 'p1', 0, 1, 'done'], ['simo13', 'p1', 0, 1, 'done'],  // round 0 (old, complete)
      ['simo12', 'p3', 1, 1, 'done']]));                                   // round 1 first delivery
  const nums = [...new Set(p.days.flatMap((d) => d.rows).map((r) => r.postNum))];
  assert.ok(nums.includes(3), 'round 1 (#3) is now the shown round');
  assert.ok(!nums.includes(1), 'round 0 (#1) has dropped out of the per-cycle view');
});

test('cycle view: lifetime totals still reflect the ledger (delivered count survives)', () => {
  const p = plan({ simo12: ['p1', 'p2'], simo13: ['p1', 'p2'] }, 0,
    led([['simo12', 'p1', 0, 1, 'done'], ['simo13', 'p1', 0, 1, 'done']]));
  assert.equal(p.totals.posted, 4, 'both accounts × 2 groups delivered = 4 group-posts in the ledger');
});
