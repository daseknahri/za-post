// tests/orchestrator-ncycle-campaign.test.js
// ADR-0023 Phase 2(b): the N-cycles-in-ONE-process regression net for Campaign Plan.
//
// Every other campaign test here is either pure (_computeCampaignPlan called directly) or drives a SINGLE cycle.
// Neither can see the failure mode this codebase actually ships: state that survives from cycle N to cycle N+1
// inside one process. The head of _loop re-reads data.json and re-folds the crash journal every cycle, and start()
// resets a block of per-run flags — so a test that models the next cycle as a new process/Orchestrator watches the
// bug get reconstructed away before it asserts. These tests hold ONE _loop invocation open across several cycles and
// at least one ROUND boundary, with the real picker, pointer, owed ledger and planner running underneath.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
// MUST be first: it fakes Date and stubs the worker before the orchestrator module captures either.
const { runCycles, duplicatePairsWithinRound, finalStateOf } = require('./helpers/ncycle');

const CP = (name, groups) => ({ name, assignedGroups: groups, postingOrder: 'campaign-plan', postFilter: 'all', enabled: true, status: 'logged_in', standby: false });
const POSTS = (n) => Array.from({ length: n }, (_, i) => ({ id: 'P' + (i + 1), caption: 'c' + (i + 1), comment: '', imagePaths: [] }));

// The spread topology, live: cluster X (2 agents on g1) is the pace-setter; cluster Y (4 agents on g2) is faster,
// so Pass 2 benches 2 of its 4 agents every round.
const FIXTURE = () => ({
  posts: POSTS(4),
  groups: [{ id: 'g1', name: 'G1', groupId: '111' }, { id: 'g2', name: 'G2', groupId: '222' }],
  accounts: [CP('X0', ['g1']), CP('X1', ['g1']), CP('Y0', ['g2']), CP('Y1', ['g2']), CP('Y2', ['g2']), CP('Y3', ['g2'])],
});

test('[ADR-0023 P2b] N cycles in ONE process: no (post,group) is delivered twice within a round', async () => {
  // THE regression net. Campaign Plan has NO durable per-(post,group) guard by design (_uniqueSeqGuard is false for
  // it; _cycleDelivered resets every cycle), so nothing in the engine would catch a repeat — only this assertion
  // does. Keyed by ROUND because a loopCampaign reloop re-delivers the whole library deliberately.
  const f = FIXTURE();
  const r = await runCycles({ ...f, cycles: 8, timeoutMs: 60000 });
  assert.ok(!r.timedOut, 'the harness must reach its cycle target, not its wall-clock deadline — a truncated run makes every assertion below pass for the wrong reason');
  assert.ok(r.cycles >= 2, `the harness must actually drive multiple cycles in one process (got ${r.cycles})`);
  assert.ok(r.pairs.length > 0, 'the run must actually deliver something (a harness that posts nothing proves nothing)');
  assert.deepEqual(duplicatePairsWithinRound(r.pairs), [], 'no (post,group) pair delivered twice inside one round');
});

test('[ADR-0023 P2b] a benched agent never wedges the round boundary (the reloop still fires)', async () => {
  // _campaignAllFinished counts a benched agent (len 0) as finished via `0 >= 0`. If that ever changed, a bench
  // would block the reloop forever and the campaign would silently stall — invisible to every single-cycle test.
  const f = FIXTURE();
  const r = await runCycles({ ...f, cycles: 40, untilRound: 1, timeoutMs: 60000 });
  assert.ok(r.rounds >= 1, `the round boundary must be reachable with 2 of 4 agents benched (rounds=${r.rounds}, cycles=${r.cycles})`);
  assert.deepEqual(duplicatePairsWithinRound(r.pairs), [], 'and crossing it still delivers each pair once per round');
});

test('[ADR-0023 P2b] campaignMinAgents seats the benched agents in a REAL multi-cycle run', async () => {
  // Phase 1 proven through the live engine rather than the pure planner: with the floor at K, all four agents of the
  // fast cluster deliver — and the cluster still delivers its library exactly once.
  const f = FIXTURE();
  const r = await runCycles({ ...f, settings: { campaignMinAgents: 4 }, cycles: 10, timeoutMs: 60000 });
  assert.ok(!r.timedOut, 'the run must complete its cycles — a starved run would show fewer posters and fake this assertion');
  const yPosters = new Set(r.picks.filter((p) => p.account.startsWith('Y')).map((p) => p.account));
  assert.deepEqual([...yPosters].sort(), ['Y0', 'Y1', 'Y2', 'Y3'], 'all four agents of the fast group-set posted (unfloored, two sit out the whole round)');
  assert.deepEqual(duplicatePairsWithinRound(r.pairs), [], 'seating them redistributes work — it never duplicates a delivery');
});

