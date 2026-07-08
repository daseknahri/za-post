// tests/orchestrator-daily-rotation.test.js
// Per-agent Daily Rotation: each agent posts ONE new post per LOCAL day, advancing its OWN pointer one
// step each day (persisted in _perAccountRotation), with an anti-repeat guard and a one-per-day gate.
// Pure unit test of _postsForAccount — no browser, no loop.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { Orchestrator } = require('../automation/orchestrator');

function makeOrch(posts) {
  const orch = new Orchestrator(() => {}, {});
  orch._data = { posts, settings: {}, accounts: [] };
  orch._perAccountRotation = {};
  return orch;
}
const ACCT = { name: 'a1', assignedGroups: ['g1'], postingOrder: 'daily-rotation', postFilter: 'all' };

test('daily-rotation: first run picks the first post', () => {
  const orch = makeOrch([{ id: 'p1', caption: 'a' }, { id: 'p2', caption: 'b' }, { id: 'p3', caption: 'c' }]);
  assert.deepEqual(orch._postsForAccount(ACCT, 1).map((p) => p.id), ['p1']);
});

test('daily-rotation: one post per local day (returns [] once posted today)', () => {
  const orch = makeOrch([{ id: 'p1' }, { id: 'p2' }]);
  orch._perAccountRotation.a1 = { lastPostId: 'p1', lastPostedDate: orch._localDayKey() };
  assert.deepEqual(orch._postsForAccount(ACCT, 1), [], 'already posted today → nothing more today');
});

test('daily-rotation: next day advances exactly one step, then wraps', () => {
  const orch = makeOrch([{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }]);
  orch._perAccountRotation.a1 = { lastPostId: 'p1', lastPostedDate: '2000-01-01' };
  assert.deepEqual(orch._postsForAccount(ACCT, 2).map((p) => p.id), ['p2'], 'advance p1 → p2');
  orch._perAccountRotation.a1 = { lastPostId: 'p3', lastPostedDate: '2000-01-01' };
  assert.deepEqual(orch._postsForAccount(ACCT, 3).map((p) => p.id), ['p1'], 'wraps p3 → p1');
});

test('daily-rotation: a deleted/updated last post restarts the rotation at the first post', () => {
  const orch = makeOrch([{ id: 'x1' }, { id: 'x2' }]);
  orch._perAccountRotation.a1 = { lastPostId: 'gone', lastPostedDate: '2000-01-01' };
  assert.deepEqual(orch._postsForAccount(ACCT, 1).map((p) => p.id), ['x1']);
});

test('daily-rotation: a single-post library still posts it (nowhere to advance — anti-repeat is moot)', () => {
  const orch = makeOrch([{ id: 'only' }]);
  orch._perAccountRotation.a1 = { lastPostId: 'only', lastPostedDate: '2000-01-01' };
  assert.deepEqual(orch._postsForAccount(ACCT, 1).map((p) => p.id), ['only']);
});

test('daily-rotation: agents are independent (one agent\'s pointer does not affect another\'s)', () => {
  const orch = makeOrch([{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }]);
  orch._perAccountRotation = { a1: { lastPostId: 'p1', lastPostedDate: '2000-01-01' }, a2: { lastPostId: 'p2', lastPostedDate: '2000-01-01' } };
  const a1 = { name: 'a1', assignedGroups: ['g1'], postingOrder: 'daily-rotation', postFilter: 'all' };
  const a2 = { name: 'a2', assignedGroups: ['g2'], postingOrder: 'daily-rotation', postFilter: 'all' };
  assert.deepEqual(orch._postsForAccount(a1, 1).map((p) => p.id), ['p2'], 'a1: p1 → p2');
  assert.deepEqual(orch._postsForAccount(a2, 1).map((p) => p.id), ['p3'], 'a2: p2 → p3 (independent pointer)');
});
