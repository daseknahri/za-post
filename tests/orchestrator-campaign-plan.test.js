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

// NOTE: this test previously ASSERTED the opposite of its own title — it required the slice to be restored on a batchId
// mismatch — and passed, codifying a double-post: the frozen plan partitions by CLUSTER sig, but delivery targets are
// read LIVE, so restoring an agent RE-PURPOSED to different groups hands it its OLD cluster's partition and it delivers
// that into its NEW cluster's groups (which those members already covered). The title was right; the assertion was
// wrong. Fixed to match the title, and the guard it describes is now actually implemented.
test('[#7] a parked slice is NOT restored across a roster/library change (batchId differs → next round assigns it)', () => {
  const o = mk();
  const B = { name: 'B', postingOrder: 'campaign-plan', enabled: true, assignedGroups: ['g2'], standby: false }; // re-purposed: was on g1 when parked
  o._saveRotationState = () => true;
  o._campaignPlan = { batchId: 'b1', agentLists: {}, parkedLists: { B: ['P2', 'P4'] }, clusters: [], roundOffset: 0 };
  o._reconcileCampaignPlan({ batchId: 'b2-changed', agentLists: {}, clusters: [] }, [B], 4);
  assert.ok(!o._campaignPlan.agentLists.B, 'B must NOT get its old partition back after a roster/library change — it would deliver its OLD cluster\'s posts into its NEW groups (a double-post)');
  assert.deepEqual(o._campaignPlan.parkedLists.B, ['P2', 'P4'], 'the slice stays PARKED (a strand, surfaced at completion) until the next round re-partitions it — strand, never re-burst');
  assert.equal(o._pendingPlanBatchId, 'b2-changed', 'and the edit is still held for the next round');
});

test('[#7] a parked slice IS restored when the agent returns UNCHANGED (same batchId → same partition is still valid)', () => {
  const o = mk();
  const B = { name: 'B', postingOrder: 'campaign-plan', enabled: true, assignedGroups: ['g1'], standby: false };
  o._saveRotationState = () => true;
  o._campaignPlan = { batchId: 'b1', agentLists: {}, parkedLists: { B: ['P2', 'P4'] }, clusters: [], roundOffset: 0 };
  o._reconcileCampaignPlan({ batchId: 'b1', agentLists: {}, clusters: [] }, [B], 4); // nothing changed → fresh hashes to the SAME batchId
  assert.deepEqual(o._campaignPlan.agentLists.B, ['P2', 'P4'], 'an unchanged agent (disable→re-enable to fix a login) resumes its exact slice — that is the whole point of parking');
  assert.ok(!o._campaignPlan.parkedLists.B, 'and it is no longer parked');
});

// [#4] AN UNRESOLVABLE SLICE POINTER MUST NOT RESTART THE SLICE. `indexOf(lastPostId)` returns -1 when the pointer does
// not belong to this slice — e.g. the operator flipped the agent to daily-rotation (whose run overwrites lastPostId with
// a rotation post) and back. `-1 + 1 = 0` silently restarted the agent at element 0 and re-posted its whole delivered
// slice on the shared IP. Campaign-plan has no durable per-(post,group) guard, so nothing caught it.
test('[#4] an unresolvable lastPostId is treated as CONSUMED, never restarted at 0', () => {
  const o = mk();
  o._data = { posts: [{ id: 'P1' }, { id: 'P2' }, { id: 'P3' }, { id: 'R9' }], accounts: [], groups: [], settings: {} };
  o._campaignPlan = { batchId: 'b1', agentLists: { A: ['P1', 'P2', 'P3'] }, clusters: [] };

  o._perAccountRotation = { A: { lastPostId: 'R9' } }; // a daily-rotation post — not in A's campaign slice
  assert.deepEqual(o._campaignNextIdx('A'), { idx: 3, len: 3 }, 'pointer not in this slice → CONSUMED (idx===len → nothing left), not idx 0 which would re-post P1,P2,P3');

  o._perAccountRotation = { A: { lastPostId: 'P2' } };  // a normal, resolvable pointer
  assert.deepEqual(o._campaignNextIdx('A'), { idx: 2, len: 3 }, 'a resolvable pointer still advances normally');

  o._perAccountRotation = { A: {} };                    // a genuinely fresh agent
  assert.deepEqual(o._campaignNextIdx('A'), { idx: 0, len: 3 }, 'no pointer at all → correctly starts at the beginning');
});

