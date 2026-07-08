// tests/orchestrator-owed-rest-standin.test.js
// REGRESSION for the interaction defects found by the 1.0.8 cross-feature audit (attention-rest × owed-ledger ×
// reserve stand-in): a dropped/rested agent that still OWES an earlier partial post must NOT be advanced to its next
// slice by a stand-in — otherwise the owed groups are stranded and the owed entry is silently clobbered on reconcile.
// Fixes: (1) _reconcileOwedFor clears only the owed entry whose post it actually reconciled (postId guard);
// (2) _immediateStandin + _campaignStandins SKIP an agent with a live persistent owed (the owed-standins path finishes
// that post to only its un-reached groups — one coverage path, no over-delivery, no double-post).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const worker = require('../automation/worker');
worker.runAccount = async () => ({ posted: 0, errors: 0, pendingApproval: 0, noRetry: false, flag: null, postedIds: [], dealtIds: [], fullyPosted: true, offline: false, progressed: true });
const { Orchestrator } = require('../automation/orchestrator');

const CP = (name, groups) => ({ name, assignedGroups: groups, postingOrder: 'campaign-plan', enabled: true, status: 'logged_in', standby: false });
const R = (name, groups) => ({ name, assignedGroups: groups, postingOrder: 'campaign-plan', enabled: true, status: 'logged_in', standby: true });

test('_reconcileOwedFor: an obligation for post Q must NOT delete a standing owed entry for a DIFFERENT post P', () => {
  const o = new Orchestrator(() => {}, {});
  o._data = { accounts: [CP('A', ['g1', 'g2', 'g3'])] };
  o._cycleDelivered = new Set(['Q::g1', 'Q::g2']);              // Q fully delivered to its obligation groups (campaign → fleet-wide key)
  o._cycleObligation = { A: { postId: 'Q', expectedGids: ['g1', 'g2'] } };
  o._owed = { A: { postId: 'P', gids: ['g3'] } };               // A still owes an EARLIER post P
  o._reconcileOwedFor('A');
  assert.deepEqual(o._owed.A, { postId: 'P', gids: ['g3'] }, 'owed for P must SURVIVE — a Q obligation must never clobber a different post\'s owed');
});

test('_reconcileOwedFor: an obligation for post P DOES clear its own fully-delivered owed entry', () => {
  const o = new Orchestrator(() => {}, {});
  o._data = { accounts: [CP('A', ['g1', 'g2'])] };
  o._cycleDelivered = new Set(['P::g1', 'P::g2']);
  o._cycleObligation = { A: { postId: 'P', expectedGids: ['g1', 'g2'] } };
  o._owed = { A: { postId: 'P', gids: ['g1', 'g2'] } };
  o._reconcileOwedFor('A');
  assert.equal(o._owed.A, undefined, 'P fully delivered → its OWN owed entry is cleared (postId matches)');
});

test('_immediateStandin: a NON-owed campaign drop is covered, an OWED agent is skipped', () => {
  const o = new Orchestrator(() => {}, {});
  const A = CP('A', ['g1', 'g2']);
  o._data = { accounts: [A], posts: [{ id: 'P' }, { id: 'Q' }], groups: [{ id: 'g1' }, { id: 'g2' }] };
  o._campaignPlan = { agentLists: { A: ['P', 'Q'] } };
  o._perAccountRotation = {};
  o._reserve = [R('Res', ['g1', 'g2'])];
  o._owed = {};
  const without = o._immediateStandin(A, () => true);
  assert.ok(without && without.reserve && without.reserve.name === 'Res' && without.postId === 'P', 'non-owed campaign drop → a reserve covers its slice P');
  o._owed = { A: { postId: 'P', gids: ['g2'] } };
  assert.equal(o._immediateStandin(A, () => true), null, 'owed agent → immediate next-slice cover is SKIPPED (owed-standins finishes P instead)');
});

test('_campaignStandins: a NON-owed drop gets a next-slice cover, an OWED agent is skipped', () => {
  const o = new Orchestrator(() => {}, {});
  const A = CP('A', ['g1', 'g2']);
  o._data = { accounts: [A], posts: [{ id: 'P' }, { id: 'Q' }], groups: [{ id: 'g1' }, { id: 'g2' }] };
  o._campaignPlan = { agentLists: { A: ['P', 'Q'] } };
  o._perAccountRotation = {};
  o._cycleDrops = new Set(['A']);
  const reserve = [R('Res', ['g1', 'g2'])];
  o._owed = {};
  assert.equal(Object.keys(o._campaignStandins([A], reserve, () => true, 3)).length, 1, 'non-owed campaign drop → a reserve covers its next slice');
  o._owed = { A: { postId: 'P', gids: ['g2'] } };
  assert.equal(Object.keys(o._campaignStandins([A], reserve, () => true, 3)).length, 0, 'owed agent → campaignStandins skips it (owed path covers P instead — no over-delivery)');
});
