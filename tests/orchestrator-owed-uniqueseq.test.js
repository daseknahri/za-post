// tests/orchestrator-owed-uniqueseq.test.js
// PERSISTENT OWED LEDGER × UNIQUE/SEQUENCE — audit finding #4 (the last one deferred from the v1.0.105 sweep).
//
// THE BUG: a unique/sequence account that delivered its post to SOME but not all of its groups still had that post
// added to the FLEET-WIDE dealt-set, while the un-reached groups were recorded ONLY in the same-cycle transient
// _cycleOwed. _cycleObligation (the persistent carry-over) was gated to daily-rotation/campaign-plan, so once the
// end-of-pool reserve pass found no covering reserve the un-reached groups stranded PERMANENTLY (the post is dealt →
// never re-picked) and _outstandingWork reported a false 100% — breaking ADR-0009's invariant that total===0 means
// everything deliverable WAS delivered, and ADR-0008's rule that a PARTIAL stays recoverable.
//
// THE FIX: unique/sequence gets its own owed pick-override (re-picks the SAME post, scoped to ONLY the un-reached
// groups), records _cycleObligation, reconciles in lock-step with the dealt-set persist, and counts its owed gids in
// _outstandingWork.
//
// The invariants proven here — the double-post ones are the ban-risk axis, so they are tested from BOTH directions:
//   (a) a delivered (post,group) is NEVER re-posted — not by the agent's own re-pick, and not by a reserve stand-in
//       (which does NOT consult _inflightDelivered, so the LEDGER itself must never list a delivered group)
//   (b) an un-reached group is never silently skipped — it persists in _owed and is re-picked next cycle
//   (c) completion waits: _outstandingWork counts unique/sequence owed gids (no false 100%)
//   (d) non-partial unique/sequence behavior is unchanged
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The worker stub MUST be installed BEFORE requiring the orchestrator (it destructures runAccount at module load).
const worker = require('../automation/worker');
let runHandler = null;
worker.runAccount = async (o) => (runHandler
  ? runHandler(o)
  : { posted: (o.account.assignedGroups || []).length, errors: 0, pendingApproval: 0, noRetry: false, flag: null, postedIds: [o.post && o.post.id], dealtIds: [o.post && o.post.id], fullyPosted: true, offline: false, progressed: true });
const store = require('../lib/store');
const { Orchestrator } = require('../automation/orchestrator');

const mkTmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-owedus-' + tag + '-'));
const UQ = (name, groups) => ({ name, assignedGroups: groups, postingOrder: 'unique', postFilter: 'all', enabled: true, status: 'logged_in', standby: false });

// Mirrors the REAL worker's targeting: assigned ∩ onlyGroups, honoring the per-(post,group) dedup ledger.
// `plan({name, postId, targetGids})` returns the gids to actually deliver (simulating a mid-run drop).
function makeMock(calls, plan) {
  return async (o) => {
    const name = o.account.name;
    const postId = o.post && o.post.id;
    let targets = (o.groups || []).filter((g) => (o.account.assignedGroups || []).includes(g.id) || (o.account.assignedGroups || []).includes(g.groupId));
    if (Array.isArray(o.onlyGroups)) { const set = new Set(o.onlyGroups); targets = targets.filter((g) => set.has(g.groupId || g.id)); }
    const targetGids = targets.map((g) => g.groupId || g.id);
    const toDeliver = new Set(plan({ name, postId, onlyGroups: o.onlyGroups ? [...o.onlyGroups] : null, targetGids }));
    let posted = 0;
    for (const gid of targetGids) {
      if (o.alreadyDelivered(gid)) continue; // the real worker SKIPS without marking → never a double-post
      if (toDeliver.has(gid)) { o.markDelivered(gid); posted++; calls.push({ name, postId, gid, onlyGroups: o.onlyGroups ? [...o.onlyGroups] : null }); }
    }
    return { posted, errors: targetGids.length - posted, pendingApproval: 0, noRetry: false, flag: null, postedIds: posted ? [postId] : [], dealtIds: posted ? [postId] : [], fullyPosted: posted === targetGids.length, offline: false, progressed: posted > 0, heldRecords: [], commentQueue: [] };
  };
}