// [#5] DAILY-ROTATION MUST NOT WRAP WITHIN ONE LOCAL DAY. The pointer advance is `% list.length`, so when cyclesPerDay
// exceeds the agent's eligible library the pointer wraps and re-delivers a post the agent ALREADY posted today — same
// groups, ~45-90 min apart, on the one shared IP. daily-rotation legitimately re-delivers across DAYS (which is why it
// has no durable per-(post,group) guard), but a same-day repeat is a spam burst. The cyclesPerDay gate only counts N;
// it never notices the library is smaller than N.
test('[#5] daily-rotation stops after ONE full library pass per day (never wraps into a same-day re-post)', () => {
  const o = mk();
  const today = o._localDayKey();
  const A = { name: 'A', assignedGroups: ['g1'], postingOrder: 'daily-rotation', postFilter: 'all', enabled: true, status: 'logged_in' };
  o._data = { accounts: [A], groups: [{ id: 'g1', groupId: 'g1' }], posts: [{ id: 'P1' }, { id: 'P2' }], settings: { cyclesPerDay: 5 } }; // N=5 > library of 2
  o._owed = {};

  // Already delivered both posts today → a 3rd pick would wrap to P1 and re-post it hours after the first.
  o._perAccountRotation = { A: { lastPostId: 'P2', lastPostedDate: today, postsToday: 2, postsTodayDate: today } };
  assert.deepEqual(o._postsForAccount(A, 0, false), [], 'whole library covered today → nothing more today (the old `% list.length` wrapped to P1 = a same-day re-post)');

  // Mid-pass is unaffected: one delivered, one to go.
  o._perAccountRotation = { A: { lastPostId: 'P1', lastPostedDate: today, postsToday: 1, postsTodayDate: today } };
  assert.deepEqual(o._postsForAccount(A, 0, false).map((p) => p.id), ['P2'], 'a partial pass still advances normally');

  // A NEW day resets the pass — cross-day re-delivery is the mode's whole point and must still work.
  o._perAccountRotation = { A: { lastPostId: 'P2', lastPostedDate: '2000-01-01', postsToday: 2, postsTodayDate: '2000-01-01' } };
  assert.deepEqual(o._postsForAccount(A, 0, false).map((p) => p.id), ['P1'], 'next day → wraps to P1 as designed (cross-day rotation is intended)');
});

// ─── ADR-0023 PHASE 1: campaignMinAgents (floor the spread) ──────────────────────────────────────────
// Pass 2 paces a FAST group-set by benching some of its agents so it spans the SLOWEST set's day-count.
// That is why healthy accounts sit idle for a whole round. campaignMinAgents floors how many agents the
// fast set keeps active. It buys NO throughput (the set delivers the same posts either way) — it spreads
// the same work over more accounts in fewer days. Every test below uses the :79 fixture's topology:
// cluster X = 2 agents/g1 → 2 posts each = the pace-setter (globalMaxLen 2, skipped by Pass 2);
// cluster Y = 4 agents/g2 → natural Keff = ceil(4/2) = 2, so 2 of its 4 agents are benched.
const _spreadFixture = () => ({
  posts: [1, 2, 3, 4].map((n) => ({ id: 'P' + n })),
  agents: [agent('X0', ['g1']), agent('X1', ['g1']), agent('Y0', ['g2']), agent('Y1', ['g2']), agent('Y2', ['g2']), agent('Y3', ['g2'])],
});
const _yLens = (plan) => ['Y0', 'Y1', 'Y2', 'Y3'].map((n) => plan.agentLists[n].length).sort();
const _withDial = (v) => { const o = mk(); const f = _spreadFixture(); o._data = { posts: f.posts, settings: { campaignMinAgents: v }, accounts: [] }; return { o, f }; };

