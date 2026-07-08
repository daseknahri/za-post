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

test('_handoffApprovedToComments: queues once, flips held->approved, dedups, drops no-id, skips empty comment', async () => {
  const { tmp, orch } = freshOrch();
  store.saveModeration({ held: [{ gid: 'g1', postId: 'p1', captionSnip: 'hello world caption', comment: 'my link', status: 'held' }] });
  store.saveComments({ pending: [] });
  const recs = [
    { gid: 'g1', postId: 'p1', captionSnip: 'hello world caption', comment: 'my link' }, // valid → 1 task
    { gid: 'g2', comment: 'no id here' },                                                 // no captionSnip + no postId → dropped
    { gid: 'g3', postId: 'p3', captionSnip: 'third', comment: '   ' },                    // empty/whitespace comment → no task
  ];
  assert.equal(await orch._handoffApprovedToComments(recs), 1, 'only the valid record with a non-empty comment queues');
  let cs = store.loadComments();
  assert.equal(cs.pending.length, 1, 'exactly one pending comment');
  assert.equal(cs.pending[0].comment, 'my link');
  assert.equal(store.loadModeration().held[0].status, 'approved', 'matched held record flipped to approved');

  assert.equal(await orch._handoffApprovedToComments(recs), 0, 'a repeat handoff adds no duplicate');
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
  // leftover recovery queues from a previous run — Start Fresh must wipe these so they aren't re-posted
  store.saveModeration({ held: [{ gid: 'g1', postId: 'p1', status: 'failed', captionSnip: 'old held post' }] });
  store.saveComments({ pending: [{ gid: 'g1', postId: 'p1', comment: 'old', status: 'pending' }] });

  const r = orch.resetRotation();
  assert.equal(r.ok, true, 'reset succeeds when stopped');
  assert.deepEqual(store.loadModeration().held || [], [], 'held recovery queue cleared on reset');
  assert.deepEqual(store.loadComments().pending || [], [], 'pending-comment recovery queue cleared on reset');
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
    { postId: 'p1', gid: 'g1', status: 'held', heldAt: now - 100 * 60 * 1000 },          // stale (>90min) → failed
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

test('moderator logged-out back-off: _noteModeratorLoggedOut backs off; _modBackedOff true until re-login or expiry', () => {
  const { tmp, orch } = freshOrch();
  // a probe came back logged-out → arm the back-off window (so the loop/kick stop re-launching a dead browser)
  orch._noteModeratorLoggedOut('simo');
  assert.ok(orch._modBackoffUntil > Date.now(), 'back-off window set');
  // while still logged out → backed off (moderator loop/kick must skip)
  assert.equal(orch._modBackedOff({ accounts: [{ name: 'simo', isModerator: true, status: 'not_logged_in' }] }), true, 'backed off while logged out');
  // operator re-logs it in (status flips) → resume EARLY + clear the window
  assert.equal(orch._modBackedOff({ accounts: [{ name: 'simo', isModerator: true, status: 'logged_in' }] }), false, 'resumes the moment it is re-logged-in');
  assert.equal(orch._modBackoffUntil, 0, 'window cleared on re-login');
  // an expired window is not a back-off
  orch._modBackoffUntil = Date.now() - 1;
  assert.equal(orch._modBackedOff({ accounts: [] }), false, 'expired window no longer backs off');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('moderator hard-gate: _runModeratorApproval does NOTHING when moderationEnabled is unchecked (no launch, held untouched)', async () => {
  const { tmp, orch } = freshOrch();
  store.saveModeration({ held: [{ postId: 'p1', gid: 'g1', status: 'held', captionSnip: 'hello world caption' }] });
  const r = await orch._runModeratorApproval({ settings: { moderationEnabled: false }, accounts: [{ name: 'simo', isModerator: true }] }, () => false);
  assert.equal(r.disabled, true, 'reports disabled when moderation is off');
  assert.equal(r.held, 0, 'processes no held posts');
  assert.equal(store.loadModeration().held[0].status, 'held', 'the held record is left untouched (no approval attempt → moderator never acted)');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('_immediateStandin: picks a healthy in-group reserve for a dropped campaign agent; excludes rate-limited / non-member / jobbed / already-covered', () => {
  const { tmp, orch } = freshOrch();
  orch._data = { posts: [{ id: 'post1' }], groups: [], accounts: [] };
  orch._campaignPlan = { agentLists: { A: ['post1'] } };
  orch._perAccountRotation = {};
  orch._jobbedThisCycle = new Set();
  orch._immediateCovered = new Set();
  const A = { name: 'A', postingOrder: 'campaign-plan', assignedGroups: ['g1', 'g2'] };
  const memberHealthy = { name: 'R1', assignedGroups: ['g1', 'g2', 'g3'] }; // superset → covers all of A's groups
  const memberRL = { name: 'R2', assignedGroups: ['g1', 'g2'] };           // covers, but in rate-limit cool-down
  const nonMember = { name: 'R3', assignedGroups: ['g1'] };                // missing g2 → cannot cover
  orch._reserve = [nonMember, memberRL, memberHealthy];
  const isHealthy = (r) => r.name !== 'R2'; // R2 is cooling down (operator spec: a rate-limited account is NOT used until cool-down passes)

  const pick = orch._immediateStandin(A, isHealthy);
  assert.ok(pick, 'a stand-in is found');
  assert.equal(pick.reserve.name, 'R1', "picks the healthy reserve that is a member of ALL of A's groups (not the rate-limited R2, not the non-member R3)");
  assert.equal(pick.postId, 'post1', "delivers A's exact next campaign post");

  orch._immediateCovered.add('A');
  assert.equal(orch._immediateStandin(A, isHealthy), null, 'an already-covered drop yields no second stand-in (no double-cover)');

  orch._immediateCovered = new Set();
  orch._reserve = [nonMember, memberRL];
  assert.equal(orch._immediateStandin(A, isHealthy), null, 'no covering+healthy reserve → null (caller leaves it for the end-of-pool backstop)');

  orch._reserve = [memberHealthy];
  orch._jobbedThisCycle = new Set(['R1']);
  assert.equal(orch._immediateStandin(A, isHealthy), null, 'a reserve that already did a job this cycle is not reused (one job/account/cycle)');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('_immediateStandin: returns null for a non-campaign-plan agent and when the slice is already complete', () => {
  const { tmp, orch } = freshOrch();
  orch._data = { posts: [{ id: 'post1' }], groups: [], accounts: [] };
  orch._campaignPlan = { agentLists: { A: ['post1'] } };
  orch._perAccountRotation = {};
  orch._jobbedThisCycle = new Set();
  orch._immediateCovered = new Set();
  orch._reserve = [{ name: 'R1', assignedGroups: ['g1', 'g2'] }];
  const isHealthy = () => true;

  // non-campaign mode → immediate path is a no-op (the end-of-pool / owed paths handle those)
  assert.equal(orch._immediateStandin({ name: 'A', postingOrder: 'sequence', assignedGroups: ['g1', 'g2'] }, isHealthy), null, 'non-campaign-plan agent → null');

  // A already delivered its only post today (pointer at end) → nothing to cover
  orch._perAccountRotation = { A: { lastPostId: 'post1', lastPostedDate: orch._localDayKey() } };
  assert.equal(orch._immediateStandin({ name: 'A', postingOrder: 'campaign-plan', assignedGroups: ['g1', 'g2'] }, isHealthy), null, 'A already posted today → null');

  fs.rmSync(tmp, { recursive: true, force: true });
});
