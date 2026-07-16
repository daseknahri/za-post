// tests/orchestrator-campaign-plan.test.js
// Campaign Plan mode: agents are clustered by their SHARED group-set; within each cluster the WHOLE post
// library is partitioned across the cluster's agents (round-robin) so every group-set receives the entire
// campaign, 1 post/agent/day. Each agent walks its own slice via the daily pointer.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { Orchestrator } = require('../automation/orchestrator');

const mk = () => new Orchestrator(() => {}, {});
const agent = (name, groups) => ({ name, assignedGroups: groups, postingOrder: 'campaign-plan', postFilter: 'all' });

test('campaign-plan: clusters by shared groups; each cluster splits the WHOLE library across its agents', () => {
  const o = mk();
  const posts = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ id: 'P' + n }));
  const agents = [agent('A', ['g1', 'g2']), agent('B', ['g1', 'g2']), agent('C', ['g3', 'g4']), agent('D', ['g3', 'g4'])];
  const plan = o._computeCampaignPlan(posts, agents, 0);
  assert.equal(plan.clusters.length, 2, 'two group-sets → two clusters');
  assert.deepEqual(plan.agentLists.A, ['P1', 'P3', 'P5', 'P7', 'P9']);
  assert.deepEqual(plan.agentLists.B, ['P2', 'P4', 'P6', 'P8']);
  // cluster 2 (different groups) independently receives the SAME whole library, split across C+D
  assert.deepEqual(plan.agentLists.C, ['P1', 'P3', 'P5', 'P7', 'P9']);
  assert.deepEqual(plan.agentLists.D, ['P2', 'P4', 'P6', 'P8']);
});

test('campaign-plan POST-SETS: each batch draws ONLY from its assigned set; content never crosses sets', () => {
  const o = mk();
  const posts = [
    { id: 'A1', postSetId: 'setA' }, { id: 'A2', postSetId: 'setA' }, { id: 'A3', postSetId: 'setA' },
    { id: 'B1', postSetId: 'setB' }, { id: 'B2', postSetId: 'setB' }, { id: 'B3', postSetId: 'setB' },
  ];
  const a = (n, g, s) => ({ ...agent(n, g), postSetId: s });
  const agents = [a('A1', ['g1'], 'setA'), a('A2', ['g1'], 'setA'), a('B1', ['g2'], 'setB'), a('B2', ['g2'], 'setB')];
  const plan = o._computeCampaignPlan(posts, agents, 0);
  const aIds = [...plan.agentLists.A1, ...plan.agentLists.A2].sort();
  const bIds = [...plan.agentLists.B1, ...plan.agentLists.B2].sort();
  assert.deepEqual(aIds, ['A1', 'A2', 'A3'], 'batch A delivers exactly its set');
  assert.deepEqual(bIds, ['B1', 'B2', 'B3'], 'batch B delivers exactly its set');
  assert.ok(!aIds.some((id) => id.startsWith('B')) && !bIds.some((id) => id.startsWith('A')), 'no content crosses between sets');
});

test('campaign-plan POST-SETS: SAME groups + DIFFERENT sets → SEPARATE clusters (each draws its own set)', () => {
  const o = mk();
  const posts = [
    { id: 'A1', postSetId: 'setA' }, { id: 'A2', postSetId: 'setA' },
    { id: 'B1', postSetId: 'setB' }, { id: 'B2', postSetId: 'setB' },
  ];
  const a = (n, s) => ({ ...agent(n, ['g1']), postSetId: s }); // identical group g1, different sets
  const plan = o._computeCampaignPlan(posts, [a('A', 'setA'), a('B', 'setB')], 0);
  assert.equal(plan.clusters.length, 2, 'same groups + different sets must NOT collide into one cluster');
  assert.deepEqual([...plan.agentLists.A].sort(), ['A1', 'A2'], 'A gets only setA');
  assert.deepEqual([...plan.agentLists.B].sort(), ['B1', 'B2'], 'B gets only setB');
});