test('[ADR-0023 P1] campaignMinAgents floors Keff — at minAgents = K nobody is benched', () => {
  const { o, f } = _withDial(4);
  const plan = o._computeCampaignPlan(f.posts, f.agents, 0);
  assert.deepEqual(_yLens(plan), [1, 1, 1, 1], 'all 4 agents of the fast set are seated (was [0,0,2,2] — 2 healthy accounts benched)');
  // The whole point of the min(K,…) OUTER clamp: the set still delivers exactly its 4 posts, once each.
  const delivered = ['Y0', 'Y1', 'Y2', 'Y3'].flatMap((n) => plan.agentLists[n]);
  assert.deepEqual(delivered.slice().sort(), ['P1', 'P2', 'P3', 'P4'], 'coverage is exact — flooring redistributes work, it never duplicates it');
  assert.equal(new Set(delivered).size, delivered.length, 'no post is handed to two agents in the same group-set (a double-post on one IP)');
  // And the pace-setter is untouched: Pass 2 skips it (curLen >= globalMaxLen), so the floor can never speed up the slowest set.
  assert.equal(plan.agentLists.X0.length, 2);
  assert.equal(plan.agentLists.X1.length, 2);
});

test('[ADR-0023 P1] campaignMinAgents can NEVER invent a seat the cluster does not have', () => {
  // Guards the clamp ORDER. max(1, minAgents, min(K, need)) would compute Keff=99 here, and `idx % 99 === rank`
  // hands agent 0 exactly one post and every other agent nothing — silent under-delivery of the whole library.
  const { o, f } = _withDial(99);
  const plan = o._computeCampaignPlan(f.posts, f.agents, 0);
  assert.deepEqual(_yLens(plan), [1, 1, 1, 1], 'Keff is capped at the cluster size (4), not the dial (99)');
  assert.equal(Object.keys(plan.agentLists).length, 6, 'no phantom agents');
  assert.deepEqual(['Y0', 'Y1', 'Y2', 'Y3'].flatMap((n) => plan.agentLists[n]).sort(), ['P1', 'P2', 'P3', 'P4'], 'still exactly the whole set, once each');
});

test('[ADR-0023 P1] campaignMinAgents does NOT reach the batchId fingerprint', () => {
  // THE regression pin for ADR-0023's most expensive possible mistake. batchId is DURABLE and compared ACROSS
  // VERSIONS: if the dial entered the fingerprint, every persisted plan would mismatch forever on upgrade —
  // permanently disabling the parked-slice restore and firing the "campaign edited" notice unprovoked.
  const f = _spreadFixture();
  const ids = [undefined, 0, 4, 99].map((v) => {
    const o = mk();
    if (v !== undefined) o._data = { posts: f.posts, settings: { campaignMinAgents: v }, accounts: [] };
    return o._computeCampaignPlan(f.posts, f.agents, 0).batchId;
  });
  assert.deepEqual(ids, ['174182176', '174182176', '174182176', '174182176'], 'the fingerprint is a function of posts+agents ONLY — never the dial');
});

test('[ADR-0023 P1] campaignMinAgents default/absent is a byte-identical no-op (and _data may be unset)', () => {
  // _computeCampaignPlan is called directly by ~20 test call-sites on an orchestrator whose _data is NEVER set by
  // the constructor. An unguarded this._data.settings read throws here. It is also the live contract: the dial must
  // change nothing until the operator opts in.
  const f = _spreadFixture();
  const bare = mk()._computeCampaignPlan(f.posts, f.agents, 0); // no _data at all
  assert.deepEqual(_yLens(bare), [0, 0, 2, 2], 'no _data → today’s spread, no crash');
  const empty = _withDial(undefined); empty.o._data.settings = {};
  assert.deepEqual(_yLens(empty.o._computeCampaignPlan(f.posts, f.agents, 0)), [0, 0, 2, 2], 'settings without the key → today’s spread');
  assert.deepEqual(_yLens(_withDial(0).o._computeCampaignPlan(f.posts, f.agents, 0)), [0, 0, 2, 2], 'explicit 0 = off');
});

