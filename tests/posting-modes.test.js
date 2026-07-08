// tests/posting-modes.test.js
// Posting-method assignment correctness. The operator's bug: 10 accounts all showed "Post #10" when
// 9 of 10 posts were already dealt. Root cause: in unique mode the no-claim picker fell back to
// remaining[0] for every surplus account. These pin the fix (F1) + distinct assignment + truthful plan.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/store');
const { Orchestrator } = require('../automation/orchestrator');

function makeOrch(posts, accounts, dealtIds = []) {
  const o = new Orchestrator(() => {}, {});
  o.log = () => {};
  o._data = { posts, accounts, groups: [{ id: 'g1', name: 'G1', groupId: '1' }], settings: { postsPerGroup: 1 } };
  o._dealt = new Set(dealtIds);
  o._claimed = new Set();
  o._active = accounts;
  o._roundOffset = 0;
  o._staggerRotation = 0;
  return o;
}
const mkAccs = (n) => Array.from({ length: n }, (_, i) => ({ name: 'a' + i, enabled: true, assignedGroups: ['g1'], postingOrder: 'post-centric-unique' }));
const mkPosts = (n) => Array.from({ length: n }, (_, i) => ({ id: 'p' + i, caption: 'caption number ' + i + ' xxxxxxxxxx' }));

test('unique mode: posts >= accounts → each account gets a DISTINCT post', () => {
  const accs = mkAccs(5);
  const o = makeOrch(mkPosts(5), accs);
  const ids = accs.map((a) => { const ap = o._postsForAccount(a, 0, true, o._claimed); return ap.length ? ap[0].id : null; });
  assert.ok(ids.every(Boolean), 'no account idles when there are enough posts');
  assert.equal(new Set(ids).size, 5, 'all 5 accounts get distinct posts');
});

test('unique mode: posts < accounts → only one account posts, the rest IDLE (the "all → Post #10" case)', () => {
  const accs = mkAccs(10);
  // 9 of 10 dealt → only p9 remains. With claiming (both the run AND the now-truthful plan claim),
  // the first account takes p9 and the rest see an empty pool → idle. The OLD plan LIED because it
  // computed assignments WITHOUT claiming, so every account saw the lone p9.
  const o = makeOrch(mkPosts(10), accs, ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']);
  const picks = accs.map((a) => o._postsForAccount(a, 0, true, o._claimed));
  assert.deepEqual(picks[0].map((p) => p.id), ['p9'], 'first account gets the one remaining post');
  for (let i = 1; i < 10; i++) assert.equal(picks[i].length, 0, `account ${i} idles (pool exhausted) — not a duplicate of p9`);
});

test('plan dry-run claims == run-time claims, and planning never touches this._claimed (F2)', () => {
  const accs = mkAccs(10);
  const dealt = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];
  const oPlan = makeOrch(mkPosts(10), accs, dealt);
  const tempClaimed = new Set(); // the throwaway set the planner uses
  const plan = accs.map((a) => { const ap = oPlan._postsForAccount(a, 0, true, tempClaimed); return ap.length ? ap[0].id : '(waits)'; });
  const oRun = makeOrch(mkPosts(10), accs, dealt);
  const run = accs.map((a) => { const ap = oRun._postsForAccount(a, 0, true, oRun._claimed); return ap.length ? ap[0].id : '(waits)'; });
  assert.deepEqual(plan, run, 'the printed plan equals the actual run-time assignment');
  assert.equal(oPlan._claimed.size, 0, 'planning used the throwaway set only — this._claimed untouched');
});

test('resetRotation: clears dealt-state when stopped, refuses while running', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-reset-'));
  store.init(tmp);
  const o = makeOrch(mkPosts(3), mkAccs(3), ['p0', 'p1']);
  o.running = false; o._roundOffset = 2;
  const r = o.resetRotation();
  assert.equal(r.ok, true);
  assert.equal(o._dealt.size, 0, 'dealt cleared');
  assert.equal(o._roundOffset, 0, 'roundOffset reset');
  const o2 = makeOrch(mkPosts(3), mkAccs(3), ['p0', 'p1']);
  o2.running = true;
  const r2 = o2.resetRotation();
  assert.equal(r2.ok, false, 'refused while running');
  assert.equal(o2._dealt.size, 2, 'dealt untouched while running');
  fs.rmSync(tmp, { recursive: true, force: true });
});
