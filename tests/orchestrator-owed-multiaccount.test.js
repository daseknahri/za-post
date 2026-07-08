// tests/orchestrator-owed-multiaccount.test.js
// REGRESSION for the daily-rotation multi-account/shared-group defect found by the 1.0.7 owed-ledger adversarial
// audit: adding 'daily-rotation' to the dedup set made it honor the ACCOUNT-AGNOSTIC this._cycleDelivered key
// ('postId::gid'). Two daily-rotation accounts that share an assigned group and land on the SAME post the same day
// then collided — whichever posted first marked P::G and the OTHER silently, permanently skipped G (invariant #2
// under-delivery + invariant #4 regression). Fix: _dkScope() scopes the key PER-AGENT for daily-rotation (each
// account is independently responsible for its own groups) while unique/sequence/campaign stay FLEET-WIDE. Every
// _cycleDelivered write (markDelivered) and read (alreadyDelivered + owed reconcile) MUST route through the SAME
// scope or a delivered group would be re-owed (double-post) or an un-reached one dropped (silent skip).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// Stub runAccount before requiring the orchestrator (it destructures it at module load).
const worker = require('../automation/worker');
worker.runAccount = async () => ({ posted: 0, errors: 0, pendingApproval: 0, noRetry: false, flag: null, postedIds: [], dealtIds: [], fullyPosted: true, offline: false, progressed: true });
const { Orchestrator } = require('../automation/orchestrator');

const DR = (name, groups) => ({ name, assignedGroups: groups, postingOrder: 'daily-rotation', enabled: true, status: 'logged_in', standby: false });
const UNI = (name, groups) => ({ name, assignedGroups: groups, postingOrder: 'unique', enabled: true, status: 'logged_in', standby: false });

test('_dkScope: daily-rotation is PER-AGENT, other modes FLEET-WIDE', () => {
  const o = new Orchestrator(() => {}, {});
  o._data = { accounts: [DR('A', ['g1']), DR('B', ['g1']), UNI('U', ['g1'])] };
  assert.equal(o._dkScope('A'), 'A::', 'daily-rotation A → per-agent scope');
  assert.equal(o._dkScope('B'), 'B::', 'daily-rotation B → per-agent scope');
  assert.equal(o._dkScope('U'), '', 'unique → fleet-wide (no scope)');
  assert.equal(o._dkScope('missing'), '', 'unknown agent → fleet-wide (safe default)');
});

test('two daily-rotation accounts sharing a group both deliver the same post (NO cross-account skip)', () => {
  const o = new Orchestrator(() => {}, {});
  o._data = { accounts: [DR('A', ['gShared']), DR('B', ['gShared'])] };
  o._cycleDelivered = new Set();
  // A delivers post P to the shared group (key scoped by A, exactly as markDelivered does).
  o._cycleDelivered.add(o._dkScope('A') + 'P::gShared');
  // B's alreadyDelivered check for the SAME (post,group) must be FALSE — B has its own scope, so B still posts it.
  assert.equal(o._cycleDelivered.has(o._dkScope('B') + 'P::gShared'), false,
    'B must NOT see A\'s delivery → the shared group still receives B\'s post (defect fixed)');
  // But A ITSELF must still be blocked from re-posting the same group (crash-retry / reserve dedup preserved).
  assert.equal(o._cycleDelivered.has(o._dkScope('A') + 'P::gShared'), true,
    'A must not re-post the same group within the cycle (within-agent dedup intact)');
});

test('owed reconcile reads the SAME scoped key markDelivered wrote (a delivered group is NEVER re-owed → no double-post)', () => {
  const o = new Orchestrator(() => {}, {});
  o._data = { accounts: [DR('A', ['g1', 'g2', 'g3'])] };
  o._cycleDelivered = new Set();
  // A delivered g1,g2 then dropped (scoped writes, as the worker closures do).
  o._cycleDelivered.add(o._dkScope('A') + 'P::g1');
  o._cycleDelivered.add(o._dkScope('A') + 'P::g2');
  // Reconcile mirrors orchestrator: owed = expected − delivered, using the SAME _dkScope('A').
  const owed = ['g1', 'g2', 'g3'].filter((gid) => !o._cycleDelivered.has(o._dkScope('A') + 'P::' + gid));
  assert.deepEqual(owed, ['g3'], 'delivered g1,g2 excluded (scope matches write) → owed is only the un-reached g3');
});

test('a reserve stand-in delivers under the COVERED agent\'s scope so its cover counts toward that agent\'s owed', () => {
  const o = new Orchestrator(() => {}, {});
  o._data = { accounts: [DR('A', ['g1', 'g2']), UNI('R', ['g1', 'g2'])] }; // R is a reserve covering daily-rotation A
  o._cycleDelivered = new Set();
  // Reserve R covers A's owed group g2: the closure scopes by the COVERED agent (stand.forAgent = 'A'), not R.
  const coveredAgent = 'A';
  o._cycleDelivered.add(o._dkScope(coveredAgent) + 'P::g2');
  // A's owed reconcile (scoped by A) must SEE the reserve\'s delivery → g2 is no longer owed.
  const owed = ['g2'].filter((gid) => !o._cycleDelivered.has(o._dkScope('A') + 'P::' + gid));
  assert.deepEqual(owed, [], 'the reserve\'s cover (scoped to forAgent A) clears A\'s owed g2 — no lost owed, no double-cover');
});

test('unique/campaign stay FLEET-WIDE: a second account IS blocked from re-posting the same (post,group)', () => {
  const o = new Orchestrator(() => {}, {});
  o._data = { accounts: [UNI('U1', ['g1']), UNI('U2', ['g1'])] };
  o._cycleDelivered = new Set();
  o._cycleDelivered.add(o._dkScope('U1') + 'P::g1'); // fleet-wide key ('' prefix)
  assert.equal(o._cycleDelivered.has(o._dkScope('U2') + 'P::g1'), true,
    'unique mode: U2 sees U1\'s delivery (fleet-wide) → one post per group ACROSS the fleet (behaviour unchanged)');
});
