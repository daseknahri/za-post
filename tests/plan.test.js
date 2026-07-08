// tests/plan.test.js — the dashboard's day-by-day plan builder (lib/plan.js). Pure, deterministic: given posts +
// accounts + rotation + a progress ledger, it must produce the right forecast days and overlay "done" correctly.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildPlan } = require('../lib/plan');

const TODAY = '2026-06-23';
const posts = [{ id: 'p1', caption: 'one' }, { id: 'p2', caption: 'two' }, { id: 'p3', caption: 'three' }];
const groups = [{ id: 'g1', name: 'Alpha' }, { id: 'g2', name: 'Beta' }];
const dr = (name, gids) => ({ name, alias: name, postingOrder: 'daily-rotation', assignedGroups: gids, enabled: true });

test('daily-rotation: fresh accounts → today is post #1, forecast walks the list, cycle = P days', () => {
  const plan = buildPlan({ posts, groups, accounts: [dr('A', ['g1']), dr('B', ['g1', 'g2'])], settings: {}, rotation: {}, progress: {}, todayKey: TODAY });
  assert.equal(plan.method, 'daily-rotation');
  assert.equal(plan.cycleDays, 3);
  const today = plan.days[plan.todayIndex];
  assert.equal(today.offset, 0);
  assert.deepEqual(today.rows.map((r) => r.postNum), [1, 1], 'both accounts post #1 today');
  assert.equal(today.rows[1].groupsTotal, 2, 'B targets 2 groups');
  const tomorrow = plan.days[plan.todayIndex + 1];
  assert.deepEqual(tomorrow.rows.map((r) => r.postNum), [2, 2], 'next day → post #2');
  // wraps after P days
  const day3 = plan.days[plan.todayIndex + 2];
  assert.deepEqual(day3.rows.map((r) => r.postNum), [3, 3]);
});

test('daily-rotation: an account that already posted #1 today shows #1 today, #2 tomorrow', () => {
  const rotation = { perAccountRotation: { A: { lastPostId: 'p1', lastPostedDate: TODAY } } };
  const plan = buildPlan({ posts, groups, accounts: [dr('A', ['g1'])], settings: {}, rotation, progress: {}, todayKey: TODAY });
  assert.equal(plan.days[plan.todayIndex].rows[0].postNum, 1, 'today = the post it already did');
  assert.equal(plan.days[plan.todayIndex + 1].rows[0].postNum, 2);
});

test('daily-rotation: an account that posted #1 YESTERDAY shows #2 today (advances)', () => {
  const rotation = { perAccountRotation: { A: { lastPostId: 'p1', lastPostedDate: '2026-06-22' } } };
  const plan = buildPlan({ posts, groups, accounts: [dr('A', ['g1'])], settings: {}, rotation, progress: {}, todayKey: TODAY });
  assert.equal(plan.days[plan.todayIndex].rows[0].postNum, 2);
});

test('progress overlay: today\'s delivered group flips the cell + row to done', () => {
  const progress = { days: { [TODAY]: { posted: 1, held: 0, errors: 0, items: {
    'A|p1|g1': { account: 'A', postId: 'p1', groupId: 'g1', group: 'Alpha', status: 'done', postNum: 1, caption: 'one' },
  } } } };
  const plan = buildPlan({ posts, groups, accounts: [dr('A', ['g1', 'g2'])], settings: {}, rotation: {}, progress, todayKey: TODAY });
  const row = plan.days[plan.todayIndex].rows[0];
  assert.equal(row.groupsDone, 1, 'one of two groups delivered');
  assert.equal(row.status, 'partial');
  assert.equal(row.groups.find((g) => g.id === 'g1').status, 'done');
  assert.equal(row.groups.find((g) => g.id === 'g2').status, 'today', 'undelivered group still pending today');
});

test('overlay matches the ledger by FACEBOOK group id, not the app id', () => {
  // The real bug: assignedGroups holds the app id (g1) but the ledger keys by the FB id (FB1). Overlay must map.
  const grpWithFb = [{ id: 'g1', groupId: 'FB1', name: 'Alpha' }];
  const progress = { days: { [TODAY]: { posted: 1, held: 0, errors: 0, items: {
    'A|p1|FB1': { account: 'A', postId: 'p1', groupId: 'FB1', group: 'Alpha', status: 'done', caption: 'one' },
  } } } };
  const plan = buildPlan({ posts, groups: grpWithFb, accounts: [dr('A', ['g1'])], settings: {}, rotation: {}, progress, todayKey: TODAY });
  const row = plan.days[plan.todayIndex].rows[0];
  assert.equal(row.groupsDone, 1, 'delivery keyed by FB id is matched to the app-id group');
  assert.equal(row.status, 'done');
});

test('past days come from the ledger (what actually happened), before today', () => {
  const progress = { days: { '2026-06-22': { posted: 1, held: 0, errors: 0, items: {
    'A|p1|g1': { account: 'A', postId: 'p1', groupId: 'g1', group: 'Alpha', status: 'done', postNum: 1, caption: 'one' },
  } } } };
  const plan = buildPlan({ posts, groups, accounts: [dr('A', ['g1'])], settings: {}, rotation: {}, progress, todayKey: TODAY });
  const past = plan.days.find((d) => d.when === 'past');
  assert.ok(past, 'a past day exists');
  assert.equal(past.dayKey, '2026-06-22');
  assert.equal(past.rows[0].status, 'done');
  assert.equal(plan.totals.posted, 1);
});