test('[ADR-0023 P1] campaignMinAgents garbage → off, never NaN-benches the whole fleet', () => {
  // clampSettings has NO key whitelist, so an unknown key persists untouched: a hand-edited data.json or the HTTP
  // API can land a string here. Number('garbage') is NaN → Keff NaN → `rank < NaN` is FALSE for every rank →
  // EVERY agent gets [] → the campaign silently delivers nothing at all. The engine must not trust the store.
  for (const junk of ['garbage', null, NaN, -4, {}]) {
    const { o, f } = _withDial(junk);
    const plan = o._computeCampaignPlan(f.posts, f.agents, 0);
    assert.deepEqual(_yLens(plan), [0, 0, 2, 2], `campaignMinAgents=${JSON.stringify(junk)} → today’s behavior, NOT a fleet-wide bench`);
    assert.ok(['Y0', 'Y1', 'Y2', 'Y3'].some((n) => plan.agentLists[n].length), 'at least one agent still posts');
  }
});

test('[ADR-0023 P1] the partition property holds for EVERY floor value (coverage exact, zero dupes)', () => {
  const f = _spreadFixture();
  for (let dial = 0; dial <= 6; dial++) {
    const { o } = _withDial(dial);
    const plan = o._computeCampaignPlan(f.posts, f.agents, 0);
    for (const cluster of [['X0', 'X1'], ['Y0', 'Y1', 'Y2', 'Y3']]) {
      const got = cluster.flatMap((n) => plan.agentLists[n]);
      assert.deepEqual(got.slice().sort(), ['P1', 'P2', 'P3', 'P4'], `dial=${dial}: cluster covers the library exactly once`);
      assert.equal(new Set(got).size, got.length, `dial=${dial}: no duplicate (post,group) pair`);
    }
  }
});

test('[ADR-0023 P1] the benched subset ROTATES — across K rounds every agent takes a turn', () => {
  // Pins the ":39-40" promise that no agent idles forever. Untested until now: a broken `shift` would silently
  // bench the SAME accounts every round, which is indistinguishable from "5 accounts are dead" in the logs.
  const f = _spreadFixture();
  const seen = new Set();
  for (let round = 0; round < 4; round++) {
    const plan = mk()._computeCampaignPlan(f.posts, f.agents, round);
    for (const n of ['Y0', 'Y1', 'Y2', 'Y3']) if (plan.agentLists[n].length) seen.add(n);
  }
  assert.deepEqual([...seen].sort(), ['Y0', 'Y1', 'Y2', 'Y3'], 'over 4 rounds every agent of the benched cluster posts at least once');
});

// ─── ADR-0023 PHASE 2(a): idle attribution ───────────────────────────────────────────────────────────
// Five distinct causes reach the same `return []` in _postsForAccount, and the two operator-facing surfaces
// used to guess between two of them. The headline defect: a BENCHED agent has an EMPTY slice, so
// _campaignNextIdx returns {idx:0,len:0} and `idx >= len` is trivially true — the planning header reported it
// as "✓ slice complete". An account that was never given work was reported as having finished its work. That
// is why a 5-account bench was misread and mis-blamed. These tests pin each cause to its own label.
test('[ADR-0023 P2] a BENCHED agent is NOT reported as "slice complete"', () => {
  const { o, f } = _withDial(0);
  o._campaignPlan = o._computeCampaignPlan(f.posts, f.agents, 0);
  o._active = f.agents;
  const benched = ['Y0', 'Y1', 'Y2', 'Y3'].find((n) => !o._campaignPlan.agentLists[n].length);
  assert.ok(benched, 'fixture sanity: the spread pass benched someone');
  const why = o._campaignIdleReason({ name: benched, postingOrder: 'campaign-plan' });
  assert.match(why, /BENCHED/, 'the bench is named outright');
  assert.doesNotMatch(why, /finished its slice/, 'THE BUG: it never had a slice to finish');
  assert.match(why, /Minimum active agents/, 'and the operator is told which dial seats it');
});