test('[ADR-0023 P2b] unfloored, the bench is real and attributed truthfully in the log', async () => {
  // Ties Phase 1 and Phase 2(a) together on live output: with the dial off, some agents of the fast cluster sit out,
  // and the operator-facing log says BENCHED — not "✓ slice complete", which is what it used to say.
  const f = FIXTURE();
  const r = await runCycles({ ...f, cycles: 6, timeoutMs: 60000 });
  assert.ok(!r.timedOut, 'a truncated run would show <4 posters for the wrong reason, faking the bench');
  assert.ok(r.picks.length > 0, 'and it must actually deliver — otherwise "fewer than 4 posted" is vacuously true');
  const yPosters = new Set(r.picks.filter((p) => p.account.startsWith('Y')).map((p) => p.account));
  assert.ok(yPosters.size < 4, `the spread pass must bench someone in round 0 (posted: ${[...yPosters].join(',') || 'nobody'})`);
  const seats = r.logs.filter((l) => l.includes('Campaign Plan seats'));
  assert.ok(seats.length >= 1, 'the seats readout is emitted so the bench is visible at all');
  assert.ok(!r.logs.some((l) => l.includes('✓ slice complete')), 'the old misattribution is gone from live output');
});

// ── ADR-0023 Phase 3: the idle reason has to reach the DASHBOARD, not just the log ────────────────────
// Phase 2(a) stopped the two LOG surfaces from guessing why an agent idled. It left untouched the surface the
// operator actually watches: the Live Operations row. That row is badged at the pool's result site, whose
// `let _finalState = 'done'` default catches the no-posts return (no flag, no errors, posted 0) — so a BENCHED
// account, one the planner never gave a slice to, rendered a blue DONE. The orchestrator's own comment at the idle
// branch predicted it: "reading as a healthy 'done' on the dashboard with no stated reason."
test('[ADR-0023 P3] a BENCHED agent\'s dashboard row reads IDLE with the reason — never DONE', async () => {
  const f = FIXTURE();
  const r = await runCycles({ ...f, cycles: 3, timeoutMs: 60000 });
  assert.ok(!r.timedOut, 'harness must not be starved — a truncated run would pass this vacuously');
  const benched = Object.keys(r.orch._campaignPlan.agentLists).filter((n) => !r.orch._campaignPlan.agentLists[n].length);
  assert.ok(benched.length, 'the fixture must actually bench someone, else this test proves nothing');
  for (const b of benched) {
    const st = finalStateOf(r.states, b);
    assert.ok(st, `${b} must reach a settled dashboard state`);
    assert.notEqual(st.state, 'done', `${b} was NEVER GIVEN WORK — 'done' is an affirmative false claim of completion`);
    assert.equal(st.state, 'idle', `${b} must badge 'idle'`);
    assert.match(st.action, /BENCHED/, 'the row must carry the REASON, not a bare label');
  }
});

// Mutation-kills the field-by-field result rebuild. That rebuild is an explicit allow-list, and this codebase has
// already been bitten once by an omission from it (runSeq → undefined → the R5 clean-commit never recorded). Drop
// idleReason from it and the badge silently reverts to 'done' — while any test asserting on _runAccount's OWN return
// keeps passing. This asserts on the far side of the rebuild, which is the only place the omission is visible.
test('[ADR-0023 P3] idleReason survives the pool\'s field-by-field result rebuild', async () => {
  const f = FIXTURE();
  const r = await runCycles({ ...f, cycles: 3, timeoutMs: 60000 });
  assert.ok(!r.timedOut, 'harness must not be starved');
  const idle = r.states.filter((s) => s.state === 'idle');
  assert.ok(idle.length, 'at least one agent must idle in this topology');
  for (const s of idle) assert.ok(s.action && s.action.trim().length > 3, `an 'idle' badge with an empty action means the reason was dropped in the rebuild (got ${JSON.stringify(s.action)})`);
});

// The fix must not over-fire: an agent that actually delivered is DONE, and an agent that delivered its whole slice
// is genuinely finished — 'idle' there would be the same class of lie in the opposite direction.
test('[ADR-0023 P3] an agent that POSTED still badges done — the idle fix does not over-fire', async () => {
  const f = FIXTURE();
  const r = await runCycles({ ...f, cycles: 3, timeoutMs: 60000 });
  assert.ok(!r.timedOut, 'harness must not be starved');
  const posted = new Set(r.picks.map((p) => p.account));
  assert.ok(posted.size, 'someone must post, else this proves nothing');
  const doneRows = r.states.filter((s) => s.state === 'done');
  assert.ok(doneRows.length, "accounts that deliver must still reach 'done'");
  for (const s of doneRows) assert.doesNotMatch(s.action, /BENCHED/, 'a delivering agent must never carry a bench reason');
});

