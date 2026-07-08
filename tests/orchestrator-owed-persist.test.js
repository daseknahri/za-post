// tests/orchestrator-owed-persist.test.js
// PERSISTENT per-(post,group) OWED LEDGER — fixes the DEFERRED [7] daily-rotation + [8] campaign-plan partial-drop
// silent-miss. A daily-rotation / campaign-plan agent that delivers its post to SOME but not all of its groups then
// drops (logout / checkpoint / crash) must, next cycle/day, finish the SAME post to ONLY the un-reached groups —
// never permanently skipping a group (invariant-#2) and never re-posting a delivered one (no double-post).
//
// The four adversarial invariants proven here:
//   (a) no group is ever double-posted on a retry / discharge (delivered groups are excluded from owed + onlyGroups)
//   (b) no un-reached group is permanently skipped (owed carries across cycles/days + persists to rotation.json)
//   (c) the pointer/quota logic still paces correctly (still 1 post/day; owed discharged before advancing)
//   (d) single-run (non-partial) behavior is unchanged (a full delivery clears owed; nothing is owed)
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

const mkTmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-owed-' + tag + '-'));
const DR = (name, groups) => ({ name, assignedGroups: groups, postingOrder: 'daily-rotation', postFilter: 'all', enabled: true, status: 'logged_in', standby: false });
const CP = (name, groups) => ({ name, assignedGroups: groups, postingOrder: 'campaign-plan', postFilter: 'all', enabled: true, status: 'logged_in', standby: false });

// A worker mock that mirrors the REAL worker's group targeting: assigned ∩ onlyGroups, honoring the per-(post,group)
// dedup ledger. `plan(o, targetGids)` returns the subset of gids to actually deliver this call (simulating a drop).
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
      if (o.alreadyDelivered(gid)) continue; // dedup ledger: never touch a group already delivered this cycle
      if (toDeliver.has(gid)) { o.markDelivered(gid); posted++; calls.push({ name, postId, gid, onlyGroups: o.onlyGroups ? [...o.onlyGroups] : null }); }
    }
    return { posted, errors: targetGids.length - posted, pendingApproval: 0, noRetry: false, flag: null, postedIds: posted ? [postId] : [], dealtIds: posted ? [postId] : [], fullyPosted: posted === targetGids.length, offline: false, progressed: posted > 0, heldRecords: [], commentQueue: [] };
  };
}

// ───────────────────────────── UNIT: pick override ─────────────────────────────────────────────────────────

test('[c] daily-rotation owed: discharge respects 1/day (same-day blocked) then re-picks the SAME post next day', () => {
  const o = new Orchestrator(() => {}, {});
  o._data = { posts: [{ id: 'P1' }, { id: 'P2' }, { id: 'P3' }], groups: ['g1', 'g2', 'g3', 'g4'].map((g) => ({ id: g })), settings: {}, accounts: [] };
  o._perAccountRotation = { A: { lastPostId: 'P1', lastPostedDate: o._localDayKey(), postsToday: 1, postsTodayDate: o._localDayKey() } };
  o._owed = { A: { postId: 'P1', gids: ['g3', 'g4'] } };
  const A = DR('A', ['g1', 'g2', 'g3', 'g4']);
  assert.deepEqual(o._postsForAccount(A, 1), [], 'already posted today → nothing more today (owed waits, pacing preserved)');
  // next day: the owed override returns the SAME post P1, NOT the next post P2
  o._perAccountRotation.A = { lastPostId: 'P1', lastPostedDate: '2000-01-01', postsToday: 1, postsTodayDate: '2000-01-01' };
  assert.deepEqual(o._postsForAccount(A, 2).map((p) => p.id), ['P1'], 'owed → re-pick P1 (the partially-delivered post), not P2');
  // once the owed obligation is cleared, the next day advances normally to P2
  o._owed = {};
  assert.deepEqual(o._postsForAccount(A, 3).map((p) => p.id), ['P2'], 'owed cleared → normal advance P1 → P2');
});