test('[ADR-0023 P2] an EXHAUSTED slice is still reported as complete (the fix must not over-fire)', () => {
  const { o, f } = _withDial(0);
  o._data.settings.cyclesPerDay = 20;
  o._campaignPlan = o._computeCampaignPlan(f.posts, f.agents, 0);
  o._active = f.agents;
  const worker = ['Y0', 'Y1', 'Y2', 'Y3'].find((n) => o._campaignPlan.agentLists[n].length);
  const slice = o._campaignPlan.agentLists[worker];
  o._perAccountRotation = { [worker]: { lastPostId: slice[slice.length - 1] } }; // pointer at the end = genuinely done
  assert.match(o._campaignIdleReason({ name: worker, postingOrder: 'campaign-plan' }), /finished its slice/, 'a real completion still reads as complete');
});

test('[ADR-0023 P2] a PARKED slice is reported as parked, not complete', () => {
  const { o, f } = _withDial(0);
  o._campaignPlan = o._computeCampaignPlan(f.posts, f.agents, 0);
  o._active = f.agents;
  const worker = ['Y0', 'Y1', 'Y2', 'Y3'].find((n) => o._campaignPlan.agentLists[n].length);
  // Park it exactly the way _reconcileCampaignPlan does when an agent leaves the campaign.
  o._campaignPlan.parkedLists = { [worker]: o._campaignPlan.agentLists[worker] };
  o._campaignPlan.agentLists[worker] = [];
  assert.match(o._campaignIdleReason({ name: worker, postingOrder: 'campaign-plan' }), /PARKED/, 'a parked slice is a strand the operator can undo — not a completion');
});

test('[ADR-0023 P2] a reserve-HELD agent is not reported as benched', () => {
  // Gate ORDER matters: an agent can be BOTH held in reserve this cycle AND hold a non-empty slice. Checking the
  // slice first would blame the planner for what "Reserve accounts" did.
  const { o, f } = _withDial(0);
  o._campaignPlan = o._computeCampaignPlan(f.posts, f.agents, 0);
  const worker = ['Y0', 'Y1', 'Y2', 'Y3'].find((n) => o._campaignPlan.agentLists[n].length);
  o._active = f.agents.filter((a) => a.name !== worker); // held back this cycle
  const why = o._campaignIdleReason({ name: worker, postingOrder: 'campaign-plan' });
  assert.match(why, /held back/, 'the reserve hold is named');
  assert.doesNotMatch(why, /BENCHED/, 'not blamed on the spread pass');
});

test('[ADR-0023 P2] _campaignIdleReason never spends the manual-run one-shot bypass', () => {
  // _dailyQuotaBlocks CONSUMES the manual-Start bypass when claim=true. If a diagnostic spent it, the real pick
  // would then be quota-blocked and the account would post NOTHING — a log line that silently costs a delivery.
  const { o, f } = _withDial(0);
  o._campaignPlan = o._computeCampaignPlan(f.posts, f.agents, 0);
  o._active = f.agents;
  const worker = ['Y0', 'Y1', 'Y2', 'Y3'].find((n) => o._campaignPlan.agentLists[n].length);
  o._manualRun = true;
  o._manualBypassUsed = new Set();
  o._campaignIdleReason({ name: worker, postingOrder: 'campaign-plan' });
  assert.equal(o._manualBypassUsed.size, 0, 'the diagnostic read state without moving it');
});

test('[ADR-0023 P2] the planning header no longer calls a benched agent "slice complete"', () => {
  // The end-to-end surface: what the operator actually reads each cycle.
  const { o, f } = _withDial(0);
  o._campaignPlan = o._computeCampaignPlan(f.posts, f.agents, 0);
  o._active = f.agents;
  const benched = ['Y0', 'Y1', 'Y2', 'Y3'].find((n) => !o._campaignPlan.agentLists[n].length);
  const line = `[${benched}] → ${o._campaignIdleReason({ name: benched, postingOrder: 'campaign-plan' }) || 'nothing to post'}`;
  assert.doesNotMatch(line, /✓ slice complete/, 'the old lie is gone');
  assert.match(line, /BENCHED/);
});