test('post-sets: a reserve STAND-IN delivers the dropped agent\'s exact post even when its own set differs', () => {
  const o = mk();
  o._data = { posts: [{ id: 'P1', postSetId: 'setX' }, { id: 'P2', postSetId: 'setY' }], settings: {}, accounts: [] };
  const R = { name: 'R', assignedGroups: ['g1'], postingOrder: 'campaign-plan', postFilter: 'all', postSetId: 'setY' };
  o._campaignTakeover = { R: { postId: 'P1' } }; // covering a dropped agent whose post is P1 (set X, NOT R's set Y)
  assert.deepEqual(o._postsForAccount(R, 0, false).map((p) => p.id), ['P1'], 'stand-in bypasses the set filter');
});

test('post-sets: an account restricted to a set draws ONLY that set in _postsForAccount (post-centric)', () => {
  const o = mk();
  o._data = { posts: [{ id: 'P1', postSetId: 'setA' }, { id: 'P2', postSetId: 'setB' }, { id: 'P3' }], settings: {}, accounts: [] };
  const acc = { name: 'X', assignedGroups: ['g1'], postingOrder: 'post-centric', postFilter: 'all', postSetId: 'setA' };
  assert.deepEqual(o._postsForAccount(acc, 0, false).map((p) => p.id), ['P1'], 'only setA, not P2/untagged P3');
});

test('campaign-plan POST-SETS: no set assigned → whole library (backward-compat is byte-identical)', () => {
  const o = mk();
  const posts = [1, 2, 3, 4].map((n) => ({ id: 'P' + n })); // untagged posts
  const agents = [agent('A', ['g1']), agent('B', ['g1'])];  // untagged agents
  const plan = o._computeCampaignPlan(posts, agents, 0);
  assert.deepEqual(plan.agentLists.A, ['P1', 'P3'], 'untagged → original whole-library split');
  assert.deepEqual(plan.agentLists.B, ['P2', 'P4']);
});

test('campaign-plan SPREAD: a faster cluster is paced to the slowest cluster duration (no idle batch)', () => {
  const o = mk();
  const posts = [1, 2, 3, 4].map((n) => ({ id: 'P' + n }));
  // Cluster X: 2 agents → 2 posts each → 2 days (the pace-setter). Cluster Y: 4 agents → would be 1 day.
  const agents = [agent('X0', ['g1']), agent('X1', ['g1']), agent('Y0', ['g2']), agent('Y1', ['g2']), agent('Y2', ['g2']), agent('Y3', ['g2'])];
  const plan = o._computeCampaignPlan(posts, agents, 0);
  // Slow cluster unchanged (2 posts each → 2 days)
  assert.equal(plan.agentLists.X0.length, 2);
  assert.equal(plan.agentLists.X1.length, 2);
  // Fast cluster spread to 2 days: only Keff=ceil(4/2)=2 agents post (2 each), the rest idle THIS round (rotate next round)
  const yLens = ['Y0', 'Y1', 'Y2', 'Y3'].map((n) => plan.agentLists[n].length).sort();
  assert.deepEqual(yLens, [0, 0, 2, 2], 'fast cluster: 2 agents post 2/day over 2 days, 2 idle this round (no 4-in-1-day burst, no idle gap)');
});

test('campaign-plan: roundOffset reshuffles who-posts-what for the next big-cycle round', () => {
  const o = mk();
  const posts = [1, 2, 3, 4].map((n) => ({ id: 'P' + n }));
  const agents = [agent('A', ['g1']), agent('B', ['g1'])];
  const r0 = o._computeCampaignPlan(posts, agents, 0);
  const r1 = o._computeCampaignPlan(posts, agents, 1);
  assert.deepEqual(r0.agentLists.A, ['P1', 'P3']);
  assert.deepEqual(r1.agentLists.A, ['P2', 'P4'], 'round 2: A now posts the other slice');
  assert.notEqual(r0.batchId, undefined);
});

