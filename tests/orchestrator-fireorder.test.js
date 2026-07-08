// tests/orchestrator-fireorder.test.js
// Firing order across batches (start-order only — what each agent posts is unchanged). _orderLaunchQueue reorders
// the per-cycle launch queue by settings.fireOrder: 'batch' keeps the grouped order, 'interleave' round-robins
// across batches, 'random' shuffles (seeded by the cycle → reproducible). A "batch" = accounts sharing a group-set.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { Orchestrator } = require('../automation/orchestrator');

const A = (name, groups) => ({ name, assignedGroups: groups });
const B1 = ['g1', 'g2', 'g3', 'g4'], B2 = ['g5', 'g6', 'g7', 'g8'];
const queue = () => [A('A1', B1), A('A2', B1), A('A3', B1), A('B1', B2), A('B2', B2), A('B3', B2)];

test("fireOrder 'batch' (and default) keeps the natural grouped order", () => {
  const o = new Orchestrator(() => {}, {});
  assert.deepEqual(o._orderLaunchQueue(queue(), 'batch', 1).map((a) => a.name), ['A1', 'A2', 'A3', 'B1', 'B2', 'B3']);
  assert.deepEqual(o._orderLaunchQueue(queue(), undefined, 1).map((a) => a.name), ['A1', 'A2', 'A3', 'B1', 'B2', 'B3']);
});

test("fireOrder 'interleave' round-robins across batches", () => {
  const o = new Orchestrator(() => {}, {});
  assert.deepEqual(o._orderLaunchQueue(queue(), 'interleave', 1).map((a) => a.name), ['A1', 'B1', 'A2', 'B2', 'A3', 'B3']);
});

test("fireOrder 'interleave' handles uneven batches (drains the longer one)", () => {
  const o = new Orchestrator(() => {}, {});
  const q = [A('A1', B1), A('A2', B1), A('A3', B1), A('B1', B2)]; // 3 + 1
  assert.deepEqual(o._orderLaunchQueue(q, 'interleave', 1).map((a) => a.name), ['A1', 'B1', 'A2', 'A3']);
});

test("fireOrder 'random' is a reproducible permutation (same seed → same order, same set)", () => {
  const o = new Orchestrator(() => {}, {});
  const r1 = o._orderLaunchQueue(queue(), 'random', 5).map((a) => a.name);
  const r2 = o._orderLaunchQueue(queue(), 'random', 5).map((a) => a.name);
  assert.deepEqual(r1, r2);                                              // same seed → reproducible
  assert.deepEqual([...r1].sort(), ['A1', 'A2', 'A3', 'B1', 'B2', 'B3']); // every account present, none lost/duplicated
  const r3 = o._orderLaunchQueue(queue(), 'random', 777).map((a) => a.name);
  assert.notDeepEqual(r1, r3);                                           // a different cycle seed gives a different order
});

test('_orderLaunchQueue is a no-op for trivial queues', () => {
  const o = new Orchestrator(() => {}, {});
  assert.deepEqual(o._orderLaunchQueue([], 'random', 1), []);
  assert.deepEqual(o._orderLaunchQueue([A('A1', B1)], 'interleave', 1).map((a) => a.name), ['A1']);
});
