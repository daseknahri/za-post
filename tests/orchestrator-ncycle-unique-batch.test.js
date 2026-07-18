// tests/orchestrator-ncycle-unique-batch.test.js
//
// PROVES THE OPERATOR'S "smart split" VISION IS ALREADY UNIQUE MODE — for a shared-group BATCH.
//
// The operator wants: healthy accounts deliver more, a rate-limited account instantly yields its remaining posts to
// the others, and the job finishes fastest — "the posts are irrelevant, we only want to finish the job." That is
// exactly UNIQUE mode's claim-based shared pool: `remaining = posts not _dealt and not _claimed` (orchestrator.js:899),
// a post enters _dealt only on FULL delivery (:1936), and a dropped account's claim is released in _runAccount's
// finally (:1282) so a healthy account picks it up the SAME cycle.
//
// THE PRECONDITION, pinned here so nobody breaks it: this only works when the pooled accounts SHARE the same groups.
// _dealt is fleet-wide, so a post delivered by one account is never delivered by another — perfect when they share
// groups (each post lands in the shared groups once), but STARVING when groups are disjoint (each group gets only its
// 1/N share). The final test documents that failure mode as a guard, so a future change can't quietly "switch the
// whole fleet to unique" and under-deliver.
//
// Every test drives N cycles in ONE process through the real picker/claim/_dealt/_inflightDelivered machinery — the
// only place unique mode's known double-post history (ADR-0021) is observable, because the crash-fold self-heals it
// on a new process.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
// MUST be first: fakes Date and stubs the worker before the orchestrator module captures either.
const { runCycles, duplicatePairsWithinRound } = require('./helpers/ncycle');

// A BATCH = several accounts sharing ONE group-set. This is the topology the operator's "5 accounts, 50 posts" is.
const UNIQ = (name, groups) => ({ name, assignedGroups: groups, postingOrder: 'unique', postFilter: 'all', enabled: true, status: 'logged_in', standby: false });
const POSTS = (n) => Array.from({ length: n }, (_, i) => ({ id: 'P' + (i + 1), caption: 'c' + (i + 1), comment: '', imagePaths: [] }));
const SHARED = ['g1', 'g2'];
const GROUPS2 = [{ id: 'g1', name: 'G1', groupId: 'G1' }, { id: 'g2', name: 'G2', groupId: 'G2' }];
const BATCH = (nAccts, nPosts) => ({
  posts: POSTS(nPosts),
  groups: GROUPS2,
  accounts: Array.from({ length: nAccts }, (_, i) => UNIQ('a' + (i + 1), SHARED)),
  settings: { postingOrder: 'unique', cyclesPerDay: 20 },
});

// Deliveries the run ASKED for, per account (a rate-limited account should end at ~0).
const deliveriesByAccount = (picks) => {
  const m = {};
  for (const p of picks) m[p.account] = (m[p.account] || 0) + 1;
  return m;
};
// For each group, the largest number of DISTINCT posts it received in any single round.
// (loopCampaign re-delivers the whole library each round, so coverage is a per-round property.)
const bestRoundCoverage = (pairs, groupId) => {
  const byRound = {};
  for (const p of pairs) {
    const [postId, gid] = p.key.split('::');
    if (gid !== groupId) continue;
    (byRound[p.round] = byRound[p.round] || new Set()).add(postId);
  }
  return Math.max(0, ...Object.values(byRound).map((s) => s.size));
};

// ── 1. WORK-STEALING: a rate-limited account's posts are delivered by the others; the whole batch still lands ───────
test('[unique-batch] a rate-limited account yields its posts — the batch still delivers every post to both groups', async () => {
  // a3 rate-limits on EVERY attempt (noRetry). If work-stealing is real, a3 delivers nothing and the other 4 cover
  // the entire 10-post library to both shared groups, with no (post,group) delivered twice.
  const f = BATCH(5, 10);
  const r = await runCycles({
    ...f, cycles: 20, timeoutMs: 60000,
    handler: async (o, base) => {
      if (o.account && o.account.name === 'a3') return { posted: 0, errors: 1, noRetry: true, flag: 'rate_limited', fullyPosted: false, progressed: false, postedIds: [], dealtIds: [] };
      return base(o);
    },
  });
  assert.ok(!r.timedOut, 'the harness must reach its cycle target — a truncated run would fake coverage');
  assert.ok(r.pairs.length > 0, 'the batch must actually deliver something');
  const byAcct = deliveriesByAccount(r.picks);
  assert.ok(!byAcct.a3, `the rate-limited account must deliver NOTHING (got ${byAcct.a3 || 0})`);
  assert.equal(bestRoundCoverage(r.pairs, 'G1'), 10, 'group G1 must receive ALL 10 posts in a round — a3\'s share was stolen by the healthy accounts');
  assert.equal(bestRoundCoverage(r.pairs, 'G2'), 10, 'group G2 must receive ALL 10 posts in a round too (each post → both shared groups)');
  assert.deepEqual(duplicatePairsWithinRound(r.pairs), [], 'and never a double-post: no (post,group) delivered twice in a round');
});