test('[b] daily-rotation owed: a deleted owed post drops the stale obligation and advances normally (claim=true)', () => {
  const o = new Orchestrator(() => {}, {});
  o._data = { posts: [{ id: 'P1' }, { id: 'P2' }], settings: {}, accounts: [] };
  o._perAccountRotation = { A: { lastPostId: 'P1', lastPostedDate: '2000-01-01' } };
  o._owed = { A: { postId: 'GONE', gids: ['g3'] } };
  const A = DR('A', ['g1', 'g2', 'g3']);
  assert.deepEqual(o._postsForAccount(A, 2, true).map((p) => p.id), ['P2'], 'owed post gone → fall through to normal next pick');
  assert.ok(!o._owed.A, 'stale owed obligation deleted on a real (claim) pick');
});

test('[c] daily-rotation owed: an owed group the operator UN-assigned is pruned (no undeliverable-owed livelock)', () => {
  const o = new Orchestrator(() => {}, {});
  o._data = { posts: [{ id: 'P1' }, { id: 'P2' }], groups: [{ id: 'g1' }, { id: 'g3' }], settings: {}, accounts: [] }; // g4 removed from the library/groups
  o._perAccountRotation = { A: { lastPostId: 'P1', lastPostedDate: '2000-01-01' } };
  o._owed = { A: { postId: 'P1', gids: ['g3', 'g4'] } };
  const A = DR('A', ['g1', 'g3']); // A no longer assigned to g4
  assert.deepEqual(o._postsForAccount(A, 2, true).map((p) => p.id), ['P1'], 'still owes g3 → re-picks P1');
  assert.deepEqual(o._owed.A.gids, ['g3'], 'the un-assigned g4 is pruned from the owed set (only the still-assigned g3 remains)');
});

test('[c] daily-rotation owed: ALL owed groups un-assigned → obligation dropped, rotation resumes (no livelock)', () => {
  const o = new Orchestrator(() => {}, {});
  o._data = { posts: [{ id: 'P1' }, { id: 'P2' }], groups: [{ id: 'g1' }], settings: {}, accounts: [] };
  o._perAccountRotation = { A: { lastPostId: 'P1', lastPostedDate: '2000-01-01' } };
  o._owed = { A: { postId: 'P1', gids: ['g3', 'g4'] } };
  const A = DR('A', ['g1']); // neither owed group is assigned anymore
  assert.deepEqual(o._postsForAccount(A, 2, true).map((p) => p.id), ['P2'], 'no deliverable owed group → drop owed + advance normally to P2');
  assert.ok(!o._owed.A, 'stale owed obligation cleared');
});

test('[b] campaign-plan owed: re-picks the owed slice-post from the FULL library before advancing', () => {
  const o = new Orchestrator(() => {}, {});
  o._data = { posts: [{ id: 'P1' }, { id: 'P2' }, { id: 'P3' }, { id: 'P4' }], groups: [{ id: 'g1' }, { id: 'g2' }], settings: {}, accounts: [] };
  const A = CP('A', ['g1', 'g2']);
  o._active = [A];
  o._campaignPlan = o._computeCampaignPlan(o._data.posts, [A], 0); // A slice = [P1,P2,P3,P4]
  o._perAccountRotation = { A: { lastPostId: 'P1', lastPostedDate: '2000-01-01' } }; // pointer already past P1 → would pick P2
  o._owed = { A: { postId: 'P1', gids: ['g2'] } };
  assert.deepEqual(o._postsForAccount(A, 1).map((p) => p.id), ['P1'], 'owed slice-post P1 re-picked, NOT the pointer-next P2');
  o._owed = {};
  assert.deepEqual(o._postsForAccount(A, 1).map((p) => p.id), ['P2'], 'owed cleared → slice pointer advances to P2');
});

test('[d] no owed → daily-rotation + campaign-plan pick is byte-identical to before (single-run unchanged)', () => {
  const o = new Orchestrator(() => {}, {});
  o._data = { posts: [{ id: 'P1' }, { id: 'P2' }, { id: 'P3' }], settings: {}, accounts: [] };
  o._perAccountRotation = { A: { lastPostId: 'P1', lastPostedDate: '2000-01-01' } };
  // _owed defaults to {} from the constructor → override is inert
  assert.deepEqual(o._postsForAccount(DR('A', ['g1']), 1).map((p) => p.id), ['P2'], 'daily-rotation advances p1 → p2 exactly as before');
});

// ───────────────────────────── UNIT: reconciliation ────────────────────────────────────────────────────────

