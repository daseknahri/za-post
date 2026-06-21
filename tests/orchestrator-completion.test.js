// tests/orchestrator-completion.test.js
// Completion engine: _outstandingWork measures how much of a FINITE campaign is left to deliver
// (undealt posts + queued comments + held posts). total===0 ⇒ everything delivered ⇒ the run auto-stops.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/store');
const { Orchestrator } = require('../automation/orchestrator');

test('_outstandingWork: undealt finite posts + pending comments + held posts', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-comp-'));
  store.init(tmp);
  const orch = new Orchestrator(() => {}, {});
  orch._data = { posts: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }], settings: {}, accounts: [] };
  orch._dealt = new Set(['p1']); // p1 already published → p2,p3 still outstanding
  const acct = { name: 'a1', assignedGroups: ['g1'], postingOrder: 'post-centric-unique', postFilter: 'all' };

  let out = orch._outstandingWork([acct]);
  assert.equal(out.undealt, 2, 'two posts not yet published');
  assert.equal(out.total, 2);
  assert.equal(out.hasFinite, true);

  store.saveComments({ pending: [{ gid: 'g1', status: 'pending', attempts: 0 }, { gid: 'g1', status: 'pending', attempts: 0 }, { gid: 'g1', status: 'done' }] });
  store.saveModeration({ held: [{ postId: 'p1', status: 'held' }, { postId: 'p2', status: 'approved' }] });
  out = orch._outstandingWork([acct]);
  assert.equal(out.pending, 2, 'two comments queued (done excluded)');
  assert.equal(out.held, 1, 'one post still held (approved excluded)');
  assert.equal(out.total, 5, 'undealt(2) + pending(2) + held(1)');

  // Everything published + queues empty → nothing outstanding → the run would auto-stop.
  orch._dealt = new Set(['p1', 'p2', 'p3']);
  store.saveComments({ pending: [] });
  store.saveModeration({ held: [] });
  assert.equal(orch._outstandingWork([acct]).total, 0, 'all delivered → done');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('_outstandingWork: a non-finite fleet (daily-rotation/post-centric) reports no finite campaign', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-comp2-'));
  store.init(tmp);
  const orch = new Orchestrator(() => {}, {});
  orch._data = { posts: [{ id: 'p1' }, { id: 'p2' }], settings: {}, accounts: [] };
  orch._dealt = new Set();
  const dr = { name: 'a2', assignedGroups: ['g1'], postingOrder: 'daily-rotation', postFilter: 'all' };
  const out = orch._outstandingWork([dr]);
  assert.equal(out.undealt, 0, 'daily-rotation is ongoing, not a finite campaign');
  assert.equal(out.hasFinite, false);
  fs.rmSync(tmp, { recursive: true, force: true });
});
