// tests/helpers/ncycle.js
// ADR-0023 Phase 2(b): drive N orchestrator cycles inside ONE process.
//
// WHY THIS EXISTS. Every cycle the orchestrator re-reads data.json, re-folds the crash journal and re-derives
// durable state at the head of _loop, and start() resets a whole block of per-run flags. A test that models "the
// next cycle" as a NEW Orchestrator (or a fresh start()) therefore hands the engine a clean slate it never gets in
// production — the exact stale-state bug you are hunting is reconstructed away before the assertion runs. That is
// not hypothetical: a fully green suite has repeatedly coexisted with live recurring double-posts, and the
// [FREEZE FIX] in _loop documents one that "self-healed via the load path while a HEALTHY run did not". Cycle 2+
// in the SAME process, through the SAME _loop invocation, is the only place those bugs are observable.
//
// WHAT IT GIVES YOU. One real Orchestrator, one real store on a temp dir, the real _loop, the real campaign
// planner/pointer/owed/reserve machinery — with exactly two things faked:
//   1. the WORKER (no browser): stubbed at automation/worker.runAccount, the same seam every integration test here
//      uses. Everything above it — the picker, the claim, markDelivered, the inflight journal, the pointer advance,
//      the owed reconcile, the round boundary — stays REAL. That matters: _postsForAccount, which contains every
//      idle path Phase 2(a) labels, is only reached through the real run.
//   2. TIME: a virtual clock. Not a convenience — a campaign agent is gated by a 30s spacing floor (N>1) or a ~20h
//      straddle floor (N=1) measured against Date.now(), and a ROUND boundary can only be crossed by reaching a new
//      LOCAL DAY. Without a fake clock, "N cycles" is either 30s+ of real sleeping per cycle or unreachable.
//
// LOAD ORDER IS LOAD-BEARING: Date must be faked before anything captures it, and the worker must be stubbed before
// the orchestrator's module-level `const { runAccount } = require('./worker')` destructure. Requiring this helper
// first from a test file is what guarantees both.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── 1. virtual clock (must precede every other require) ────────────────────────────────────────────────
// Overriding the GLOBAL keeps orchestrator._localDayKey and store's own day-key in sync. Stubbing only
// _localDayKey desyncs them: the engine believes it is tomorrow while the store still counts today's usage.
const RealDate = Date;
let _offset = 0;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length === 0) super(RealDate.now() + _offset); else super(...a); }
  static now() { return RealDate.now() + _offset; }
}
global.Date = FakeDate;

// ── 2. worker stub (must precede the orchestrator require) ─────────────────────────────────────────────
const worker = require('../../automation/worker');
let _handler = null;
worker.runAccount = async (o) => (_handler ? _handler(o) : { posted: 0, errors: 0, pendingApproval: 0, noRetry: true, flag: null, postedIds: [], dealtIds: [], fullyPosted: false, offline: false, progressed: false });
const store = require('../../lib/store');
const { Orchestrator } = require('../../automation/orchestrator');

// Settings that make a real run fast WITHOUT weakening any delivery guard.
// waitIntervalMin/Max — NOT `waitInterval`. The inter-cycle wait reads the Min/Max RANGE; the legacy single key is
// dead here, so `waitInterval: 0` silently falls through to a random 90–180 MINUTE sleep and the run appears to hang.
const FAST_SETTINGS = {
  scheduleMode: 'continuous',   // skip the daily fire-time gate; cycles run back-to-back
  waitIntervalMin: 0, waitIntervalMax: 0,
  cycleGapMin: 0,               // no explicit inter-cycle override → the 0-range above wins
  parallelAccounts: 4, staggerAccounts: false, accountDelay: 0, groupDelay: 0,
  realIpMinPostGapSec: 0, realIpMaxConcurrent: 8, dailyCap: 0,
  varyImages: false, varyContent: false, randomizeLinks: false,
  useProxies: false, warmupRuns: 0, maxCycles: 0,
  // N>1 swaps the per-account ~20h straddle floor for the anti-burst spacing floor. That floor is NOT 30s here: it is
  // max(30s, gapMin*60000*0.5), and gapMin falls back to 90 when cycleGapMin and waitIntervalMin are both 0 — so it is
  // ~45 VIRTUAL minutes. The virtual clock is what makes that free; it is why clockStepMs must mint minutes, not ms.
  cyclesPerDay: 20,
  loopCampaign: true,
};