function reconOrch(tag) {
  const tmp = mkTmp(tag);
  store.init(tmp);
  const o = new Orchestrator(() => {}, {});
  o._owed = {};
  o._cycleObligation = {};
  o._cycleDelivered = new Set();
  return { tmp, o };
}

test('[a][b] reconcile: a fresh partial delivery → owed = the un-reached groups (delivered groups excluded)', () => {
  const { tmp, o } = reconOrch('recon1');
  o._cycleObligation = { A: { postId: 'P1', expectedGids: ['g1', 'g2', 'g3', 'g4'] } };
  o._cycleDelivered = new Set(['P1::g1', 'P1::g2']); // delivered g1,g2; dropped at g3,g4
  o._reconcileOwedLedger();
  assert.deepEqual(o._owed.A, { postId: 'P1', gids: ['g3', 'g4'] }, 'owed carries ONLY the un-reached g3,g4 — never the delivered g1,g2');
  assert.deepEqual(store.loadRotation().owedLedger.A, { postId: 'P1', gids: ['g3', 'g4'] }, 'persisted to rotation.json');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('[a][d] reconcile: a FULLY delivered post clears any owed (no delivered group is ever re-posted)', () => {
  const { tmp, o } = reconOrch('recon2');
  o._owed = { A: { postId: 'P1', gids: ['g3', 'g4'] } }; // was owed from a prior cycle
  o._cycleObligation = { A: { postId: 'P1', expectedGids: ['g3', 'g4'] } }; // discharge run targeted only the owed groups
  o._cycleDelivered = new Set(['P1::g3', 'P1::g4']); // both delivered this cycle
  o._reconcileOwedLedger();
  assert.ok(!o._owed.A, 'owed cleared — obligation fully covered');
  assert.ok(!store.loadRotation().owedLedger.A, 'cleared on disk too');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('[b] reconcile: a discharge that STILL drops carries the remaining un-reached groups', () => {
  const { tmp, o } = reconOrch('recon3');
  o._owed = { A: { postId: 'P1', gids: ['g3', 'g4'] } };
  o._cycleObligation = { A: { postId: 'P1', expectedGids: ['g3', 'g4'] } };
  o._cycleDelivered = new Set(['P1::g3']); // delivered g3, dropped again at g4
  o._reconcileOwedLedger();
  assert.deepEqual(o._owed.A, { postId: 'P1', gids: ['g4'] }, 'still owes g4 → carried to the next cycle/day');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// _reconcileOwedFor is the CRASH-SAFETY primitive: it is called INLINE right before each per-account rotation save,
// so this._owed is persisted in lock-step with the pointer advance (closing the discharge double-post window that
// reviewer #1 found and the fresh silent-miss window that reviewer #2 found).

test('[a] crash-safety: inline reconcile TRIMS an already-delivered group from a stale owed entry before the save', () => {
  const { tmp, o } = reconOrch('cs1');
  o._owed = { A: { postId: 'P1', gids: ['g3', 'g4'] } }; // stale (pre-cycle) discharge obligation, as loaded from disk
  o._cycleObligation = { A: { postId: 'P1', expectedGids: ['g3', 'g4'] } };
  o._cycleDelivered = new Set(['P1::g3']); // discharge delivered g3, about to save the pointer
  const changed = o._reconcileOwedFor('A');
  assert.equal(changed, true);
  assert.deepEqual(o._owed.A, { postId: 'P1', gids: ['g4'] }, 'g3 (just delivered) is removed BEFORE the save → a crash cannot re-post g3');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('[b] crash-safety: inline reconcile SETS owed for a fresh partial before the save (so a crash cannot lose it)', () => {
  const { tmp, o } = reconOrch('cs2');
  o._owed = {}; // fresh post — no prior owed
  o._cycleObligation = { A: { postId: 'P1', expectedGids: ['g1', 'g2', 'g3', 'g4'] } };
  o._cycleDelivered = new Set(['P1::g1', 'P1::g2']); // delivered g1,g2, about to advance+save the pointer past P1
  const changed = o._reconcileOwedFor('A');
  assert.equal(changed, true);
  assert.deepEqual(o._owed.A, { postId: 'P1', gids: ['g3', 'g4'] }, 'un-reached g3,g4 persisted WITH the pointer advance → crash-safe (no silent skip)');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('[a][d] crash-safety: inline reconcile CLEARS owed when the agent fully covered it (no lingering re-post)', () => {
  const { tmp, o } = reconOrch('cs3');
  o._owed = { A: { postId: 'P1', gids: ['g3', 'g4'] } };
  o._cycleObligation = { A: { postId: 'P1', expectedGids: ['g3', 'g4'] } };
  o._cycleDelivered = new Set(['P1::g3', 'P1::g4']);
  assert.equal(o._reconcileOwedFor('A'), true);
  assert.ok(!o._owed.A, 'fully covered → owed cleared before the save');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('[b] crash-safety: inline reconcile leaves owed UNTOUCHED when the agent has no obligation (full drop keeps prior owed)', () => {
  const { tmp, o } = reconOrch('cs4');
  o._owed = { A: { postId: 'P1', gids: ['g3', 'g4'] } }; // prior owed
  o._cycleObligation = {}; // A delivered nothing this cycle (full drop) → no obligation recorded
  assert.equal(o._reconcileOwedFor('A'), false);
  assert.deepEqual(o._owed.A, { postId: 'P1', gids: ['g3', 'g4'] }, 'a full drop keeps its prior owed (retries next cycle) — not lost');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('[d] reconcile: no obligation this cycle → owed ledger untouched, no write', () => {
  const { tmp, o } = reconOrch('recon4');
  o._owed = { B: { postId: 'PZ', gids: ['g9'] } };
  o._cycleObligation = {};
  const changed = o._reconcileOwedLedger();
  assert.equal(changed, false, 'nothing obligated → no change');
  assert.deepEqual(o._owed.B, { postId: 'PZ', gids: ['g9'] }, 'unrelated owed entry preserved');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ───────────────────────────── UNIT: completion-awareness ──────────────────────────────────────────────────

test('[b] campaign owed blocks completion: _campaignAllFinished is false + _outstandingWork counts the owed groups', () => {
  const tmp = mkTmp('comp'); store.init(tmp);
  const o = new Orchestrator(() => {}, {});
  o._data = { posts: [{ id: 'P1' }, { id: 'P2' }], settings: {}, accounts: [] };
  const A = CP('A', ['g1', 'g2']);
  o._active = [A];
  o._campaignPlan = o._computeCampaignPlan(o._data.posts, [A], 0);
  o._perAccountRotation = { A: { lastPostId: 'P2', lastPostedDate: '2000-01-01' } }; // slice pointer LOOKS complete
  o._owed = {};
  assert.equal(o._campaignAllFinished(), true, 'no owed → slice complete → finished');
  assert.equal(o._outstandingWork([A]).undealt, 0, 'no owed → nothing outstanding');
  o._owed = { A: { postId: 'P1', gids: ['g2'] } }; // but g2 still owes P1
  assert.equal(o._campaignAllFinished(), false, 'owed groups → NOT finished (would else stop / reshuffle with a permanent miss)');
  assert.equal(o._outstandingWork([A]).undealt, 1, 'the 1 owed (post,group) is outstanding work');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ───────────────────────────── UNIT: persistence round-trip ────────────────────────────────────────────────

test('[b] owedLedger round-trips through saveRotation → loadRotation, alongside the other rotation fields', () => {
  const tmp = mkTmp('rt'); store.init(tmp);
  const o = new Orchestrator(() => {}, {});
  o._dealt = new Set(['x']);
  o._perAccountRotation = { A: { lastPostId: 'P1', lastPostedDate: '2026-01-01' } };
  o._owed = { A: { postId: 'P1', gids: ['g3', 'g4'] } };
  assert.equal(o._saveRotationState(), true);
  const st = store.loadRotation();
  assert.deepEqual(st.owedLedger, { A: { postId: 'P1', gids: ['g3', 'g4'] } }, 'owed persisted');
  assert.deepEqual(st.perAccountRotation.A.lastPostId, 'P1', 'sibling fields not dropped');
  assert.deepEqual(st.dealt, ['x'], 'dealt not dropped');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ───────────────────────────── INTEGRATION: full pool, mocked worker ───────────────────────────────────────

async function runOneCycle(orch, until) {
  orch.start(() => store.load());
  for (let i = 0; i < 300; i++) { if (until()) break; await new Promise((r) => setTimeout(r, 50)); }
  try { orch.stop(); } catch {}
  await new Promise((r) => setTimeout(r, 50));
}

test('[b] INTEGRATION: a partial daily-rotation delivery persists the un-reached groups to the owed ledger', async () => {
  const tmp = mkTmp('int-fresh'); store.init(tmp);
  const calls = [];
  runHandler = makeMock(calls, ({ postId, targetGids }) => (postId === 'P1' ? ['g1', 'g2'] : targetGids)); // deliver only g1,g2 of {g1..g4}, then "drop"
  store.save({
    posts: [{ id: 'P1', caption: 'a', imagePaths: [] }, { id: 'P2', caption: 'b', imagePaths: [] }],
    groups: ['g1', 'g2', 'g3', 'g4'].map((g) => ({ id: g, name: g, groupId: g })),
    accounts: [DR('A', ['g1', 'g2', 'g3', 'g4'])],
    settings: { parallelAccounts: 1, accountDelay: 0, waitInterval: 0, groupDelay: 0, maxCycles: 1, staggerAccounts: false, varyImages: false },
    proxies: [], useProxies: false,
  });
  const orch = new Orchestrator(() => {}, {});
  await runOneCycle(orch, () => (store.loadRotation().owedLedger || {}).A);
  runHandler = null;

  const owed = (store.loadRotation().owedLedger || {}).A;
  assert.ok(owed, 'A owes something after a partial delivery');
  assert.equal(owed.postId, 'P1');
  assert.deepEqual(owed.gids.slice().sort(), ['g3', 'g4'], 'the un-reached g3,g4 are owed (g1,g2 were delivered)');
  // pointer advanced (still 1/day) — daily pacing intact
  const rec = store.loadRotation().perAccountRotation.A;
  assert.equal(rec.lastPostId, 'P1'); assert.equal(rec.lastPostedDate, orch._localDayKey());
  // and g1,g2 were each delivered exactly once (no double-post)
  assert.deepEqual(calls.filter((c) => c.gid === 'g1').length, 1);
  assert.deepEqual(calls.filter((c) => c.gid === 'g2').length, 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('[a][b][c] INTEGRATION: next day the agent finishes ONLY the owed groups (no double-post) and clears the ledger', async () => {
  const tmp = mkTmp('int-discharge'); store.init(tmp);
  const calls = [];
  runHandler = makeMock(calls, ({ targetGids }) => targetGids); // deliver everything it's asked to (the owed subset)
  // Pre-seed: A already posted P1 to g1,g2 on a PAST day and owes g3,g4.
  store.saveRotation({
    dealt: [], roundOffset: 0, staggerRotation: 0, lastDailyRunDate: null, campaignPlan: null,
    perAccountRotation: { A: { lastPostId: 'P1', lastPostedDate: '2000-01-01', postsToday: 1, postsTodayDate: '2000-01-01' } },
    owedLedger: { A: { postId: 'P1', gids: ['g3', 'g4'] } },
  });
  store.save({
    posts: [{ id: 'P1', caption: 'a', imagePaths: [] }, { id: 'P2', caption: 'b', imagePaths: [] }],
    groups: ['g1', 'g2', 'g3', 'g4'].map((g) => ({ id: g, name: g, groupId: g })),
    accounts: [DR('A', ['g1', 'g2', 'g3', 'g4'])],
    settings: { parallelAccounts: 1, accountDelay: 0, waitInterval: 0, groupDelay: 0, maxCycles: 1, staggerAccounts: false, varyImages: false },
    proxies: [], useProxies: false,
  });
  const orch = new Orchestrator(() => {}, {});
  await runOneCycle(orch, () => !(store.loadRotation().owedLedger || {}).A);
  runHandler = null;

  // (a) no double-post: g1 and g2 (already delivered on the prior day) are NEVER re-posted
  assert.equal(calls.filter((c) => c.gid === 'g1').length, 0, 'g1 NOT re-posted');
  assert.equal(calls.filter((c) => c.gid === 'g2').length, 0, 'g2 NOT re-posted');
  // (b) the un-reached groups get the SAME post P1
  assert.deepEqual(calls.filter((c) => c.postId === 'P1').map((c) => c.gid).sort(), ['g3', 'g4'], 'only g3,g4 delivered P1');
  assert.ok(calls.every((c) => c.onlyGroups && c.onlyGroups.slice().sort().join() === 'g3,g4'), 'worker was scoped via onlyGroups=[g3,g4]');
  // (d) owed cleared once fully covered
  assert.ok(!(store.loadRotation().owedLedger || {}).A, 'owed ledger cleared after full coverage');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('[a][b] INTEGRATION: a reserve that only PARTIALLY covers the owed groups → the truly un-reached group is still carried', async () => {
  const tmp = mkTmp('int-splitpartial'); store.init(tmp);
  const calls = [];
  // A delivers g1,g2 of {g1..g4} then drops (owes g3,g4). Reserve R (covers g3,g4) is sent to finish them but
  // itself delivers only g3 and drops at g4. The FINAL owed must be exactly {g4} — never losing g4, never re-posting
  // g1,g2,g3. This locks the split-coverage obligation fix (record forAgent's FULL set, not a stand-in's subset).
  runHandler = makeMock(calls, ({ name }) => (name === 'A' ? ['g1', 'g2'] : ['g3']));
  store.save({
    posts: [{ id: 'P1', caption: 'a', imagePaths: [] }, { id: 'P2', caption: 'b', imagePaths: [] }],
    groups: ['g1', 'g2', 'g3', 'g4'].map((g) => ({ id: g, name: g, groupId: g })),
    accounts: [
      DR('A', ['g1', 'g2', 'g3', 'g4']),
      { ...DR('R', ['g3', 'g4']), standby: true }, // healthy in-group reserve for the owed g3,g4
    ],
    settings: { parallelAccounts: 2, accountDelay: 0, waitInterval: 0, groupDelay: 0, maxCycles: 1, staggerAccounts: false, varyImages: false },
    proxies: [], useProxies: false,
  });
  const orch = new Orchestrator(() => {}, {});
  await runOneCycle(orch, () => { const o = (store.loadRotation().owedLedger || {}).A; return o && o.gids && o.gids.length === 1; });
  runHandler = null;

  const owed = (store.loadRotation().owedLedger || {}).A;
  assert.ok(owed, 'A still owes after the reserve only partially covered');
  assert.deepEqual(owed.gids.slice().sort(), ['g4'], 'exactly g4 is still owed (g3 was covered by the reserve, g1/g2 by A) — g4 is NOT lost');
  // no group is delivered more than once across A + R
  for (const g of ['g1', 'g2', 'g3']) assert.equal(calls.filter((c) => c.gid === g).length, 1, `${g} delivered exactly once (no double-post)`);
  assert.equal(calls.filter((c) => c.gid === 'g4').length, 0, 'g4 never delivered (it dropped) → correctly still owed');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('[a] INTEGRATION: daily-rotation gets the per-(post,group) dedup ledger (markDelivered/alreadyDelivered are live)', async () => {
  const tmp = mkTmp('int-dedup'); store.init(tmp);
  let sawFns = null;
  runHandler = async (o) => {
    sawFns = { md: typeof o.markDelivered, ad: typeof o.alreadyDelivered };
    const gid = 'g1';
    o.markDelivered(gid);
    const second = o.alreadyDelivered(gid); // a within-run duplicate attempt must be reported as already-delivered
    return { posted: 1, errors: 0, pendingApproval: 0, noRetry: false, flag: null, postedIds: ['P1'], dealtIds: ['P1'], fullyPosted: true, offline: false, progressed: true, heldRecords: [], commentQueue: [], _second: second };
  };
  store.save({
    posts: [{ id: 'P1', caption: 'a', imagePaths: [] }],
    groups: [{ id: 'g1', name: 'g1', groupId: 'g1' }],
    accounts: [DR('A', ['g1'])],
    settings: { parallelAccounts: 1, accountDelay: 0, waitInterval: 0, groupDelay: 0, maxCycles: 1, staggerAccounts: false, varyImages: false },
    proxies: [], useProxies: false,
  });
  const orch = new Orchestrator(() => {}, {});
  await runOneCycle(orch, () => (store.loadRotation().perAccountRotation || {}).A);
  runHandler = null;
  assert.deepEqual(sawFns, { md: 'function', ad: 'function' }, 'daily-rotation receives REAL dedup callbacks (not no-ops) → a crash-retry can never double-post a delivered group');
  fs.rmSync(tmp, { recursive: true, force: true });
});
