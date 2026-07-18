// tests/plan-frozen-disclosure.test.js
// ADR-0023 P3: the Plan panel renders the PERSISTED plan, which is frozen for the current round. Right after an edit
// it therefore shows the OLD shape — indistinguishable, to the operator, from "my edit was ignored". The only button
// that looks like it applies the edit is Start Fresh, which re-delivers the whole library from #1 to every group on
// the one shared IP. buildPlan must surface the engine's own pending marker so the panel can say "already handled".
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildPlan } = require('../lib/plan');

const ACC = (name, groups) => ({ name, assignedGroups: groups, postingOrder: 'campaign-plan', postFilter: 'all', enabled: true, standby: false, status: 'logged_in' });
const BASE = () => ({
  accounts: [ACC('a1', ['g1'])],
  posts: [{ id: 'P1' }, { id: 'P2' }],
  groups: [{ id: 'g1', name: 'G1', groupId: '111' }],
  settings: { postingOrder: 'campaign-plan' },
  progress: {},
});

test('[ADR-0023 P3] buildPlan surfaces a PENDING edit so the panel need not look ignored', () => {
  const b = BASE();
  const rotation = { campaignPlan: { batchId: 'OLD', agentLists: { a1: ['P1'] }, clusters: [] }, pendingPlanBatchId: 'NEW', perAccountRotation: {} };
  const p = buildPlan({ ...b, rotation });
  assert.ok(p.frozen, 'a pending edit must be disclosed — silence here routes the operator to Start Fresh (a re-burst)');
  assert.equal(p.frozen.pendingBatchId, 'NEW');
  assert.equal(p.frozen.batchId, 'OLD');
});

test('[ADR-0023 P3] no pending edit → no disclosure (the note must not cry wolf)', () => {
  const b = BASE();
  const rotation = { campaignPlan: { batchId: 'SAME', agentLists: { a1: ['P1'] }, clusters: [] }, pendingPlanBatchId: 'SAME', perAccountRotation: {} };
  assert.equal(buildPlan({ ...b, rotation }).frozen, null, 'a marker equal to the live plan is not pending');
});

test('[ADR-0023 P3] a rotation file from an older version (no marker) is not read as a pending edit', () => {
  const b = BASE();
  const rotation = { campaignPlan: { batchId: 'OLD', agentLists: { a1: ['P1'] }, clusters: [] }, perAccountRotation: {} };
  assert.equal(buildPlan({ ...b, rotation }).frozen, null, 'a bare read would make every upgrade show a phantom pending edit');
});
