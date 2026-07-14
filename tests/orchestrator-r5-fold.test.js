// tests/orchestrator-r5-fold.test.js
// R5 CRASH-DURABILITY FOLD (_recoverInflightJournal) — regression guard for the crown-jewel double-post ledger.
// A HARD kill mid-account loses the in-memory _cycleDelivered + the un-persisted rotation/dealt pointer; on the next
// run start the surviving journal lines (pcu-inflight.jsonl) are FOLDED back into {perAccountRotation pointer, _owed,
// _dealt, _inflightDelivered} exactly as a clean account-return would — so no delivered group is re-posted, and (for
// re-delivering modes) no legit re-delivery is suppressed. The adversarial verification found + fixed TWO critical
// double-posts here; these tests lock them closed. Journal line shape (see markDelivered): { q, a, o, s, p, g, d }
// where s = _dkScope prefix ('agent::' for daily-rotation/campaign-plan, '' for unique/sequence) and the durable
// _inflightDelivered key is byte-identical to the worker's alreadyDelivered key: s + p + '::' + g.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const worker = require('../automation/worker'); // require BEFORE the orchestrator (it destructures runAccount at load)
const store = require('../lib/store');
const { Orchestrator } = require('../automation/orchestrator');

// Fresh temp USER_DATA + a synthetic journal, then an Orchestrator with its ledger state seeded directly.
function mk(entries, initial) {
  store.init(fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-r5fold-')));
  try { store.compactInflight(() => false); } catch {} // ensure an empty journal to start
  for (const e of entries) store.appendInflight(e);
  const o = new Orchestrator(() => {}, {});
  // Seed every ledger field the fold touches (in the live app these are set by _loop init before the fold runs).
  o._dealt = new Set();
  o._owed = {};
  o._perAccountRotation = {};
  o._inflightSeq = {};
  o._inflightDelivered = new Set();
  Object.assign(o, initial); // scenario overrides win
  return o;
}
const DAY = () => new Orchestrator(() => {}, {})._localDayKey();
const acc = (name, order, groups) => ({ name, postingOrder: order, assignedGroups: groups, enabled: true, status: 'logged_in' });
const grps = (ids) => ids.map((id) => ({ id }));

// ── HOLE 2 (rotation/campaign owed-discharge) — must NOT re-owe groups a prior clean cycle already delivered ──────
test('R5 fold: daily-rotation owed-discharge crash clears owed (never re-owes prior-delivered groups)', () => {
  const d = DAY();
  // Cycle 1 (clean, icommit=8) delivered P to g1,g2 → persisted _owed = {P,[g3]}. Cycle 2 delivers g3 then crashes.
  const o = mk(
    [{ q: 10, a: 'A', o: 'daily-rotation', s: 'A::', p: 'P', g: 'g3', d }],
    {
      _data: { accounts: [acc('A', 'daily-rotation', ['g1', 'g2', 'g3'])], groups: grps(['g1', 'g2', 'g3']), posts: [{ id: 'P' }], settings: {} },
      _perAccountRotation: { A: { lastPostId: 'P', lastPostedDate: d, postsToday: 1, postsTodayDate: d, icommit: 8 } },
      _owed: { A: { postId: 'P', gids: ['g3'] } },
    },
  );
  o._recoverInflightJournal(o._data);
  assert.ok(!o._owed.A, 'owed cleared — g3 (the only owed group) was delivered; g1,g2 are NOT re-owed');
});

// ── HOLE 1 (unique/sequence PARTIAL) — a resumed partial must SKIP already-delivered groups (no double-post) ──────
test('R5 fold: unique partial delivery seeds the durable guard so delivered groups are skipped on resume', () => {
  const d = DAY();
  const o = mk(
    [{ q: 5, a: 'U', o: 'unique', s: '', p: 'P', g: 'g1', d }, { q: 6, a: 'U', o: 'unique', s: '', p: 'P', g: 'g2', d }],
    { _data: { accounts: [acc('U', 'unique', ['g1', 'g2', 'g3'])], groups: grps(['g1', 'g2', 'g3']), posts: [{ id: 'P' }], settings: {} } },
  );
  o._recoverInflightJournal(o._data);
  assert.ok(!o._dealt.has('P'), 'partial → P stays UN-dealt (resume re-picks + finishes it)');
  assert.ok(o._inflightDelivered.has('P::g1') && o._inflightDelivered.has('P::g2'), 'delivered g1,g2 in the durable guard (alreadyDelivered skips them → no double-post)');
  assert.ok(!o._inflightDelivered.has('P::g3'), 'the un-reached g3 is NOT guarded (it must still be delivered)');
});

test('R5 fold: unique FULL delivery marks the post dealt and leaves no guard keys', () => {
  const d = DAY();
  const o = mk(
    ['g1', 'g2', 'g3'].map((g, i) => ({ q: 5 + i, a: 'U', o: 'unique', s: '', p: 'P', g, d })),
    { _data: { accounts: [acc('U', 'unique', ['g1', 'g2', 'g3'])], groups: grps(['g1', 'g2', 'g3']), posts: [{ id: 'P' }], settings: {} } },
  );
  o._recoverInflightJournal(o._data);
  assert.ok(o._dealt.has('P'), 'full delivery → P dealt (never re-picked)');
  assert.ok(!o._inflightDelivered.has('P::g1'), 'a fully-delivered post is purged from the durable guard (no unbounded growth)');
});

// ── The v1 regression guard: the durable guard must NEVER touch a RE-DELIVERING mode (daily-rotation/campaign) ─────
test('R5 fold: a daily-rotation PARTIAL reconstructs owed but NEVER populates the unique/sequence durable guard', () => {
  const d = DAY();
  const o = mk(
    [{ q: 5, a: 'A', o: 'daily-rotation', s: 'A::', p: 'P', g: 'g1', d }, { q: 6, a: 'A', o: 'daily-rotation', s: 'A::', p: 'P', g: 'g2', d }],
    { _data: { accounts: [acc('A', 'daily-rotation', ['g1', 'g2', 'g3'])], groups: grps(['g1', 'g2', 'g3']), posts: [{ id: 'P' }], settings: {} } },
  );
  o._recoverInflightJournal(o._data);
  assert.deepEqual((o._owed.A || {}).gids, ['g3'], 'daily-rotation partial → owed = the un-reached group only');
  assert.equal(o._inflightDelivered.size, 0, 'daily-rotation delivered groups are NEVER durably guarded (a durable guard there would permanently SUPPRESS the legit re-delivery — the v1 bug)');
});

// ── Supersession: a line already covered by its agent's watermark must NOT fold (clean-path no-op) ────────────────
test('R5 fold: a journal line at/below the agent watermark is superseded (not folded)', () => {
  const d = DAY();
  const o = mk(
    [{ q: 3, a: 'A', o: 'daily-rotation', s: 'A::', p: 'P', g: 'g1', d }], // q=3 <= icommit 5 → superseded
    {
      _data: { accounts: [acc('A', 'daily-rotation', ['g1', 'g2'])], groups: grps(['g1', 'g2']), posts: [{ id: 'P' }], settings: {} },
      _perAccountRotation: { A: { lastPostId: 'P', lastPostedDate: d, postsToday: 1, postsTodayDate: d, icommit: 5 } },
      _owed: {},
    },
  );
  o._recoverInflightJournal(o._data);
  assert.ok(!o._owed.A, 'superseded line does not reconstruct owed');
  assert.equal(o._perAccountRotation.A.icommit, 5, 'the clean-committed watermark is untouched (no re-fold)');
});

// ── Idempotency: re-running the fold (e.g. after a failed persist) must be a no-op, never a double-count ──────────
test('R5 fold: re-running the fold is idempotent (postsToday SET to 1, guard keys unchanged)', () => {
  const d = DAY();
  const seed = () => [{ q: 5, a: 'U', o: 'unique', s: '', p: 'P', g: 'g1', d }];
  const o = mk(seed(), { _data: { accounts: [acc('U', 'unique', ['g1', 'g2'])], groups: grps(['g1', 'g2']), posts: [{ id: 'P' }], settings: {} } });
  o._recoverInflightJournal(o._data);
  const size1 = o._inflightDelivered.size;
  const dealt1 = o._dealt.has('P');
  // Second fold against the same (uncompacted-on-failure) journal — re-add the line the first compaction may have kept.
  store.appendInflight({ q: 5, a: 'U', o: 'unique', s: '', p: 'P', g: 'g1', d });
  o._recoverInflightJournal(o._data);
  assert.equal(o._inflightDelivered.size, size1, 'guard key set unchanged on a re-fold (Set.add of the same key is a no-op)');
  assert.equal(o._dealt.has('P'), dealt1, 'dealt-ness unchanged on a re-fold');
});

// ── H1: the crash-fold stamps the REAL delivery timestamp (journal `t`) so _dailyQuotaBlocks's 20h anti-straddle
// floor measures TRUE elapsed-since-post, not the restart instant (which benched a good agent for a full day). ──────
test('R5 fold H1: rotation pointer lastPostedAt = the journal delivery timestamp t (real elapsed, not restart-instant)', () => {
  const d = DAY();
  const realTs = Date.now() - 23 * 3600000; // delivered ~23h ago
  const o = mk(
    [{ q: 12, a: 'A', o: 'daily-rotation', s: 'A::', p: 'P', g: 'g1', d, t: realTs }],
    { _data: { accounts: [acc('A', 'daily-rotation', ['g1'])], groups: grps(['g1']), posts: [{ id: 'P' }], settings: {} } },
  );
  o._recoverInflightJournal(o._data);
  assert.equal(o._perAccountRotation.A.lastPostedAt, realTs, 'fold uses the journal t → the 20h floor sees the true 23h gap (fixes the full-day bench after an unattended crash+restart)');
});

test('R5 fold H1: a legacy line WITHOUT t falls back to ~now (conservative bench = under-deliver, ban-safe, no regression)', () => {
  const d = DAY();
  const before = Date.now();
  const o = mk(
    [{ q: 5, a: 'A', o: 'daily-rotation', s: 'A::', p: 'P', g: 'g1', d }], // legacy line: no t
    { _data: { accounts: [acc('A', 'daily-rotation', ['g1'])], groups: grps(['g1']), posts: [{ id: 'P' }], settings: {} } },
  );
  o._recoverInflightJournal(o._data);
  const lp = o._perAccountRotation.A.lastPostedAt;
  assert.ok(lp >= before && lp <= Date.now() + 5, 'no t → Date.now() fallback = exactly today\'s conservative behavior (never loosens the floor)');
});

test('R5 fold H1: the highest-q (pointer-owning) delivery timestamp wins (larger lastPostedAt only ever benches LONGER)', () => {
  const d = DAY();
  const early = Date.now() - 40 * 3600000, late = Date.now() - 22 * 3600000;
  const o = mk(
    [{ q: 5, a: 'A', o: 'daily-rotation', s: 'A::', p: 'P', g: 'g1', d, t: early }, { q: 9, a: 'A', o: 'daily-rotation', s: 'A::', p: 'P', g: 'g2', d, t: late }],
    { _data: { accounts: [acc('A', 'daily-rotation', ['g1', 'g2'])], groups: grps(['g1', 'g2']), posts: [{ id: 'P' }], settings: {} } },
  );
  o._recoverInflightJournal(o._data);
  assert.equal(o._perAccountRotation.A.lastPostedAt, late, 'the latest (highest-q) delivery ts owns the pointer');
});

test('R5 fold H1: a CORRUPT t (non-numeric / 0 / negative / future) is rejected → conservative Date.now() bench (no floor bypass)', () => {
  const d = DAY();
  for (const badT of ['x', 0, -5, Date.now() + 5 * 3600000]) {
    const before = Date.now();
    const o = mk(
      [{ q: 7, a: 'A', o: 'daily-rotation', s: 'A::', p: 'P', g: 'g1', d, t: badT }],
      { _data: { accounts: [acc('A', 'daily-rotation', ['g1'])], groups: grps(['g1']), posts: [{ id: 'P' }], settings: {} } },
    );
    o._recoverInflightJournal(o._data);
    const lp = o._perAccountRotation.A.lastPostedAt;
    assert.ok(lp >= before && lp <= Date.now() + 5, `corrupt t=${JSON.stringify(badT)} → foldTs falls back to ~now (benched, never a floor bypass)`);
  }
});