async function runOneCycle(orch, until) {
  orch.start(() => store.load());
  for (let i = 0; i < 300; i++) { if (until()) break; await new Promise((r) => setTimeout(r, 50)); }
  try { orch.stop(); } catch {}
  await new Promise((r) => setTimeout(r, 50));
}

// ───────────────────────────── UNIT: the pick override ─────────────────────────────────────────────────────

test('[b] unique owed: re-picks the SAME dealt post instead of dealing a new one', () => {
  const o = new Orchestrator(() => {}, {});
  const A = UQ('A', ['g1', 'g2', 'g3', 'g4', 'g5']);
  o._data = { posts: [{ id: 'P1' }, { id: 'P2' }], groups: ['g1', 'g2', 'g3', 'g4', 'g5'].map((g) => ({ id: g })), settings: {}, accounts: [A] };
  o._active = [A];
  o._dealt = new Set(['P1']); // P1 was dealt on the partial cycle
  o._owed = { A: { postId: 'P1', gids: ['g3', 'g4', 'g5'] } };
  assert.deepEqual(o._postsForAccount(A, 1).map((p) => p.id), ['P1'], 'owed → re-pick the dealt P1, NOT the fresh P2');
  o._owed = {};
  assert.deepEqual(o._postsForAccount(A, 1).map((p) => p.id), ['P2'], 'owed cleared → normal deal resumes at P2');
});

test('[d] no owed → the unique deal is unchanged (override inert)', () => {
  const o = new Orchestrator(() => {}, {});
  const A = UQ('A', ['g1']);
  o._data = { posts: [{ id: 'P1' }, { id: 'P2' }], groups: [{ id: 'g1' }], settings: {}, accounts: [A] };
  o._active = [A];
  o._dealt = new Set(); // _loop normally seeds this from rotation.json
  assert.deepEqual(o._postsForAccount(A, 1).map((p) => p.id), ['P1'], 'first undealt post dealt exactly as before');
});

test('[a] unique owed: a group proven delivered by the crash-fold guard is pruned from the ledger, never re-picked', () => {
  const o = new Orchestrator(() => {}, {});
  const A = UQ('A', ['g1', 'g2', 'g3']);
  o._data = { posts: [{ id: 'P1' }, { id: 'P2' }], groups: ['g1', 'g2', 'g3'].map((g) => ({ id: g })), settings: {}, accounts: [A] };
  o._active = [A];
  o._dealt = new Set(['P1']);
  o._owed = { A: { postId: 'P1', gids: ['g2', 'g3'] } };
  o._inflightDelivered = new Set(['P1::g2']); // the fold proved g2 landed before the crash
  assert.deepEqual(o._postsForAccount(A, 1, true).map((p) => p.id), ['P1'], 'still owes g3 → re-picks P1');
  assert.deepEqual(o._owed.A.gids, ['g3'], 'g2 pruned from the LEDGER — a reserve stand-in never consults the guard, so a listed g2 would be re-posted');
});

test('[a] unique owed: every owed group already delivered → obligation dropped, no re-pick of the dealt post', () => {
  const o = new Orchestrator(() => {}, {});
  const A = UQ('A', ['g1', 'g2']);
  o._data = { posts: [{ id: 'P1' }, { id: 'P2' }], groups: ['g1', 'g2'].map((g) => ({ id: g })), settings: {}, accounts: [A] };
  o._active = [A];
  o._dealt = new Set(['P1']);
  o._owed = { A: { postId: 'P1', gids: ['g2'] } };
  o._inflightDelivered = new Set(['P1::g2']);
  assert.deepEqual(o._postsForAccount(A, 1, true).map((p) => p.id), ['P2'], 'nothing genuinely owed → deal the next post');
  assert.ok(!o._owed.A, 'fully-covered obligation dropped');
});