/**
 * Run a real orchestrator for up to `cycles` cycles (or until `untilRound` is reached) in ONE process.
 *
 * @param {object} cfg
 *   posts/groups/accounts  — the fixture written to a temp store
 *   settings               — merged over FAST_SETTINGS
 *   cycles                 — stop after this many cycles complete (default 6)
 *   untilRound             — stop early once orch._roundOffset reaches this (default: never)
 *   handler                — optional worker handler; defaults to "deliver everything targeted"
 *   clockStepMs            — virtual ms minted per timer tick (default 120s — see the ticker below)
 *   timeoutMs              — real-time safety net (default 20s). Reaching it sets `timedOut`; ASSERT ON IT.
 * @returns {{picks, pairs, plans, rounds, cycles, timedOut, orch, logs}}
 *   picks — [{cycle, round, account, postId, gids}] every delivery the engine ASKED for
 *   pairs — [{round, key:'postId::gid'}] every (post,group) actually delivered, tagged with its round
 */
async function runCycles(cfg) {
  const picks = [];
  const pairs = [];
  const plans = [];
  const logs = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-ncycle-'));
  _offset = 0;

  store.init(tmp);
  store.save({
    posts: cfg.posts,
    groups: cfg.groups,
    accounts: cfg.accounts,
    settings: { ...FAST_SETTINGS, ...(cfg.settings || {}) },
    proxies: [], useProxies: false,
  });

  const orch = new Orchestrator((channel, m) => { if (channel === 'automation-log') logs.push(String(m)); }, {});

  // ── per-account STATE recorder (what the dashboard's Live Operations row actually receives) ──────────
  // Recorded at _setAcctState rather than off the automation-progress emit on purpose: _emitLiveOps coalesces on a
  // ~400ms leading/trailing throttle, so a fast virtual run drops intermediate states and a test reading the emit
  // would sample whatever survived the throttle — flaky, and blind to the exact transition under test. _setAcctState
  // is the synchronous source those snapshots are built from, so every transition is seen, in order.
  // Instance-level shadow (NOT a prototype patch): scoped to this run, so it cannot leak into another test in the
  // same process. The real method still runs — this only observes.
  const states = [];
  const _realSet = orch._setAcctState.bind(orch);
  orch._setAcctState = (name, state, extra) => { states.push({ name, state, action: (extra && extra.action) || '' }); return _realSet(name, state, extra); };

  // The default handler DERIVES its result from the input. A static one (e.g. `dealtIds: []`) silently gates off the
  // pointer advance and the dealt persist, so the harness would model "nothing ever posts" and go green proving
  // nothing — precisely the false-confidence this file exists to prevent.
  _handler = async (o) => {
    const acct = o.account || {};
    const assigned = new Set(acct.assignedGroups || []);
    let targets = (o.groups || []).filter((g) => assigned.has(g.id) || assigned.has(g.groupId));
    // onlyGroups is how the engine scopes an OWED discharge or a stand-in to the un-reached groups. Ignoring it would
    // fake a double-post the real worker never makes.
    if (Array.isArray(o.onlyGroups)) { const only = new Set(o.onlyGroups); targets = targets.filter((g) => only.has(g.groupId || g.id)); }
    const gids = targets.map((g) => g.groupId || g.id);
    const postId = o.post && o.post.id;
    picks.push({ cycle: orch._progress ? orch._progress.cycle : 0, round: orch._roundOffset || 0, account: acct.name, postId, gids: gids.slice() });
    for (const g of gids) {
      pairs.push({ round: orch._roundOffset || 0, account: acct.name, key: postId + '::' + g });
      // markDelivered is what populates the per-cycle guard and appends the inflight journal — i.e. what makes the
      // crash-fold and the owed reconcile REAL rather than theatre. Skipping it hollows out the whole harness.
      if (typeof o.markDelivered === 'function') { try { o.markDelivered(g); } catch {} }
    }
    // No runSeq here: the orchestrator computes it above this seam and injects it into the result itself, so a worker
    // stub cannot influence the clean-commit watermark either way. (There IS a real runSeq/watermark bug in this
    // codebase's history — it lived at the pool's result-rebuild, a layer above this one. See runseq-watermark.test.js.)
    return {
      posted: gids.length, errors: 0, pendingApproval: 0, noRetry: false, flag: null,
      postedIds: postId ? [postId] : [], dealtIds: postId ? [postId] : [],
      fullyPosted: true, offline: false, progressed: gids.length > 0,
    };
  };
  if (cfg.handler) { const inner = cfg.handler; const base = _handler; _handler = async (o) => inner(o, base); }

  // Virtual time flies: +clockStepMs per timer tick. A 5ms setInterval does NOT fire every 5ms — Windows timer
  // resolution puts it at ~15ms, and that is a machine-global setting any other process can change — so the mint rate
  // is not something this file can control. Mint a big step instead of many small ones: the per-account spacing floor
  // on this path is ~45 VIRTUAL minutes (cyclesPerDay>1 → max(30s, gapMin*60000*0.5), and gapMin falls back to 90 when
  // waitIntervalMin is 0), so a 20s step needed ~135 real ticks per post and the run hit its wall-clock deadline
  // instead of its cycle target. Overshoot is safe: every gate on this path is a `Date.now() < end` poll or a day-key
  // compare — there is no narrow window a big jump can skip past.
  const step = cfg.clockStepMs || 120000;
  const ticker = setInterval(() => { _offset += step; }, 5);

  const maxCycles = cfg.cycles || 6;
  const deadline = RealDate.now() + (cfg.timeoutMs || 20000);
  let stopped = false;
  let timedOut = false;
  try {
    orch.start(() => store.load());
    // Poll the REAL progress counter. Do not string-match the "cycle complete" log — the wording is not a contract.
    for (;;) {
      // The deadline is a SAFETY NET, not an exit condition. Exiting on it silently would hand the test a truncated
      // run — fewer cycles, fewer deliveries — and every "no duplicates" assertion would pass for the worst possible
      // reason: nothing happened. Record it so the caller can fail loudly. A starved harness must never look green.
      if (RealDate.now() >= deadline) { timedOut = true; break; }
      const c = (orch._progress && orch._progress.cycle) || 0;
      if (orch._campaignPlan && plans.length < c) plans.push(JSON.parse(JSON.stringify(orch._campaignPlan.agentLists || {})));
      if (cfg.untilRound != null && (orch._roundOffset || 0) >= cfg.untilRound) break;
      if (c >= maxCycles) break;
      if (!orch.isRunning()) break;
      await new Promise((r) => setTimeout(r, 5));
    }
  } finally {
    clearInterval(ticker);
    try { orch.stop(); stopped = true; } catch {}
    // Let the in-flight cycle unwind so nothing writes to tmp after we delete it.
    for (let i = 0; i < 100 && orch.isRunning(); i++) await new Promise((r) => setTimeout(r, 10));
    _handler = null;
    _offset = 0;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  return { picks, pairs, plans, logs, states, orch, stopped, timedOut, rounds: orch._roundOffset || 0, cycles: (orch._progress && orch._progress.cycle) || 0 };
}

// The LAST state a given account settled on — the row the operator is left looking at. Skips 'running'/'queued', which
// are transient scaffolding every account passes through on its way to a real outcome.
function finalStateOf(states, name) {
  const s = states.filter((x) => x.name === name && x.state !== 'running' && x.state !== 'queued');
  return s.length ? s[s.length - 1] : null;
}

// Duplicate (post,group) deliveries WITHIN a round. Cross-round repeats are excluded BY DESIGN: with loopCampaign on,
// the round boundary nulls every roster pointer and the campaign deliberately re-delivers the whole library — a naive
// cross-round dedup assertion is a false alarm on every loop test.
function duplicatePairsWithinRound(pairs) {
  const seen = new Set();
  const dupes = [];
  for (const p of pairs) {
    const k = p.round + '#' + p.key;
    if (seen.has(k)) dupes.push(k); else seen.add(k);
  }
  return dupes;
}

module.exports = { runCycles, duplicatePairsWithinRound, finalStateOf, FAST_SETTINGS };
