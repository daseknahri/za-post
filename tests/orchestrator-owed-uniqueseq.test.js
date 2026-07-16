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

test('[d] no owed → the unique deal is unchanged (override inert)', () => {
  const o = new Orchestrator(() => {}, {});
  const A = UQ('A', ['g1']);
  o._data = { posts: [{ id: 'P1' }, { id: 'P2' }], groups: [{ id: 'g1' }], settings: {}, accounts: [A] };
  o._active = [A];
  o._dealt = new Set(); // _loop normally seeds this from rotation.json
  assert.deepEqual(o._postsForAccount(A, 1).map((p) => p.id), ['P1'], 'first undealt post dealt exactly as before');
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

// ===============================================================================================================
// LEDGER COHERENCE — the [9] re-delivery was REMOVED; these lock in WHY, so it is not re-added blind.
//
// [9] (v1.0.110) gave unique/sequence a persistent owed ledger + a pick-override. An adversarial audit returned
// FIVE recurring double-posts: a delivered (post,group) re-posted EVERY cycle on the ONE shared IP. Root cause
// PRE-DATES [9]: the ledger's CONSUMERS are mode-agnostic while the producer of its discharge record is not, so an
// entry whose owner cannot discharge it is IMMORTAL and gets re-dispatched to a reserve forever.
//
// The fix is two-sided:
//   (1) do NOT create an entry a mode cannot discharge (the obligation gate is pointer-modes-only again), and
//   (2) do NOT CONSUME an entry whose owner cannot discharge it (_owedDischargeable gates every consumer), and
//       drop-and-log it instead — self-healing across an operator mode-flip.
// Trade: a strand (recoverable, ~1.1% measured) over a double-post (a ban ends the fleet).
// ===============================================================================================================

const mkO = () => new Orchestrator(() => {}, {});

test('[a] REMOVED: a unique agent with an owed entry does NOT re-pick the dealt post (no re-delivery surface)', () => {
  const o = mkO();
  o._data = { accounts: [UQ('A', ['g1', 'g2', 'g3'])], groups: [{ id: 'g1', groupId: 'g1' }, { id: 'g2', groupId: 'g2' }, { id: 'g3', groupId: 'g3' }], posts: [{ id: 'P1' }, { id: 'P2' }], settings: {} };
  o._dealt = new Set(['P1']);            // P1 partial-delivered then dealt
  o._owed = { A: { postId: 'P1', gids: ['g2', 'g3'] } }; // a legacy/stale entry
  const picks = o._postsForAccount(o._data.accounts[0], 0, false).map((p) => p.id);
  assert.deepEqual(picks, ['P2'], 'the dealt P1 is NOT re-picked — it deals the next undealt post; the owed override is gone');
});

test('[a] _owedDischargeable: only the pointer modes (which HAVE a pick-override) may consume an entry', () => {
  const o = mkO();
  o._data = { accounts: [
    { name: 'DR', postingOrder: 'daily-rotation' }, { name: 'CP', postingOrder: 'campaign-plan' },
    { name: 'UQ', postingOrder: 'unique' }, { name: 'SQ', postingOrder: 'sequence' },
    { name: 'PC', postingOrder: 'post-centric' }, { name: 'NM', postingOrder: '' },
  ], groups: [], posts: [], settings: {} };
  for (const n of ['DR', 'CP']) assert.equal(o._owedDischargeable(n), true, `${n} has an owed pick-override → may be consumed`);
  for (const n of ['UQ', 'SQ', 'PC', 'NM']) assert.equal(o._owedDischargeable(n), false, `${n} has NO pick-override → consuming its entry would re-post the same gids every cycle`);
  assert.equal(o._owedDischargeable('ghost'), false, 'an owner no longer in the library is never dischargeable');
});


test('[a] owedDischargeableMode: the ONE predicate BOTH the producer and the consumers gate on', () => {
  const { owedDischargeableMode } = require('../automation/orchestrator');
  // The producer (_cycleObligation gate) and every consumer (_hasPersistentOwed / synthesis / _owedSelf) call this.
  // If they ever disagree again, an entry becomes immortal and a reserve re-posts its gids every cycle.
  for (const m of ['daily-rotation', 'campaign-plan']) assert.equal(owedDischargeableMode(m), true, `${m} HAS an owed pick-override -> may both produce and consume`);
  for (const m of ['unique', 'unique-random', 'sequence', 'post-centric', 'random', '', null, undefined]) {
    assert.equal(owedDischargeableMode(m), false, `${JSON.stringify(m)} has NO owed pick-override -> must never produce or consume an entry`);
  }
});

test('[a] pointer-mode carry-over is UNCHANGED by the revert (regression guard for [7][8])', () => {
  const o = mkO();
  o._cycleObligation = { DR: { postId: 'P1', expectedGids: ['g1', 'g2'] } };
  o._cycleDelivered = new Set();
  o._owed = {};
  o._data = { accounts: [{ name: 'DR', postingOrder: 'daily-rotation' }], groups: [], posts: [{ id: 'P1' }], settings: {} };
  o._cycleDelivered.add(o._dkScope('DR') + 'P1::g1');
  o._reconcileOwedFor('DR');
  assert.deepEqual(o._owed.DR.gids, ['g2'], 'daily-rotation still carries its un-reached groups — only the unique/sequence extension was reverted');
});
