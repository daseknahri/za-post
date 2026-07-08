// tests/orchestrator-reserve-maxjobs.test.js
// #5 multi-drop-per-reserve: reserveMaxJobsPerCycle lets a healthy reserve do up to N browser jobs/cycle (default 1 =
// today's exact one-job/account/cycle). Locks the clamp + the _jobbedThisCycle Map count semantics + default byte-identity.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/store');
const { Orchestrator } = require('../automation/orchestrator');

test('#5 clamp: reserveMaxJobsPerCycle → integer clamped 1..5; only touches keys present', () => {
  assert.equal(store.clampSettings({ reserveMaxJobsPerCycle: 0 }).reserveMaxJobsPerCycle, 1, '0 → 1 (floor)');
  assert.equal(store.clampSettings({ reserveMaxJobsPerCycle: 1 }).reserveMaxJobsPerCycle, 1);
  assert.equal(store.clampSettings({ reserveMaxJobsPerCycle: 3 }).reserveMaxJobsPerCycle, 3);
  assert.equal(store.clampSettings({ reserveMaxJobsPerCycle: 99 }).reserveMaxJobsPerCycle, 5, '99 → 5 (ceiling)');
  assert.equal(store.clampSettings({ reserveMaxJobsPerCycle: 2.7 }).reserveMaxJobsPerCycle, 3, '2.7 → 3 (round)');
  assert.equal('reserveMaxJobsPerCycle' in store.clampSettings({ waitInterval: 30 }), false, 'absent → not added (only touches keys present)');
});

test('#5 _jobbedOut/_markJob: default 1 is byte-identical to the old one-job cap; raising allows N', () => {
  const o = new Orchestrator(() => {}, {});
  o._data = { settings: {}, accounts: [], posts: [], groups: [] };
  o._jobbedThisCycle = new Map();
  assert.equal(o._reserveMaxJobs(), 1, 'default 1');
  assert.equal(o._jobbedOut('R'), false, 'not jobbed yet');
  o._markJob('R');
  assert.equal(o._jobbedOut('R'), true, 'default 1 → jobbed out after 1 job (== old Set.has)');

  o._data.settings.reserveMaxJobsPerCycle = 2;
  assert.equal(o._jobbedOut('R'), false, 'max 2 → STILL available after 1 job (covers a 2nd drop)');
  o._markJob('R');
  assert.equal(o._jobbedOut('R'), true, 'max 2 → jobbed out after 2 jobs');

  o._data.settings.reserveMaxJobsPerCycle = 99; // hand-edited out of range
  assert.equal(o._reserveMaxJobs(), 5, 're-clamped at read time → 5');
  o._data.settings.reserveMaxJobsPerCycle = 0;
  assert.equal(o._reserveMaxJobs(), 1, 're-clamped at read time → 1');
});

test('#5 _jobbedOut tolerates a legacy Set (binary) — older tests that set a Set still read correctly', () => {
  const o = new Orchestrator(() => {}, {});
  o._data = { settings: {}, accounts: [], posts: [], groups: [] };
  o._jobbedThisCycle = new Set(['R']);
  assert.equal(o._jobbedOut('R'), true, 'a Set member reads as jobbed');
  assert.equal(o._jobbedOut('X'), false, 'a non-member reads as available');
});