// ── postsPerCycle: collapse the per-cycle BARRIER ─────────────────────────────────────────────────────
// A cycle is a barrier: every agent must finish before the next starts, so an agent that ends early idles until the
// slowest lands — over N cycles you pay the SLOWEST agent's time N times instead of once (measured on the live logs:
// agents idle ~75% of each cycle). postsPerCycle lets an agent walk several of its slice back-to-back.
// These tests exist because the NAIVE version of this change is a 17.3x over-post: the pointer recorded dealtIds[0]
// (the FIRST post of the batch) and postsToday +1, so N posts went out while the pointer advanced by one and the quota
// never bound. Asserting on the picker alone would NOT catch it — only a real multi-cycle run does.
// THE SLICE MUST OUTLAST ONE CYCLE. A batch that drains in cycle 1 hides the pointer/partial bugs entirely: with
// nothing left in cycle 2 there is nothing to re-pick, and every mutation of the cross-cycle machinery stays green
// (verified — the first draft of these tests survived all three mutations for exactly this reason). 40 posts across 2
// agents = a 20-post slice each; at 3 posts/cycle it takes ~7 cycles to drain, so the pointer advance is exercised
// cycle-to-cycle, which is the only place dealtIds[0]-vs-[last] and the partial-stop actually differ.
const BATCH = () => ({
  posts: POSTS(40),
  groups: [{ id: 'g1', name: 'G1', groupId: '111' }, { id: 'g2', name: 'G2', groupId: '222' }],
  accounts: [CP('a1', ['g1', 'g2']), CP('a2', ['g1', 'g2'])], // ONE shared group-set = one batch
});

test('[postsPerCycle] N posts land in ONE cycle, and never the same (post,group) twice', async () => {
  const f = BATCH();
  const r = await runCycles({ ...f, settings: { cyclesPerDay: 20, postsPerCycle: 3 }, cycles: 4, timeoutMs: 60000 });
  assert.ok(!r.timedOut, 'harness must not be starved — a truncated run makes every no-duplicate assertion vacuous');
  const c1 = r.picks.filter((p) => p.cycle === 1);
  assert.ok(c1.length > 2, `cycle 1 must deliver several posts (got ${c1.length}) — otherwise the barrier is still there`);
  assert.deepEqual(duplicatePairsWithinRound(r.pairs), [], 'THE regression net: no (post,group) may be delivered twice in a round');
});

test('[postsPerCycle] the pointer names the LAST post dealt — not the first (the 17.3x over-post)', async () => {
  // With postsPerCycle=3 over a 20-post slice this runs ~7 cycles, so a pointer that rewinds to dealtIds[0] re-picks
  // the batch's tail on the NEXT cycle — which a single-cycle-draining fixture cannot surface.
  const f = BATCH();
  const r = await runCycles({ ...f, settings: { cyclesPerDay: 20, postsPerCycle: 3 }, cycles: 8, timeoutMs: 60000 });
  assert.ok(!r.timedOut, 'harness must not be starved');
  const perRound = {};
  for (const p of r.picks) { const k = p.round + '|' + p.account + '|' + p.postId; perRound[k] = (perRound[k] || 0) + 1; }
  const repicked = Object.entries(perRound).filter(([, n]) => n > 1);
  assert.deepEqual(repicked, [], `a post re-picked inside one round means the pointer rewound: ${JSON.stringify(repicked)}`);
});