// ── 2. HEALTH-WEIGHTING: the unhealthy account delivers strictly less than every healthy one ───────────────────────
test('[unique-batch] health-weighting — an unhealthy account delivers less than every healthy account', async () => {
  // The operator's "healthy account gets more" is emergent: the rate-limited account drops out and the healthy pool
  // absorbs its work. Binary, not graduated (each active account deals 1/cycle) — so the honest, robust assertion is
  // that the unhealthy account delivers STRICTLY FEWER than the healthy ones, and the healthy ones each do real work.
  const f = BATCH(5, 20);
  const r = await runCycles({
    ...f, cycles: 30, timeoutMs: 60000,
    handler: async (o, base) => {
      if (o.account && o.account.name === 'a3') return { posted: 0, errors: 1, noRetry: true, flag: 'rate_limited', fullyPosted: false, progressed: false, postedIds: [], dealtIds: [] };
      return base(o);
    },
  });
  assert.ok(!r.timedOut, 'the run must complete its cycles');
  const byAcct = deliveriesByAccount(r.picks);
  const unhealthy = byAcct.a3 || 0;
  const healthy = ['a1', 'a2', 'a4', 'a5'].map((n) => byAcct[n] || 0);
  assert.ok(healthy.every((h) => h > 0), `every healthy account must deliver real work (got ${JSON.stringify(healthy)})`);
  assert.ok(healthy.every((h) => h > unhealthy), `the unhealthy account (${unhealthy}) must deliver fewer than every healthy account (${JSON.stringify(healthy)})`);
});

// ── 3. NO DOUBLE-POST under crashes across many rounds (the ADR-0021 blind spot) ───────────────────────────────────
test('[unique-batch] intermittent mid-post crashes across many rounds never double-post', async () => {
  // A partial delivery (posted to g1, crashed before g2) is unique mode's historically dangerous case. Drive it hard:
  // every 7th delivery crashes after reaching only g1. Across many rounds in ONE process (no crash-fold to self-heal),
  // the durable _inflightDelivered guard must keep every round free of a repeated (post,group).
  const f = BATCH(5, 10);
  let call = 0;
  const r = await runCycles({
    ...f, cycles: 40, timeoutMs: 60000,
    handler: async (o, base) => {
      call++;
      if (call % 7 === 0 && o.markDelivered) {
        const g1 = (o.groups || []).filter((g) => (g.groupId || g.id) === 'G1');
        for (const g of g1) o.markDelivered(g.groupId || g.id);
        return { posted: 1, errors: 1, noRetry: false, flag: null, fullyPosted: false, progressed: true, postedIds: [], dealtIds: [] };
      }
      return base(o);
    },
  });
  assert.ok(!r.timedOut, 'the harness must run its cycles, not hit the wall clock');
  assert.ok(r.rounds >= 3, `must cross several round boundaries so the no-dup check isn't vacuous (rounds=${r.rounds})`);
  assert.deepEqual(duplicatePairsWithinRound(r.pairs), [], 'no (post,group) re-posted within a round, even with partial-delivery crashes');
});

// ── 4. FULL COVERAGE, no drops: the shared-group batch delivers the whole library to both groups ───────────────────
test('[unique-batch] all healthy — the batch delivers every post to both shared groups, once each per round', async () => {
  const f = BATCH(5, 10);
  const r = await runCycles({ ...f, cycles: 20, timeoutMs: 60000 });
  assert.ok(!r.timedOut, 'the run must complete');
  assert.equal(bestRoundCoverage(r.pairs, 'G1'), 10, 'G1 gets all 10 posts in a round');
  assert.equal(bestRoundCoverage(r.pairs, 'G2'), 10, 'G2 gets all 10 posts in a round');
  assert.deepEqual(duplicatePairsWithinRound(r.pairs), [], 'each post lands in each shared group exactly once per round');
  // and the work spread across the whole batch, not one account
  const byAcct = deliveriesByAccount(r.picks);
  assert.ok(Object.keys(byAcct).length >= 4, `the pool spreads work across the batch, not one account (posters: ${Object.keys(byAcct).join(',')})`);
});

// ── 5. THE PRECONDITION, pinned: unique mode STARVES disjoint groups — it needs a shared-group batch ───────────────
test('[unique-batch] GUARD: on DISJOINT groups unique under-delivers — this is why the batch must share groups', async () => {
  // NOT a bug — a documented limitation, pinned so a future change can't "switch the whole fleet to unique" and
  // silently starve each group to its 1/N share. _dealt is fleet-wide: a post delivered by one disjoint account is
  // never delivered to another account's groups. On the live 3-disjoint-account shape, each group gets ~1/3 of the
  // library. If this test ever FAILS (coverage reaches full), unique gained a per-group deal and the batch precondition
  // may have changed — revisit the recommendation before trusting a fleet-wide switch.
  const posts = POSTS(6);
  const groups = [1, 2, 3, 4, 5, 6].map((n) => ({ id: 'g' + n, name: 'G' + n, groupId: 'G' + n }));
  const accounts = [UNIQ('a1', ['g1', 'g2']), UNIQ('a2', ['g3', 'g4']), UNIQ('a3', ['g5', 'g6'])]; // disjoint pairs
  const r = await runCycles({ posts, groups, accounts, settings: { postingOrder: 'unique', cyclesPerDay: 20 }, cycles: 30, timeoutMs: 60000 });
  assert.ok(!r.timedOut, 'the run must complete for the coverage check to mean anything');
  assert.ok(r.pairs.length > 0, 'it must deliver something');
  for (const g of ['G1', 'G3', 'G5']) {
    const cov = bestRoundCoverage(r.pairs, g);
    assert.ok(cov < 6, `group ${g} must be UNDER-delivered on disjoint groups (got ${cov}/6) — proves unique needs a shared-group batch`);
  }
});