test('campaign-plan: each agent walks its slice 1/day, one-per-day, then completes', () => {
  const o = mk();
  o._data = { posts: [1, 2, 3, 4].map((n) => ({ id: 'P' + n })), settings: {}, accounts: [] };
  const A = agent('A', ['g1']), B = agent('B', ['g1']);
  o._active = [A, B];
  o._campaignPlan = o._computeCampaignPlan(o._data.posts, [A, B], 0); // A=[P1,P3] B=[P2,P4]
  o._perAccountRotation = {};

  assert.deepEqual(o._postsForAccount(A, 1).map((p) => p.id), ['P1'], 'day 1 → first slot');
  o._perAccountRotation.A = { lastPostId: 'P1', lastPostedDate: o._localDayKey() };
  assert.deepEqual(o._postsForAccount(A, 1), [], 'already posted today → nothing more');
  o._perAccountRotation.A = { lastPostId: 'P1', lastPostedDate: '2000-01-01' };
  assert.deepEqual(o._postsForAccount(A, 1).map((p) => p.id), ['P3'], 'next day → next slot');
  o._perAccountRotation.A = { lastPostId: 'P3', lastPostedDate: '2000-01-01' };
  assert.deepEqual(o._postsForAccount(A, 1), [], 'slice complete → nothing');

  o._perAccountRotation = { A: { lastPostId: 'P3', lastPostedDate: '2000-01-01' }, B: { lastPostId: 'P4', lastPostedDate: '2000-01-01' } };
  assert.equal(o._campaignAllFinished(), true, 'all agents delivered their whole slice');
  o._perAccountRotation.B = { lastPostId: 'P2', lastPostedDate: '2000-01-01' };
  assert.equal(o._campaignAllFinished(), false, 'B still has P4 to deliver');
  assert.ok(o._campaignRemaining() >= 1, 'B has remaining work');
});

test('campaign-plan: a deleted post in a slice is skipped (no stall)', () => {
  const o = mk();
  o._data = { posts: [{ id: 'P1' }, { id: 'P3' }], settings: {}, accounts: [] }; // P2 deleted from library
  const A = agent('A', ['g1']);
  o._active = [A];
  o._campaignPlan = { agentLists: { A: ['P1', 'P2', 'P3'] }, clusters: [] };
  o._perAccountRotation = { A: { lastPostId: 'P1', lastPostedDate: '2000-01-01' } };
  assert.deepEqual(o._postsForAccount(A, 1).map((p) => p.id), ['P3'], 'skips the deleted P2 → P3');
});

// ── CP1: the plan roster is the STABLE full campaign fleet; completion is roster-aware. This closes the reserve-churn
// ban-footgun (per-cycle reserve rotation changed the active set → batchId churn → pointer wipe → re-post every cycle). ──
test('CP1: _campaignRoster = enabled, non-mod, non-standby campaign agents WITH groups (stable; ignores per-cycle churn)', () => {
  const o = mk();
  o._data = { accounts: [
    agent('A', ['g1']), agent('B', ['g1']),
    { ...agent('C', ['g1']), standby: true },       // standby → excluded (covers as a reserve, never churns the roster)
    { ...agent('D', ['g1']), enabled: false },      // disabled → excluded
    { ...agent('M', ['g1']), isModerator: true },   // moderator → excluded
    agent('E', []),                                  // no groups → excluded (can't deliver a slice)
  ] };
  assert.deepEqual(o._campaignRoster().map((a) => a.name).sort(), ['A', 'B']);
});

test('CP1: _campaignAllFinished counts a RESERVE-held agent (in the plan roster, not in _active) → no premature reloop', () => {
  const o = mk();
  o._data = { posts: [{ id: 'P1' }, { id: 'P2' }], accounts: [], settings: {} };
  o._campaignPlan = { agentLists: { A: ['P1', 'P2'], B: ['P1', 'P2'] } };
  o._owed = {};
  o._active = [agent('A', ['g1'])]; // B held in reserve this cycle → NOT in _active (the churn condition)
  o._perAccountRotation = { A: { lastPostId: 'P2', lastPostedDate: o._localDayKey() }, B: { lastPostId: 'P1', lastPostedDate: o._localDayKey() } };
  assert.equal(o._campaignAllFinished(), false, 'B still owes P2 → NOT finished, even though B is not active (prevents the premature reloop = whole-library re-post burst)');
  assert.equal(o._campaignRemaining(), 1, 'exactly B\'s one remaining slice-post is counted');
  o._perAccountRotation.B = { lastPostId: 'P2', lastPostedDate: o._localDayKey() }; // B finishes too
  assert.equal(o._campaignAllFinished(), true, 'every agent in the plan roster finished → finished');
});