test('[postsPerCycle] a PARTIAL delivery STOPS the cycle — no later post is dealt past it', async () => {
  // The invariant that makes multi-post cycles safe with the single-slot _owed: the loop stops at the first post that
  // does not reach EVERY group, so a cycle has at most ONE partial and it is always LAST — exactly what one owed slot
  // can hold. Without the stop the cycle deals more posts PAST the partial, so the partial is no longer last: the owed
  // recording (keyed on the last-dealt post) names a fully-delivered post instead, the partial's un-reached group
  // strands for the round, and a later post that should have waited for tomorrow's quota lands today.
  // Observable signal: with P2 partial, a correct engine deals P1 then STOPS — P3 must NOT land in that cycle.
  // (P2 itself isn't in `picks`: this handler returns without base(), so only the FULL deliveries — P1, and P3 iff the
  // stop is broken — are recorded. P3's presence is therefore the exact tell.)
  const f = { ...BATCH(), accounts: [CP('a1', ['g1', 'g2'])] };
  const r = await runCycles({
    ...f, settings: { cyclesPerDay: 40, postsPerCycle: 3 }, cycles: 2, timeoutMs: 60000,
    handler: async (o, base) => {
      if (o.post && o.post.id === 'P2') { // P2 reaches only g1 — partial on g2
        const g1 = (o.groups || []).find((g) => (g.groupId || g.id) === 'g1');
        if (g1 && typeof o.markDelivered === 'function') { try { o.markDelivered(g1.groupId || g1.id); } catch {} }
        return { posted: 1, errors: 1, pendingApproval: 0, noRetry: false, flag: null, postedIds: [], dealtIds: ['P2'], fullyPosted: false, offline: false, progressed: true };
      }
      return base(o);
    },
  });
  assert.ok(!r.timedOut, 'harness must not be starved');
  const c1 = r.picks.filter((p) => p.cycle === 1).map((p) => p.postId);
  assert.ok(c1.includes('P1'), 'P1 (before the partial) must be delivered');
  assert.ok(!c1.includes('P3'), `the cycle must STOP at the partial P2 — P3 landing means the loop ran past it (got ${JSON.stringify(c1)})`);
});

test('[postsPerCycle] postsToday counts every post delivered — not one per cycle', async () => {
  // The quota is the ONLY thing bounding the day, and it reads postsToday. Counting one per CYCLE instead of one per
  // POST is what let a multi-post cycle run to 465 posts/agent/day against a 30 quota. Asserted DIRECTLY on the
  // persisted postsToday vs the posts actually delivered that day — no day-boundary/clock dependency (an assertion
  // that waited for the quota to *bind* was flaky on the harness's virtual clock; this checks the accounting itself,
  // which is what the fix changes and what MUT `_pt + 1` breaks).
  const f = BATCH();
  const deliveredToday = {};
  const r = await runCycles({
    ...f, settings: { cyclesPerDay: 40, postsPerCycle: 4 }, cycles: 3, timeoutMs: 60000,
    handler: async (o, base) => {
      // Key by the engine's LOCAL day-key (matches _localDayKey: local Y-M-D), NOT toISOString (UTC). Near midnight
      // — e.g. running just after the local date rolls — the UTC and local day differ, so the delivery day-key would
      // never match rec.postsTodayDate → checked=0 → a spurious failure that has nothing to do with the accounting.
      if (o.account && o.post) { const _d = new Date(); const _z = (n) => String(n).padStart(2, '0'); const k = o.account.name + '|' + `${_d.getFullYear()}-${_z(_d.getMonth() + 1)}-${_z(_d.getDate())}`; (deliveredToday[k] = deliveredToday[k] || new Set()).add(o.post.id); }
      return base(o);
    },
  });
  assert.ok(!r.timedOut, 'harness must not be starved');
  const rot = r.orch._perAccountRotation || {};
  let checked = 0;
  for (const [name, rec] of Object.entries(rot)) {
    if (!rec.postsTodayDate) continue;
    const delivered = (deliveredToday[name + '|' + rec.postsTodayDate] || new Set()).size;
    if (!delivered) continue;
    checked++;
    assert.equal(rec.postsToday, delivered, `${name}: postsToday=${rec.postsToday} but it delivered ${delivered} distinct posts today — the quota counter must match reality (a per-cycle count under-reports it)`);
    assert.ok(delivered > 1, `${name} must deliver several posts in a cycle for this to prove anything (got ${delivered})`);
  }
  assert.ok(checked > 0, 'at least one agent must have a same-day count to verify');
});

test('[postsPerCycle] default (1) is byte-identical to the classic one-post-per-cycle engine', async () => {
  const f = BATCH();
  const a = await runCycles({ ...f, settings: { cyclesPerDay: 10 }, cycles: 3, timeoutMs: 60000 });                     // absent → 1
  const b = await runCycles({ ...f, settings: { cyclesPerDay: 10, postsPerCycle: 1 }, cycles: 3, timeoutMs: 60000 });   // explicit 1
  assert.ok(!a.timedOut && !b.timedOut, 'harness must not be starved');
  const shape = (r) => r.picks.filter((p) => p.cycle === 1).length;
  assert.equal(shape(a), shape(b), 'explicit 1 must equal absent');
  assert.deepEqual(duplicatePairsWithinRound(a.pairs), [], 'the classic path must stay clean');
});
