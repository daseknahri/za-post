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