test('[c] unique owed: an un-assigned owed group is pruned (no undeliverable-owed livelock)', () => {
  const o = new Orchestrator(() => {}, {});
  const A = UQ('A', ['g1', 'g3']); // operator un-assigned g4
  o._data = { posts: [{ id: 'P1' }, { id: 'P2' }], groups: [{ id: 'g1' }, { id: 'g3' }], settings: {}, accounts: [A] };
  o._active = [A];
  o._dealt = new Set(['P1']);
  o._owed = { A: { postId: 'P1', gids: ['g3', 'g4'] } };
  assert.deepEqual(o._postsForAccount(A, 1, true).map((p) => p.id), ['P1'], 'still owes the assigned g3 → re-picks P1');
  assert.deepEqual(o._owed.A.gids, ['g3'], 'the un-assigned g4 is pruned');
});

test('[c] unique owed: a deleted owed post drops the stale obligation and deals normally', () => {
  const o = new Orchestrator(() => {}, {});
  const A = UQ('A', ['g1']);
  o._data = { posts: [{ id: 'P2' }], groups: [{ id: 'g1' }], settings: {}, accounts: [A] };
  o._active = [A];
  o._dealt = new Set(['P1']);
  o._owed = { A: { postId: 'P1', gids: ['g1'] } }; // P1 no longer in the library
  assert.deepEqual(o._postsForAccount(A, 1, true).map((p) => p.id), ['P2'], 'owed post gone → deal normally');
  assert.ok(!o._owed.A, 'stale obligation dropped (else _outstandingWork would count it forever)');
});

test('[a] Loop recycle: a cleared dealt-set disarms the owed entry so the recycled post goes to ALL groups', () => {
  // A recycle re-delivers the whole library to every group. A leftover owed subset must not narrow that — and because
  // _runAccount's _owedSelf keys off the ledger ALONE, the entry has to be DROPPED here, not merely skipped.
  const o = new Orchestrator(() => {}, {});
  const A = UQ('A', ['g1', 'g2', 'g3']);
  o._data = { posts: [{ id: 'P1' }], groups: ['g1', 'g2', 'g3'].map((g) => ({ id: g })), settings: {}, accounts: [A] };
  o._active = [A];
  o._dealt = new Set(); // Loop-campaign recycle cleared it
  o._owed = { A: { postId: 'P1', gids: ['g3'] } };
  assert.deepEqual(o._postsForAccount(A, 1, true).map((p) => p.id), ['P1'], 'P1 re-dealt by the recycle');
  assert.ok(!o._owed.A, 'stale owed dropped → _owedSelf cannot scope the recycled delivery down to [g3]');
});

// ───────────────────────────── UNIT: reconciliation + the guard-purge idempotency trap ─────────────────────

function reconOrch(tag, accounts) {
  const tmp = mkTmp(tag);
  store.init(tmp);
  const o = new Orchestrator(() => {}, {});
  o._data = { posts: [{ id: 'P1' }], groups: [], settings: {}, accounts };
  o._owed = {};
  o._cycleObligation = {};
  o._cycleDelivered = new Set();
  o._inflightDelivered = new Set();
  return { tmp, o };
}

