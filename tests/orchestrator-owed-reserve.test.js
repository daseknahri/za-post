// tests/orchestrator-owed-reserve.test.js
// Locks the NEW partial-delivery reserve coverage: _owedStandins pairs an account that delivered its post to SOME
// but not all of its groups with a healthy reserve that covers ALL the un-reached (owed) groups, targeting ONLY
// those groups. Guards: full coverage required, no reserve reuse, moderators/excluded/unhealthy skipped, deferral.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/store');
const { Orchestrator } = require('../automation/orchestrator');

function mk() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-owed-'));
  store.init(tmp);
  const orch = new Orchestrator(() => {}, {});
  orch._data = { groups: [{ id: 'g1' }, { id: 'g2' }, { id: 'g3' }, { id: 'g4' }], posts: [{ id: 'pX' }], settings: {} };
  return { tmp, orch };
}
const healthy = () => true;

test('_owedStandins: picks a reserve covering ALL owed groups; targets ONLY those', () => {
  const { tmp, orch } = mk();
  const reserve = [{ name: 'R', assignedGroups: ['g1', 'g2', 'g3', 'g4'] }];
  const r = orch._owedStandins({ A: { postId: 'pX', gids: ['g2', 'g3'] } }, reserve, healthy);
  assert.deepEqual(Object.keys(r.assigned), ['R']);
  assert.equal(r.assigned.R.postId, 'pX');
  assert.equal(r.assigned.R.forAgent, 'A');
  assert.deepEqual(r.assigned.R.gids.slice().sort(), ['g2', 'g3']);
  assert.equal(r.deferred.length, 0);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('_owedStandins (#1 split): a reserve covering SOME owed groups is split-USED for those; only the rest defers', () => {
  const { tmp, orch } = mk();
  const reserve = [{ name: 'S', assignedGroups: ['g2'] }]; // covers g2, missing g3
  const r = orch._owedStandins({ A: { postId: 'pX', gids: ['g2', 'g3'] } }, reserve, healthy);
  // Pre-#1 this rejected S entirely and deferred both groups. Now S is split-routed to the g2 it covers, and ONLY the
  // truly-uncoverable g3 (no member reserve) is deferred.
  assert.deepEqual(Object.keys(r.assigned), ['S']);
  assert.equal(r.assigned.S.forAgent, 'A');
  assert.deepEqual(r.assigned.S.gids, ['g2'], 'S split-routed to g2');
  assert.deepEqual(r.deferred, [{ owner: 'A', count: 1 }], 'only g3 is deferred');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('_owedStandins (#1 split): a reserve covering NONE of the owed groups still fully defers', () => {
  const { tmp, orch } = mk();
  const reserve = [{ name: 'S', assignedGroups: ['g1'] }]; // covers neither g2 nor g3
  const r = orch._owedStandins({ A: { postId: 'pX', gids: ['g2', 'g3'] } }, reserve, healthy);
  assert.deepEqual(Object.keys(r.assigned), []);
  assert.deepEqual(r.deferred, [{ owner: 'A', count: 2 }]);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('_owedStandins: excluded reserves (already a full-drop stand-in) are never reused', () => {
  const { tmp, orch } = mk();
  const reserve = [{ name: 'R', assignedGroups: ['g1', 'g2', 'g3', 'g4'] }];
  const r = orch._owedStandins({ A: { postId: 'pX', gids: ['g2', 'g3'] } }, reserve, healthy, new Set(['R']));
  assert.deepEqual(Object.keys(r.assigned), []); // R excluded → no cover → deferred
  assert.deepEqual(r.deferred, [{ owner: 'A', count: 2 }]);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('_owedStandins: two owed agents get two DISTINCT reserves (no reuse); unhealthy skipped', () => {
  const { tmp, orch } = mk();
  const reserve = [
    { name: 'R1', assignedGroups: ['g1', 'g2'] },
    { name: 'R2', assignedGroups: ['g3', 'g4'] },
    { name: 'Rdead', assignedGroups: ['g1', 'g2', 'g3', 'g4'] },
  ];
  const owed = { A: { postId: 'pX', gids: ['g1', 'g2'] }, B: { postId: 'pX', gids: ['g3', 'g4'] } };
  const r = orch._owedStandins(owed, reserve, (x) => x.name !== 'Rdead');
  assert.equal(Object.keys(r.assigned).length, 2);
  assert.equal(r.assigned.R1.forAgent, 'A');
  assert.equal(r.assigned.R2.forAgent, 'B');
  assert.equal(r.deferred.length, 0);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('_owedStandins: a moderator account is NEVER used as a cover reserve', () => {
  const { tmp, orch } = mk();
  const reserve = [{ name: 'mod', isModerator: true, assignedGroups: ['g1', 'g2', 'g3', 'g4'] }];
  const r = orch._owedStandins({ A: { postId: 'pX', gids: ['g2'] } }, reserve, healthy);
  assert.deepEqual(Object.keys(r.assigned), []);
  assert.deepEqual(r.deferred, [{ owner: 'A', count: 1 }]);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('_owedStandins: empty owed (or empty gids) → no assignments, no deferrals', () => {
  const { tmp, orch } = mk();
  const reserve = [{ name: 'R', assignedGroups: ['g1'] }];
  const a = orch._owedStandins({}, reserve, healthy);
  assert.deepEqual(a.assigned, {}); assert.deepEqual(a.deferred, []);
  const b = orch._owedStandins({ A: { postId: 'pX', gids: [] } }, reserve, healthy);
  assert.deepEqual(b.assigned, {}); assert.deepEqual(b.deferred, []);
  fs.rmSync(tmp, { recursive: true, force: true });
});