// ── CP2: warn (don't split) when same-cluster agents disagree on postFilter — splitting would over-deliver because
// filters OVERLAP (all ⊇ with-comments) and the per-(post,group) ledger dedups only within a cycle. ──────────────────
test('CP2: same-group campaign agents with DIFFERENT postFilter → one-time warning, still ONE cluster (no split)', () => {
  const logs = [];
  const o = new Orchestrator((channel, m) => { if (channel === 'automation-log') logs.push(m); }, {});
  const mixed = [{ ...agent('A', ['g1']), postFilter: 'all' }, { ...agent('B', ['g1']), postFilter: 'with-comments' }];
  const plan = o._computeCampaignPlan([{ id: 'P1', comment: 'x' }, { id: 'P2' }], mixed, 0);
  assert.equal(plan.clusters.length, 1, 'still ONE cluster (sig unchanged — splitting would over-deliver via overlapping filters)');
  assert.ok(logs.some((m) => /DIFFERENT post filters/i.test(m)), 'a warning fired about the mixed post filters');
});

test('CP2: uniform postFilter across a cluster → NO warning', () => {
  const logs = [];
  const o = new Orchestrator((channel, m) => { if (channel === 'automation-log') logs.push(m); }, {});
  o._computeCampaignPlan([{ id: 'P1' }, { id: 'P2' }], [agent('A', ['g1']), agent('B', ['g1'])], 0);
  assert.ok(!logs.some((m) => /DIFFERENT post filters/i.test(m)), 'no warning when filters agree');
});

// ── #2 (defer-to-next-round): a mid-round campaign edit must NOT re-partition slices or wipe pointers — recomputing
// mid-round restarts every agent at slice[0], re-posting the whole library to the shared IP (a re-burst = the ban-risk
// axis). _reconcileCampaignPlan builds the plan once, then FREEZES it; the edit is applied at the next round boundary. ──
test('#2: _reconcileCampaignPlan builds the plan on the FIRST call', () => {
  const o = mk();
  o._saveRotationState = () => true; // isolate from disk
  o._data = { posts: [{ id: 'P1' }, { id: 'P2' }], accounts: [], settings: {} };
  const agents = [agent('A', ['g1']), agent('B', ['g1'])];
  const fresh = o._computeCampaignPlan(o._data.posts, agents, 0);
  assert.equal(o._campaignPlan, null, 'no plan yet');
  o._reconcileCampaignPlan(fresh, agents, 2);
  assert.equal(o._campaignPlan, fresh, 'the first call installs the freshly-computed plan');
  assert.equal(o._pendingPlanBatchId, null, 'nothing pending after a clean first build');
});

test('#2: a mid-round EDIT is frozen — the active plan is not recomputed and pointers are preserved (no re-burst)', () => {
  const o = mk();
  o._saveRotationState = () => true;
  o._data = { posts: [{ id: 'P1' }, { id: 'P2' }], accounts: [], settings: {} };
  const agents = [agent('A', ['g1']), agent('B', ['g1'])];
  const original = o._computeCampaignPlan(o._data.posts, agents, 0); // A=[P1] B=[P2]
  o._reconcileCampaignPlan(original, agents, 2);
  // both agents have delivered their slice — their pointers are set
  o._perAccountRotation = { A: { lastPostId: 'P1', lastPostedDate: '2000-01-01' }, B: { lastPostId: 'P2', lastPostedDate: '2000-01-01' } };
  // operator adds a post mid-round → a DIFFERENT batchId (a genuine edit)
  const edited = o._computeCampaignPlan([{ id: 'P1' }, { id: 'P2' }, { id: 'P3' }], agents, 0);
  assert.notEqual(edited.batchId, original.batchId, 'the edit changed the batchId');
  o._reconcileCampaignPlan(edited, agents, 3);
  assert.equal(o._campaignPlan, original, 'the ACTIVE plan is unchanged (frozen) — NOT replaced by the edited one');
  assert.deepEqual(o._perAccountRotation.A, { lastPostId: 'P1', lastPostedDate: '2000-01-01' }, 'A\'s pointer preserved (no wipe → no re-post of P1)');
  assert.deepEqual(o._perAccountRotation.B, { lastPostId: 'P2', lastPostedDate: '2000-01-01' }, 'B\'s pointer preserved');
  assert.equal(o._pendingPlanBatchId, edited.batchId, 'the edit is recorded as pending for the next round');
});