test('[b] reconcile: a unique partial → owed = the un-reached groups (fleet-wide empty-scope keys)', () => {
  const { tmp, o } = reconOrch('recon-us', [UQ('A', ['g1', 'g2', 'g3', 'g4', 'g5'])]);
  o._cycleObligation = { A: { postId: 'P1', expectedGids: ['g1', 'g2', 'g3', 'g4', 'g5'] } };
  o._cycleDelivered = new Set(['P1::g1', 'P1::g2']); // unique/sequence → EMPTY _dkScope prefix
  o._reconcileOwedLedger();
  assert.deepEqual(o._owed.A, { postId: 'P1', gids: ['g3', 'g4', 'g5'] }, 'the 3 un-reached groups carry; the 2 delivered never do');
  assert.deepEqual(store.loadRotation().owedLedger.A, { postId: 'P1', gids: ['g3', 'g4', 'g5'] }, 'persisted to rotation.json');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('[a] reconcile: a group known delivered ONLY via the durable guard is never re-owed', () => {
  const { tmp, o } = reconOrch('recon-guard', [UQ('A', ['g1', 'g2'])]);
  o._cycleObligation = { A: { postId: 'P1', expectedGids: ['g1', 'g2'] } };
  o._cycleDelivered = new Set(['P1::g2']);
  o._inflightDelivered = new Set(['P1::g1']); // g1 landed before a crash; the worker skipped it (so it never re-marked)
  o._reconcileOwedLedger();
  assert.ok(!o._owed.A, 'g1 counts as delivered → nothing owed → no reserve is ever handed g1 to re-post');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('[a] reconcile is IDEMPOTENT across the _inflightDelivered purge (no resurrection of delivered groups)', () => {
  // The trap: _reconcileOwedFor runs INLINE before _persistDealt, which then PURGES the durable guard for a
  // no-longer-owed post. The end-of-pool sweep re-reconciles the same obligation — if the owed math depended on the
  // (now purged) guard, it would resurrect g1 into the ledger and a reserve stand-in would re-post it.
  const { tmp, o } = reconOrch('recon-idem', [UQ('A', ['g1', 'g2'])]);
  o._cycleObligation = { A: { postId: 'P1', expectedGids: ['g1', 'g2'] } };
  o._cycleDelivered = new Set(['P1::g2']);
  o._inflightDelivered = new Set(['P1::g1']);
  o._reconcileOwedFor('A');                     // inline pass → owed clears
  assert.ok(!o._owed.A);
  o._inflightDelivered.clear();                 // _persistDealt purges the guard: P1 is no longer owed
  o._reconcileOwedFor('A');                     // end-of-pool sweep re-runs the SAME obligation
  assert.ok(!o._owed.A, 'still clear — the guard hit was promoted into _cycleDelivered, so the sweep cannot resurrect g1');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('[a] _persistDealt keeps the durable guard for a STILL-OWED post, purges it once discharged', async () => {
  const tmp = mkTmp('purge'); store.init(tmp);
  const o = new Orchestrator(() => {}, {});
  o._data = { posts: [{ id: 'P1' }], groups: [], settings: {}, accounts: [UQ('A', ['g1', 'g2'])] };
  o._dealt = new Set();
  o._inflightDelivered = new Set(['P1::g1']);
  o._owed = { A: { postId: 'P1', gids: ['g2'] } };
  assert.equal(await o._persistDealt(['P1']), true);
  assert.ok(o._inflightDelivered.has('P1::g1'), 'still owed → the guard SURVIVES (it is the only durable proof g1 landed)');
  delete o._owed.A; // the owed is discharged
  assert.equal(await o._persistDealt(['P1']), true);
  assert.ok(!o._inflightDelivered.has('P1::g1'), 'discharged → the guard is purged (stays bounded)');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ───────────────────────────── UNIT: completion-awareness ──────────────────────────────────────────────────

test('[c] unique owed blocks completion: _outstandingWork counts the owed gids (no false 100%)', () => {
  const tmp = mkTmp('comp-us'); store.init(tmp);
  const o = new Orchestrator(() => {}, {});
  const A = UQ('A', ['g1', 'g2', 'g3', 'g4', 'g5']);
  o._data = { posts: [{ id: 'P1' }], groups: [], settings: {}, accounts: [A] };
  o._dealt = new Set(['P1']); // every post dealt → the old tally said "100% delivered"
  o._owed = {};
  assert.equal(o._outstandingWork([A]).undealt, 0, 'nothing owed → nothing outstanding');
  o._owed = { A: { postId: 'P1', gids: ['g3', 'g4', 'g5'] } };
  assert.equal(o._outstandingWork([A]).undealt, 3, 'the 3 un-reached (post,group) pairs are outstanding → completion waits');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('[c] _outstandingWork counts a DISABLED unique agent\'s owed (a reserve still finishes it)', () => {
  const tmp = mkTmp('comp-disabled'); store.init(tmp);
  const o = new Orchestrator(() => {}, {});
  const A = { ...UQ('A', ['g1', 'g2']), enabled: false };
  o._data = { posts: [{ id: 'P1' }], groups: [], settings: {}, accounts: [A] };
  o._dealt = new Set(['P1']);
  o._owed = { A: { postId: 'P1', gids: ['g2'] } };
  assert.equal(o._outstandingWork([]).undealt, 1, 'tallied over the ROSTER, not `active` — an active-only tally collapses to a false 100%');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('[c] _outstandingWork does NOT count an owed post that is un-dealt or deleted (no wedged run)', () => {
  const tmp = mkTmp('comp-honest'); store.init(tmp);
  const o = new Orchestrator(() => {}, {});
  const A = UQ('A', ['g1', 'g2']);
  o._data = { posts: [{ id: 'P1' }], groups: [], settings: {}, accounts: [A] };
  o._dealt = new Set(); // un-dealt → already counted whole by the undealt tally
  o._owed = { A: { postId: 'P1', gids: ['g2'] } };
  assert.equal(o._outstandingWork([A]).undealt, 1, 'counted ONCE as an undealt post, not double-counted as a post + its owed gids');
  o._dealt = new Set(['PX']);
  o._owed = { A: { postId: 'PX', gids: ['g2'] } }; // PX deleted from the library
  assert.equal(o._outstandingWork([A]).undealt, 1, 'a deleted owed post is not deliverable → not counted (ADR-0009: total===0 means everything DELIVERABLE was delivered)');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ───────────────────────────── UNIT: crash-fold × owed ─────────────────────────────────────────────────────

test('[a] crash-fold prunes the owed ledger against the groups it just proved delivered', () => {
  // A crash DURING an owed re-pick: the dead run reached g3, so the ledger must not still hand g3 to a reserve.
  const tmp = mkTmp('fold-owed'); store.init(tmp);
  store.appendInflight({ q: 5, a: 'A', o: 'unique', s: '', p: 'P1', g: 'g3', d: new Date().toISOString().slice(0, 10), t: Date.now() });
  store.saveRotation({
    dealt: ['P1'], roundOffset: 0, staggerRotation: 0, lastDailyRunDate: null, campaignPlan: null,
    perAccountRotation: {}, owedLedger: { A: { postId: 'P1', gids: ['g3', 'g4', 'g5'] } }, inflightSeq: {},
  });
  const o = new Orchestrator(() => {}, {});
  const data = { posts: [{ id: 'P1' }], groups: ['g3', 'g4', 'g5'].map((g) => ({ id: g, groupId: g })), settings: {}, accounts: [UQ('A', ['g3', 'g4', 'g5'])] };
  // Mirror what _loop seeds from rotation.json before folding the crash journal.
  const _st = store.loadRotation();
  o._dealt = new Set(_st.dealt);
  o._owed = _st.owedLedger;
  o._perAccountRotation = _st.perAccountRotation || {};
  o._inflightSeq = _st.inflightSeq || {};
  o._recoverInflightJournal(data);
  assert.deepEqual(o._owed.A.gids, ['g4', 'g5'], 'g3 pruned — the fold proved it landed, so no reserve stand-in can re-post it');
  assert.ok(o._inflightDelivered.has('P1::g3'), 'and the durable guard still stops the agent re-posting g3');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ───────────────────────────── INTEGRATION: the finding's exact scenario ───────────────────────────────────

test('[a][b][c] INTEGRATION: unique partial-delivers 2/5 with NO reserve → the 3 un-reached groups persist + are counted', async () => {
  const tmp = mkTmp('int-partial'); store.init(tmp);
  const calls = [];
  runHandler = makeMock(calls, ({ postId, targetGids }) => (postId === 'P1' ? ['g1', 'g2'] : targetGids)); // deliver g1,g2 of {g1..g5}, then drop
  store.save({
    posts: [{ id: 'P1', caption: 'a', imagePaths: [] }, { id: 'P2', caption: 'b', imagePaths: [] }],
    groups: ['g1', 'g2', 'g3', 'g4', 'g5'].map((g) => ({ id: g, name: g, groupId: g })),
    accounts: [UQ('A', ['g1', 'g2', 'g3', 'g4', 'g5'])], // no reserve exists → the old code stranded the un-reached groups
    settings: { parallelAccounts: 1, accountDelay: 0, waitInterval: 0, groupDelay: 0, maxCycles: 1, staggerAccounts: false, varyImages: false },
    proxies: [], useProxies: false,
  });
  const orch = new Orchestrator(() => {}, {});
  await runOneCycle(orch, () => (store.loadRotation().owedLedger || {}).A);
  runHandler = null;

  const owed = (store.loadRotation().owedLedger || {}).A;
  assert.ok(owed, 'the partial is CARRIED — it used to vanish into the dealt-set with no trace');
  assert.equal(owed.postId, 'P1');
  assert.deepEqual(owed.gids.slice().sort(), ['g3', 'g4', 'g5'], 'exactly the 3 un-reached groups');
  assert.ok(store.loadRotation().dealt.includes('P1'), 'P1 stays dealt (no other account re-deals it) — the owed ledger is what recovers it');
  for (const g of ['g1', 'g2']) assert.equal(calls.filter((c) => c.gid === g).length, 1, `${g} delivered exactly once`);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('[a][b] INTEGRATION: next cycle re-picks the owed post to ONLY the 3 un-reached groups (g1,g2 NOT re-posted)', async () => {
  const tmp = mkTmp('int-discharge'); store.init(tmp);
  const calls = [];
  runHandler = makeMock(calls, ({ targetGids }) => targetGids); // deliver whatever it is asked to
  // Pre-seed the exact post-partial state: P1 dealt, g1+g2 delivered, g3..g5 owed.
  store.saveRotation({
    dealt: ['P1'], roundOffset: 0, staggerRotation: 0, lastDailyRunDate: null, campaignPlan: null,
    perAccountRotation: {}, owedLedger: { A: { postId: 'P1', gids: ['g3', 'g4', 'g5'] } }, inflightSeq: {},
  });
  store.save({
    posts: [{ id: 'P1', caption: 'a', imagePaths: [] }, { id: 'P2', caption: 'b', imagePaths: [] }],
    groups: ['g1', 'g2', 'g3', 'g4', 'g5'].map((g) => ({ id: g, name: g, groupId: g })),
    accounts: [UQ('A', ['g1', 'g2', 'g3', 'g4', 'g5'])],
    settings: { parallelAccounts: 1, accountDelay: 0, waitInterval: 0, groupDelay: 0, maxCycles: 1, staggerAccounts: false, varyImages: false },
    proxies: [], useProxies: false,
  });
  const orch = new Orchestrator(() => {}, {});
  await runOneCycle(orch, () => !(store.loadRotation().owedLedger || {}).A);
  runHandler = null;

  // (a) THE ban-risk invariant: the 2 already-delivered groups are never touched again
  assert.equal(calls.filter((c) => c.gid === 'g1').length, 0, 'g1 NOT re-posted');
  assert.equal(calls.filter((c) => c.gid === 'g2').length, 0, 'g2 NOT re-posted');
  // (b) the un-reached groups get the SAME post
  assert.deepEqual(calls.filter((c) => c.postId === 'P1').map((c) => c.gid).sort(), ['g3', 'g4', 'g5'], 'P1 finished to exactly g3,g4,g5');
  assert.ok(calls.filter((c) => c.postId === 'P1').every((c) => c.onlyGroups && c.onlyGroups.slice().sort().join() === 'g3,g4,g5'), 'the worker was scoped via onlyGroups=[g3,g4,g5]');
  assert.ok(!(store.loadRotation().owedLedger || {}).A, 'ledger cleared once fully covered');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('[a][b] INTEGRATION: a reserve finishing a unique partial lands ONLY the un-reached groups', async () => {
  const tmp = mkTmp('int-reserve'); store.init(tmp);
  const calls = [];
  // A delivers g1,g2 of {g1..g4} then drops. Reserve R (in g3,g4) finishes only g3 and drops at g4 → g4 must CARRY.
  runHandler = makeMock(calls, ({ name }) => (name === 'A' ? ['g1', 'g2'] : ['g3']));
  store.save({
    posts: [{ id: 'P1', caption: 'a', imagePaths: [] }, { id: 'P2', caption: 'b', imagePaths: [] }],
    groups: ['g1', 'g2', 'g3', 'g4'].map((g) => ({ id: g, name: g, groupId: g })),
    accounts: [UQ('A', ['g1', 'g2', 'g3', 'g4']), { ...UQ('R', ['g3', 'g4']), standby: true }],
    settings: { parallelAccounts: 2, accountDelay: 0, waitInterval: 0, groupDelay: 0, maxCycles: 1, staggerAccounts: false, varyImages: false },
    proxies: [], useProxies: false,
  });
  const orch = new Orchestrator(() => {}, {});
  await runOneCycle(orch, () => { const o = (store.loadRotation().owedLedger || {}).A; return o && o.gids && o.gids.length === 1; });
  runHandler = null;

  const owed = (store.loadRotation().owedLedger || {}).A;
  assert.deepEqual(owed.gids.slice().sort(), ['g4'], 'g4 (reached by nobody) still carries — the reserve covering g3 does not mask it');
  for (const g of ['g1', 'g2', 'g3']) assert.equal(calls.filter((c) => c.gid === g).length, 1, `${g} delivered exactly once across A + R (no double-post)`);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------------
// [a] REGRESSION — the reserve-cover obligation gate (the ban-risk axis).
//
// THE BUG this locks out: [9] gave unique/sequence a persistent owed ledger, and _hasPersistentOwed + the
// persistent-owed synthesis (_owedStandins) are MODE-AGNOSTIC — so a reserve now covers a UNIQUE agent's owed. But the
// stand-in bookkeeping's obligation gate still admitted ONLY daily-rotation/campaign-plan, so that cover recorded NO
// _cycleObligation → _reconcileOwedFor early-returns (!ob) → this._owed[forAgent] SURVIVED A SUCCESSFUL COVER → the
// synthesis re-dispatched the IDENTICAL gids the next cycle. A stand-in's _uniqueSeqGuard is FALSE, so its only defense
// was _cycleDelivered — which resets every cycle. Net: the reserve re-posted the SAME (post,group) EVERY cycle on the
// one shared IP (measured: 3 cycles → 3× per group), verbatim the failure the [DISABLED-AGENT FIX] closed for the
// pointer modes.
//
// WHY THE WHOLE SUITE WAS BLIND TO IT: the crash-fold's [9] block reconciles the ledger from the journal on every
// process start, so it CLEARS the stale entry on restart. Any test that models the next cycle as a NEW PROCESS passes.
// Only a HEALTHY days-unattended run (fold runs once, cycles keep going) accumulates the duplicates — i.e. exactly the
// product's purpose. Hence this tests the ADMISSION DECISION directly, in-process, with no fold in between.
const { standinObligationAdmits } = require('../automation/orchestrator');

test('[a] stand-in obligation: a unique/sequence cover WITH a baseline records the obligation (ledger clears → no re-dispatch)', () => {
  // The live path: _owedStandins is seeded from _owed[A].postId, so a baseline is always present.
  assert.equal(standinObligationAdmits('unique', true), true, 'unique + baseline MUST record → _reconcileOwedFor can clear _owed → the reserve never re-posts');
  assert.equal(standinObligationAdmits('unique-random', true), true, 'the unique-* family too (order.includes(unique))');
  assert.equal(standinObligationAdmits('sequence', true), true, 'sequence is the same dedup axis');
});

test('[a] stand-in obligation: unique/sequence WITHOUT a baseline records nothing (strand, never a double-post)', () => {
  // No baseline → expectedGids would fall back to the full assigned set (re-owing already-delivered groups → re-post)
  // or, for an absent/disabled forAgent, to an EMPTY set (→ still=[] → delete _owed → silent strand). Refuse both.
  assert.equal(standinObligationAdmits('unique', false), false, 'no owed baseline → record nothing: a strand is recoverable, a double-post is a ban');
  assert.equal(standinObligationAdmits('sequence', false), false);
});

test('[a] stand-in obligation: the pointer modes are admitted unconditionally (v1.0.107 behavior unchanged)', () => {
  for (const m of ['daily-rotation', 'campaign-plan']) {
    assert.equal(standinObligationAdmits(m, true), true, `${m} + baseline`);
    assert.equal(standinObligationAdmits(m, false), true, `${m} with NO baseline still records — its full-assigned-set fallback is correct for a fresh whole-set takeover (the [DISABLED-AGENT FIX] path)`);
  }
});

test('[a] stand-in obligation: an unknown/absent mode is never admitted (no obligation on a mode we cannot reason about)', () => {
  for (const m of ['', null, undefined, 'post-centric', 'random']) {
    assert.equal(standinObligationAdmits(m, true), false, `mode ${JSON.stringify(m)} must not record an obligation`);
  }
});