test('campaign-plan: uses the persisted agentLists grid', () => {
  const rotation = { campaignPlan: { agentLists: { A: ['p1', 'p3'], B: ['p2'] } }, perAccountRotation: {} };
  const accts = [{ name: 'A', alias: 'A', postingOrder: 'campaign-plan', assignedGroups: ['g1'], enabled: true },
    { name: 'B', alias: 'B', postingOrder: 'campaign-plan', assignedGroups: ['g2'], enabled: true }];
  const plan = buildPlan({ posts, groups, accounts: accts, settings: {}, rotation, progress: {}, todayKey: TODAY });
  assert.equal(plan.method, 'campaign-plan');
  const today = plan.days[plan.todayIndex];
  assert.deepEqual(today.rows.map((r) => r.account).sort(), ['A', 'B']);
  assert.equal(plan.days[plan.todayIndex + 1].rows.length, 1, 'day 2: only A still has a post (p3)');
});

test('daily-rotation: respects an account postFilter (with-comments only)', () => {
  const withComments = [{ id: 'p1', caption: 'one' }, { id: 'p2', caption: 'two', comment: 'http://link' }, { id: 'p3', caption: 'three' }];
  const acct = { name: 'A', alias: 'A', postingOrder: 'daily-rotation', assignedGroups: ['g1'], enabled: true, postFilter: 'with-comments' };
  const plan = buildPlan({ posts: withComments, groups, accounts: [acct], settings: {}, rotation: {}, progress: {}, todayKey: TODAY });
  assert.equal(plan.cycleDays, 1, 'only one post has a comment → 1-day cycle');
  assert.equal(plan.days[plan.todayIndex].rows[0].postNum, 2, 'posts the with-comment post (#2 in the library)');
});

test('campaign-plan: skips OVER a deleted post-id (no wasted day)', () => {
  // agentList references a deleted post pX in the middle; engine skips it, so after p1 (yesterday) today = p3.
  const rotation = { campaignPlan: { agentLists: { A: ['p1', 'pX', 'p3'] } }, perAccountRotation: { A: { lastPostId: 'p1', lastPostedDate: '2026-06-22' } } };
  const accts = [{ name: 'A', alias: 'A', postingOrder: 'campaign-plan', assignedGroups: ['g1'], enabled: true }];
  const plan = buildPlan({ posts, groups, accounts: accts, settings: {}, rotation, progress: {}, todayKey: TODAY });
  const today = plan.days[plan.todayIndex];
  assert.equal(today.rows.length, 1);
  assert.equal(today.rows[0].postNum, 3, 'deleted pX skipped → today is #3, not an idle/blank day');
});

test('campaign-plan: previews from config BEFORE any run (no persisted agentLists)', () => {
  // Two accounts sharing the same group → one cluster, K=2 interleave: A gets idx%2==0 (p1,p3), B gets p2.
  const accts = [{ name: 'A', alias: 'A', postingOrder: 'campaign-plan', assignedGroups: ['g1'], enabled: true },
    { name: 'B', alias: 'B', postingOrder: 'campaign-plan', assignedGroups: ['g1'], enabled: true }];
  const plan = buildPlan({ posts, groups, accounts: accts, settings: {}, rotation: {}, progress: {}, todayKey: TODAY });
  assert.equal(plan.method, 'campaign-plan');
  const today = plan.days[plan.todayIndex];
  const byAcct = Object.fromEntries(today.rows.map((r) => [r.account, r.postNum]));
  assert.equal(byAcct.A, 1, 'A starts the partition at #1');
  assert.equal(byAcct.B, 2, 'B takes #2');
  assert.equal(plan.days[plan.todayIndex + 1].rows.find((r) => r.account === 'A').postNum, 3, 'A → #3 next day');
});

test('campaign-plan SPREAD: a faster cluster is paced to the slowest cluster\'s duration (no idle day)', () => {
  // 4 posts. Cluster A: 2 agents → 2 posts each → 2 days. Cluster B: 4 agents → 1 post each → would be 1 day.
  // After spread, B must also span 2 days (2 posts/day via 2 active agents), so neither cluster idles on day 2.
  const p4 = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p4' }];
  const grps = [{ id: 'gA', groupId: 'A' }, { id: 'gB', groupId: 'B' }];
  const accts = [];
  for (let i = 0; i < 2; i++) accts.push({ name: 'A' + i, postingOrder: 'campaign-plan', assignedGroups: ['gA'], enabled: true });
  for (let i = 0; i < 4; i++) accts.push({ name: 'B' + i, postingOrder: 'campaign-plan', assignedGroups: ['gB'], enabled: true });
  const plan = buildPlan({ posts: p4, groups: grps, accounts: accts, settings: {}, rotation: {}, progress: {}, todayKey: TODAY });
  const fut = plan.days.filter((d) => d.when !== 'past');
  assert.equal(fut.length, 2, 'both clusters span 2 days');
  for (const d of fut) {
    const a = d.rows.filter((r) => r.groups.some((g) => g.id === 'gA')).length;
    const b = d.rows.filter((r) => r.groups.some((g) => g.id === 'gB')).length;
    assert.equal(a, 2, 'cluster A posts 2/day');
    assert.equal(b, 2, 'cluster B is spread to 2/day too (not 4 on day 1, 0 on day 2)');
  }
});

test('post-centric → a message, no finite days', () => {
  const accts = [{ name: 'A', alias: 'A', postingOrder: 'post-centric', assignedGroups: ['g1'], enabled: true }];
  const plan = buildPlan({ posts, groups, accounts: accts, settings: {}, rotation: {}, progress: {}, todayKey: TODAY });
  assert.equal(plan.method, 'post-centric');
  assert.match(plan.message, /continuously/i);
});
