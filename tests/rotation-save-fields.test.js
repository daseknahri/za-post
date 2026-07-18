// tests/rotation-save-fields.test.js
// store.saveRotation is a WHOLESALE REPLACE of the rotation file, and the state literal used to be copy-pasted at six
// call sites. A field added to one was therefore silently DROPPED by the other five. That is exactly what happened to
// pendingPlanBatchId: the per-delivery save wiped it on the FIRST post of every cycle, so the frozen-plan disclosure
// (whose whole job is to stop an operator inferring "my edit was ignored" and reaching for Start Fresh = a
// whole-library re-burst) was dead on arrival. Every existing test asserted the IN-MEMORY value, so none caught it.
// These tests round-trip through DISK, which is the only place the omission is visible.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/store');
const { Orchestrator } = require('../automation/orchestrator');

const withStore = (fn) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zp-rot-'));
  store.init(tmp);
  try { return fn(); } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
};
const mk = () => {
  const o = new Orchestrator(() => {}, {});
  o._dealt = new Set(['seen']); o._perAccountRotation = { a1: { lastPostId: 'P1' } };
  o._owed = {}; o._inflightSeq = {}; o._roundOffset = 2;
  o._campaignPlan = { batchId: 'OLD', agentLists: { a1: ['P1'] }, clusters: [] };
  o._pendingPlanBatchId = 'PENDING-NEW';
  return o;
};

test('[ADR-0023 P3] the per-delivery rotation save does NOT wipe pendingPlanBatchId', () => {
  withStore(() => {
    const o = mk();
    o._saveRotationState();
    assert.equal(store.loadRotation().pendingPlanBatchId, 'PENDING-NEW', 'baseline');
    o._saveRotationWith(); // the per-delivery save — fires on EVERY post
    assert.equal(store.loadRotation().pendingPlanBatchId, 'PENDING-NEW', 'a post delivery must not erase the operator-facing pending-edit marker');
  });
});

test('[ADR-0023 P3] the unique/sequence recycle saves keep the marker AND their own overrides', () => {
  withStore(() => {
    const o = mk();
    o._saveRotationWith({ dealt: [], roundOffset: 0 });
    const r = store.loadRotation();
    assert.equal(r.pendingPlanBatchId, 'PENDING-NEW', 'a recycle is not an edit — the marker survives');
    assert.deepEqual(r.dealt, [], 'the override still applies');
    assert.equal(r.roundOffset, 0, 'the override still applies');
  });
});

test('[ADR-0023 P3] Start Fresh clears the marker (it has no pending edit by definition)', () => {
  withStore(() => {
    const o = mk();
    o._saveRotationState();
    o._dealt = new Set(); o._campaignPlan = null; o._pendingPlanBatchId = null;
    o._saveRotationWith({ dealt: [], roundOffset: 0, staggerRotation: 0, lastDailyRunDate: null, perAccountRotation: {}, campaignPlan: null, owedLedger: {}, inflightSeq: {}, pendingPlanBatchId: null });
    assert.equal(store.loadRotation().pendingPlanBatchId, null, 'Start Fresh rebuilt the plan — nothing is pending');
  });
});

test('[ADR-0023 P3] every rotation save carries the full field set (no silent field loss)', () => {
  // The structural guard: if someone adds a field to the builder and a caller bypasses it, this fails.
  withStore(() => {
    const o = mk();
    o._saveRotationWith();
    const KEYS = ['dealt', 'roundOffset', 'staggerRotation', 'lastDailyRunDate', 'perAccountRotation', 'campaignPlan', 'owedLedger', 'inflightSeq', 'pendingPlanBatchId'];
    const got = Object.keys(store.loadRotation());
    for (const k of KEYS) assert.ok(got.includes(k), `rotation state lost '${k}' — saveRotation is a wholesale replace, so a missing key is a DELETED key`);
  });
});