test('#2: an agent REMOVED from the roster mid-round is pruned from the frozen plan (completion can\'t wedge)', () => {
  const o = mk();
  o._saveRotationState = () => true;
  o._data = { posts: [{ id: 'P1' }, { id: 'P2' }], accounts: [], settings: {} };
  const A = agent('A', ['g1']), B = agent('B', ['g1']);
  o._reconcileCampaignPlan(o._computeCampaignPlan(o._data.posts, [A, B], 0), [A, B], 2); // A=[P1] B=[P2]
  assert.ok(o._campaignPlan.agentLists.B, 'B starts in the plan');
  // operator turns B OFF → _campaignRoster() shrinks to [A]; reconcile is called with the shrunk roster
  const freshWithoutB = o._computeCampaignPlan(o._data.posts, [A], 0);
  o._reconcileCampaignPlan(freshWithoutB, [A], 2);
  assert.ok(!o._campaignPlan.agentLists.B, 'B\'s slice is pruned — its un-advanceable pointer can no longer wedge the loop/completion');
  assert.deepEqual(o._campaignPlan.agentLists.A, ['P1'], 'the SURVIVING agent A\'s slice is untouched (frozen; no re-partition, no re-burst)');
});

test('#2: a still-rostered agent (benched / reserve-held) is NOT pruned — CP1 no-premature-reloop preserved', () => {
  const o = mk();
  o._saveRotationState = () => true;
  o._data = { posts: [{ id: 'P1' }, { id: 'P2' }], accounts: [], settings: {} };
  const A = agent('A', ['g1']), B = agent('B', ['g1']);
  o._reconcileCampaignPlan(o._computeCampaignPlan(o._data.posts, [A, B], 0), [A, B], 2);
  // B is merely benched/held this cycle but STILL enabled in the roster → reconcile still receives [A, B]
  o._reconcileCampaignPlan(o._computeCampaignPlan(o._data.posts, [A, B], 0), [A, B], 2);
  assert.ok(o._campaignPlan.agentLists.B, 'B stays in the plan (still rostered) → still counted for completion, no premature reloop');
});

// ── #1: _outstandingWork must tally campaign-remaining over the PLAN ROSTER, not the per-cycle `active` set — else a
// cycle that reserves ALL campaign agents collapses undealt to 0 and completionMode declares a FALSE 100% and stops
// with campaign posts still owed (the CP1 active-vs-roster anti-pattern). Asserts `undealt` (not `total`, which reads
// pending/held off disk) so the campaign accounting is isolated. ──
test('#1: campaign-remaining is counted from the roster even when NO campaign agent is active this cycle (no false 100%)', () => {
  const o = mk();
  o._data = { posts: [{ id: 'P1' }, { id: 'P2' }], accounts: [], settings: {} };
  o._campaignPlan = { agentLists: { A: ['P1', 'P2'], B: ['P1', 'P2'] } }; // A owes P2, B owes P1+P2 → 3 remaining across the roster
  o._perAccountRotation = { A: { lastPostId: 'P1', lastPostedDate: '2000-01-01' }, B: {} };
  o._owed = {}; o._dealt = new Set(['P1', 'P2']); // the ONLY active agent is a FINISHED unique agent (all its posts dealt)
  const finishedUnique = { name: 'U', postingOrder: 'unique', assignedGroups: ['g1'], postFilter: 'all' };
  const out = o._outstandingWork([finishedUnique]); // active set has ZERO campaign agents (both reserved this cycle)
  assert.equal(out.undealt, 3, 'the 3 owed campaign slice-posts are counted from agentLists, not the empty active set (bug → 0)');
  assert.equal(out.hasFinite, true, 'hasFinite stays true so completion waits for the owed campaign work');
});

