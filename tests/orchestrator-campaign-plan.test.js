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
