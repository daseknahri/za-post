// tests/orchestrator-gaps.test.js
// Guards for the remaining-gaps fix batch:
//  - _handoffApprovedToComments: the SOLE path that rescues approved held posts — a same()-regression would
//    double-comment, drop a comment, or loop re-approving. Lock dedup / drop-no-id / flip-held->approved / skip-empty.
//  - resetRotation: "Start Fresh" must clear ALL rotation state (shared dealt + per-agent + campaign + daily marker)
//    in memory AND on disk — a partial clear left the campaign permanently off-schedule.
//  - _pruneModeration: the only path that graduates held posts into the Phase-4 reserve re-post — lock the
//    stale->failed transition + the 24h prune.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/store');
const { Orchestrator } = require('../automation/orchestrator');

function freshOrch() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-gaps-'));
  store.init(tmp);
  return { tmp, orch: new Orchestrator(() => {}, {}) };
}

test('_handoffApprovedToComments: queues once, flips held->approved, dedups, drops no-id, skips empty comment', () => {
  const { tmp, orch } = freshOrch();
  store.saveModeration({ held: [{ gid: 'g1', postId: 'p1', captionSnip: 'hello world caption', comment: 'my link', status: 'held' }] });
  store.saveComments({ pending: [] });
  const recs = [
    { gid: 'g1', postId: 'p1', captionSnip: 'hello world caption', comment: 'my link' }, // valid → 1 task
    { gid: 'g2', comment: 'no id here' },                                                 // no captionSnip + no postId → dropped
    { gid: 'g3', postId: 'p3', captionSnip: 'third', comment: '   ' },                    // empty/whitespace comment → no task
  ];
  assert.equal(orch._handoffApprovedToComments(recs), 1, 'only the valid record with a non-empty comment queues');
  let cs = store.loadComments();
  assert.equal(cs.pending.length, 1, 'exactly one pending comment');
  assert.equal(cs.pending[0].comment, 'my link');
  assert.equal(store.loadModeration().held[0].status, 'approved', 'matched held record flipped to approved');

  assert.equal(orch._handoffApprovedToComments(recs), 0, 'a repeat handoff adds no duplicate');
  assert.equal(store.loadComments().pending.length, 1, 'still one pending comment');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('resetRotation: full clear of dealt + roundOffset + per-agent + campaign + daily marker (memory AND disk)', () => {
  const { tmp, orch } = freshOrch();
  orch._dealt = new Set(['p1', 'p2']);
  orch._roundOffset = 3;
  orch._staggerRotation = 5;
  orch._perAccountRotation = { a1: { lastPostId: 'p1', lastPostedDate: '2026-06-22' } };
  orch._campaignPlan = { batchId: 'x', clusters: [] };
  orch._lastDailyRunDate = '2026-06-22';

  const r = orch.resetRotation();
  assert.equal(r.ok, true, 'reset succeeds when stopped');
  assert.equal(orch._dealt.size, 0, 'dealt cleared');
  assert.equal(orch._roundOffset, 0);
  assert.equal(orch._staggerRotation, 0);
  assert.deepEqual(orch._perAccountRotation, {}, 'per-agent pointers cleared');
  assert.equal(orch._campaignPlan, null, 'campaign plan cleared');
  assert.equal(orch._lastDailyRunDate, null, 'daily marker cleared');
  const disk = store.loadRotation();
  assert.deepEqual(disk.dealt || [], [], 'disk dealt empty');
  assert.deepEqual(disk.perAccountRotation || {}, {}, 'disk per-agent empty');
  assert.equal(disk.campaignPlan || null, null, 'disk campaign null');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('_pruneModeration: stale held -> failed (heldFailedAt set); young held stays; old terminal pruned', () => {
  const { tmp, orch } = freshOrch();
  const now = Date.now();
  store.saveModeration({ held: [
    { postId: 'p1', gid: 'g1', status: 'held', heldAt: now - 31 * 60 * 1000 },           // stale → failed
    { postId: 'p2', gid: 'g2', status: 'held', heldAt: now - 5 * 60 * 1000 },            // young → stays held
    { postId: 'p3', gid: 'g3', status: 'failed', heldFailedAt: now - 25 * 3600 * 1000 }, // old terminal → pruned
  ] });
  orch._pruneModeration();
  const byId = Object.fromEntries(store.loadModeration().held.map((h) => [h.postId, h]));
  assert.equal(byId.p1 && byId.p1.status, 'failed', 'stale held became failed');
  assert.ok(byId.p1 && byId.p1.heldFailedAt, 'heldFailedAt anchored for the repost-grace clock');
  assert.equal(byId.p2 && byId.p2.status, 'held', 'young held stays held');
  assert.equal(byId.p3, undefined, 'old terminal record pruned');
  fs.rmSync(tmp, { recursive: true, force: true });
});