// ── the label must never recommend a remedy that provably cannot work ──────────────────────────────────
test('[ADR-0023 P2] a cluster with MORE AGENTS THAN POSTS is not blamed on the spread pass', () => {
  // A cluster can never seat more agents than it has posts (rank >= P gets nothing for ANY Keff), so the surplus is
  // benched by ARITHMETIC and campaignMinAgents cannot seat them. The old text said "raise Minimum active agents" —
  // which at the dial's own maximum reads "the floor is 100 — raise it". Advice that cannot work sends the operator
  // to Start Fresh, i.e. a whole-library re-burst.
  const o = mk();
  const posts = [1, 2, 3].map((n) => ({ id: 'P' + n }));
  const agents = [agent('A0', ['g1']), agent('A1', ['g1']), agent('A2', ['g1']), agent('A3', ['g1']), agent('A4', ['g1'])]; // 5 agents, 3 posts
  o._data = { posts, settings: { campaignMinAgents: 100 }, accounts: [] }; // the dial at its clamp MAXIMUM
  o._campaignPlan = o._computeCampaignPlan(posts, agents, 0);
  o._active = agents;
  const idle = ['A0', 'A1', 'A2', 'A3', 'A4'].find((n) => !o._campaignPlan.agentLists[n].length);
  assert.ok(idle, 'fixture sanity: 5 agents cannot all hold one of 3 posts');
  const why = o._campaignIdleReason({ name: idle, postingOrder: 'campaign-plan' });
  assert.match(why, /more accounts than posts|only 3 post/, 'the real cause (a post shortage) is named');
  assert.doesNotMatch(why, /Raise "Minimum active agents"/, 'and the dial is NOT offered as the fix — it cannot seat them');
});

test('[ADR-0023 P2] an empty post-set is named as such, not as a bench', () => {
  const o = mk();
  const posts = [{ id: 'P1', postSetId: 'setA' }];
  const agents = [{ ...agent('B0', ['g1']), postSetId: 'setEMPTY' }, { ...agent('B1', ['g1']), postSetId: 'setEMPTY' }];
  o._data = { posts, settings: {}, accounts: [] };
  o._campaignPlan = o._computeCampaignPlan(posts, agents, 0);
  o._active = agents;
  assert.match(o._campaignIdleReason({ name: 'B0', postingOrder: 'campaign-plan' }), /NO posts/, 'an empty post-set is a misconfiguration, not a spread-pass bench');
});