test('#1b: with only campaign agents and NONE active this cycle, hasFinite still comes from the roster', () => {
  const o = mk();
  o._data = { posts: [{ id: 'P1' }], accounts: [], settings: {} };
  o._campaignPlan = { agentLists: { A: ['P1'] } };
  o._perAccountRotation = {}; o._owed = {}; o._dealt = new Set();
  const out = o._outstandingWork([]); // no active agents at all
  assert.ok(out.undealt >= 1, 'roster campaign-remaining is counted');
  assert.equal(out.hasFinite, true, 'hasFinite comes from the roster → completion cannot falsely fire');
});

// [#7] ROSTER-SHRINK PRUNE MUST BE REVERSIBLE. The prune stops a departed agent's un-advanceable pointer from wedging
// completion — but deleting the slice made a routine disable→re-enable (fix a login, turn it back on) void that agent's
// posts FOREVER: nothing re-added the slice, cluster-mates hold disjoint partitions, and the freeze blocks
// redistribution. Every completion consumer reads agentLists, so those posts went INVISIBLE and the run reported
// "🎉 complete — every post published" with them never delivered. Park + restore, and surface a parked slice.
test('[#7] a departed agent\'s slice is PARKED (not deleted) and RESTORED when it returns — same round', () => {
  const o = mk();
  const A = { name: 'A', postingOrder: 'campaign-plan', enabled: true, assignedGroups: ['g1'], standby: false };
  const B = { name: 'B', postingOrder: 'campaign-plan', enabled: true, assignedGroups: ['g1'], standby: false };
  o._saveRotationState = () => true;
  o._campaignPlan = { batchId: 'b1', agentLists: { A: ['P1', 'P3'], B: ['P2', 'P4'] }, clusters: [], roundOffset: 0 };
  const fresh = { batchId: 'b1', agentLists: {}, clusters: [] };

  o._reconcileCampaignPlan(fresh, [A], 4);          // B left (operator disabled it)
  assert.ok(!o._campaignPlan.agentLists.B, 'B is pruned from agentLists so its stuck pointer cannot wedge completion');
  assert.deepEqual(o._campaignPlan.parkedLists.B, ['P2', 'P4'], 'B\'s slice is PARKED, not destroyed — else its posts are delivered by nobody and completion falsely reports 100%');
  assert.deepEqual(o._campaignPlan.agentLists.A, ['P1', 'P3'], 'a surviving agent\'s slice is untouched (no re-partition → no re-burst)');

  o._reconcileCampaignPlan(fresh, [A, B], 4);       // operator re-enables B
  assert.deepEqual(o._campaignPlan.agentLists.B, ['P2', 'P4'], 'B rejoined → its parked slice is restored, resuming where it left off');
  assert.ok(!o._campaignPlan.parkedLists.B, 'and it is no longer parked');
});

test('[#7] a parked slice is NOT restored across a round/library change (batchId differs → next round assigns it)', () => {
  const o = mk();
  const B = { name: 'B', postingOrder: 'campaign-plan', enabled: true, assignedGroups: ['g1'], standby: false };
  o._saveRotationState = () => true;
  o._campaignPlan = { batchId: 'b1', agentLists: {}, parkedLists: { B: ['P2', 'P4'] }, clusters: [], roundOffset: 0 };
  // Same-round restore is keyed on the PLAN's own batchId, which the freeze never mutates mid-round; a library edit
  // only sets _pendingPlanBatchId. So a returning agent restores here, and the next ROUND recomputes partitions afresh.
  o._reconcileCampaignPlan({ batchId: 'b2-edited', agentLists: {}, clusters: [] }, [B], 4);
  assert.deepEqual(o._campaignPlan.agentLists.B, ['P2', 'P4'], 'B returns within the SAME frozen round → slice restored (the pending edit is still deferred to the next round)');
  assert.equal(o._pendingPlanBatchId, 'b2-edited', 'and the library edit is still held for the next round');
});