test('[ADR-0023 P2] the anti-burst spacing floor is NOT reported as a spent daily quota', () => {
  // _dailyQuotaBlocks says "blocked" for two unrelated reasons. At cyclesPerDay=20 with ONE post delivered a minute
  // ago, the agent is inside the spacing floor — it has used 1 of 20, not "today's quota". Telling the operator the
  // quota is spent points them at a dial that is not the cause.
  const o = mk();
  const posts = [1, 2, 3, 4].map((n) => ({ id: 'P' + n }));
  const agents = [agent('A', ['g1']), agent('B', ['g1'])];
  o._data = { posts, settings: { cyclesPerDay: 20, waitIntervalMin: 90 }, accounts: [] };
  o._campaignPlan = o._computeCampaignPlan(posts, agents, 0);
  o._active = agents;
  const today = o._localDayKey();
  o._perAccountRotation = { A: { postsToday: 1, postsTodayDate: today, lastPostedDate: today, lastPostedAt: Date.now() - 60 * 1000 } };
  const why = o._campaignIdleReason({ name: 'A', postingOrder: 'campaign-plan' });
  assert.match(why, /spacing floor/, 'the real cause is the spacing floor');
  assert.doesNotMatch(why, /already used today's quota/, 'THE REGRESSION: 1 of 20 posts is not an exhausted quota');
  // and a genuinely exhausted quota still reads as one
  o._perAccountRotation = { A: { postsToday: 20, postsTodayDate: today, lastPostedDate: today, lastPostedAt: Date.now() - 60 * 60 * 1000 } };
  assert.match(o._campaignIdleReason({ name: 'A', postingOrder: 'campaign-plan' }), /already used today's quota of 20/, 'a real quota exhaustion is still named');
});

test('[ADR-0023 P2] a manual-Start bypass is not mislabeled as a quota block', () => {
  // The REAL pick (claim=true) consumes the one-shot. If the diagnostic then re-asks, it sees the bypass already spent
  // and reports a quota block for a pick that was explicitly NOT quota-blocked. The caller must pass what it saw
  // BEFORE the pick.
  const o = mk();
  const posts = [1, 2].map((n) => ({ id: 'P' + n }));
  const agents = [agent('A', ['g1']), agent('B', ['g1'])];
  o._data = { posts, settings: { cyclesPerDay: 1 }, accounts: [] };
  o._campaignPlan = o._computeCampaignPlan(posts, agents, 0);
  o._active = agents;
  const today = o._localDayKey();
  // A finished its slice AND posted today — the manual bypass is granted, so the pick is not quota-blocked; the real
  // reason it returns [] is that the slice is done.
  o._perAccountRotation = { A: { lastPostId: o._campaignPlan.agentLists.A[o._campaignPlan.agentLists.A.length - 1], postsToday: 1, postsTodayDate: today, lastPostedDate: today, lastPostedAt: Date.now() } };
  o._manualRun = true;
  o._manualBypassUsed = new Set(['A']); // already spent by the real pick, exactly as _runAccount leaves it
  assert.match(o._campaignIdleReason({ name: 'A', postingOrder: 'campaign-plan' }, true), /finished its slice/, 'with the pre-pick bypass state passed in, the true cause survives');
  assert.doesNotMatch(o._campaignIdleReason({ name: 'A', postingOrder: 'campaign-plan' }, true), /quota/, 'and the quota is not blamed for a pick that bypassed it');
});

// ── ADR-0023 P3: a BENCHED agent must still be able to discharge an owed obligation ───────────────────
// The empty-slice guard sat ABOVE the owed block, so a benched agent could never reach its discharge path. Because a
// benched agent is still a key of agentLists ([] assigned, not deleted), _campaignAllFinished's owed check then
// returned false forever: the reloop never fires and the campaign stops dead, restart-durable. Dormant at K=1;
// it arms the moment accounts are re-enabled into shared group-sets.
const _wedgeFixture = () => {
  const o = mk();
  o._data = { posts: [{ id: 'P1' }, { id: 'P2' }], settings: { cyclesPerDay: 20 }, accounts: [], groups: [{ id: 'g1', groupId: 'G1' }, { id: 'g2', groupId: 'G2' }] };
  o._campaignPlan = { batchId: 'b', agentLists: { A1: ['P1', 'P2'], A2: [] }, clusters: [{ groupKey: 'g1|g2::', agents: ['A1', 'A2'], totalPosts: 2, days: 2 }] };
  o._perAccountRotation = { A1: { lastPostId: 'P2' }, A2: {} };
  return o;
};
const _A2 = { name: 'A2', postingOrder: 'campaign-plan', postFilter: 'all', assignedGroups: ['g1', 'g2'] };

test('[ADR-0023 P3] a BENCHED agent can still discharge an owed obligation (the permanent wedge)', () => {
  const o = _wedgeFixture();
  o._owed = { A2: { postId: 'P1', gids: ['G2'] } };
  assert.deepEqual(o._campaignPlan.agentLists.A2, [], 'A2 must be benched for this test to mean anything');
  const picked = o._postsForAccount(_A2, 0, true).map((p) => p.id);
  assert.deepEqual(picked, ['P1'], 'a benched agent MUST still be able to finish the un-reached groups of a post it already partially delivered — otherwise its owed entry blocks _campaignAllFinished forever');
});

test('[ADR-0023 P3] a benched agent with a STALE owed drops it and self-heals (no wedge)', () => {
  const o = _wedgeFixture();
  o._owed = { A2: { postId: 'GONE', gids: ['G2'] } }; // post no longer in the library
  const picked = o._postsForAccount(_A2, 0, true);
  assert.deepEqual(picked, [], 'nothing to deliver');
  assert.equal(o._owed.A2, undefined, 'the stale obligation must be DROPPED on a claim, else it wedges the reloop forever');
  assert.equal(o._campaignAllFinished(), true, 'with the stale entry dropped the round can complete and reloop');
});

test('[ADR-0023 P3] a benched agent with NO owed is unchanged — and never spends the manual one-shot', () => {
  const o = _wedgeFixture();
  o._owed = {};
  o._manualRun = true; o._manualBypassUsed = new Set();
  assert.deepEqual(o._postsForAccount(_A2, 0, true), [], 'benched with nothing owed still idles');
  assert.ok(!o._manualBypassUsed.has('A2'), 'the common benched path must not even reach the quota gate — spending its one-shot would make a later manual Start post nothing');
});

// ── ADR-0023 P3: the seats readout must not manufacture the very inference it exists to prevent ───────
const _seatLogs = (plan, settings, data) => { const L = []; const o = mk(); o.log = (m) => L.push(String(m)); o._data = { posts: [], groups: [], accounts: [], settings: settings || {}, ...(data || {}) }; o._logPlanSeats(plan); return L; };
const _noBenchPlan = { agentLists: { a1: ['P1', 'P2'] }, clusters: [{ groupKey: 'g1::', agents: ['a1'], totalPosts: 2, days: 2 }] };

test('[ADR-0023 P3] no bench + dial off → the seats readout stays SILENT (a 1/1 ratio reads as a cap)', () => {
  // "1/1 seat(s)" on a fleet with no bench invites: raise the dial → byte-identical plan → "it's broken" → Start
  // Fresh → whole-library re-burst. That is the exact chain this readout was added to prevent.
  assert.deepEqual(_seatLogs(_noBenchPlan, { campaignMinAgents: 0 }), [], 'nothing is sitting out and the dial is off — there is nothing truthful to report');
});

test('[ADR-0023 P3] dial SET but nothing to seat → say so (a silent dial is a dial that looks broken)', () => {
  const L = _seatLogs(_noBenchPlan, { campaignMinAgents: 6 });
  assert.equal(L.length, 1, 'an operator waiting for an effect must be told there is none');
  assert.match(L[0], /nothing to seat|changes nothing/i);
  assert.doesNotMatch(L[0], /1\/1 seat/, 'still no cap-like ratio');
});

test('[ADR-0023 P3] the seats dedupe key includes the dial — editing it always re-prints', () => {
  // The dial was in the MESSAGE but not the KEY, so an edit that produced an identical plan (the inert case — the
  // common one) printed NOTHING. The one readout that exists to show the dial's effect was silent exactly when the
  // operator most needed an answer.
  const o = mk(); const L = []; o.log = (m) => L.push(String(m));
  o._data = { posts: [], groups: [], accounts: [], settings: { campaignMinAgents: 0 } };
  o._logPlanSeats(_noBenchPlan);
  o._data.settings.campaignMinAgents = 6;   // operator edits the dial; the plan is unchanged
  o._logPlanSeats(_noBenchPlan);
  assert.equal(L.length, 1, 'the dial change must produce a line even though the plan is identical');
  assert.match(L[0], /set to 6/);
});

test('[ADR-0023 P3] the plan span is reported in CYCLES + real days, never "1 post/day"', () => {
  // A 30-post slice at cyclesPerDay=20 burns in ~2 days, not 30. The Plan panel already says "cycle"; the log said
  // "day(s)" — a 15x overstatement of how long the operator's groups are shielded from the whole library.
  const o = mk();
  o._data = { posts: [], groups: [], accounts: [], settings: { cyclesPerDay: 20, cycleGapMin: 2 } };
  assert.equal(o._effectiveDailyPosts(), 20, 'cyclesPerDay binds when the spacing floor allows more');
  assert.match(o._planSpanLabel(30), /30 cycle\(s\).*2 day\(s\)/, '30 cycles at 20/day is 2 days');
  const o1 = mk();
  o1._data = { posts: [], groups: [], accounts: [], settings: { cyclesPerDay: 1 } };
  assert.equal(o1._effectiveDailyPosts(), 1, 'the classic 1/day model is unchanged');
  assert.match(o1._planSpanLabel(30), /30 cycle\(s\).*30 day\(s\)/, 'at 1/day cycles and days coincide — old meaning preserved');
});
