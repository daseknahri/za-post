# Changelog

Notable changes to za-post. Format loosely follows Keep a Changelog; versions follow SemVer.

## [1.0.116] — 2026-07-16 — The v1.0.115 sweep: my last three fixes each shipped a defect. Eight fixed, three open.

A sweep weighted at the v1.0.113/114/115 fixes themselves (8 lenses, 41 agents) returned 11 confirmed findings — **7 of them in fixes from the previous three versions.** Suite **382/382**, antispam 34/34. Eight fixed here; three remain open (listed at the end).

**The v1.0.115 `_runSeq` fix was actively broken (crash-durability, HIGH ×2 — one work item).** The pool **rebuilds `res` field-by-field** from the `_runAccount` result, and `runSeq` wasn't in that rebuild — so `res.runSeq` was **always `undefined`** at both commit sites. `icommit: undefined` → `watermark()` coerces with `|| 0` → **every journal line stayed a survivor forever**: the R5 clean-commit was never recorded on any path, and a crash-fold would re-apply already-committed deliveries. Fixing that then **activated** a latent second defect: split-cover runs N stand-ins against one `forAgent` sharing a single `icommit`, and the commit was a plain replace — a low-seq sibling returning last would **regress** the watermark, resurrecting a high-seq sibling's committed lines as survivors → the fold re-applies them → re-post. Both commits (`icommit`, `_inflightSeq`) are now **monotonic** via `Math.max`, which also makes a missing `runSeq` (the supervisor catch path) a no-op instead of a zeroing. +3 tests.

- **[HIGH][double-post] v1.0.113 left the persistent-owed synthesis unguarded per-entry.** It deleted the per-entry `_owedDischargeable` check and replaced it with a comment claiming the block gates it — **false twice**: `_hasPersistentOwed` is an existential `.some()` that never filters the loop, and the block's entry condition is a **disjunction** (any unrelated `_cycleDrops` opens it with `_hasPersistentOwed` false). So an undischargeable entry reached the dispatch and a reserve re-posted its gids every cycle. The guard is restored as a `continue` — never a delete, since the entry must survive for `_owedSelf` to scope a mode-flipped agent's own re-pick.
- **[HIGH][double-post] The producer and consumer predicates disagreed, so an entry survived a COMPLETE delivery.** `owedScopableMode` admits unique/sequence, so `_owedSelf` scopes a mode-flipped agent's re-pick and it delivers exactly the owed gids — but the producer gated on `owedDischargeableMode`, recorded no obligation, and `_reconcileOwedFor` early-returned on `!ob`. The ledger still said those groups were owed; flip the agent back to daily-rotation and its pick-override re-posts them. The **stand-in mirror already solved this** (`standinObligationAdmits(_faOrd, !!_prevFa)`); the self path never got it. Now uses the same helper. Cannot re-open ADR-0021: with a baseline `_expected` is the owed **subset**, so reconcile can only shrink or clear — and a baseline-less unique partial still records nothing (the accepted strand).
- **[HIGH][double-post] v1.0.114's parked-slice restore had no guard — my own comment prescribed one and the code never implemented it.** The plan partitions by cluster **sig** while delivery targets are read **live**, so an agent re-purposed to different groups while parked got its **old** cluster's partition and delivered it into its **new** cluster's groups. Now gated on `_plan.batchId === fresh.batchId`. **The test that should have caught this asserted the opposite of its own title** — it required restore-on-mismatch and passed, codifying the bug. Both are fixed.
- **[HIGH][double-post] `_campaignNextIdx` clamped an unresolvable pointer to 0 — restarting the slice.** `indexOf` returns `-1` when the pointer isn't in this slice (flip an agent to daily-rotation, whose run overwrites `lastPostId`, and back), and `-1 + 1 = 0` silently re-posted the whole delivered slice. Now treated as **consumed** — stranding the remainder is recoverable; restarting is a ban.
- **[HIGH][false-complete] The loopCampaign reloop lacked the empty-roster guard its sibling build block has.** `_campaignAllFinished()` is vacuously true on an empty `agentLists`, so a momentarily-empty roster recomputed the plan from **zero agents**, overwriting the frozen plan and **permanently destroying every live and parked slice** (nothing can rebuild them), while burning a `_roundOffset` per cycle. Now skipped with a log.
- **[LOW] `add-post` IPC** — the one post-creating path the operator uses by hand — was the only one left without `{ throwIfUnsaved: true }`; a skipped save returned `ok()` while the renderer cleared the compose form. Also given the collision-proof id shape.

**Still open (tracked, not fixed here):** daily-rotation's pointer can wrap **within one local day** when `cyclesPerDay` exceeds the agent's eligible library (re-posts the same pair ~45–90 min apart — pre-existing, latent); `_emitCompletionReport` logs the parked-slice warning and then still claims "every post published" in the same call, and the parked count is the whole slice rather than the undelivered remainder; nothing clears the campaign plan on Stop→Start, so the 📝 notice's advertised escape hatch does not exist.

## [1.0.115] — 2026-07-16 — The last 5 from the v1.0.112 sweep: id collisions, a split-cover watermark race, and 3 truthfulness fixes

Closes the sweep: **13 of 13 confirmed findings fixed.** Suite **377/377**, antispam 34/34.

- **[HIGH][double-post] Post ids were not collision-proof.** Both bulk-add paths captured `Date.now()` **outside** the `store.update()` mutator, so store's `_writeChain` serialization gave **zero** protection: two concurrent bulk adds minted **identical** id sequences (`post-N-0..post-N-k`). The single-add path calls `Date.now()` *inside* the mutator, so only the bulk paths were exposed — and nothing anywhere enforces `post.id` uniqueness, a load-bearing assumption every prior audit made. A duplicate id is a **double-post**: campaign-plan is the one mode with no durable per-(post,group) guard, so its monotonic slice pointer is the only defense, and `_campaignNextIdx` resolves it with `list.indexOf(lastPostId)+1` — which returns the **first** occurrence and silently **rewinds** the slice into a permanent re-post loop. Fixed at the **mint site** (not by hardening the pointer, which would only mask a corrupt library) using the repo's existing nanosecond+monotonic+random shape from `lib/imageVary.js`. +3 tests, including one proving the old shape collides.
- **[HIGH][double-post] `_runSeq` was a shared instance field, but split-cover runs two stand-ins under the SAME `_respAgent`.** The shared field justified its write race with "at commit time `_runSeq` is ≥ every q this run appended" — true only for **one live run per agent**, which `_splitCover` breaks by design (it pairs a set of reserves against one `forAgent` for disjoint gid subsets, sharing one watermark). So R1's commit wrote R2's higher seq and **pre-superseded R2's still-in-flight journal lines**; a crash before R2 returned left the fold blind to its real deliveries → the pointer/owed state rebuilds as if they never happened → re-post. The sequence is now **run-local** and carried on the result (`res.runSeq`), so a stand-in can only ever commit a watermark ≥ its **own** q. `_journalHigh` remains the shared monotonic allocator, which is what keeps q values globally unique.
- **[MEDIUM][strand] Phase-4 `recMatch` omitted `posterAccount`.** `.find()` returned the **first** matching record regardless of which candidate the loop was on, so it claimed/resolved/stamped the **wrong** account's held card — stranding the other for ~24h and corrupting the R6 `repostedBy` identity. Now scoped by poster, exactly as the Phase-1 dedup and the handoff already do. Only **narrows** the match, so a single-poster hold (the common case) is byte-identical.
- **[MEDIUM][false-complete] `addPostsBulkFromRemote` omitted the `{ throwIfUnsaved: true }` its own comment claims.** A skipped save (transient `data.json` lock) still resolved → the route returned **HTTP 200 with a truthful-looking `added` count** while nothing was persisted. Now rejects → `server.js`'s `apiErr` produces the documented 500 so the caller can retry. Same fix applied to the `add-posts-bulk` IPC handler, where the renderer clears the operator's pasted batch on success — a phantom import silently lost the paste.
- **[LOW] Remote `DELETE /api/posts/:index` reported success on a NaN / out-of-range index** (the guard fell through and still resolved). Now a truthful rejection. Index-addressing is itself a **TOCTOU** — the orchestrator concurrently removes posts *by id* (`autoDeletePosted`), so a stale index from a prior GET can delete the **wrong** post; that needs an id-addressed route (an API change for the client) and is tracked rather than silently patched.

## [1.0.114] — 2026-07-16 — Four more from the v1.0.112 sweep: two double-posts, an anti-spam floor silently off, and a false "complete"

Suite **374/374**, antispam 34/34. Two of these are defects in my own earlier hardening (the v1.0.96 campaign freeze).

- **[HIGH][double-post] A transiently empty campaign roster destroyed the frozen plan → mid-round repartition + pointer rewind = re-burst.** An empty `_campaignRoster()` nulled `_campaignPlan` **and** `_pendingPlanBatchId`. But an empty roster means "no campaign work *this cycle*", not "the round is over" — and it is one click away (flip a poster off campaign-plan, clear its groups, or standby/disable on a mixed fleet). The next non-empty cycle then hit the first-plan branch and installed a plan recomputed from the **current** library — exactly the mid-round repartition the freeze exists to forbid. `_perAccountRotation` survives, so `_campaignNextIdx` does `indexOf(lastPostId)+1` against the **new** slice: a `lastPostId` that moved to another agent's slice (or was deleted) yields `-1` → `idx 0` → the agent **restarts its slice and re-posts already-live pairs**. Campaign-plan has no durable delivered-guard by design and `_cycleDelivered` resets each cycle, so nothing caught it; the 📝 edit notice was lost too, so the operator got no signal. No disk write happened, so a **crash self-healed** while a healthy run did not — the blind spot exactly. Now the plan is kept and campaign work is simply skipped for the cycle; it clears only at a genuine round boundary or Stop→Start.
- **[HIGH][double-post] Comment-rescue's ≤3 re-open left a moderator-approved (LIVE) post eligible for Phase-4 re-post.** The `>3` sibling sets `repostAttempts = 1` and its comment names the hazard verbatim; the `≤3` branch did not, while preserving the **original `heldAt`** — so the 90-min stale prune could flip the record to `failed` with `repostAttempts` still 0, and the Phase-4 candidate filter (`failed` + `!(repostAttempts>0)`) then handed an already-live post to a re-post = duplicate. Now marked ineligible, matching its sibling. Nothing else reads `repostAttempts`, so the re-open → re-approve → re-queue flow is unchanged.
- **[HIGH][anti-spam] The Loop-campaign round reset REPLACED each pointer record instead of merging — silently disabling the ~20h floor fleet-wide.** It dropped `lastPostedAt`, the **only** bench `_dailyQuotaBlocks`' anti-straddle floor measures elapsed-since-post against, for **every** campaign agent at once — so a new round could post sooner than the floor permits on the one shared IP. It also dropped `icommit`, the R5 clean-commit watermark, making this run's already-superseded journal lines look like survivors to the next crash-fold. Now merges: only the slice (`lastPostId` + today's quota) is round-scoped.
- **[HIGH][false-complete] The v1.0.96 roster-shrink prune was destructive and silent → "🎉 complete" while posts were never delivered.** It `delete`d a departed agent's slice with no log, and nothing ever re-added it — but every reason `_campaignRoster()` drops an agent (disabled / standby / method changed / groups cleared) is a one-click flip an operator routinely **undoes** (disable to fix a login, re-enable). After that round-trip the agent had no slice, its posts were delivered by nobody (cluster-mates hold disjoint partitions; the freeze blocks redistribution), and because every completion consumer keys off `agentLists` those posts were **invisible** → `total===0` → "every post published". Now the slice is **parked** (not deleted), **restored** when the agent returns within the same frozen round, both transitions logged, and any parked-but-undelivered slice is **surfaced in the completion report** — so "complete" can never claim 100% while posts sit unassigned. The no-wedge property is preserved (consumers still read `agentLists` only). Parked slices are never auto-redistributed: that is the re-burst direction; they resolve on re-enable or at the next round.

## [1.0.113] — 2026-07-16 — [HIGH][ban-safety] v1.0.112's own coherence fix introduced a double-post — scoping is a GUARD, not a dispatch

A confirm-dry sweep of v1.0.112 (7 lenses, 46 agents, with the crash-fold blind spot baked into the brief) returned 13 confirmed findings. **The top one was mine**, introduced by the v1.0.112 fix itself. Suite **372/372**, antispam 34/34, every fix mutation-verified. Three more of v1.0.112's own defects are corrected here.

- **[HIGH][double-post] `_owedSelf` must NOT gate on the dispatch predicate (v1.0.112 regression).** v1.0.112 gated *every* owed consumer on `owedDischargeableMode`. That was right for the three **dispatching** consumers (`_hasPersistentOwed` / the synthesis / `_owedStandins`), which turn a ledger entry into a **new** delivery — gating them prevents a re-post. It was **backwards for `_owedSelf`**, which only feeds `_onlyGroups` and thereby **removes** groups from a run's target set: it is a **guard**, not an action. **Narrowing can never cause a double-post — only its absence can.** Gating it deleted the one protection for already-delivered groups: a daily-rotation agent with `_owed{P,[g1,g2]}` that the operator flips to unique re-picks P off `remaining` (2491 keeps pointer-mode posts out of `_dealt`, so P stays re-pickable), `_owedSelf` went null, `_onlyGroups` went null, and the run **re-posted the already-delivered g3,g4** on the shared IP. `_uniqueSeqGuard` is true post-flip but consults `_inflightDelivered`, which only the crash-fold seeds → empty on a healthy run. **Fix:** a second pure predicate, `owedScopableMode` (the dedup family — pointer **and** unique/sequence — excluding only broadcast, where a stale entry would starve the run). Two predicates, deliberately not one; merging them re-opens one bug or the other.
- **[LOW→ban-relevant] `_prevOwed` is `_owedSelf`'s mirror and now uses the same predicate.** They decide what a run *targeted* vs what it was *responsible for*; if they disagree, `_owedNow` is computed against the wrong baseline → a bogus same-cycle reserve cover for groups the run never targeted, or a silently suppressed one.
- **[MEDIUM][livelock] Removed the `[9]` `_outstandingWork` owed tally — un-reverted v1.0.110 residue.** It survived the v1.0.112 revert while its enabling pick-override did not, leaving its gate exactly **inverted**: the producer can only create daily-rotation/campaign-plan entries (for which `_isUniqueSeqAgent` is false → dead for its stated purpose), while the only reachable unique-owned entry is a **stale mode-flipped** one (for which it is true) — so it counted as outstanding precisely what nothing can discharge → completionMode wedged at `total>0` **forever**. Its own rationale cited a pick-override that no longer exists.
- **[MEDIUM] The v1.0.112 drop-and-log self-heal was unreachable.** It lived inside the reserve-takeover block, whose entry condition (`_hasPersistentOwed`) requires `_owedDischargeable === true` — the exact **negation** of the drop-and-log's own trigger. The heal could never reach its own patients; it fired only coincidentally (when an unrelated condition opened the block, a reserve existed, **and** `_uniqueMode` held). So v1.0.112's "the entry cannot outlive the mode change" claim was **false on the healthy path**, and every `saveRotation` re-persisted the entry. **Fix:** `_pruneUndischargeableOwed()`, swept unconditionally at the cycle top. Its predicate is **"can neither discharge NOR scope"** (i.e. broadcast/deleted owners only) — *not* `!dischargeable`, which would delete the very entry the fix above needs to scope a mode-flipped agent's re-pick and would **re-open the double-post**. That interaction is mutation-tested.

## [1.0.112] — 2026-07-16 — [HIGH][ban-safety] REVERT the v1.0.110 owed-carry, and fix the pre-existing ledger incoherence behind it

**Reverts ADR-0021 / v1.0.110 (never shipped), and closes the root-cause double-post it exposed — which predates it.** Suite **369/369**, antispam 34/34, both fixes mutation-verified.

An adversarial audit of the v1.0.110 unique/sequence owed-carry returned **11 confirmed findings — 7 HIGH, five of them recurring double-posts**: a delivered `(post,group)` re-posted **every cycle** on the one shared IP. v1.0.111 had already found and patched one; this audit found five more, **two of which bypassed that patch** (the mode-agnostic consumers dispatch regardless of the gate, and the gate itself sits inside `if (res.dealtIds.length)` so a cover that skips every group never reaches it). The defect rate rose after patching. All of it passed **370/370**.

**Why the tests were blind (the durable lesson).** The crash-fold reconciles `this._owed` from the journal on every process start, so a stale entry is cleared on restart. Any test that models "the next cycle" as a **new process** watches the bug self-heal. Duplicates only accumulate in a **healthy days-unattended run** — the fold runs once, then cycles continue in-process with stale state. **Crashes self-heal; health accumulates**, so the failure targets exactly what the product is for. Every test in this area now runs N cycles in ONE process with no fold.

- **Reverted: the unique/sequence owed pick-override and its obligation carry** (ADR-0021 → **Rejected**). A unique/sequence partial now **strands** again — recoverable — instead of being auto-re-delivered. Deliberate trade, measured on the owner's own finished campaign: **17/1491 pairs (1.1%)** lost, all in the shared-IP throttle tail, and the **same-cycle** reserve cover (`_cycleOwed`, unchanged and dry-verified) already recovers most partials. ADR-0021 only added *cross-cycle* carry — a fraction of 1.1%. **A strand costs ~1%; a ban costs the whole fleet.** The real lever for that tail is **proxies** (87% of the campaign's errors were shared-IP throttle), not cross-cycle re-delivery. The rationale is pinned in-code at the unique pick and in the ADR so it is not re-added blind.
- **[HIGH][root cause, PRE-EXISTING] Fixed the owed-ledger incoherence** (new **ADR-0022**). The ledger's **consumers** (`_hasPersistentOwed`, the persistent-owed synthesis, `_owedStandins`, `_owedSelf`) were **mode-agnostic** while its **producer** (the `_cycleObligation` gate) was mode-restricted — so an entry whose owner cannot discharge it became **immortal**: nothing pruned it, no obligation was recorded, `_reconcileOwedFor` early-returned on `!ob`, and the synthesis re-dispatched the identical gids to a reserve every cycle (a stand-in has `_uniqueSeqGuard=false`, so only the per-cycle `_cycleDelivered` guarded it). **This is reachable without v1.0.110** — a pointer-mode agent accrues an entry and the operator flips it to `post-centric`/`unique`; the `!unique` branch returns before any cleanup. It was live in the "confirmed dry" v1.0.109 baseline and the sweep missed it: no lens modelled a mid-run **mode switch** across cycles in one process. v1.0.110 did not create this hole — it multiplied its blast radius from "a pointer agent someone re-moded" to "every unique agent on a unique fleet".
  - **Fix:** one exported predicate, `owedDischargeableMode(postingOrder)`, now gates **both sides** — the producer never *creates* an entry nothing can discharge, and every consumer refuses to *consume* one. The synthesis **drops-and-logs** an entry whose owner is no longer dischargeable, so it cannot outlive an operator mode-flip. `_owedSelf` is gated too, so a stale entry can never silently narrow a broadcast account's run.
  - **Safety:** the predicate can only ever *shrink* what is eligible, so it cannot introduce a delivery. Pointer-mode carry-over ([7][8]) is byte-identical and regression-guarded. No pacing, anti-spam floor, or rest-ladder code touched.
- **Known gap (deliberate, tracked in ADR-0022):** a stranded unique/sequence partial is no longer counted, so completion can imply 100% for it. The follow-up is a **read-only** strand report — never consumed by any delivery path — kept separate from `_owed` on purpose: the moment a record can become a post, it needs this whole invariant again.

## [1.0.111] — 2026-07-16 — [HIGH][ban-safety] v1.0.110's owed-carry re-opened a recurring double-post on the unique axis

**A reserve covering a unique/sequence agent's owed re-posted the SAME (post, group) pairs EVERY cycle on the shared IP.** Found by an adversarial design review of the v1.0.110 change — *not* by the test suite, which was 370/370 green with the bug present.

v1.0.110 gave unique/sequence a persistent owed ledger (the pick-override at ~773 + the obligation at ~2379), and `_hasPersistentOwed` (2544) and the persistent-owed synthesis/`_owedStandins` (2565) are **mode-agnostic** — so a reserve now covers a *unique* agent's owed. But the stand-in bookkeeping's obligation gate still admitted only `daily-rotation`/`campaign-plan`, so that cover recorded **no `_cycleObligation`** → `_reconcileOwedFor` early-returns on `!ob` → **`this._owed[forAgent]` survived a successful cover** → the synthesis re-dispatched the identical gids next cycle. A stand-in's `_uniqueSeqGuard` is `false`, so its only defense was `_cycleDelivered`, which resets every cycle. Nothing bounded it. This is verbatim the failure the v1.0.107 `[DISABLED-AGENT FIX]` closed for the pointer modes, re-opened on the unique axis — and it directly contradicted the synthesis's own safety comment at 2543 ("a reserve lands ONLY the un-reached groups, never a double-post").

**Why a fully green suite missed it (the important lesson):** the crash-fold's `[9]` block reconciles the ledger from the journal on every process start, so it *clears* the stale entry on restart. Any test that models the next cycle as a **new process** silently passes. Only a **healthy days-unattended run** — the fold runs once, cycles keep going — accumulates duplicates. Crashes self-heal; health accumulates. That inversion is why it survived review, and why the regression test asserts the admission decision **in-process, with no fold in between**.

- **Fix:** the gate now admits unique/sequence too, but **only with a prior-owed baseline** (`standinObligationAdmits`, a pure exported helper matching the repo's `crashRestartDecision`/`watchdogTickDecision` idiom). The `hasBaseline` conjunct is load-bearing: `expectedGids` must be the owed **subset** — the full-assigned-set fallback would re-owe the original partial's already-delivered groups (→ re-post), and for an absent/disabled `forAgent` that fallback is **empty** → `still=[]` → `delete _owed` → a silent strand. No baseline → record nothing → the pre-`[9]` behavior (a strand: recoverable) rather than a double-post (a ban).
- **Safety:** `_reconcileOwedFor` can only *shrink* `_owed` (a `.filter()` of `expectedGids`) or postId-guarded-delete it, and the only consumers that turn `_owed` into a post are the ~773 override (scoped by `_onlyGroups`) and the 2565 synthesis (scoped to `ow.gids`) — so a monotonically shrinking ledger can only ever cause **fewer** attempts. The edit cannot introduce a double-post. The rotation/campaign arm is byte-identical. No pacing, anti-spam floor, or rest-ladder code touched.
- **+4 regression tests** (374/374, antispam 34/34), **mutation-verified**: reverting the gate to pointer-modes-only makes them fail.

## [1.0.110] — 2026-07-16 — The last deferred audit finding: unique/sequence partial deliveries no longer strand

Finding #4 of the 72-agent audit — the one item deferred from the v1.0.105 sweep because it touches ADR-0009's completion/crash-fold engine and the obvious fix double-posts. The other 16 shipped in v1.0.105. Suite **370/370** (18 new), antispam 34/34. See ADR-0021 (amends ADR-0008).

- **[HIGH][data-loss] A unique/sequence PARTIAL delivery stranded its un-reached groups permanently and reported a false 100%.** An account that delivered its post to some but not all of its groups had that post added to the fleet-wide `_dealt` set — correct in itself (it is live in the groups it reached; re-dealing the whole post would double-post) — while the un-reached groups were recorded only in the same-cycle transient `_cycleOwed`. The persistent carry-over (`_cycleObligation` → `_owed`) was gated to daily-rotation/campaign-plan, because only those per-agent-pointer modes had an owed pick-override to discharge it. So when the end-of-pool reserve pass found no covering reserve, the groups were lost silently: the post is dealt → filtered out of every account's `remaining` → never re-picked by anyone. `_outstandingWork` then counted neither the post (dealt) nor the owed gids (tallied only over the campaign roster), so completion mode declared **100% delivered and stopped** with groups un-served — breaking ADR-0008's "a partial is never silently skipped" and ADR-0009's "`total === 0` means everything deliverable was delivered". Fixed by extending the ADR-0008 ledger to unique/sequence rather than adding a parallel mechanism: `_cycleObligation` is now recorded for every dedup mode; unique/sequence gets its own owed pick-override (re-picks the SAME post, scoped via `onlyGroups` to ONLY the un-reached groups); `_reconcileOwedFor` runs inline before `_persistDealt` so the ledger is written in the same `saveRotation` as the dealt-set (ADR-0008's lock-step rule, with `_dealt` as the pointer); and `_outstandingWork` counts unique/sequence owed gids over the account roster (not `active` — the CP1 anti-pattern), guarded to only dealt posts still in the library so the count stays honest instead of wedging the run. The naive alternative — not marking the partial dealt — was verified **unsafe**: `_inflightDelivered` is crash-path-only, so the re-picked post would re-post every already-delivered group.
- **[ban-safety] Two double-post traps the extension itself opened, closed with it.** Both stem from unique/sequence having a third source of delivery truth the pointer modes lack — the crash-fold's durable `_inflightDelivered` guard — which a reserve stand-in deliberately does **not** consult. (1) A group proven delivered by the guard must never sit in the ledger: the worker would skip it, but the persistent-owed synthesis hands the raw ledger gids to a stand-in, which would re-post it. Every owed filter now routes through one `_owedDelivered(agent, postId, gid)` predicate that honors the guard for unique/sequence (never for rotation/campaign, which legitimately re-deliver), and the crash-fold prunes `_owed` against the groups it just proved delivered. (2) `_persistDealt` purged the guard for every dealt id, on the now-false assumption that dealt ⇒ fully delivered; it would have destroyed the only durable proof of a pre-crash partial's reach. The purge now skips still-owed posts and fires on the cycle that discharges them (still bounded). `_owedDelivered` also promotes a guard hit into `_cycleDelivered`, which keeps `_reconcileOwedFor` idempotent across that purge — without it the end-of-pool sweep re-runs the obligation against a purged guard and resurrects delivered groups into the ledger.
- **[correctness] A Loop-campaign recycle disarms a leftover unique/sequence owed entry.** A recycle clears `_dealt` to re-deliver the whole library to ALL groups; a stale owed subset must not narrow that back down. The override drops the entry rather than merely skipping it, because `_runAccount`'s `_owedSelf` keys off the ledger alone and would otherwise scope the recycled post's delivery down to the owed subset. (A recycle cannot fire while owed work is live — its pick probe sees the override return the post — so this only ever disarms an already-inert entry.)

## [1.0.109] — 2026-07-16 — Fourth confirm-dry round: 3 more gaps (0 HIGH; 1 was a v1.0.108 residual)

A fifth adversarial pass — plateauing at 3, and now with **zero HIGH** and low real-world exposure. All fixed; suite **352/352**, antispam 34/34. After this the loop reaches a verify round; the material scope is effectively dry.

- **[pacing] Phase-4 held re-post bypassed the opt-in `realIpMinPostGapSec` floor and the shared real-IP clock.** A held-post re-post (`runRepost`) is a REAL group post on the shared IP, but it was launched without `ipPostGate` and posts a single group (so the worker's inter-group gate never fires); the only spacing was a hardcoded 30–90s sleep that ignored a raised `realIpMinPostGapSec` and never advanced `_lastRealIpPostAt`. The ~30s anti-spam floor was always satisfied, so only the opt-in hardening knob was bypassed — but an operator who raised it wasn't getting it on Phase-4, and the pool couldn't see Phase-4 posts on the shared clock. Now the inter-re-post gap is `max(30–90s, _ipPostGate(0, reserveProxied))`, so it honors the floor AND reserves/advances the shared clock (no-op for a proxied reserve; only ever raises the gap).
- **[liveness] A Finish during a disk-halt parked the pool forever.** `_waitWhilePaused()` looped on `_paused || _diskHalt` and broke only on `_stop`, not `_finish` (unlike its sibling `_waitForConnectivity`, which honors Finish). Since `finish()` can't clear `_diskHalt` (only the >2GB re-eval does), a Finish issued while the fleet was held on a <1GB disk-halt never returned — the run hung at "Finishing…" until a hard Stop. Now the wait also breaks on `_finish`, letting the in-flight set drain to a clean end (safe: the launch guards already block new work on a full disk).
- **[regression] The v1.0.108 healthy-timer fix left a mid-backoff window.** The `automation-restarted` re-arm fires only AFTER the crash backoff sleep, so from the throw until the sleep ends the pre-crash timer stayed live; a cycle crashing in the last backoff-window before 10 min (e.g. ~9m40s with a 30s backoff) let that stale timer cross 10 min mid-backoff and reset both relaunch caps during an active crash sequence — re-opening the unbounded-relaunch hole v1.0.108 closed. Now the orchestrator emits `automation-crashed` at the throw (before the backoff) and the main process clears the timer immediately; it's re-armed only when the loop actually re-enters, so `_markHealthy` fires solely after a genuinely uninterrupted 10-minute cycle.

## [1.0.108] — 2026-07-16 — Third confirm-dry round: 3 more gaps (1 HIGH watchdog defeat, 1 was a v1.0.107 regression)

A fourth adversarial pass (16 agents) after v1.0.107 — still converging (17 → 6 → 4 → 3). 3 more confirmed gaps, one a regression the v1.0.107 fix itself introduced. All fixed; suite **352/352**, antispam 34/34.

- **[HIGH][ban-safety] The "healthy" reset timer measured wall-clock since automation-started, not crash-free uptime — a mid-thrash reset made the crash-relaunch loop UNBOUNDED.** The 10-min `_healthyResetTimer` was armed once on `automation-started` and cleared only on `automation-stopped`; the in-process crash breaker re-enters `_loop` in the SAME process without re-emitting `automation-started`, so the timer ran uninterrupted across an active crash-thrash. Once cumulative wall-clock crossed 10 min while still crash-restarting, it fired `_markHealthy` → reset the persisted in-process relaunch streak to 0 AND wrote the `.healthy` marker start.bat reads to reset ITS `_fails` to 0. So any deterministic crash whose doomed cycles each outlived ~10 min made BOTH watchdog caps never accumulate → the app relaunched forever, hammering the shared IP — the exact runaway both caps exist to prevent. Fixed: the orchestrator now emits `automation-restarted` on each in-process restart, and the main process re-arms the timer from that moment, so "healthy" means **10 continuous crash-free minutes** (matching `crashRestartDecision`'s per-cycle `ranMs` semantics). Belt-and-suspenders: `_crashedGiveUp` now deletes any `.healthy` marker before exiting so start.bat can't consume a stale one written mid-thrash.
- **[data-loss] Startup temp-sweep ignored the crash-obligation journal → a >24h comment-image temp was reclaimed before the fold re-referenced it.** `sweepOrphanTemps()` built its keep-set only from `moderation.held` + `comments.pending`, never `pcu-obligations.jsonl`. A comment obligation that survived a hard-kill is journaled but folded into `comments.pending` only at the next run start — and the module-load sweep runs BEFORE that fold. So after the machine was off >24h, the sweep unlinked the `za-img-*`/`zpv-*` temp; the fold then restored a pending comment whose `commentImg` pointed at a deleted file → rescue's `uploadFile` hits ENOENT (an image-only comment fails; a text+image comment silently loses its image). Now the sweep also protects any temp referenced by the obligation journal. (Interacts with the v1.0.105 queue-aware sweep — same keep-set discipline, now extended to the not-yet-folded journal.)
- **[regression] The v1.0.107 "re-home stays pending on write failure" fix could wedge a record permanently `pending` at attempts≥3, invisible to dispatch, accounting, and the completion report.** That branch left `rec` `pending` with `attempts` incremented but — unlike every sibling terminal branch — had no `attempts>=3` escape. Three cycles where the moderation write fails but the comments write succeeds drive attempts 1→2→3 while status stays `pending`; at attempts≥3 the record is excluded from re-dispatch, from `_outstandingWork` (so completionMode could declare 100% and STOP), and from the no-link report, and the prune keeps it forever — and while attempts<3 a re-dispatch would re-PLACE a HELD comment. Now bounded exactly like its siblings: exhausting the 3 attempts flips it to `failed` with a surfacing note (still retries transient failures, but surfaces instead of wedging).

## [1.0.107] — 2026-07-16 — Second confirm-dry round: 4 more gaps (1 HIGH double-post), converging

A third adversarial pass (22 agents: fix-interactions + under-covered areas + a completeness critic, each finding refuted by 2 skeptics) after v1.0.106 was still not fully dry — 4 more confirmed gaps, converging (17 → 6 → 4). All fixed; suite **352/352**, antispam 34/34. Each fix stays minimal and strengthens, never weakens, the ban-safety invariants.

- **[HIGH][ban-safety] A DISABLED campaign/rotation agent's owed entry never cleared → a reserve re-posted the same post to the same groups every cycle (recurring per-(post,group) double-post).** The persistent-owed synthesis dispatches a reserve stand-in for a disabled agent's `_owed`, but the stand-in's obligation record resolved the covered agent's mode via `this._active` only — a disabled agent is absent from active, so its mode came back `''`, the daily-rotation/campaign-plan guard was false, and `_cycleObligation` was never recorded. `_reconcileOwedFor` was then a no-op, so `this._owed[agent]` was never cleared or carried, and the next cycle re-synthesized the same owed → the reserve re-posted the SAME owed groups on the shared IP, repeating indefinitely. Fixed by resolving the covered agent's **mode** from the full account list (not just active) so the obligation records; the `_target`/`expectedGids` math is untouched (still the owed subset via `_prevFa`, never the whole assigned set), so already-delivered groups are not re-owed.
- **[MED][data-loss] Rescue "notfound" re-home flipped the pending record to `rehomed` unconditionally while its moderator-queue write was un-awaited** — a failed moderation save (file lock / disk full) durably lost the orphaned link-comment (no card, no pending record, no journal entry) and the run falsely reported it delivered. The comments mutator is now async and awaits the moderation `{ok}`; the record flips to `rehomed` only when the held card durably landed, otherwise it stays `pending` (retryable). Mirrors the queue-first/flip-after discipline already used in the approved-handoff path.
- **[durability] Inflight-journal compaction kept a unique/sequence reserve's stand-in line forever** (unbounded `pcu-inflight.jsonl` growth on a days-unattended run). Both compaction keep-clauses classified a unique/sequence partial by the stored `e.o` (the DELIVERING account's own mode), so a reserve whose own mode is unique/sequence — standing in for a rotation/campaign agent on a campaign post that never enters `_dealt` — produced a line the clause kept permanently, even after the covered agent's icommit superseded it. Now classified by the RESPONSIBLE agent `e.a` (mirroring the survivor/watermark classifier), so the line is dropped once its covered agent's watermark passes it. No double-post/ban impact — a superseded line already failed the fold's survivor test; purely a resource leak.
- **[waste] Comment rescue ignored `blocked_login`/`blocked_checkpoint`** — a mid-rescue logout fell through to the generic-failure branch, so the loop kept driving the now-dead session through every remaining task (each burning one of its post's 3 attempts against an authBad guard) and never flagged the logout, leaving it to be re-picked as a rescuer next cycle. Now a logged-out/checkpointed rescuer sets `needsLogin`, does NOT consume the post's attempts, and stops immediately (the orchestrator marks it logged-out; remaining comments stay pending) — matching the poster path.

## [1.0.106] — 2026-07-16 — Confirm-dry round: 6 more gaps (2 were regressions in the v1.0.105 fixes)

A focused confirm-dry sweep (fix-interaction analysis + under-covered areas + a completeness critic, adversarially verified) after v1.0.105 was NOT dry — it surfaced 6 more confirmed gaps, **two introduced/exposed by the v1.0.105 fixes themselves.** All fixed; suite **352/352**, antispam 34/34.

- **[ban-safety] Proxy fails OPEN in the login / auto-login / membership-check launches** (`main.js`). The worker fails closed on an unparseable proxy, but these three launch sites had no `else` branch — so a configured-but-unparseable proxy (schemeless / bad scheme / bad port) opened an authenticated FB session on the real shared host IP, correlating the account to the fleet IP (the exact multi-IP link the proxy prevents). All three now fail closed (abort + a fix-the-proxy message).
- **[regression] The v1.0.100 in-process crash-relaunch RACED the v1.0.101 start.bat watchdog.** On give-up the app did `app.relaunch()` AND start.bat relaunched — the app's fresh process won the single-instance lock, so start.bat's relaunch lost the lock and quit in ~1s without clearing `run-active.flag`, burning its `_fails` every ~30s until the whole watchdog retired while a healthy process ran (then a later hard-kill went unrecovered). Fixed: under the watchdog (a new `ZAPOST_WATCHDOG` env) the app EXITS and lets start.bat own the single relaunch + cap; a `.healthy` marker (written at 10 min uptime) lets start.bat reset its `_fails` so isolated crashes days apart don't accumulate; and the persisted self-relaunch streak now also resets on a clean stop.
- **Sticky `_runFlags` defeated the daily-cap midnight hold.** The `_allCapped` test excluded any account ever flagged this run (a run-lifetime accumulator), so a single earlier — and since-recovered — rate-limit permanently poisoned it: a capped fleet then skipped the midnight hold and the stall-breaker STOPPED the run mid-day. Now gated on LIVE account status (matching the sibling rate-limit check).
- **Moderator approval dropped image-only comments.** The handoff guard skipped any held record with no comment TEXT, silently losing a valid image-only link-comment while marking the post approved. Now keeps records with a comment image.
- **`ipPostGate` keyed its no-op on the fleet-wide `useProxies` flag, not per-account** — a self-proxied account (global toggle off) still entered and advanced the shared real-IP clock, needlessly slowing the real-IP fleet. Now keyed on the account's own proxy (matching the launch throttle).
- **Reserve-takeover probe could crowd out assigned split-cover stand-ins** with classic-takeover candidates (which probe-positive on the same released post), slipping the stand-in's un-reached groups a cycle. Now probes assigned stand-ins first.

## [1.0.105] — 2026-07-16 — Hardening sweep: 16 verified gaps from a 72-agent adversarial audit

An exhaustive multi-agent audit (14 subsystems audited in parallel, every finding cross-examined by 3 refute-by-default verifiers — reproduce / already-handled / fix-safety — then deduped + ranked) surfaced 17 confirmed gaps in the days-unattended path. 16 are fixed here; **each strengthens, never weakens, the ban-safety invariants.** Full suite **352/352**, antispam 34/34. The 17th (#4) is deferred to a dedicated pass (below). A follow-up adversarial SELF-REVIEW of the 16 fixes (16 reviewers + refute-by-default verification) caught and corrected **2 self-introduced bugs** before ship: #10's tunnel exit handler ran its state-reset (`onDown`) UNCONDITIONALLY — a stale superseded tunnel's delayed exit would corrupt a live tunnel's state and leak cloudflared children over a long run (now the whole handler is identity-gated); and #13's `_ipPostGate` sampled `Date.now()` twice (clamp vs return), a sub-ms negative flake (now a single capture).

**Correctness / data-loss**
- **[HIGH] False 100%-complete while campaign posts are owed.** `_outstandingWork` gated campaign-remaining + the owed tally on the per-cycle `active` set, so a cycle that RESERVED all campaign agents collapsed undealt to 0 → completionMode stopped the run reporting success with posts still owed. Now tallied over the plan roster (mirrors CP1); `hasFinite`'s campaign term is roster-based too. +2 tests.
- **Corrupt primary clobbered the good `.bak`.** `saveModeration`/`saveComments` copied a possibly-corrupt primary over the backup with no parse-guard (unlike `saveProgress`) — a corrupt primary + a failed atomic write lost BOTH copies. Now parse-guarded.
- **A string `dailyCap` silently disabled the cap.** `normalize()` never clamped numerics on LOAD, so a hand-edited `"dailyCap":"5"` reached the engine where `Number.isFinite("5")` is false → cap OFF. `clampSettings` now runs on load. +1 test.
- **Stand-in claim over-release → double-deal.** `_runAccount`'s finally released a shared `_claimed` id for every post, but only unique/sequence accounts claim — a campaign/stand-in run released a DIFFERENT unique account's live claim. Now releases only self-made claims.

**Scheduling**
- **Daily-cap hold slept to UTC midnight; the cap resets at LOCAL midnight** → idled the timezone offset every capped day. Now local midnight (mirrors the sibling daily-rotation hold).

**Durability / lifecycle**
- **Crash-breaker give-up wedged a live process.** After the in-process breaker gave up nothing relaunched (process stayed alive). Now hands off to a fresh process (`app.relaunch`+`app.exit`), bounded by a persisted streak reset after 10 min healthy uptime.
- **`--autostart` suppressed by a sticky run-active flag when resume is disabled.** Decoupled — the daily hook fires for an interrupted run whose resume is off, and the stale flag is cleared.
- **Journal appends weren't fsync'd** → the no-double-post guard didn't survive power loss (only force-kill), despite the header claiming it. Now fsync per append.

**Leaks / network / waste**
- **Handed-off comment-image temps leaked in tmpdir** (reclaimed only at module load). Now a queue-aware sweep runs between cycles, and it NEVER deletes a temp still referenced by a persisted held/pending record (previously a >24h-unapproved moderation image was destroyed across a restart → dropped comment).
- **Cloudflare tunnel had no death detection** — a dead quick-tunnel left `tunnelActive` stuck so a re-enable was a no-op. Now the child exit resets state + self-heals after 60s if still enabled.
- **`downloadImage` retried permanent 4xx** (404/410/403) as transient → burned the full retry+backoff every cycle. Now classified non-retryable (still retries timeout/408/429/5xx/network). +2 tests.
- **Moderator single-flight guard defeated by Stop→Start.** The abort signal + guard release are now generation-scoped.

**Real-IP pacing (no-proxy fleets — all only RAISE spacing)**
- **First group-post bypassed the per-IP gate** → under Max the first post landed below `realIpMinPostGapSec`; and **`staggerAccounts=false` removed real-IP start-spacing entirely.** The launch throttle now enforces a floor of at least `realIpMinPostGapSec` regardless of the stagger toggle (the toggle governs cadence, not the ban-safety floor).
- **`ipPostGate` reservation was moot** — the worker's `max(_cfgGap, gateWait)` ignored it when the inter-group gap dominated, and the slot was reserved at the boundary not the real post instant. The gate now reserves on the PROJECTED post instant (one reservation per post — never double-advances the shared clock), so concurrent no-proxy posts can't drift below the floor.

**Deferred — dedicated pass (#4, ADR-0009 completion/crash-fold, double-post-sensitive):** unique/sequence PARTIAL delivery is marked dealt with no PERSISTENT owed-carry (only same-cycle `_cycleOwed`), so un-reached groups strand if no same-cycle reserve covers them, and completion can report a false 100%. The persistent obligation is gated to daily-rotation/campaign-plan (`orchestrator.js:2307`) because those have an owed-pick-override; unique/sequence uses the shared `_dealt` set and needs a per-(post,group)-scoped override to avoid re-posting already-delivered groups. Left for a careful, live-validated pass.

## [1.0.104] — 2026-07-16 — Robustness: the per-account watchdog aborts a live-but-STUCK browser (last gap-hunt item)

The per-account time-budget watchdog re-extended the FULL budget on any "alive" tick with no progress check — so a browser that stays responsive to a trivial evaluate but never advances a group (a persistent interstitial / hung SPA) would re-extend **forever** and stall the cycle drain. Now (new pure `watchdogTickDecision`): a dead browser aborts (unchanged); a live browser that STARTED a new group since the window armed extends (it's slow, not stuck); a live browser with ZERO group progress gets **one grace window** (a rare laptop sleep-resume fires the wall-clock timer with no fault — though `powerSaveBlocker` blocks sleep during a run) then **aborts** on the second consecutive no-progress window, and a reserve covers its groups. +4 unit tests, full suite **347/347**, antispam 34/34.

This clears every actionable finding from the days-unattended gap-hunt.

## [1.0.103] — 2026-07-16 — Robustness: daily-mode cap false-stop + unbounded crash journal (2 gaps)

Two more from the gap-hunt, both self-contained and ban-safety-preserving:
- **A daily-mode fleet that hit its per-account cap mid-day STOPPED the run.** The "all accounts capped → wait for the next day" cap-hold was gated to non-daily modes, assuming the daily gate handles it — but the daily gate waits on the `cyclesPerDay` COUNT, not the per-account daily CAP, so a fleet that exhausts its cap before the day's cycles are used up fell through to the stall-breaker and STOPPED (while logging a self-contradicting "resumes after midnight"). Removed the gate so the cap-hold — which already verifies every active poster is genuinely capped, none cooling/flagged — waits for the next day in daily mode too.
- **The crash-durability inflight journal grew unbounded on a run that never restarts.** `pcu-inflight.jsonl` gets a line per delivery, but compaction ran only at Start/fold — so a days-long run bloated it (and slowed the eventual restart fold). Now compacted between cycles, reusing the fold's EXACT keepFn: a line is dropped only once durably superseded (`q` ≤ its agent's committed watermark AND, for unique/sequence, its post fully dealt), so crash recovery is never weakened. Safe because a new cycle is only reached if the prior cycle's persists succeeded.

Full suite **343/343**, antispam 34/34. (Remaining gap-hunt item: #5 no-progress watchdog — a watch-item, group ops have their own timeouts.)

## [1.0.102] — 2026-07-16 — Robustness: a transient file-lock no longer ends a days-long run (2 gaps)

From a gap-hunt for days-unattended failure modes. Two "a momentary Windows file-lock (AV / OneDrive / Search-indexer holding `run-state.json`) kills the whole run" gaps — the same class the disk hardening (v1.0.88) targets — now self-heal:
- **The critical rotation-state persist had no retry.** `_persistDealt` (the post-delivery "mark dealt" write that STOPS the run on failure to avoid re-posting) called `saveRotation` ONCE and stopped on any failure, while every OTHER persist path already retries transient locks ×3. Now it retries ×3 with a 200 ms backoff — the write is atomic + idempotent (temp→fsync→rename), so a retry can never corrupt or double-post; only a persistent failure stops the run.
- **`_recordLossHalt` never auto-cleared.** A failed held/comment persist set a sticky halt that forced the pool to launch nothing EVERY cycle, reset only on a manual Start — so a transient lock that later cleared still wedged the run (the dead-fleet stall-breaker then killed it 3 cycles later). Now it clears at the top of each cycle (the affected post is already dealt → no double-post), so a cleared lock self-recovers and a persistent one just re-halts that one cycle. Mirrors `_diskHalt`'s self-healing.

Full suite **343/343**. (Gap-hunt also surfaced #3 unbounded `pcu-inflight.jsonl` growth, #4 daily-mode capped-fleet false stop, #5 no-progress watchdog — deferred.)

## [1.0.101] — 2026-07-16 — Robustness: no-admin userland auto-relaunch after a process crash (Issue-2 #2)

Complements v1.0.100 (the in-process restart survives a THROW; this survives a full PROCESS crash / GPU-OOM kill / reboot). The generated `start.bat` is now a relaunch-on-crash **watchdog**: it runs the exe with `start /wait`, and on exit checks a `run-active.flag` the app drops **next to the exe** (mirrors the userData run-state; A1 keeps it set on a crash). Flag present after the process died = a run was active = a crash → relaunch after a 30s backoff, with a **5-in-a-row crash breaker** so a deterministic crash can't loop-hammer the shared IP. Flag absent = a clean quit / Stop / completed run → the watchdog exits. **No admin, no Windows scheduled task.** The app already auto-resumes an interrupted run on launch (renderer-load + a 20s renderer-independent fallback), and `resumeOnStartup` now **defaults ON** (gated on run-active-from-crash AND work-remaining, so it never resurrects a finished run) so the relaunch actually resumes. Files: `main.js` (exe-adjacent flag in `setRunActive`, packaged-only, best-effort), `lib/store.js` (default), `scripts/build-portable.js` (watchdog bat — flow validated). Suite **343/343**.

Known edge: if v1.0.100's in-process breaker gives up (3 rapid throws) the process stays open (run stopped, run-active kept) — the watchdog acts only on a process EXIT, so a later process death then relaunches + resumes. A full process crash / reboot is covered immediately.

## [1.0.100] — 2026-07-16 — Robustness: the loop auto-restarts in-process after a crash (no more dead-until-relaunch)

Issue-2 #1 — the biggest wasted time for an always-running machine. A throw ANYWHERE in the ~1440-line cycle body used to unwind the WHOLE run through the single top-level catch, and it then sat dead until a human relaunched (A1 only recovers on the NEXT launch → a night crash = up to ~24h idle). Now the loop **auto-restarts in-process**: re-entering `_loop` reloads durable state from disk + re-folds the crash journal — exactly what a relaunch does, minus the human — so no progress is lost. A crash-loop breaker (new pure `crashRestartDecision`) allows up to **3 rapid** consecutive restarts with a growing, capped backoff (30/60/90s … ≤5 min) so a deterministic crash can't hammer the shared IP, then stops and tags `crashed` (A1 keeps run-active for the next launch). A crash after a long HEALTHY run RESETS the streak, so isolated transient faults days apart never accumulate to the breaker. Stop/Finish/Completed still exit normally. Verified safe: re-entering `_loop` spawns no duplicate moderator loop or timers (both live in `start()`), and each account self-cleans its browser in a `finally`. +6 unit tests, full suite **343/343**.

Covers an in-process THROW. A full PROCESS crash / reboot still needs the no-admin userland auto-relaunch (Issue-2 #2, next).

## [1.0.99] — 2026-07-16 — Time-waste: fewer composer-open retries once FB is already throttling

Extends the v1.0.97/98 pushback-aware pattern to the composer-open step (Issue-2 #3). A healthy account keeps the full 4 attempts (a slow / hidden / proxied feed legitimately needs the retries). But once FB is already pushing an account back (`consecPushback>0`), the feed usually won't render at all, so 4 attempts just idle ~30s before the skip — cut to **2** (new `composerOpenAttempts`) so the account reaches its backoff fast instead of hammering an unloadable group. The first attempt is always made; it's a READ-ONLY pre-publish path, so fewer attempts can never cause a double-post. Gated strictly on `pushback>0` (a healthy account is never shortened). +3 unit tests, full suite **337/337**, antispam 34/34.

## [1.0.98] — 2026-07-15 — Hardening: unified mixed-failure backoff — a throttled account stops flailing across its groups

From the finished-campaign analysis (95.8% delivered / recovery works / only 1.1% permanently lost — every error class = FB throttling few accounts on one shared IP). The account-stop logic had **three independent "2 in a row" counters** — publish-timeout, composer-won't-open, post-button-missing — so an account that FB throttles into failing **different** ways across its groups (a timeout, then a composer miss, then a post-button miss) tripped none of them and flailed every remaining group (wasted time + a botty rapid-fail pattern on an already-throttling account).

Fix (`worker.js`, new `consecPushback` + `mixedPushbackDecision`): a unified counter increments on **any** of those pushback failures and resets on a confirmed/held publish; **≥3 in a row (any mix)** ⇒ FB is pushing the account back → stop hammering its remaining groups and back it off (a reserve / the next cycle covers). Checked at the group-loop **top**, so it only fires when there ARE remaining groups to protect (a flail on the last group just ends the cycle → retries next). Purely **additive** — a same-type 2-in-a-row always breaks first, so same-type behaviour is byte-identical — and it mirrors the #7 guard (a `transient` stop, not an 8h rest, if the account already delivered today). +5 unit tests, full suite **334/334**, antispam 34/34.

Reminder: this reduces the *symptom*. The cause is the shared IP (20 accounts, proxies off) — proxies prevent the throttle that makes accounts fail this way at all.

## [1.0.97] — 2026-07-15 — Time-waste: a silently-throttled account no longer idles ~70s per post

From a live-run log. When Facebook SILENTLY throttles an account (no error, no banner — it just drops the publish), the account waited the full **70s** publish-confirmation ceiling on EACH post before giving up; and because the throttle backoff needs **2 unconfirmed posts in a row**, it ate that ~70s **twice** (~190s idle of a 397s cycle in the observed case — `e3`) before benching. That's the "sits stalled doing nothing" the operator saw.

Fix (`worker.js`, new `publishWaitCeilingMs`): the FIRST post of a run keeps the full 70s — a slow / hidden / proxied publish can take 35-45s+, and a too-short wait is a FALSE "timeout" the owed/reserve path could re-post = a **duplicate** (the one ban-risk axis). But once FB has silently dropped one publish this run (`consecPubTimeouts>0` ⇒ its create-story backend didn't acknowledge the prior post), the next post's ceiling drops to **35s** so the account reaches its 2-in-a-row backoff fast instead of idling. **Double-post safety is unchanged**: on a timeout the H3 network-capture confirm (~3s), the dialog-close poll (~12s) and the author-matched feed rescan ALL still run — ≈15s of landing coverage AFTER the ceiling — so 35s still covers the documented slow-publish window; a post that actually landed is caught and never re-posted. Considered and **rejected**: a network-level fast-fail — `sawCreate=true, hit=null` is ambiguous with a slow `@defer`-streaming SUCCESS (`worker.js:3416`), so bailing on it would risk a double-post. +5 unit tests, full suite **329/329**, antispam 34/34.

Prevention is the bigger lever: `e3` was throttled because 20 accounts share one IP (proxies OFF). Assigning proxies avoids the throttle — and the whole wasted cycle — not just 35s of it.

## [1.0.96] — 2026-07-15 — Core batch 2c: a mid-run campaign edit no longer re-bursts the whole library (#2)

From the core-invariant audit. Campaign Plan splits the library into per-agent daily slices stamped with a `batchId` (hash of the posts **and** the roster, where each agent's `sig` covers its groups + post-set); progress is a single per-agent pointer. The `_loop` plan-build block recomputed the plan **and wiped every pointer** whenever `batchId` changed — so any operator edit to a RUNNING campaign (turn an account on/off, change a group assignment or post-set, add/remove/reorder posts) restarted every agent at slice[0]. Campaign-Plan posts aren't in the fleet-wide `_dealt` set (each group-set must receive the whole library), so once the pointer was wiped nothing blocked cross-cycle re-delivery → a **whole-library re-burst onto the shared IP** (the one ban-risk axis), gated only by operator discipline. The reserve-rotation flavor was already fixed by CP1; this closes the genuine mid-run-edit flavor.

Fix (`orchestrator.js`, new `_reconcileCampaignPlan`): build the plan **once per round, then FREEZE it**. A mid-round `batchId` change is detected but **deferred** — the active plan and its pointers are held for the rest of the round, and the edit applies cleanly at the next round boundary (loop-wrap recompute) or on Stop→edit→Start; the operator is told once per distinct edit. The one step applied immediately is a **roster shrink**: an agent that LEFT the campaign (turned off, un-grouped, or switched off campaign-plan → gone from `_campaignRoster()`) has its slice pruned from `agentLists`, so its un-advanceable pointer can't wedge `_campaignAllFinished`/`_campaignRemaining` (loop never wraps / completion never fires). Pruning leaves every surviving agent's slice untouched (no re-partition → no re-burst); `_owed` is kept so standby coverage of a removed agent's partial delivery still runs; a benched or reserve-held agent stays in `_campaignRoster()` → NOT pruned → CP1's no-premature-reloop guarantee holds. Trade-off (intended, ban-safety-first): a mid-run edit takes effect next round, not instantly — a safe deferral in place of a dangerous over-delivery. +4 regression tests (first build, frozen edit with preserved pointers, roster-shrink prune, benched-not-pruned). New [ADR-0019](docs/decisions/ADR-0019-campaign-plan-frozen-within-round.md). Full suite **324 tests** (2 pre-existing time-of-day-dependent `firing-loop` failures unrelated to this change), antispam 34/34.

Batch 2 remaining: **#5** owed/reserve re-delivery liveness gate (inverted risk — the staged C1; needs a live run to tune before shipping).

## [1.0.95] — 2026-07-15 — Core batch 2b: moderator won't wrong-approve a stranger's identical-caption post (#6)

From the core-invariant audit (latent — behind `moderationEnabled`, currently off — but real). When a poster has no `fbDisplayName` (or the queue author is unreadable), the moderator's author check fails OPEN to caption-only, so it could approve a STRANGER's held post carrying byte-identical ad copy — landing our link-comment on their post. Fix (`moderator.js`): a stricter `authorConfirmedOurs` flag (true ONLY on a positive `ourNames` match, never the fail-open default), and before a caption-only approval, require the `captionSnip` to be UNIQUE across the scan — if 2+ cards share the same caption and none has a confirmed author, decline all (they stay `held` → recovered next pass / Phase-4). An author-confirmed card still approves normally even amid same-caption strangers; the change only ever NARROWS what the moderator clicks (never double/wrong-approves, never clears a real block). Full suite **320/320**.

## [1.0.94] — 2026-07-15 — Posting waste-audit batch B: established-account daily warm pass + focus-poll reclaim

Batch B from the posting waste audit — the primary warming reinvestment + the biggest floor-safe time reclaim. Anti-spam floors, single-IP pacing, and all guards untouched; full suite **320/320**, antispam 34/34, boot OK.

- **#13 (WARM) — established accounts now get an ongoing daily warm pass.** The new-account warm-up stops after `warmupRuns`, so the whole long-running fleet went auth→composer every cycle with no browse — a durable spam-shape on the single IP. Established accounts (`priorRuns ≥ warmupRuns`, `enableWarmup` on) now do a LIGHT home-feed pass at most once/~20 h — keyed off a persisted `lastWarmTs` — home dwell + one genuine reaction, and ~half the time a dwell on one of its own groups. Best-effort, `shouldStop`-guarded; adds time BEFORE posting, never touches any anti-spam gap. Tunable via `establishedWarmHours` (0 → off). The primary sink for the time the speedups reclaim.
- **#8 (SAFE-SPEEDUP) — `focusEditable`'s blind `sleep(400)` → a bounded focus poll.** Same 400 ms ceiling, ~120 ms residual floor; the click focuses synchronously so it usually returns in ~120–160 ms, keeping the full ceiling for a slow re-mount. Fires twice per caption (~13–15 min/day reclaimed fleet-wide) — reinvested into warming, not banked as speed. Never returns before 120 ms (the residual settle keeps first-try insert-miss + survival churn from rising).

## [1.0.93] — 2026-07-15 — Posting waste-audit batch A: light warming in Max/Fast + dead-code/log-noise cleanups

From a 9-agent waste audit of the posting lifecycle (code + real log timing; every change floor-checked by a skeptic that rejects anything touching an anti-spam floor). Batch A — the highest-confidence warming win + pure cleanups. Anti-spam floors, single-IP pacing, and all double-post/held/cap guards untouched; full suite **320/320**, antispam 34/34, boot OK.

- **#14 (WARM) — Max/Fast is no longer a warming no-op.** `humanDwell` early-returned in fast/max/turbo (the tiers production runs), so every established account went land→instant-composer with no browse — a durable spam-shape on the single IP. Now fast/max does a LIGHT pre-composer dwell (1–2 scrolls + a short read), operator-tunable via `fastDwellMsMin/Max` (Max=0 → off) with a ~20% skip so it isn't metronomic. It ADDS time before the composer and never feeds/shortens the inter-group gap. Normal/safe keep the full `pageScrollDwell`.
- **#4 — deleted the redundant 3rd Post-button diagnostic scan** (`worker.js`) — it was `null` on every fast/instant/turbo post and only logged; set no DOM attribute, gated nothing. The enable-gate, `waitForPublish` keys, prePublishDwell, clickPostButton, and the post-button-not-found failure path are untouched.
- **#5 — gated the composer-fail DOM diagnostic to the terminal (4th) attempt** — attempts 1–3 self-heal, so ~74/86 of these scans/day diagnosed a problem that had already resolved.
- **#6 — removed a redundant second 1500 ms settle** between failed composer attempts (the next attempt's own settle covers it; failure path only).
- **#1 / #3 — log-noise cuts (~1,070 lines/day):** the inter-cycle countdown now LOGS every 5 min on long waits (the 30 s UI progress emit is unchanged for liveness); "Opening composer (attempt 1/4)" now logs only on retries.

## [1.0.92] — 2026-07-15 — Core batch 2a: reconstruct the daily cap after a mid-cycle crash (#4)

From the core-invariant audit. A hard kill BETWEEN a delivery and `_recordAccountOutcome` (which increments `acc.daily.count` — the cap) loses that cycle's count. The rotation-pointer crash-fold (#3, v1.0.91) covers `postsToday` but NOT the separate `acc.daily.count`, so on resume the account's remaining budget is too high and it can over-post past its daily cap (a Facebook spam signal) — in ALL posting modes. Fix (`orchestrator.js`): `_reconstructDailyCounts` runs once at run start (right after the inflight fold) and rebuilds today's count per account from the PER-DELIVERY run-report (`appendReport` writes each row synchronously *before* the account returns, so it captures crashed-cycle deliveries), deduped by `account|postId|groupId` (a commented post's two `posted` rows count once) and filtered to the LOCAL day. It takes `MAX(persisted, reconstructed)` — only ever RAISING the count, so it fails safe toward under-posting and never over-posts; a correct persisted count is preserved. +1 regression test. Full suite **320/320**.

## [1.0.91] — 2026-07-15 — Core-correctness batch 1: 4 verified fixes from the adversarial core-invariant audit

An 8-agent adversarial audit tried to BREAK each core safety invariant (double-post, wrong-group, caption, held-post, accounting, crash-fold, bench, rotation); 18 holes found, 12 verified against the code. This ships the 4 highest-value, provably-safe, no-new-persisted-state fixes. All preserve the load-bearing guards; full suite **319/319** (+2), antispam 34/34, boot OK.

- **#7 — false `likely_blocked` completed (the d4 case).** v1.0.90's D-guard only covered the terminal "posted nothing" fallback (`worker.js:4048`); the audit found two SIBLING flag-sites — `consecNoComposer>=2` (`worker.js:3037`) and `consecNoPostBtn>=2` (`worker.js:3329`) — that escalate to `likely_blocked` BEFORE it. Extracted the probe into one `deliveredToday()` helper applied to all three: an account that already delivered today (persisted daily count) is NOT benched on a transient composer/feed/post-button miss (it still stops the cycle + reserves cover it via `res.errors>0`). Fails safe toward FB — an account that posted nothing today still benches. (This is the false "check this account on Facebook" alarm seen on d4.)
- **#3 — `cyclesPerDay>1` crash-fold over-post (high).** The R5 fold seeded `postsToday: 1` unconditionally, discarding same-day cycles already committed before a crash → on resume the account could post up to N-1 MORE past its daily cap (a ban-risk). Fix: fold `postsToday = min(N, priorSameDayCount + 1)`; the manual-Start one-shot bypass is pre-spent when the folded count already meets N. N=1 stays byte-identical. +2 regression tests.
- **#1 — held re-post livelock (high).** A successful / already-live reserve re-post flipped the record to `'approved'` but never set `repostAttempts`, so when the comment-rescue reopen path later marked it `'failed'` (after `reopenCount>3`), the candidate filter (`!(repostAttempts>0)`) re-picked it and re-posted an ALREADY-LIVE held post every cycle (duplicate). Fix: set `repostAttempts=1` on both terminal-success paths (`markResolved` + the `reopen>3` terminal). `repostAttempts` has no other reader; Phase-1 re-hold dedup keys on status, so a fresh future hold is unaffected.
- **#10 — crash-key mismatch on a postingOrder switch (low, zero blast radius).** The unique-branch fold seeded `_inflightDelivered` with the stored rotation scope `(rec.s||'')+p+'::'+g`, but the resumed unique/sequence worker looks it up with the empty scope, so a daily-rotation→unique switch between crash and resume made the key never match → delivered groups re-posted. Fix: normalize the seed to `p+'::'+g`; strict no-op on the normal path (`rec.s` already `''` for unique/sequence).

Deferred to batch 2 (careful standalone work): #4 crash daily-cap reconstruction (day-key handling), #5 owed-repost liveness gate (inverted risk — reuse `repost.js` isContentLive), #2 campaign durable per-(post,group) ledger (L, new persisted state), #6 moderator wrong-approve (latent — moderation off). Rejected: two-phase report double-row (audit-only; ledger + cap already dedup by `account|postId|groupId`).

## [1.0.90] — 2026-07-15 — Observability: machine-readable status.json + hourly HEALTH line for an away operator

E from the hardening plan. An operator polling the tunnel for days couldn't tell a healthy run from a slowly-dying one (accounts benching one by one, disk-halted, stuck with no recent post) — the run summary only emits at terminal states. Fix (`orchestrator.js` + `store.js`): the orchestrator now (a) writes `status.json` at the userData root every ~5 min (atomic overwrite) with running/paused/diskHalt/offline, cycle, posted/errors/pending, accountsDone/Total, the benched-accounts list, last-post-ago, and uptime; and (b) logs a `💓 HEALTH — …` line hourly. Read-only over existing counters, driven by a timer OFF the per-post critical path (a slow status write can't perturb pacing or the single-IP loop); the timer starts with the run and is cleared in `.finally()`, which also writes a final status reflecting the terminal state. New `store.writeStatus` / `store.statusFile`. Full suite **317/317** · antispam 34/34 · boot OK.

## [1.0.89] — 2026-07-15 — Disk self-management: prune Chrome caches between cycles (complements the auto-pause)

B2 from the hardening plan — the PROACTIVE half of disk safety (B1 in v1.0.88 was the reactive auto-pause). Chrome's HTTP/GPU/shader caches grow unbounded across a multi-day run (only the HTTP cache was capped); on a busy day the profile churn alone was several GB, which is what filled the drive and stalled a run. Fix (`orchestrator.js`): between cycles — when the pool + rescue + repost have all drained, before the inter-cycle wait — `_pruneProfileCaches` deletes ONLY ephemeral cache dirs (`Cache`, `Code Cache`, `GPUCache`, `ShaderCache`, `GrShaderCache`, `Dawn*`, `Crashpad`) at the profile root and its `Default` folder, for every non-moderator account. It NEVER touches Cookies/Network, Local Storage, IndexedDB, Service-Worker CacheStorage, or Preferences — and the durable login (`accounts/<name>/cookies.json`) lives outside `chrome-profile` entirely, so a session is never affected. Safe against a stray open browser (Windows locks in-use files → `rmSync` skips them) and skips the moderator (its background approval browser may be open). Runs before the next cycle's disk check so reclaimed space can avert a B1 pause. New regression tests (2) assert caches are pruned while every cookie/identity artifact survives, and that the moderator is never pruned. Full suite **317/317** · antispam 34/34.

## [1.0.88] — 2026-07-15 — Unattended-survival hardening: honest crash tag (auto-resume unblocked) + hard disk auto-pause; CSV BOM

P0 "days-unattended" survival fixes from the 2026-07-14 campaign-log hardening plan. All load-bearing guards preserved; `node --check` · full suite **315/315** · antispam 34/34 · boot OK.

- **A1 — a real orchestrator-loop crash was mislabeled a clean "completed" and cleared run-active, so the resume path never fired (silent, unrecoverable run death).** `_loop().catch()` logged the crash, but `.finally()` computed `reason = _stop ? 'stopped' : _finish ? 'finished' : 'completed'` — a thrown loop collapses to `'completed'`, and main.js cleared run-active on every terminal reason. Fix: the catch sets `this._crashed = true`; the reason is now `_crashed ? 'crashed' : …`; main.js clears run-active on every reason EXCEPT `'crashed'`. A crash now KEEPS run-active set → the existing next-launch resume recovers it, and the log stops lying with "Automation completed." Clear semantics for completed/finished/stopped (incl. maxCycles / no-posts) are byte-identical.
- **B1 — a filling disk was advisory-only; it would hit ENOSPC and halt the whole fleet mid-run (it did on 2026-07-14, forcing a manual C:→D: move).** Added a hard floor below the existing warn tier: a SEPARATE `_diskHalt` flag (never the operator's `_paused`) that `_waitWhilePaused` now honors, evaluated (`_evalDiskHalt`) before each pool top-up. Auto-PAUSE all posting under 1 GB free, auto-RESUME over 2 GB (hysteresis so it can't flap). Between-launch hold only — never aborts a live post. Converts the single most-likely hard failure into a self-healing pause.
- **CSV BOM.** `run-report.csv` gets a UTF-8 BOM on header creation so Arabic/accented group names render in Excel/LibreOffice instead of mojibake (write-only file; no reader strips it).

## [1.0.87] — 2026-07-15 — Posting effectiveness: caption-drop reclassify + image-first Lexical seed stabilization; opt-in relocatable userData

Two posting-effectiveness fixes from the 2026-07-14 campaign-log analysis (1438 posted / 34 errors; the error cluster was 13× "post button not found", 12× "composer did not open", ~30 "caption did not land"), plus an infrastructure opt-in for low-disk machines. All load-bearing guards preserved (single-IP serialized pacing, ~30s anti-spam floors, double-post / wrong-caption / caption-less guards untouched); `node --check` · full suite **315/315** · antispam 34/34.

- **C2 — a dropped caption was misreported as "post button not found" and burned the group.** When the image-attach caption-survival loop exhausted WITHOUT confirming our caption (but the editor wasn't provably empty, so the existing caption-less guard didn't fire), execution fell through to a doomed publish; the missing Post button was then reported as `post button not found` — misleading, and it wrongly advanced the 2-in-a-row "unsupported UI language" streak. Today 10 of 13 "post button not found" errors immediately followed a "Caption not confirmed" for the SAME account+group (clustered on c4/b5). Fix (`worker.js`): a group-scoped `captionConfirmed` flag (default true; set to the survival loop's result) is consulted at the clickPostButton-null branch — when false, throw a `transient:` so it routes to the EXISTING bounded pre-publish retry (fresh composer; `publishClicked` still false → no double-post; max 3/group) instead of misreporting the button. Fires ONLY when the button is genuinely absent, so a still-publishable composer (caption actually fine, only the verify flaked) is never discarded. Also corrected the misleading "will re-attempt the group" log.
- **G2 — image-first caption often "did not land" on the first paste (≈30 retries/day).** In fast/paste mode with an image, attaching the image re-mounts FB's Lexical editor; the seed paste used a blind fixed settle and could insert MID-re-mount → the caption lands in a stale editor → the survival loop grinds ~9s then owes the group. Fix (`worker.js`): the image-first seed (only) now waits, AFTER the existing floor settle, until the marked editor's bounding rect is identical across two 150ms reads (settled + still present), bounded (~1.8–2.5s). Strictly ADDITIVE — it never inserts earlier than before and the survival loop remains the safety net, so it can only improve first-try landing, never regress it; the two other `enterCaptionOnce` callers pass no `stabilize` and are byte-identical.
- **Relocatable userData (`ZA_USERDATA_DIR`, opt-in, inert unless set).** `main.js` honors a `ZA_USERDATA_DIR` env var before whenReady/store.init to `app.setPath('userData', …)`, moving ALL app data (profiles, cookies, logs, uploads, license) to another volume; on failure it silently keeps the default path. Used on the operator's machine to move data off a near-full C: onto D: after a disk-full crash. Safe for client builds (unset → default).

## [1.0.86] — 2026-07-14 — Harden checkStatus cookie injection: retry a transient miss so a healthy account isn't falsely benched (operator-reported)

Symptom (surfaced right after the 26-account rename/profile-move): `checkStatus` intermittently returned `"No c_user cookie — not authenticated"` for accounts whose session was actually fine — they'd self-recover on the next check. Cause: an inject/navigate miss (a dropped `setCookie`, a slow nav) leaves the probe page with a half-seeded cookie jar, so the post-navigation c_user read fails. That falsely benches a healthy account (under-delivery). Fix (`main.js checkStatus`): when the SOURCE jar contains `c_user` but the page doesn't after navigating, retry the inject+navigate **once** (clearing the half-seeded jar first). Stays conservative — a real logout (source jar has no `c_user`) or a real `/login|checkpoint/` redirect is authoritative and never retried, and the retry only re-injects the EXISTING jar's cookies (it can never invent a session). Same browser, so no extra IP concurrency; the second load only happens on the flaky-miss path. `node --check` + boot verified.

## [1.0.85] — 2026-07-14 — Fix: assigning a group to an account didn't update the UI until a restart (operator-reported)

`toggleGroupAssignment` (renderer) saved the change to disk but its in-place UI update queried `.account-groups > div > span:last-child` — a selector from the pre-v1.0.77 card layout that no longer matches anything. So the `📋 N` chip and the "N groups assigned" text never refreshed until a full re-render/restart. Fix: tag the chip + text with `data-groupchip`/`data-grouptext` (account-keyed) and update those in place — so the count updates live and the picker stays open for assigning several groups in a row. Renderer-only; `node --check` + boot verified.

## [1.0.84] — 2026-07-14 — H4 shipped (standby checkpoint un-stick) + multi-cycle firing-loop test (operator-approved)

Cleared the last two "known items" from the v1.0.83 wrap-up.

- **H4 — standby stuck at checkpoint: NOW FIXED (was deferred).** Re-reading `checkStatus` (main.js:1340-1414) showed the deferral premise was a conflation: `checkStatus` launches a *real browser*, navigates FB, and returns `logged_in` **only if** the URL isn't `/login|checkpoint/` and `location.href` has no `/checkpoint/` (lines 1369/1384) — so an *active* `logged_in` genuinely means the checkpoint redirect is gone. (The "reads logged_in even when blocked" caveat is the *passive* cookie-beacon, which M2-02 still correctly distrusts.) Fix: in the login-browser `disconnected` handler, when the active `checkStatus` returns `logged_in`, force a stuck `checkpoint`/`needs_verification` status to `logged_in` past M2-02 and clear the attention-rest. **Adversarially reviewed (3 angles, all confirmed-safe):** keyed strictly on `checkpoint`/`needs_verification` (never touches `rate_limited`/`account_disabled`); worst case (a rare non-URL checkpoint slipping the URL check) is caught mid-run by the worker's *stricter* `checkVerification` on the first group and re-benched — bounded + self-correcting, no hammering; over-posting impossible (delivery governed by the dealt-set/journal/daily-cap independent of bench status). Only fires on the operator-driven login-browser path, never a passive probe.
- **Multi-cycle firing-loop regression test.** Extracted the daily-gate wait decision into a testable `_dailyCycleWaitMs()` (behavior-preserving) and added `tests/orchestrator-firing-loop.test.js` (5 tests) that drive the full firing sequence — locking the v1.0.78 fix (a subsequent cycle arms an absolute fire time and counts DOWN to it, never re-arming a fresh gap forever). Also corrected two stale `≥5min`/`cycleGapMin ≥5min` comments (both are 30s now).
- Verified: `node --check` · full suite **315/315** · antispam 34/34 · boot OK.

## [1.0.83] — 2026-07-14 — Deferred ban-safety sweep: 4 provably-safe fixes shipped, 1 kept deferred (operator-requested "final sweep")

Cleared the deferred findings recorded at v1.0.73/76. Each was re-verified against current code by an independent reader and adversarially reviewed (skeptics tried to refute ban-safety); all four ship with `banAxisRegression: false`. Ban-safety rule held: never loosen an anti-spam floor, never over-post, never clear a real block.

- **CP1 — reserve-churn campaign reset (was OVER-deliver; dormant at reserveAccounts:0).** The numeric "Reserve Accounts" hold-back rotates which agents are `active` each cycle → the campaign plan's `batchId` churned → the mismatch branch wiped every agent's slice pointer → the campaign re-posted slice[0] every cycle forever. Fix (3 coupled edits, `orchestrator.js`): new `_campaignRoster()` = the STABLE full campaign fleet (enabled, non-mod, non-standby, campaign-plan, with groups) from `this._data`; both `planAgents` sites (in-cycle build + loopCampaign reloop) use it; `_campaignAllFinished`/`_campaignRemaining` are now roster-aware (iterate `agentLists` keys, not `_active`) so a reserve-held agent can't trigger a premature reloop = whole-library re-post burst. **Byte-identical at reserveAccounts:0** (the operator's live config).
- **H1 — crash-fold fabricated `lastPostedAt=now` for a prior-day delivery (was UNDER-deliver).** The R5 journal fold stamped the restart instant, benching a good agent for a full day after an unattended crash. Fix: `markDelivered` now records the REAL delivery timestamp `t` on the journal line (additive/opaque — old lines carry no `t`); the fold uses the highest-q survivor's `t` (`foldTs`, defensively validated: NaN/0/negative/future → `Date.now()` fallback) so the 20h anti-straddle floor measures true elapsed-since-post. Provably never releases before 20h-since-real-post; legacy lines are byte-identical to before.
- **H2/H3 — operator re-login cleared status but not the attention-rest (was UNDER-deliver).** A recovered logged-out account stayed benched until timer expiry (≤24h). Fix: persist the bench REASON (`attnFlag`) on the rest and clear it on a clean delivery; the manual-relogin path (main.js disconnected handler) un-benches ONLY when `attnFlag === 'needs_login'` — never for checkpoint/blocked/disabled (a `logged_in` cookie-probe doesn't prove FB lifted those = ban-axis). `attnFlag` added to the RUNTIME persisted-field list. Overpromise log corrected (re-check only helps a logged-out account).
- **CP2 — cluster signature omits postFilter (dormant at uniform `postFilter:"all"`).** Agents sharing groups+set but different filters collapse into one cluster gated by the first. Shipped a **one-time warning** (NOT a signature change — splitting overlapping filters would over-deliver across days).
- **H4 — standby stuck at checkpoint: KEPT DEFERRED.** The gating check failed: `checkStatus` returns only logged_in/not_logged_in/error and reads logged_in even for a checkpointed account, so bypassing the M2-02 defense to clear a checkpoint on manual login can't be proven safe (clearing a real checkpoint = ban-axis). Left as-is.
- Verified: `node --check` · full suite **310/310** (new H1 fold + CP1 roster/completion + CP2 warning tests) · antispam 34/34 · boot OK.

## [1.0.82] — 2026-07-14 — Scaling hardening: dashboard stays cheap for big/long-running campaigns (operator-requested, ahead of scale)

Proactive, ahead of a bigger campaign. None of these change posting/pacing/guards — all display + I/O efficiency.
1. **Coalesced ledger write** (`store.recordProgress`/`flushProgress`): the dashboard `daily-progress.json` was deep-cloned + fully rewritten on EVERY delivery — O(ledger size) per post. Now recordProgress mutates the in-memory cache directly (get-plan reads it instantly) and the disk write is debounced ~1.2s so a burst of deliveries is ONE write. Flushed on app quit (`main.js` window-all-closed → `store.flushProgress()`). Safe: the posting-critical rotation pointer + append-only run-report are still persisted per delivery, so a hard crash between flushes loses at most ~1.2s of dashboard cells (self-heals), never a double-post or audit row. `store.init()` now also resets the progress cache (correct on re-init; also isolates tests).
2. **Scoped plan scan** (`lib/plan.js campaignCycleDays`): builds the per-cycle map for only the VIEWED round (two cheap passes) instead of every round in history → memory bounded to one round on a long-lived ledger.
3. **Windowed cycle strip** (`renderer.js`): renders at most ~60 cycle pills with `‹N` / `N›` jump buttons, so a campaign with hundreds of cycles doesn't create hundreds of DOM nodes.
- Verified: `node --check` (store/plan/main/renderer) · full suite **302/302** (new `progress-ledger` flush round-trip + tag-persistence tests) · antispam 34/34 · boot OK.

## [1.0.81] — 2026-07-14 — Fix: per-cycle view reset too eagerly on round-loop (completed round vanished) (operator-verified live)

Caught while watching the operator's run confirm v1.0.80. A campaign with a short slice completes a whole round in one run; with Loop Campaign on it immediately loops (`roundOffset++`), and v1.0.80's "current round only" filter made the just-completed round's cycles **vanish instantly** — showing an empty new round. That re-created the exact "reput on finish" the operator originally reported (their campaign loops continuously, so it reset every round).

**Fix (`lib/plan.js` `campaignCycleDays`, display-only):** the view now follows the **most-recently-delivered round**, not strictly `roundOffset`. A just-completed round stays visible until the NEXT round's first post lands, then flips forward. Delivered cycles are grouped by their recorded `cycle` tag (round-scoped) so they survive the pointer reset + agentList reshuffle a loop causes; the live agentLists supply the forecast only while the shown round is the current one. Matches the operator's intent ("keep the record until it resets / Start Over").
- Verified on live data: `roundOffset=1` with round 0 in the ledger now shows `Cycle 1 [past] #3 2/2 · Cycle 2 [past] #6 2/2` (100%), not an empty round 1.
- Tests updated (`tests/plan-campaign-cycles.test.js`): "keep-record: completed round stays until next round posts" + "reset ON next round: flips once round 1 delivers". Full suite **300/300**.

## [1.0.80] — 2026-07-13 — Campaign panel: true per-CYCLE breakdown (was collapsing all of a day's cycles into one) (operator-requested)

Follow-up to v1.0.79. Operator: cycles should be "separated by cycle" and the record kept through the run until it finishes or Start Over. v1.0.79 stopped the *forgetting* but still lumped every cycle of a day into one "Cycle 1" bucket, because the plan grouped by calendar DAY.

**What changed:** for `campaign-plan`, the dashboard plan is now built **per posting cycle** (slice position), not per calendar day. Cycle 1 = every account's 1st slice-post, Cycle 2 the 2nd, etc. — each its own navigable entry with its own progress bar and cycle-strip pill.
- **Delivered detail** comes from the durable ledger, now tagged at delivery with the campaign `round` + `cycle` position (`orchestrator._slicePosOf` stamps each record in both delivery sinks; `store.recordProgress` persists them). Survives restarts.
- **Reset each round** (operator's choice): only the CURRENT round's deliveries fill the per-cycle view; when the campaign completes and loops to a new round, it starts fresh. Prior rounds stay in lifetime totals.
- **Pointer-aware:** cycles the rotation pointer has already advanced past render as delivered even without per-group ledger detail (e.g. a resumed campaign / pre-ledger history), so a resume doesn't look empty.
- **Display-only:** no posting/pacing/guard logic touched. The record stamping is a read-only `indexOf` in the result callback. Other methods (daily-rotation/sequence) keep the calendar-day view (with the v1.0.79 ledger fix).
- Note: the per-cycle view populates for deliveries made from v1.0.80 on (older ledger rows have no round/cycle tag). A fresh run — or **Start Over** — shows it cleanly from Cycle 1.
- Verified: `node --check` · full suite **299/299** (new `tests/plan-campaign-cycles.test.js`: delivered / mid-run current / reset-each-round / totals) · boot OK.

## [1.0.79] — 2026-07-13 — Fix: dashboard Campaign panel "forgot" delivered cycles under cyclesPerDay>1 (operator-reported)

Operator: "Campaign in dashboard, in the next cycle it forgets the last cycle." Real bug, surfaced by multi-cycle (v1.0.78).

**Root cause (display, `lib/plan.js`):** The campaign plan is CALENDAR-DAY-based (ledger + rotation keyed by local day). With `cyclesPerDay>1`, an account delivers several posts in ONE day, and when a campaign round finishes same-day the engine correctly resets its rotation pointer (`lastPostId → null`) to start the next round paced to tomorrow. But `buildPlan` rendered "today" from that pointer (now `null` → forecast post #1), then overlaid the ledger — and the ledger holds the *delivered* posts (#6/#7/#8), which post #1 can't match. Result: today's delivered progress vanished ("forgot the last cycle").

**Fix:** `buildPlan` now renders TODAY from the **ledger** (the delivered truth) — every post actually delivered today, expanded to each account's full assigned groups so partial/held/pending cells still render — and appends the forecast only for accounts that haven't posted today yet. Future days (offset ≥1) stay pure forecast; the forecast→offset mapping is unchanged. Display-only — no automation/posting/ban impact. New test `tests/plan-multicycle.test.js` reproduces the exact broken live state (pointer `null` + 3 posts in the ledger) and asserts all three survive; existing `overlayRow` 'today' convention preserved.

**Also (orchestrator, consistency):** two `Math.min(8, cyclesPerDay)` clamps left over from the v1.0.78 cap raise widened to `Math.min(20)` — line 1379 (crash-fold reconstruction) and line 2699 (campaign round-reset quota marker). The 2699 under-mark could set the "quota full" counter below the real cap, letting a fresh round post again the SAME day instead of pacing to tomorrow; widening restores correct same-day pacing.

- Verified: `node --check` · full suite **299/299** (4 new) · boot OK.

## [1.0.78] — 2026-07-13 — Operator cycle control + fix: multi-cycle daily runs never fired cycle 2+ (operator-requested)

Operator asked for direct control over how many cycles a run does and how short the gap between them can be ("even as little as 30s / 1 min"). Wiring that up surfaced a latent bug that made the multi-cycle path unusable.

**Cycle control (loosened floors)**
- **Cycles per run:** `cyclesPerDay` cap raised **8 → 20** (`lib/store.js` clamp, renderer clamp, both orchestrator `N` clamps).
- **Between-cycle gap:** `cycleGapMin` minimum lowered **5 min → 0.5 min (30s)**, decimals allowed (clamp `Math.max(0.5, …)`, renderer `parseFloat`, UI input `min="0.5" step="0.5"`). The daily gate's inter-cycle floor and the per-account anti-glitch floor both lowered `5min → 30s`. A ⚠️ ban-risk note was added under the field: gaps under ~5 min raise per-IP velocity on the single shared residential line. **The per-action anti-spam floors (post→comment, inter-group) are untouched** — they still pace every post/comment inside a cycle; this only shrinks the idle wait *between* cycles.

**Fix — multi-cycle daily runs never advanced past cycle 1**
- **Symptom:** with `cyclesPerDay ≥ 2`, cycle 1 fired, then cycles 2..N never started — the run sat idle forever. (Invisible until now because only `cyclesPerDay: 1` had ever been used, which correctly rests until tomorrow after one cycle.)
- **Root cause:** the daily loop's *first*-cycle wait targets an absolute wall-clock time (`dailyPostTime`), so its countdown reaches 0 and fires. The *subsequent*-cycle branch instead recomputed a fresh inter-cycle gap on **every loop re-entry**, and `_dailyCycleCount` only advances *after* a cycle fires — so `waitMs` was always `> 0` and the fire line (`_dailyCycleCount++`) was never reached. Infinite re-wait.
- **Fix:** subsequent cycles now arm an **absolute fire time** (`_nextCycleAt`) **once**, then count down to it across re-entries (mirroring the proven `dailyPostTime` pattern); on firing it's cleared so the next gap re-arms fresh. Reset alongside `_dailyCycleCount` (constructor, manual-Start, new-day). `cyclesPerDay: 1` is byte-identical — the reworked branch only runs when `1 ≤ doneToday < N`.
- Verified: `node --check` + full suite **295/295** + antispam **34/34** + boot OK. Live confirmation (cycle 2 firing ~gap after cycle 1) pending an operator Start.

## [1.0.77] — 2026-07-13 — UX pass: smaller cards, compact/detailed views, click-to-select, one-click open-all-groups, post-set filtering (operator-requested)

Operator-directed UX pass over the renderer (Accounts / Posts / Groups / Dashboard). NOTE: an Electron renderer can't be driven through a headless browser preview, so these changes were written from the source + syntax-verified + boot-verified — the **visuals are pending the operator's on-screen review**. No automation/posting logic touched; all changes are UI + one additive backend handler.

**Account cards**
- **👥 Open groups** — new split-button on each card opens ALL of the account's assigned groups at once, each in its own tab, in the account's own browser (through its proxy). Backend: `open-account-groups` IPC + `openLoginBrowser` now accepts `opts.gotoUrls[]` (opens N tabs; capped at 12); URLs built + sanitized in main (allowlisted in preload). The **▾** still opens a single group.
- **Compact ⇄ Detailed toggle** — Compact (default) hides the per-card config sections (group-assignment, posting-options, proxy, FB-name, last-checked/Chrome meta) so cards are small for scanning/bulk-work; Detailed shows the full controls. CSS-driven (`body.accounts-compact`), no re-render cost.
- **Click-to-select** — clicking a card body (not a control) toggles selection with a ✓ badge; the bulk-action bar now appears whenever anything is selected (no separate "Select mode" needed). Popovers close on click-away.
- **⋯ overflow** — Cookies / Rename / Delete moved off the action row. A **group-count chip** (📋 N) is always visible in the header. Smaller avatar + tighter padding.
- **Sort** — Issues-first (default: floats not-logged-in / rate-limited to the top) · Name A–Z · Most groups.

**Posts**
- **Set filter chips** — `All (n)` · each `📦 Set (n)` · `Untagged (n)` filter the grid to that set (the ✕ still deletes a set); filter + search + select-all compose. **Compact ⇄ Detailed** (compact = small thumbnails + clamped caption). **Click-to-select** the whole card.

**Groups** — click-to-select the card (consistent with Posts/Accounts).

**Dashboard** — verified wired (a local `set(id,val)` helper updates the stat/health/campaign cells — not dead). One completeness fix: the Account Health card now breaks **checkpoint / needs-verification** out of the "Other" lump (was hidden). (Operator flagged "work on the dashboard" — beyond this, the dashboard is structurally complete + wired; awaiting specifics on what else feels incomplete.)

**Persistence** — the Compact/Detailed + sort choices now persist across reloads via `localStorage`.

Verified: `node --check` (renderer/main/preload); boots clean (`[BOOT] renderer loaded OK`, 4 processes). No unit-test change (renderer isn't covered by the node test suite). Pending: operator's visual review.

## [1.0.76] — 2026-07-12 — Account-health sweep: fix TWO ban-direction (wrongly-eligible) gaps in the eligibility gating (operator-requested)

Ran an adversarially-verified sweep of the account **health-state lifecycle + eligibility gating** — the logic that decides, every cycle, WHICH accounts may post right now (it governs how much load hits the single IP, so it is directly ban-critical). Found **2 CONFIRMED_SHIP (both HIGH, ban-direction) + 4 deferred** (all under-delivery / ban-SAFE). Both shipped fixes are **safe-by-construction — they only TIGHTEN gating** (record a cooldown / rest an ambiguous account), never loosen a cooldown or anti-spam floor, and each fixes a real inconsistency with an existing sibling.

- **[HIGH] `runOne` health gate failed OPEN on a transient `data.json` read-lock** (`orchestrator.js:1967`). The per-launch eligibility lookup `const live = getData().accounts.find(…)` had **no `|| account` fallback**. On a transient read failure of `data.json` (OneDrive sync / Defender / search-indexer lock — the exact hazard this LONG-unattended box runs on), `store.load()` returns `blank()`/stale, making `live` undefined → every `if (live && …)` health guard (enabled / rateLimitedUntil / nextAttnRetry / dailyCap) is **skipped** → a rate-limited / logged-out / disabled account posts on the shared IP (fail-OPEN = ban-escalation, and a blank read hits ALL accounts launched during the lock = coordinated re-load). The two structurally-identical sibling lookups (`:1929` coverDrop, `:2224` `_isHealthyReserve`) already carry `|| r`; the main gate was the lone outlier. **Fix:** `… .find(…) || account` (the cycle-start snapshot). Guards compare to `Date.now()`, so an already-expired cooldown still passes (no false over-rest); it only ADDS restrictions on a degraded read.
- **[HIGH] Phase-4 held-repost never persisted a walled reserve's cooldown** (`orchestrator.js:2465-2484`). When a reserve's re-post is rate-limited/blocked by FB (`flag:'rate_limited'`/`'likely_blocked'`/`'account_disabled'`, `posted:0`), the failure branch reverted the held record but **never called `_recordAccountOutcome`** — so the reserve's `rateLimitedUntil`/`rlStrikes` were never written (a rate_limited outcome changes no status field, so `rateLimitedUntil` is the only gating residue). Every reserve health gate then read it as 0 → the reserve was re-picked next cycle and re-launched on the shared IP **while FB still had it walled** (reserve burn + ban-escalation), and the strike ladder never advanced for repeat held-repost walls. The pool (`:2019`) and the sibling Phase-3 comment-rescue (`:2618`, with its explicit "reserve burn" comment) both persist exactly this; Phase-4 was the omission. **Fix:** mirror them — one `_recordAccountOutcome` call on the flag branch, reusing the LOCKED ladder unchanged.

**Verified SOLID (reassurance):** the wrongly-eligible axis is otherwise airtight — every path that launches a browser (poster gate, all reserve/takeover/repost/rescue dispatch) re-reads FRESH disk health and blocks a rate-limited/resting account; the special-account never-post gates (moderator / standby / disabled) are consistent across ALL selection paths (empty finding); cooldowns self-clear on time + zero on a clean delivery (no too-early clear, no manual-Start reset of a live cooldown); health-flag writes are atomic (tmp+fsync+rename, `.bak`, serialized `_writeChain`) with safe corrupt/legacy migration.

**Deferred (verified real, all UNDER-delivery / ban-SAFE — recorded in `AUTONOMOUS-SESSION-LOG.md`):** (a) crash-fold stamps `lastPostedAt=now` for a prior-day delivery → the 20h floor benches campaign agents for a day after an unattended restart (the naive fix loosens the Sacred 20h anti-straddle floor in the cross-midnight case → needs a journal-format change + live validation); (b/c) operator re-login/re-check clears `status` but not the attention-rest `nextAttnRetry` → a recovered account stays benched to timer-expiry (≤24h) — the fix must distinguish `needs_login` (safe to clear) from `likely_blocked`/`checkpoint` (a cookie-probe `logged_in` doesn't prove FB lifted the block) → ban-axis behavior decision; (d) a Standby stuck at `checkpoint` can't clear (needs bypassing the M2-02 `preserveAttentionStatus` defense — safe only if `checkStatus` robustly DOM-detects checkpoints, unverified). All four touch the ban-safe REST bias or Sacred crash-durability → held for an operator/live-validation decision, consistent with the prefer-REST-over-post bias.

Both shipped fixes verified against the source independently; no test-count change (each is a 1-line additive mirror of a working sibling; the inline run-loop paths aren't cleanly unit-testable without a flaky call-order-dependent harness — test-gap noted). Verified: `node --check`; full suite green. App restart to pick up v1.0.76.

## [1.0.75] — 2026-07-12 — Publish-confirm sweep: post-verdict verified locale-robust; flag Arabic-locale composer-open failures so reserves cover (operator-requested)

Ran an adversarially-verified sweep of the **POST publish-confirmation** mechanics (`waitForPublish` / the create-story capture / pending-vs-published / partial-publish / locale), the counterpart to the already-verified comment-confirm. **Headline: the post publish-verdict is well-hardened and locale-ROBUST** — no reachable double-post or missed-delivery on the live config. The authoritative "published" signal (`worker.js:921`, composer dialog-count drop + `data-zp-composer` shell gone) is **locale-free**; `FB.postButton` (line 499, incl. Arabic نشر/مشاركة) and `FB.pending` (line 488, Arabic) are locale-complete; a slow/committed publish is caught by three layered locale-free backstops (H3 network capture, the dialog-close re-poll, the author-aware feed-rescan). The claimed slow-publish double-post needs all three off (no comment + no/short caption + >82s teardown) — off your config (comments ON). The three EN/FR-only mini-banks inside the `sig` evaluate (`hasEnabledPost` 943, pending 935, error 937) are all backstopped by the locale-free signals and reach no bad outcome (verified independently against the source).

**Shipped — flag unsupported-locale composer-open failures** (`worker.js` ~3027). `openComposer`'s "Write something" trigger list is EN/ES/DE/HU/FR — **no Arabic**. A Moroccan account whose Facebook renders in Arabic (a plausible involuntary flip after a checkpoint/re-login) can't open the composer, so it errored per-group and posted nothing — but, unlike the post-button path (which flags `likely_blocked` + "set the account to English" after 2 misses so reserves cover), the composer-open path had **no** account-level flag, so the account silently under-delivered with a wall of unhelpful errors. Added the matching guard: two consecutive composer-open failures with **no identifiable per-group cause** (a membership/group-unavailable cause resets the streak) → flag `likely_blocked` + stop so reserves cover its groups + surface the actionable hint. **Stop-direction only** (`publishClicked` never fired, `waitForPublish` never ran) → structurally cannot double-post; mirrors the blessed `consecNoPostBtn` pattern exactly.

**Recorded, NOT shipped (needs live-Arabic-FB verification):** adding actual Arabic composer-open **trigger strings** (`بم تفكر`/`اكتب شيئا`/`أنشئ منشورًا`) — blind candidates could match the wrong element and mis-open, so they must be confirmed on a real Arabic account first. The new flag is the safe interim: an Arabic account fails loud + reserves cover, rather than silently posting nothing. (Two finder agents glitched to a `"test"` stub mid-run; `locale-dom` was re-run fresh — robust — and `confirm-accounting` was covered by the pending-vs-published finder.)

Verified: `node --check`; full suite green. App restart to pick up v1.0.75 (the flag only fires for an account whose composer never opens — dormant for a supported-locale fleet).

## [1.0.74] — 2026-07-12 — Recovery-pipeline sweep: comment-rescue/confirm verified SOLID; add the missing inter-rescuer IP-spacing gap (operator-requested)

Ran an adversarially-verified sweep of the **recovery** paths — held-post re-posting (`repost.js` Phase-4, **ON** for the operator), orphan/deferred link-comment rescue (`rescue.js` Phase-3), the network-capture + caption comment-**confirm** (`worker.js`), the obligation lifecycle, and shared-IP recovery pacing. **Headline: the wrong-post / double-comment / false-confirm axes are SOLID** — the v1.0.25–1.0.28 confirm fix-cluster (gid-scoped-URL capture, ambiguity-reject, caption-required confirm, author-never-confirms, addFirstComment idempotency, `/^\d{8,}$/` id-gate that nulls the always-local `post-<ts>` id so rescue never gets a blind numeric anchor) all hold and are not weakened. No reachable double-comment or wrong-post-comment. 7 candidates → **1 shipped**, 2 NEEDS_OPERATOR (recorded), 4 NOT_A_BUG.

**Shipped — Phase-3 inter-rescuer IP-spacing gap** (`orchestrator.js` ~2610). The Phase-3 comment-rescue loop dispatched consecutive rescuer **accounts** back-to-back with no enforced gap — so a batch of orphan link-comments (FB's strongest single spam signal) could fan out from multiple accounts on the ONE residential IP spaced only by browser lifecycle. The sibling **Phase-4** re-post loop already guards exactly this ("so a batch doesn't fan out as a coordinated burst") with an explicit 30–90s `_interruptibleSleep` — link-comments warrant *at least* that. Added the matching interruptible 30–90s gap **between** rescuers (never trailing; Stop/Pause stay responsive). Purely additive spacing — touches no confirm / idempotency / dedup / cap guard; the within-rescuer comment floor (`rescue.js`) still paces each account's own cadence, this adds the IP-level cross-account gap. Directly serves the load-bearing single-IP-pacing invariant.

**NEEDS_OPERATOR (verified real, Sacred, NOT shipped — recorded in `AUTONOMOUS-SESSION-LOG.md`):** a rare held-repost **double-post** — on a successful Phase-4 re-post, `repostAttempts` is never set, so if the `'approved'` write is lost (transient AV/OneDrive lock; `markResolved` ignores `saveModeration`'s return) **or** a hard-kill hits the seconds-wide post-before-resolve window, `_pruneModeration` re-arms the record `superseded→failed` **uncapped** → re-selected → an `isContentLive` miss (short caption <12, or an aged reserve copy past the 60-article feed scan) → a second live copy on the IP. Both verifiers ruled it a low-probability Sacred double-post whose fixes are behavior-changing (durable-write-with-halt like the held-persist at :767, or a re-arm counter trading never-drop for never-duplicate) and need live-FB validation — an author/product call, not an autonomous ship. Fires only when FB-held posts + ≥1 in-group reserve/standby exist (operator has 3 Standby).

No test-count change (the shipped change is an additive interruptible sleep, mirroring the untested-by-timing Phase-4 sibling). Verified: `node --check`; full suite green. Dormant-ish (only fires when ≥2 rescuers run in a cycle) — loads on the next natural restart.

## [1.0.73] — 2026-07-12 — Decision-logic sweep: campaign-plan/rotation/scheduling verified sound on the live config; one ban-footgun warning added (operator-requested)

Ran an adversarially-verified sweep of the posting **decision** logic (the less-audited "what post → which group → when" core: campaign-plan split, rotation/sequence/unique pointers, post-set + post-filter selection, day-boundary scheduling, group coverage). **Headline: on the operator's actual config the decision core is correct** — verified against live `data.json` (`reserveAccounts:0`, all 28 accounts `postFilter:"all"`, campaign-plan × 27 + post-centric-unique × 1, daily/N=1). The partition math (every post delivered once even when M∤K), the rotation pointers/wrap/anti-repeat, per-account set+filter application, the local-day bucketing + daily-N gate + 20h anti-straddle floor, and per-cycle group coverage all trace clean and match existing tests.

Two real bugs found — **both DORMANT on the live config**, so no delivery-path change was made:
- **Reserve churn resets the campaign plan (ban-footgun).** When `reserveAccounts > 0`, the per-cycle reserve **rotation** changes which agents are active → the campaign plan's batchId (keyed on the active-agent set) changes every cycle → the mismatch branch resets **every** agent's slice pointer → the campaign re-posts its earliest posts each cycle and never advances (silent over-delivery on the shared IP; campaign-plan has no cross-cycle re-post guard by design). Requires `reserveAccounts > 0`; the operator runs **0** (with 3 Standby, which don't churn `active`), and `allPosters` filters on enabled/standby only — **not** health — so a rate-limited account doesn't churn the roster either. **Not fixed** (the correct fix — rebase the plan onto the stable full roster + make `_campaignAllFinished` roster-aware — touches Sacred completion logic with premature-completion blast radius; deferred for an explicit go-ahead). **Added a one-time WARNING** (`orchestrator.js`, gated `reserveN > 0`, matching the existing config-warning idiom) steering campaign-plan backup to Standby — because "Reserve Accounts" *sounds* safe and a well-meaning bump would silently cause the exact ban the operator avoids.
- **Cluster signature omits `postFilter`.** Two campaign-plan agents sharing groups+set but with different `postFilter` collapse into one cluster gated by the first agent's filter (wrong content + a whole filter's posts undelivered). Requires non-uniform `postFilter`; the operator runs uniform `"all"`, so **dormant**. The naive fix (add `postFilter` to the cluster sig) is unsafe — filters *overlap* (`all ⊇ with-comments`) so it would cause cross-day over-delivery; the safe remedy is a warn-on-disagreement. **Recorded, not shipped.**

No test count change (the shipped change is a guarded log line; the full suite still passes). Verified: `node --check`; **295/295** unit + **34/34** antispam. Dormant on the live config — loads on the next natural restart (no forced restart to interrupt a running poster). Full write-ups in `AUTONOMOUS-SESSION-LOG.md`.

## [1.0.72] — 2026-07-12 — CRASH-DURABILITY: held records + link-comments now survive a hard-kill mid-run (operator-requested)

The biggest known reliability gap (from the temporal/state deep-dive), now closed. Held-post records and orphan/deferred link-comments were kept only in the worker's memory until account-return — so a hard-kill (power loss / OOM / task-kill) between publishing and returning **lost** them: a live post permanently missing its link-comment, a held card the moderator never sees. Worst in two-phase mode, where the loss window is the entire Phase-2 (up to ~10 comments). No double-post (the delivery journal already prevents that) — pure lost-work. This makes those obligations **as durable as the delivery** that owes them.

- **New obligation crash-journal** (`lib/store.js`: `appendObligation`/`loadObligations`/`compactObligations`, on `pcu-obligations.jsonl`) — mirrors the existing delivery inflight-journal, separate file (different commit lifecycle).
- **Journal at creation** — the worker now records each held record (`addHeld`), orphan comment (`addCommentTask` — covers every `routeToRescue` site too), and two-phase deferred comment (at defer time) into the journal the instant it's created, co-located with the durable `markDelivered`. Side-writes: best-effort, wrapped, never affect posting.
- **Fold on the next Start** (`orchestrator._foldObligationJournal`) — obligations a crash left behind are folded into `moderation.json` / `comments.json`, **deduped exactly as the account-return persist does** (held `postId+gid+poster+status`; comment `postId`/`permalink`/`captionSnip+poster`) so a survivor is recovered once, never doubled. Phase-3 rescue's `addFirstComment` is idempotent, so a re-queued already-placed comment is a no-op — which is why a two-phase deferred comment can be re-queued safely without tracking placed-vs-not. Held records fold only when a consumer is on (moderator/repost/completion); comments always rescue.
- **No phantom** — after a clean account-return, its obligations are compacted out of the journal (keyed on `posterAccount`), so a clean run leaves it empty and the next Start folds nothing (a moderator-resolved card can't be re-added). The fold also clears the journal after recovering a crash's survivors; Start-Fresh clears it too.

Tests +2: `obligation-fold.test.js` locks the fold (recovers held + comments, deduped, idempotent across a repeat crash, cleared after, moderation-off gating) and the per-account compaction. Verified: `node --check`; **295/295** unit + **34/34** antispam. Requires an app restart.

## [1.0.71] — 2026-07-12 — Temporal/state deep-dive: fix disabled-account owed-coverage + lock the ban-critical backoff ladder (operator-requested)

Ran a temporal/concurrency/state-consistency deep-dive (5 scenario tracers — pause/resume, crash-restart, reserve-takeover races, concurrent mutations, queue/ledger integrity — + a test-gap finder; every finding requiring a concrete reachable interleaving, adversarially verified). **Headline: the posting core is airtight on the Sacred axes** — no constructible interleaving produces a double-post, double-comment, wrong-group, or ledger corruption across any crash / pause / takeover point (the durable inflight-journal + R5 crash-fold + owed allow-list + serialized store writes all hold). The real findings are lost-work-on-crash + coverage gaps, never duplication. Operator (runs LOCAL) chose to ship the owed-coverage fix + the test-gaps now, and hold the larger crash-durability change for a dedicated pass.

- **Disabled-account owed groups could strand forever (coverage gap).** The persistent-owed reserve-coverage synthesis (which lets a healthy in-set reserve finish an agent's carried-over un-reached groups) was nested INSIDE the takeover block, whose gate only opened on a *same-cycle drop or partial delivery*. So if the operator disabled a rate-limited account mid-run, and on later cycles no *other* account dropped, that account's owed groups were never covered — even though the code explicitly claims to handle the "disabled account never self-recovers" case. Fixed: the gate now also opens when a still-deliverable, not-yet-covered persistent-owed entry exists (`orchestrator.js` — added `_hasPersistentOwed` to the takeover-block condition). The existing synthesis + `_owedStandins` + the per-(post,group) ledger do the rest — a reserve lands ONLY the un-reached groups, never a double-post. Verified no regression across the 25+ orchestrator/takeover tests.

**Tests +2 (pure additions, lock critical previously-untested logic):**
- `orchestrator-backoff-ladder.test.js` — the ban-critical rate-limit + attention-rest EXPONENTIAL backoff ladder in `_recordAccountOutcome` (tiered account/post/comment × early-in-run × 2^strike, 48h/24h clamps) + the clean-delivery recovery clear. A regression to a flat rest would re-submit FB logins on the one IP every 3h forever — and nothing caught it before.
- `orchestrator-intercycle.test.js` — `_interCycleMs` (cycleGapMin + jitter, else the waitInterval range, explicit-0 honored) so a regression can't make cycles fire back-to-back on the shared IP.

Verified: `node --check`; **293/293** unit + **34/34** antispam. Requires an app restart.

**Deferred (verified real, safe-by-construction, operator-held for a dedicated pass):** crash-durability (held/comment obligations lost on a hard-kill between publish and account-return — worst in two-phase); daily-cap not reconstructed by the R5 fold (crash-resume cap overshoot); Phase-3 rescue re-home durability + moderator-honors-Pause (both moderation-ON only). Full write-ups in `AUTONOMOUS-SESSION-LOG.md`.

## [1.0.70] — 2026-07-12 — Whole-app hardening sweep: 7 verified fixes across main/server/store (operator-requested)

Ran an end-to-end hardening sweep (7 finders across the less-audited surfaces — main.js's 62 IPC handlers + `execFile`, the remote HTTP API, the renderer, lib store/proxy — plus cross-cutting resource-leak and crash-resilience finders; every candidate adversarially verified with a concretely-reachable failure scenario). **Headline: the app is genuinely well-hardened** — 0 high-severity, no accumulating resource leaks (every browser/tab/CDP/timer/listener teardown already bounded), robust crash-recovery. 7 real fixes shipped (all safe-by-construction, none touch a posting/double-post/held guard, license, runtime data, or the anti-spam floors):

- **Account create/rename could silently share one Chrome profile (wrong-identity posting).** `create-account` and `rename-account` deduped on the raw display name, but two names that sanitize to the same on-disk folder (e.g. `bb 24` vs `bb.24` → `bb_24`) would share one profile + cookie jar — so one account posts under the other's Facebook identity. Now both dedup on the **sanitized on-disk key** (matching the bulk-add path), rejecting the collision. (main.js — med)
- **Remote `POST /api/posts/add` / delete returned `success:true` even when the save failed.** The two remote hooks ended their `store.update` chain with `.catch(() => {})`, so an ENOSPC or a transient data.json lock was swallowed and the API answered 200 while the post was silently lost. Now they don't swallow + pass `{ throwIfUnsaved: true }`, so a failure rejects → the route returns a truthful, retryable error (matches the bulk hook). (main.js/server.js — med)
- **`checkStatus()` was the only browser teardown with an unbounded `await browser.close()`.** A wedged probe Chromium could hang the awaiting IPC forever (import-cookies / check-status spinner never clears) and orphan the profile lock. Now bounded `Promise.race(close, 8s)` + `SIGKILL` fallback like every other teardown. (main.js — low)
- **Remote `POST /api/accounts/:name/login` spawned a real Chrome + junk profile dir for a non-existent account name.** `openLoginBrowser` now returns early for any name not in `data.accounts` (before `sanitizeProfile`/launch), so a token-bearing client or a typo can't leak browser processes + junk dirs. (main.js — low)
- **Progress-ledger corruption quarantine grew unbounded.** `loadProgress()` renamed a corrupt `daily-progress.json` to `.corrupt-<ts>` but never pruned — unlike data.json's `pruneCorrupt()`. Generalized `pruneCorrupt(file)` and call it after the progress quarantine too (keep newest 3). (lib/store.js — low)

**Renderer XSS re-audit (the ~40 `innerHTML` sites) — real sinks found + fixed.** The renderer runs privileged, so `innerHTML` executes injected `<img onerror>` / handler-breakout payloads. The two escaping helpers are `escapeHtml` (escapes `& < >` only — text-position safe) and `escapeAttr` (adds `" '` — attribute/handler safe). Fixed:
- **Two directly-exploitable `group.groupId` sinks (HIGH).** A group ID is stored verbatim when it isn't a `facebook.com/groups/…` URL, so a group added from a shared/untrusted config with an ID like `<img src=x onerror=…>` executed. `renderer.js:1951` interpolated it into a text span **fully unescaped** → now `escapeHtml`. `renderer.js:1491` interpolated it into an inline `onclick` via `escapeHtml` (which leaves `'`/`"` intact → JS-string breakout) → now `escapeAttr(JSON.stringify(...))`.
- **Account-name stored-XSS hole closed at the source.** ~16 account-card inline handlers build `onclick="fn('${account.name}')"` with the raw name. Creation charset-gates the name to `[a-zA-Z0-9_]+`, but the **rename path skipped that check** — a rename to `x');alert(1)//` would make every one of those handlers live XSS. Enforced the same `[a-zA-Z0-9_]+` gate on rename (renderer `saveEditAccount`) and — never trusting the renderer — in the **main-process** `rename-account`, `create-account`, and `add-accounts-bulk` handlers. So `account.name` is now guaranteed XSS-safe at every write path, making the whole handler cluster safe without churning 16 sites.
- **Search-box `value=""` sinks** (`post-search`, `acct-search`) used `escapeHtml` (leaves `"` → attribute breakout) → now `escapeAttr` (self-XSS defense).

Verified: `node --check`; **291/291** unit + **34/34** antispam. Requires an app restart.

## [1.0.69] — 2026-07-12 — Harden the 3 speed tiers end-to-end: close a two-phase post→link floor gap (operator-requested)

Ran a full end-to-end hardening pass on the new 3-tier speed model — 4 agents traced each tier (Safe/Fast/Max + cross-cutting) through every layer (UI → store → resolver → worker runtime timing), with every candidate gap adversarially verified. **Headline: all three tiers are correct and hardened at runtime.** Safe stays fully human (real typing, dwells, full 20s/30s floors — and its `humanizeMaster=true` force holds even when the global toggle is off); Fast pastes + skips dwells but keeps the full floors; Max never drops post→link below 1000ms (`rand(1000,3000)` floors at exactly its `lo`) and skips no correctness guard (double-post/wrong-post/held all fire identically). No tier bleeds into another.

Only one real gap surfaced (verified REAL_SHIP), now fixed:

- **Two-phase single-deferred-comment skipped the Safe/Fast post→link floor.** In two-phase (post-then-comment) mode, Phase-2's comment-to-comment cadence only fires for `d>0`, relying on "natural aging between passes" for the post→comment anti-spam gap. That holds when several comments are deferred (the first is the most-aged post), but when exactly ONE comment is deferred (a single-group account, or a run where only one group's post had a comment) that comment's post was published *last* — aged only ~5–15s. For a **Safe or Fast** account (contracted to keep the 30s comment floor) this landed the link-comment well under 30s — the exact post→instant-link pattern the floor exists to prevent. **Fix:** a new tested helper `postLinkFloorOwed(settings, publishedAt, now)` + a `publishedAt` timestamp on each deferred comment; Phase-2 now waits the shortfall so every post→link gap ≥ the tier floor. Safe-by-construction — it only ever ADDS a wait (a well-aged post owes 0; Max owes 0 by design), and touches no double-post/comment/wrong-post/held guard.
- **Fixed a stale comment** at `orchestrator.js:722` that still described the retired multiplicative pace model (`safe 2× / fast 0.5× / turbo 0.25×…`) — replaced with the current tier-select model, pointing at `lib/speed.js`.

Tests +1: `humanize.test.js` locks `postLinkFloorOwed` (Safe/Fast owe the shortfall to 30s, aged posts owe 0, Max owes 0, invalid inputs owe 0) and re-asserts the Fast-keeps-the-full-30s-floor contract. Verified: `node --check`; **291/291** unit + **34/34** antispam. Requires an app restart.

## [1.0.68] — 2026-07-12 — Quick Setup: clicking a fleet speed now visibly sets every agent (operator-requested fix)

v1.0.67 collapsed the two speed bars, but clicking a fleet speed (Safe/Fast/Max) only set the hidden baseline while every agent row still showed "⚙️ Inherit" — so nothing appeared to change. Fixed to match the operator's model: **the fleet-speed button sets everyone.**

- **Clicking a fleet tier sets the baseline AND clears all per-account overrides**, so every agent row immediately shows that speed (`qsSetSpeed` now does `qsState.pace = {}`).
- **Each agent row displays the fleet speed when it has no explicit override** (never a bare "Inherit") — `paceSelect` shows `pace || fleetSpeed`, options Safe/Fast/Max. Picking a tier on a row overrides just that agent; clicking a fleet button resets everyone.
- **Randomize now varies around whatever fleet speed is showing** — click Max → all agents Max → 🎲 Randomize → they spread to {fast, max} around Max. Exactly the requested flow.
- Removed the now-redundant "⚙️ All inherit" button (clicking the current fleet tier already resets everyone) and the dead `qsSetAllPace` helper.

On finish: an un-overridden agent inherits `settings.speedMode` (= the fleet speed you picked, same effective result); a randomized/hand-picked agent stores its explicit tier. Renderer-only; `node --check` clean, no dangling references, Electron boots clean. Requires an app restart.

## [1.0.67] — 2026-07-12 — Quick Setup: collapse the two speed bars into one + simpler Randomize (operator-requested)

The Quick Setup Review step showed TWO overlapping speed controls — "⚡ Speed (whole run)" (the fleet baseline) and "Set all: Inherit/Safe/Fast/Max" (bulk per-account). In the one-baseline model they're redundant ("set everyone to Fast" IS just "fleet = Fast, all inherit"), so the second bar was pure confusion.

- **One speed control.** Kept the fleet **"⚡ Speed (whole run): Safe / Fast / Max"** bar (the baseline every account inherits) and removed the redundant "Set all" tier bar. Per-account overrides still live in each account row's dropdown (⚙️ Inherit default), plus two compact tools folded into the one bar: **🎲 Randomize** and **⚙️ All inherit** (clear all overrides; dimmed when there are none).
- **Randomize works better.** Was: click 🎲 → reveals 3 bands (calm/mixed/bold) → pick one → randomizes (two clicks + a choice). Now it's **one click** that varies each account *around the chosen fleet baseline* — `safe→{safe,fast}`, `fast→{safe,fast,max}`, `max→{fast,max}` — so it never pushes accounts wildly off your selected speed, and there's nothing extra to pick. Removed `QS_RANDOM_BANDS`, `qsToggleRandomize`, and the `randomizeOpen` state.

Renderer-only change; `node --check` clean, no dangling references, Electron boots clean. Requires an app restart.

## [1.0.66] — 2026-07-12 — Speed-model dead-code cleanup (the deferred v1.0.65 internal polish; non-behavioral)

Removed the dead code the 3-tier consolidation left behind. All provably non-behavioral (verified by the full suite), and deliberately conservative about what NOT to touch:

- **Dead `defaultPace` fully removed.** After the collapse to one baseline + Inherit/override, the fleet-fallback `defaultPace` had zero functional readers. Deleted it from `DEFAULT_SETTINGS`, `clampSettings`, and the orchestrator's pace-label logic (which still fell back to it). The orchestrator's `_PACE_LABELS`/`_effPace` now label the real tiers (🛡️Safe/⚡Fast/🚀Max) and log only an explicit per-account override (inherit → no line, since it just follows the fleet).
- **Dead `turbo` internals removed.** `turbo` is never emitted as an internal token now (the `max` tier maps to `instant`). Deleted the unreachable `antiSpamFloors` `turbo` branch (its comment now notes the `instant`/`max` floors are used by the **rescue** path — the worker's own post/comment sites bypass them via `rand()`), and deleted the `isTurboMode` helper + its export + test (its only use was the already-removed dead post-publish-settle branch).
- **Removed the dead post-publish-settle `turbo→1200` branch** (unreachable: `instant` is caught above it; `turbo` never occurs) → the ladder is now `instant→1000 · fast→1500 · else→3000`.

**Deliberately NOT done** (judged not worth the risk/reward — stated so the decision is on record): (1) hoisting the ~20 inline `=== 'instant'` settle/gap constants into a table — they're context-specific values across Sacred timing sites, and consolidating them is marginal readability for real regression risk with no test to catch a typo; (2) removing the harmless `turbo` clause in `isFastMode` — that's the single most-called Sacred helper (65 callers), and a defensive check against a stray legacy token is worth keeping over a cosmetic trim (I tried it, the suite flagged the behavior-doc test, and I reverted it). `antiSpamFloors('instant')` itself is KEPT (live via the rescue path).

Verified: `node --check`; **290/290** unit + **34/34** antispam. Requires an app restart.

## [1.0.65] — 2026-07-12 — SPEED MODEL simplified to 3 tiers + Settings/Quick-Setup/Accounts-card unified (operator-requested)

The posting-speed model was "all over the app": TWO parallel tempo axes that didn't share names and secretly MULTIPLIED — a fleet `speedMode` (instant/turbo/fast/normal/slow) that filled absolute timing ranges, and a per-account `pace`/`defaultPace` (safe/normal/fast/turbo/instant) that scaled them. That produced the slow-vs-safe naming split, a "Fast × Fast = double-discount" (effective speed ≠ what you picked), 5 presets that were only ~3 distinct behaviors in the engine, three disagreeing copies of each tier's numbers, ~20 scattered `=== 'instant'` constants, and a dead unreachable anti-spam floor. A 4-agent mapping workflow (38 findings) diagnosed it; the operator chose **3 tiers (Safe / Fast / Max)** and **one baseline + Inherit/override**.

- **One vocabulary, one source of truth.** New `lib/speed.js` defines the 3 tiers (`safe`/`fast`/`max`), each tier's timing, and a resolver. safe = old normal+slow (full human, full floors), fast = old fast (paste, full floors), max = old turbo+instant merged (aggressive; keeps today's floor-bypass — operator's choice). `TIER_INTERNAL` maps each tier to the worker's EXISTING internal token (safe→'normal', fast→'fast', max→'instant'), so the worker's ~65 branches and the Sacred anti-spam floors are **byte-for-byte unchanged** — no 65-site rename.
- **No more compounding.** `worker.applyPace` now delegates to `resolveEffectiveSettings`: a per-account tier SELECTS that tier's per-post timing (it no longer multiplies), and cycle/stagger cadence always stays fleet-level. The double-discount bug is gone.
- **Automatic, behavior-preserving migration.** `store.normalize`/`clampSettings` migrate any legacy config on load (normal/slow→safe, fast→fast, turbo/instant→max; per-account normal→inherit). Existing installs upgrade with no data loss and identical behavior (an un-migrated `instant` config resolves exactly like `max`).
- **The three surfaces now go hand in hand.** Settings has ONE 3-button speed control (Safe/Fast/Max) as the fleet baseline; the compounding "Default account pace" dial is **deleted**. The Accounts card is Inherit-or-override (⚙️ Inherit / Safe / Fast / Max). Quick Setup uses the same 3 tiers, its per-account pace mirrors the card (with an explicit Inherit), it always writes the chosen tier's ranges (fixes "Normal didn't reset the timing"), and its random-bands were renamed (calm/mixed/bold) so they no longer collide with tier names.
- **Orchestrator** recognizes the `max` tier in its own fleet-level pacing (2 direct reads via `normalizeSpeedMode`).

Tests: rewrote the speed/pace blocks in `humanize.test.js` to the new invariants; added `tests/speed-model.test.js` (9 — migration, internal-token map, no-compounding, cadence-inheritance) and `tests/speed-migration.test.js` (2 — end-to-end legacy data.json round-trip, which caught + fixed a load-path gap where the stored `speedMode` wasn't migrated on load). Verified: `node --check`; **290/290** unit + **34/34** antispam. Requires an app restart. (Remaining internal polish, deferred: hoist the ~20 inline `instant` settle constants into the tier table + delete the now-dead unreachable floor code — non-behavioral cleanup.)

## [1.0.64] — 2026-07-12 — Apply waste-audit levers #2 + #3 (operator-approved), implemented safely

Operator approved two of the five deferred levers from the v1.0.63 audit. Both implemented in the semantics-preserving form (NOT the finder's naive form) after re-reading the control flow:

- **Lever #2 — verify-reload hover-render (worker.js:3617): flat `sleep(700)` → early-exit poll, SAME ~700ms ceiling.** When the caption match succeeds but the timestamp permalink hasn't lazy-rendered, the code hovered the node then blind-slept 700ms before one href read. Now it polls that same read (5 × ~150ms ≈ 750ms ceiling) and breaks the instant a `/posts|/permalink/` href appears — so a fast render exits in ~150–300ms (saving ~300–550ms) while a slow render still gets the full ceiling exactly as before. Safe by construction: the caption+author match ALREADY confirmed the post LIVE, so this href is only a bonus direct-comment permalink; a null result falls back to postId reconstruction / the caption-matched box (unchanged). Fires on all no-comment + all two-phase-comment posts whose href renders lazily → meaningful per-cycle time at fleet scale.
- **Lever #3 — mid-run-relogin redundant re-nav (worker.js:3014): dropped the `&& await gotoGroup()`.** On a composer-path session-expiry auto-login, success ran `if (cr === true && await gotoGroup()) { sleep(2500); recovered = true; }`. `credentialLogin` returns true ONLY after confirming the session (`c_user && xs && !onWall`) on a LOADED post-login page — that IS the connectivity proof, and the extra `gotoGroup()` nav's loaded page was discarded by the `continue` immediately below. Now `if (cr === true) { sleep(2500); recovered = true; }`: the redundant navigation (a GET on the shared IP) is gone; the **2500ms settle is KEPT** (it buffers the fresh session before the next iteration's terminal auth probe — a separately-verified KEEP). Behavior refinement: a connection drop in the tiny window after login-confirm no longer abandons the freshly-re-logged-in account as `needs_login` — the next iteration's own `gotoGroup` + navOk/offline handling retries it. No posting-safety guard touched (nothing was published on this path; `publishClicked` is false). `_pool.activeNavs` off-by-one on this ≤1/run path is immaterial to the recycle-every-N tab rotation.

The other 3 levers stay deferred (documented in `AUTONOMOUS-SESSION-LOG.md`): #1 composer-open settle (double-caption correctness role), #4 `watchEmptied` (Sacred double-comment window — silent-drop risk), #5 rescue cookie probe (wedge risk on shared-IP pacing).

Verified: `node --check`; **284/284** unit + **34/34** antispam. Requires an app restart.

## [1.0.63] — 2026-07-12 — Posting-flow waste audit: trim two provably-safe micro-wastes (operator-requested "nothing wasted")

Ran a 6-slice adversarial waste audit of the whole posting flow (composer→publish, publish-confirm/capture, browser-lifecycle/recovery, comment path, orchestrator pacing, Phase-3/4 launch) — 16 agents, each candidate independently refuted by an adversarial safety skeptic before acceptance. **Headline: the flow is already tightly calculated.** Of 10 candidates, **8 were load-bearing** (deliberate anti-detection jitter, async-render settles feeding safety checks, control-flow gates, or anti-burst spacing on the single IP) and only **2 were provably pure waste**. Shipped only the 2:

- **worker.js:3083 — caption-commit sleep trimmed 300→150ms (fast/turbo only).** After `Input.insertText` in the paste path, a fixed 300ms "let React commit" sleep sat directly in front of `verifyCaptionLanded`, which reads-first then polls every 150ms up to an **unchanged** 3000ms deadline on a positive prefix-match. So the pre-sleep was redundant pre-read latency: 150ms now gives one poll-interval of commit headroom and the poller (deadline unchanged) absorbs any late commit. Cannot mis-verify (marked/prefix-match path only confirms on our actual caption). Saves ~150ms × 1–3 caption entries per post in fast/turbo. Instant (60ms) unchanged.
- **worker.js:3240 — redundant Post-button diagnostic scan gated out in the speed tiers.** A `page.evaluate` DOM scan that runs after the button-enable `waitForFunction` gate and before `clickPostButton` (which re-scans), feeding ONLY a log line — the code's own comment calls it "a REDUNDANT 3rd scan … it gates nothing (only logs)." It was already skipped at `instant`; now skipped for all of `isFastMode` (fast/turbo/instant/humanize-off) where the operator chose speed, while normal/safe keep it. On a genuine miss the `clickPostButton` failure path still fires (incl. the 2-in-a-row unsupported-language flag); the full enabled-buttons enumeration is available in normal/safe or via `scripts/inspect-fb.js`. Saves ~1 CDP round-trip (~10–60ms) per post in the speed tiers; no FB action, zero ban-budget impact.

**Deliberately NOT shipped (5 speed⇄ban levers — real but tightening shifts LIVE-FB timing/pacing; need operator validation):** (1) composer-open settle fast 500→~200ms — has a Lexical handler-attach correctness role (a miss routes to the double-caption-prone re-entry path); (2) verify-reload hover-render fixed 700ms → early-exit poll (keep the 700 ceiling) — tightens per-account cadence on a shared IP; (3) mid-run-relogin `gotoGroup` re-nav — a control-flow gate + weak connectivity probe, ≤1/run; (4) `watchEmptied` sleep-first 1s → check-first 250ms — **Sacred (double-comment confirm window)**; its `GONE` branch means an early read in FB's volatile post-Enter render could false-confirm → silently drop the link-comment; (5) rescue.js 2.5s cookie probe → poll — the `page.cookies()` call is wedge-prone under 20+ Chromes and the sleep also paces the fleet's riskiest action (deep-link comment) on the shared IP. Full write-ups (with the adversarial refutation for each) are in `AUTONOMOUS-SESSION-LOG.md`.

Verified: `node --check`; **284/284** unit + **34/34** antispam. Requires an app restart.

## [1.0.62] — 2026-07-12 — BATCH-PER-IP: run up to `realIpMaxConcurrent` accounts on EACH exit IP (real or proxy), unified (operator-requested)

Follows v1.0.61. The operator wants a proxy IP to work like the real IP does — a **batch** of accounts, not one-at-a-time. Previously the anti-link gate ran **exactly one** account per proxy IP (a boolean `inFlightIps` Set), while the shared real IP ran up to `realIpMaxConcurrent` (default 3). Now the rule is **unified for every exit IP, real or proxy**: each IP runs up to `realIpMaxConcurrent` accounts concurrently (a "batch"), and never more.

- **Gate.** `inFlightIps` changed from a boolean `Set` to a per-IP **count** `Map` (ipKey → # in flight); `launchNext` launches an account only while its IP's count `< realIpMaxConcurrent`, increments on launch, decrements on completion.
- **Keying.** `ipKey` now returns a SHARED `'ip:__real__'` key for no-proxy (real-IP) accounts (was `null`), so the one home line is batch-counted exactly like a proxy IP. Proxy IPs still key on the exit **host** (v1.0.61), so same-IP/different-port entries share one batch.
- **Ceiling.** Max concurrency = **(distinct exit IPs) × `realIpMaxConcurrent`**, still min'd with `parallelAccounts` + the hardware ceiling. No-proxy case is **unchanged** (1 IP × 3 = 3 — the current run is not affected); the proxy case now scales to (IPs × 3) instead of (IPs × 1).
- **Pacing fix (required by the keying change).** Two pacing branches used `ipKey`/`!ipKey` as the real-vs-proxy discriminator; since `ipKey` is now truthy for BOTH, that would have misrouted them. Switched both to `proxyForAccount(account)` (computed once as `_isProxied`): proxy accounts still get the initial-fill stagger, real-IP accounts still get the `_lastRealIpLaunchAt` launch throttle — behavior preserved exactly.
- **Tunable / reversible.** Set **Settings → "Max browsers at once on one IP" = 1** to restore strict one-account-per-IP anti-link. This is a speed⇄correlation lever: more simultaneous FB sessions from one IP is a stronger correlation signal, so the operator owns the tradeoff.
- **Tests.** `orchestrator-ip-affinity.test.js` rewritten for the batch cap (three accounts on one IP + cap 2 → at most 2 concurrent on it, and it DOES reach 2, not serialize to 1). `orchestrator-ip-affinity-port.test.js` now pins `realIpMaxConcurrent=1` to prove strict mode + host-based keying together.

Verified: `node --check`; **284/284** unit + **34/34** antispam. Requires an app restart to take effect.

## [1.0.61] — 2026-07-12 — HARDEN the proxy anti-link gate: serialize on the exit IP, not the proxy string (operator-requested)

The anti-link concurrency gate (never run two accounts from the SAME IP at once — FB links accounts seen simultaneously on one IP) keyed on the FULL proxy STRING. So two entries that share ONE exit IP but differ in port/auth (common with residential providers' rotating ports on one IP) got distinct keys and could run on that IP **concurrently** = the IP effectively "duplicated" across two accounts. Now the gate keys on the exit **host/IP** (via `parseProxy`'s new `host` field), so all entries sharing an IP serialize to one account at a time regardless of port/auth; a domain host keys on the domain (each a distinct exit); an unparseable string falls back to itself (still gated).

This also **corrects the concurrency ceiling** to count DISTINCT exit IPs (not distinct proxy strings), so browser concurrency = the number of real exit IPs, never over-counting. No-proxy fleets are unaffected (real-IP accounts remain gated only by the `realIpMaxConcurrent` cap). Added `host` to `parseProxy`; keyed `ipKey` on it; new test `tests/orchestrator-ip-affinity-port.test.js` (same-IP/different-port accounts serialize).

Verified: `node --check`; **284/284** unit + **34/34** antispam. Requires an app restart to take effect (proxy path only — no impact on the current no-proxy run).

## [1.0.60] — 2026-07-12 — Default the per-IP post gap to 15s (anti-burst hardening for one shared IP; operator-requested)

`realIpMinPostGapSec` default changed **0 → 15**: a fresh no-proxy config now spaces the whole fleet's posts ≥15s apart on the one shared IP by default — a small anti-burst hardening that barely slows a 3-browser run (the recommended "mostly work with 3" setup) — instead of off. Still fully tunable in **Settings → "Min seconds between posts on your IP"** (0 = off for max speed). Concurrency default (`realIpMaxConcurrent`) kept at **3**. **NOTE:** an EXISTING data.json that already has a saved `realIpMinPostGapSec` (e.g. the operator's `0`) is NOT retroactively changed — set it to 15 in Settings + Save to activate. Updated `DEFAULT_SETTINGS` + `clampSettings` + the renderer load/save default + the UI field value/help text.

Verified: `node --check`; **283/283** unit + **34/34** antispam. Requires an app restart.

## [1.0.59] — 2026-07-12 — Expose the per-IP concurrent-browser cap as a Settings field (operator-requested)

The number of browsers posting AT ONCE on a no-proxy shared IP was governed by a HIDDEN setting (`realIpMaxConcurrent`, read with a `||3` fallback, never surfaced in the UI) — so "Parallel accounts" was silently clamped to 3 on one IP with no visible control (you saw 3 browsers and couldn't find where to change it). Now exposed as **Settings → "Max browsers at once on one IP"** (default **3**, range **1–8**). The effective concurrency is `min(parallelAccounts, this)`, so raising both increases posting SPEED at more ban risk (more simultaneous FB sessions from one line is a stronger spam/correlation signal); it self-limits on free RAM (~300–500 MB per browser). Enforced 1–8 at three layers (HTML input, `clampSettings`, and the orchestrator's read-time clamp — unchanged). Added to `DEFAULT_SETTINGS` + `clampSettings` + renderer load/save.

Verified: `node --check`; **283/283** unit + **34/34** antispam. Requires an app restart.

## [1.0.58] — 2026-07-12 — FIX Phase-4 double-post on auto-released held posts (P-0, operator-approved)

The one High-confidence Sacred risk from the deep audit, now fixed (operator-approved for live validation). A post FB HELD in "Spam potentiel" that FB later AUTO-RELEASES (~60 min) sits deep in the CHRONOLOGICAL feed; Phase-4's liveness feed-scan reads only the first 60 articles (`repost.js:133`), missed it, returned `'absent'`, and a reserve RE-POSTED the already-public original = a duplicate (cap-1 bounded, but recurred per held-then-released post in busy groups).

Fix (`worker.js`, the `pending_at_publish` held record): persist the gid-scoped **create-story URL** (`_netPost.url` — the ALLOWED capture, NOT the banned story_fbid/post_id field) onto the held record, so Phase-4's **permalink-direct** liveness check (`repost.js:91`) reaches the post regardless of feed depth → confirms it live → does NOT re-post. **NULL-safe:** if FB exposes no URL for a held post, the record stays `null` = prior feed-scan behavior (zero regression). The only two other held-record sites (`comment_notfound`) already persisted the captured permalink; this closes the last one. Added a diagnostic log at hold time so the operator can see, live, whether the URL was captured (the P-0 efficacy signal).

Verified: `node --check`; **283/283** unit + **34/34** antispam. **LIVE VALIDATION IN PROGRESS** — confirm on a held-then-auto-released post that the log shows the captured URL and NO duplicate re-post appears.

## [1.0.57] — 2026-07-12 — FIX a v1.0.54 regression: genuine login on FB's save-device prompt mis-flagged needs_login

The P6 adversarial review of this session's stacked changes (v1.0.53–56) found the whole stack **substantially clean** — every cross-change interaction verified safe (offline-gate × backoff, reserve-eligibility × launch-throttle, C1 × busy-guard, attnStrikes/rlStrikes mutual exclusion; no double-post / wrong-post / compounding false-stop) — EXCEPT one regression introduced in v1.0.54:

- **save-device gate hole (fixed).** The v1.0.54 credential-login success gate (`c_user AND xs AND !onWall`) treated FB's post-auth "Save your login info?" interstitial (`/login/save-device`, `/login/device-based`) as a login WALL because its URL contains `/login/`. A GENUINE fully-authed login (c_user AND xs both set) that parks there → `return false` → false `needs_login` → the healthy account is benched ~3h + a reserve is spent + a false alarm. It self-heals (the on-disk profile keeps the session; Tier-1 recovers it next cycle), but it's a real false-stop inside the recovery path. Now those two specific post-auth prompts are treated as SUCCESS when `_hasSession` (requires `xs`, so it CANNOT resurrect the false-success cases the gate guards — a 2FA/checkpoint withholds `xs`; a lingering `c_user` has no valid `xs`).
- **Doc accuracy.** Softened the `realIpMinPostGapSec` / `_ipPostGate` comments (v1.0.55): the gate spaces INTER-GROUP posts fleet-wide; each account's first post is spaced by the launch throttle (~15–45s), so a cap up to ~45s is fully covered and larger values bound the sustained rate. (Non-blocking; the feature is default-off.)
- **Tests +6.** `tests/write-atomic.test.js` for `store.writeFileAtomic` (the atomic-write primitive behind data.json/cookies/moderation/comments): exact round-trip, atomic replace of prior content, large-payload write-loop. `tests/plan-daykey.test.js` for `plan.localDayKey`/`dayLabel` (the LOCAL day-bucketing that governs the daily-rotation/campaign "one per day" boundary): key format + relative-label boundaries across month rollover.
- **P7 audit (renderer settings round-trip + app lifecycle) — verified CLEAN.** The 30 settings inputs load↔collect 1:1 (matching ids, safe fallbacks); keys without a form control are preserved via the `...appData.settings` spread — no safety setting can be silently dropped/reset/flipped. Lifecycle (single-instance lock, idempotent resume + `--autostart` daily fire, mutually exclusive, `orchestrator.start` synchronously idempotent) can't double-start or fire unintentionally.
- **Arabic classifier coverage (`tests/fb-detection-arabic.test.js`).** The rate-limit/checkpoint/pending classifiers carry hamza-free Arabic patterns (for the operator's Moroccan fleet) but had ZERO test coverage — a silent break would let an Arabic-locale account post into an undetected block. Now pinned (positive matches + benign-text false-positive guards). (Noted, not shipped: the secondary `hasEnabledPost` probe inside `waitForPublish` matches only `post`/`publier` — a safe-direction Arabic-label addition is possible but it touches the Sacred publish-confirm path, so it's left for review.)
- **`tests/normalize-account.test.js`** — the DI-3/DI-4 data-integrity coercions (`store.normalize`/`normalizeAccount`): a NaN/string/negative daily.count can't disable/skew the cap, a malformed date can't freeze it, a corrupt far-future `rateLimitedUntil`/`nextAttnRetry` can't block an account forever, and strike counters (incl. v1.0.53 `attnStrikes`) floor to a non-negative integer.
- **`VALIDATION.md`** — a prioritized live-FB validation runbook (trigger / PASS / FAIL-rollback per change) for the whole v1.0.53–57 stack + the P-0 patch, so the owed validation is fast and safe.
- **`scripts/readiness.js`** (read-only diagnostic, not packaged) — added a per-group reserve-coverage check (campaign-plan: warns pre-run about any active group with no reserve assigned = an uncovered limit/logout) and an auth-recovery check (not-logged-in accounts with neither cookies nor credentials = permanently stuck).

Verified: `node --check`; **283/283** unit (+25 this session, 9 new test files) + **34/34** antispam. Requires an app restart.

## [1.0.56] — 2026-07-12 — Autonomous hardening: deep-audit safe fixes + test coverage

Deep 5-lens adversarial audit of the mature codebase (autonomous session). The core posting/comment/campaign engine and the store/IPC/security/leak surfaces were confirmed CLEAN (no wrong-outcome trace); effort concentrated on the two previously un-audited Sacred surfaces (moderator approval, Phase-4 re-post) + support code. Shipped the safe-by-construction fixes below; Sacred-risky findings (Phase-4 double-post via null permalink; moderator confirm-by-detachment + caption-only fail-open) are written up as ready-to-apply proposals in `AUTONOMOUS-SESSION-LOG.md` for review (they touch the double-post path / need live-FB validation).

- **C1** (correctness) main.js `checkStatus` used a stale LOCAL `normalizeCookie` missing INV-25 (`secure:true` for `sameSite:'None'`) → dropped xs/c_user on a minimal jar → false "not logged in" → a needless real-IP auto-login on the shared line. Deleted the local copy; routed the last caller to the tested single source `store.normalizeCookie`.
- **S3** (Sacred guard-strengthen) moderator.js — length-gated the reverse-substring author-match so a short stranger token ("ali") can't pass the wrong-approve veto as a substring of our display name ("ali baba store").
- **L2** (leak) server.js `GET /api/posts` returned absolute on-disk image paths (OS username + userData layout); now basename only (the `/images/<name>` route + the consumer already use basename).
- **L1** (leak) main.js — masked the `c_user` FB UID in the tunnel-reachable log stream.
- **R1** (reliability) lib/proxy.js — looped the `writeSync` so a short write can't torn-write proxy-health.json.
- **Tests +12** (5 new files, pure additions, zero production change): `store.sanitizeName` (path isolation + documented collision), `store.updateComments`/`updateModeration` serialization + `blank()` fresh-settings, `geo.detectProxyGeo` fail-safe + `CC_LOCALE` well-formedness, `imageVary.varyImage` determinism + hash-shift, `chromium.findSystemBrowser` null-or-real invariant.

Verified: `node --check`; **270/270** unit (was 258) + **34/34** antispam. No live-FB validation needed for these fixes. Requires an app restart.

## [1.0.55] — 2026-07-12 — HARDEN single-IP pacing/concurrency: cap-bypass + opt-in per-IP rate ceiling

Adversarial workflow audit (wf_cd271ed4) of how 28 accounts share ONE no-proxy residential IP — the existential ban surface. **The model is already largely sound** (verified SAFE: the ≤3-concurrent cap holds on every automation launch path; the reserve-takeover pool inherits the cap AND the launch throttle via the carried-over launchIdx; phase boundaries are true barriers so no secondary phase overlaps Phase-1; per-account cadence is de-clustered; login/session-start rate is bounded; no two cycles overlap). Three fixes:

- **#1 (cap-bypass, gap) — "Check account status" refused mid-run.** `check-account-status` (main.js) and the post-cookie-import verification both open a NO-proxy real-IP FB browser (`checkStatus`) that ignores the pool's `_realIpMax` cap — while their siblings (`openLoginBrowser`, `check-account-memberships`) both guard on `isRunning()`. So clicking Check during a run added a 4th+ concurrent session on the shared IP. Now guarded (returns a `busy` flag; the renderer short-circuits so it doesn't misread the refusal as logged-out and fire an auto-login; cookie-import still imports, just defers the verification).
- **#2 (opt-in per-IP aggregate rate ceiling) — NEW setting `realIpMinPostGapSec` (default 0 = OFF).** Today nothing bounds total posts/hr FROM THE IP — only per-account pacing + the 3-concurrent cap (≈40 posts/hr at default speed, higher on instant). New orchestrator-owned `_ipPostGate()` reserves each real-IP post on a shared timestamp (same race-free idiom as the launch throttle) so no two posts across the whole fleet land closer than the configured minimum (effective inter-group gap = `max(configured, per-IP min)`); no-proxy fleets only, only ever slows, never touches double-post/coverage. Default 0 = zero behavior change; set it in Settings ("Min seconds between posts on your IP") to cap the fleet's aggregate rate after watching live. New UI field + load/save + `store.normalize` clamp (0..3600).
- **#3 (burst-timing, gap) — unified real-IP launch spacing.** The initial fill's first ~3 real-IP sessions started 1–5s apart (instant), tighter than the code's own 5–13s steady-state throttle and skipping the shared `_lastRealIpLaunchAt` — a repeating micro-burst at each cycle start. Real-IP launches now ALL go through the one throttle (the per-account initial-fill stagger is proxy-only), so onsets space evenly; `myLaunch=0` still starts immediately.

Two items left as conscious TUNING (operator declined for now): a diurnal/quiet-hours window (residential IP posting at 4am is a signature — usable today via `scheduleMode:'daily'`), and the cycle-wave duty cycle (flattens automatically if #2 is enabled). Verified: `node --check` (worker/orchestrator/store/main/renderer); **258/258** unit + **34/34** antispam (added 3 `_ipPostGate` assertions: off no-op, ~30s spacing, proxied no-op). No live-FB validation yet. Requires an app restart.

## [1.0.54] — 2026-07-12 — HARDEN auth path: offline/cookie-wedge false-logout + login-submit ban-hygiene (single IP)

Adversarial workflow audit (wf_0ffa239e) of the login / Tier-3 auto-login / checkpoint / cookie path, scoped to the operator's single no-proxy residential IP where every extra FB login-form submit is a ban signal. **No Sacred finding** — the path can't mint a false auth-success (wrong-post/double-post), and offline is never misclassified as a checkpoint; the audit also confirmed no per-IP login burst is possible (`realIpMax`=3 + the 15–45s launch stagger already drip-feed starts). Five robustness/ban-hygiene fixes:

- **R1 — offline guard on the auth bootstrap.** A transient network blip during the `facebook.com`/`/login` nav cascaded all three auth tiers to failure → false `needs_login` (which the v1.0.53 backoff then sidelines) + a doomed login-form submit on the shared IP. Now, before attempting Tier-3 login, if `isOnline()` is false it returns `{offline:true}` → the orchestrator HOLDS the pool and leaves the account untouched (mirrors the mid-loop 2864 / posted-nothing 3931 guards).
- **R2 — cookie-read timeout no longer reads as "logged out."** Tier-1/Tier-2 used a `[]` default for a timed-out `page.cookies()`, so a wedged CDP `getCookies` under host load (20+ Chrome instances) demoted a genuinely logged-in account → a needless `/login` submit *while online* (which R1 can't catch). Switched to a `null` sentinel that only demotes on a real cookie array lacking `c_user` — matching the run-end persist (~3941), which already refuses to act on a `cookies()` timeout.
- **C1 — credential-login success gate tightened.** Success was `c_user` present ALONE, so a Tier-2-injected/lingering `c_user` (or a checkpoint that withholds `xs`) could return a false "recovered" → `writeCookies` clobbered the good jar with a dead/partial one → silent every-cycle failure. Now requires `c_user` AND `xs` AND not-on-a-login/checkpoint-wall (mirrors Tier 1/2 + the run-end persist).
- **C1-companion — language-independent checkpoint detection.** A login that sets `c_user` but withholds `xs` (off-wall) is a 2FA/identity challenge whatever the page language; now routed to `checkpoint` (→ `needs_verification`: operator notified + no auto-retry into the wall) instead of a mis-flagged `needs_login`. More robust than adding localized text tokens (rejected: FB's own footer contains "sécurité"/"vérification", which would false-fire a checkpoint on a successful FR-locale login).
- **F1 — no repeat login submit on a definitive rejection.** `credentialLogin` retried MAX=2 on ANY failure, so a wrong-password / "unusual activity" lock / "temporarily blocked" (positively detected as still-on-/login with FB's error rendered, EN/FR/AR) fired a 2nd guaranteed-to-fail submit on the shared IP. Now returns a `'rejected'` sentinel → no retry; a NON-positive/ambiguous failure (nav didn't complete, form never rendered) still returns plain `false` and still retries once, so transient recovery is preserved.

R1/R2/C1-core are pure added guards; C1-companion + F1 are classification/retry-behavior changes the operator explicitly approved. Verified: `node --check`; **258/258** unit + **31/31** antispam (these auth paths need a live Puppeteer page so they're guard-logic-reviewed, not unit-covered — no regression in the existing suites). No live-FB validation yet. Requires an app restart.

## [1.0.53] — 2026-07-12 — HARDEN limit/logout failover: sideline hygiene + login-retry backoff

An adversarial workflow audit of the LIMIT/LOGOUT → reserve-takeover → work-completion path (campaign-plan mode). The core failover is already correct — a mid-delivery limit/logout records its un-reached groups as OWED (no lost work, no double-post), and a recovered account can't collide with the reserve that covered it (verified behind the pointer/icommit + owed-reconcile + `onlyGroups` + rescue `checkExisting` guards). The one Sacred double-post candidate raised was disproven (a reconfigured standby hits `_postsForAccount`'s `if (!listIds.length) return []` before the owed override). What remained were four robustness/visibility gaps, all fixed here — none weaken any double-post/comment/wrong-post guard:

- **R1 — reserve roles now respect the soft-rest timer.** All five reserve/rescue/repost eligibility predicates gated on `status`+`rateLimitedUntil` but not `nextAttnRetry`, so a just-logged-out/likely-blocked account (soft-rested, `status` still logged-in for unattended Tier-3 auto-login) could still be pulled in as a takeover reserve / comment-rescuer / re-poster — a wasted browser launch on the one shared IP (and a login-form re-submit on the Phase-4 path), plus it masked the "no healthy reserve" coverage warning. Added `&& (Number(nextAttnRetry)||0) <= now` to all five.
- **R2 — logged-out/blocked login retry now BACKS OFF instead of re-hammering.** The attention-rest was a FLAT 3h with no strike ladder, so a permanently-dead account re-submitted the FB login form on the single Moroccan IP every 3h forever. Now it mirrors the rate-limit ladder: exponential `attnStrikes` backoff (3h→6h→12h→24h, capped 24h), so a genuinely-broken account decays to ~once/day while a transient logout still self-recovers on its short first-strike window. `attnStrikes` persists across rest-window expiries (that's what escalates it) and clears on any clean delivery. New field sanitized in `store.normalize` + preserved as a RUNTIME field in main.js.
- **R3 — split-cover takeover no longer drops a second reserve.** When an owed agent's un-reached groups need TWO reserves (no single member covers all), `maxTakeover` counted the agent as 1 and the probe break dropped the 2nd → those groups slipped a cycle (self-healing, never lost). The probe cap now admits every already-assigned split-cover reserve (disjoint `onlyGroups` → no double-post).
- **M1 — operator now sees uncovered owed groups.** An active campaign agent that partial-delivers with no reserve to finish it carried its owed groups silently. Now logs a throttled (once/agent/run) "N groups un-reached, no reserve — carried to next cycle; add/warm a reserve" warning.

Verified: `node --check` (orchestrator/store/main); **258/258** unit + **31/31** antispam (added 4 focused R2 backoff-ladder assertions: strike increment, per-strike growth, clean-delivery clear, 24h cap). No live-FB validation yet. Requires an app restart.

## [1.0.52] — 2026-07-12 — HARDEN rescue: pre-comment idempotency (no cross-account double-comment)

The reserve/rescue path re-comments a post's link via a DIFFERENT account with no check whether the link is already there — so if the original account's comment actually landed but was mis-reported (a lost-ack `'unplaced'`; and recent changes route more cases to reserves), the reserve placed a real SECOND copy = double-comment. Now `addFirstComment` takes a gated `checkExisting` flag (ONLY the rescue caller passes it → a first-time comment never scans → never false-skips): before typing, it scans OUR post's scope (scheme-agnostic, path-unique ≥12-char key, excludes the composer box) for our link; if already present → returns `'already_present'` → rescue records it done and does NOT re-comment. Best-effort by nature (a collapsed "View more comments" thread or a bare preview-card render can hide the original's comment → the scan can't see it), but it closes the common case (link shown as text on a fresh post) with negligible false-skip risk. Verified: `node --check`; **258/258 + 27/27**. Requires an app restart.

## [1.0.51] — 2026-07-12 — HARDEN publish path: wrong-group guard + false-published/false-early fixes (Sacred)

Three deferred publish-path gaps, designed against the current code by a workflow + adversarially stress-tested for false-published / false-timeout(→double) / wrong-group before ship:

- **Wrong-group guard (#6):** the pre-publish drift guard only checked `/groups/` (ANY group) — a stray popup-follow / redirect onto a DIFFERENT group would publish your identical caption there. Now: the resolved group segment (numeric id OR the vanity slug FB 302'd to) is captured on first landing, and asserted equal before publishing; a mismatch throws a `transient:` error → the pre-publish retry re-navigates to the correct group + opens a fresh composer. Fires strictly BEFORE the Post click (`publishClicked` false) → zero double-post; degrades to the old any-`/groups/` check when no segment was captured. Both numeric-gid and vanity-slug groups still post unchanged.
- **False-`published` from a popup collapse (#2):** the publish confirm counted composer-like dialogs — a Messenger/notification popup (has a textbox) collapsing mid-wait dropped the count → a post counted delivered that never sent (silent loss). Now `published` ALSO requires OUR tagged composer shell (`data-zp-composer`, set on the outer dialog at Post-click — survives the editor re-mount) to be gone. STRICTLY narrower than before (a subset of today's published-set) → it can never *add* a false-published, only removes the popup-collapse one; byte-identical when the tag is absent. Same gate applied to the timeout dialog-closed fallback.
- **False-early `submitted` (#5):** a moderated group's "will be reviewed / sera examiné" banner rendered INSIDE the composer matched the submitted-phrase scan → an early false `published`. The scan now excludes the open composer (like the two sibling scanners) — reads pending/error only from separate toasts; the authoritative dialog-close still confirms a real held publish.

Verified: `node --check`; **258/258 + 27/27**. Requires an app restart. Test plan: a numeric-gid group + a vanity-slug group (both post), a moderated group (held→moderator, not lost), and — if reproducible — a Messenger popup open during a publish.

## [1.0.50] — 2026-07-11 — HARDEN red-text limits: immediate detection + stop-on-any-limit + speed backoff (Sacred)

"Hard solve" the FB limit walls (login / account-block / post-limit / comment-limit). Workflow-designed, then 4 adversarial review passes that caught + closed 2 double-risks and a false-positive class before ship.

**Immediate detection.** New `classifyWallScoped(page)` — the ONE classifier: scans notice surfaces ([role=alert]/[role=status]/[role=dialog]) EXCLUDING feed articles + the open composer/box (so a neighbor's feed post or OUR caption/comment can't trip it), NFD-normalized multi-locale, + structural login (/login URL or a visible email+pass) and checkpoint (url/captcha). Folded into `waitForPublish`'s poll → a red-text wall is caught in ~1–2s instead of waiting out the 70s ceiling; and a comment-wall pre-check runs right after Enter instead of after ~10–14s of re-press/send-button gestures.

**Stop on ANY limit (operator policy).** login→needs_login, checkpoint→needs_verification, account/post/comment-limit→stop the account (was: comment-limit kept posting). Remaining groups + comments route to reserves; nothing lost.

**Speed backoff.** A limit that hits EARLY in the run rests the account longer (1st action → 2×, first quarter → 1.5×); comment-limit now rests like a posting-limit; still capped 48h. Also fixed GAP-6: an account block after a successful publish was cooled at the short post-tier (no `rlKind`) → now correctly 3×.

**Double-post/comment safety (the load-bearing part):**
- A rate/block wall does NOT prove the post didn't commit — so `blocked_account`/`blocked_post` route through the SAME landing-confirmation the timeout path uses (create-story id + feed-rescan): a committed-but-walled post is markDelivered (never re-posted by a reserve); a genuinely-absent one is reserved. login/checkpoint stop directly (can't publish logged-out/checkpointed).
- Comment pre-check returns a non-landed stop ONLY when the box PROVABLY still holds our full text AND is still `isConnected` (a detached box reads stale text → no longer mislabels a landed comment as unplaced).
- Legacy `classifyRateLimit`/`checkVerification`/emergingBlock scans were whole-`body.innerText` on the HEALTHY pre-post + post-success paths → a feed neighbor's "action blocked" post or our own caption (esp. the everyday Arabic word محظور) could FALSELY stop a healthy account. Now scoped to notice surfaces, with a whole-body fallback ONLY on a genuine full-page block.

Verified: `node --check`; **258/258 + 27/27**; final adversarial pass confirms no reachable double-post / lost-post / silent-wall-swallow. Requires an app restart.

## [1.0.49] — 2026-07-11 — SPEED: tighter instant inter-group gap (0.5–1.8s → 0.1–1s)

Operator-requested: the pause between groups in INSTANT mode was `rand(500,1800)` (0.5–1.8s); the next group already pre-loads during it, so it's pure anti-spam pacing. Trimmed to `rand(100,1000)` (0.1–1s) at both sites (the normal path and the held-continue path), keeping a ~100ms floor + jitter so it's never a literal-0, metronomic bot tell on a single IP. ⚠️ Faster group-switching is more detectable — dial back up if blocks appear. Verified: `node --check`; **258/258 + 27/27**. Requires an app restart.

## [1.0.48] — 2026-07-11 — Phase-1 SPEED (adaptive capture + caption) + HARDEN (false account-stops)

Measured Phase-1 (INSTANT, image posts): ~19s/group, dominated by the post-click→confirmed window (~9.7s, incl. a ~3s capture wait that is ALWAYS wasted for these posts) and the caption paste (~4.1s). Four safe speed/hardening changes (workflow-designed, adversarially verified — both retained edits confirmed KEEP):

**Speed:**
- **Adaptive capture wait:** a per-account empty-capture streak (`_capMiss`) — once the create-story URL has failed to arrive 2× in a row (this operator: every post), the finalize wait drops from ~3s to ~0.45s. **~2.5s/group saved from group 3 on.** Any real hit instantly restores the full wait; Phase 2's feed-scan targets the post regardless.
- **Caption paste (~0.75s):** removed a redundant back-to-back `focusEditable` (clearEditable already focuses+marks the editor) and trimmed the seed's instant pre-insert settle 250→100ms (it stacked on the re-focus's own settle). The caption-less + draft-publish guards are untouched.

**Harden (both stop a HEALTHY account being falsely killed on a slow residential IP):**
- **Disabled-Post-button = transient, not "unsupported language":** on a slow IP the image finishes uploading server-side after the local preview renders, and FB keeps Post `aria-disabled` past the 8s enable-wait → today the group is dropped and 2-in-a-row falsely flags `likely_blocked` and stops the account. Now: if a Post button is present but still disabled, throw a `transient:` error → the `!publishClicked` retry re-opens a fresh composer (zero double-post) instead of the false stop. Only a genuinely absent button takes the language path.
- **`sawCreate` slow-publish ≠ throttle:** a `timeout` where FB's create-story response DID arrive (just no URL) is almost certainly a slow success — it no longer counts toward the `consecPubTimeouts` account-stop streak (still not flipped to 'published' — the body could be a reject).

**Fix:** the "NOT yet feed-confirmed … a no-comment post has nothing to auto-detect it" warning no longer misfires on comment posts (Phase 2 detects their held state); only genuine no-comment posts get it.

Verified: `node --check`; **258/258 + 27/27**; the transient throw is confirmed to route through the existing `publishClicked`-guarded retry. Requires an app restart. Deferred to a tested follow-up (touch the publish-confirm/guard path — verify on moderated groups): confirm-publish by the marked composer node vs a dialog count, exclude the open composer from the "submitted"-phrase scan, and a same-group-segment assertion at the pre-publish drift guard.

## [1.0.47] — 2026-07-11 — Note 2 (async-verify = skip the redundant inline reload) default-on + gap-closers

**Note 2 — non-blocking post-verify.** The operator's ask ("keep posting while the land/held check runs in the background") is already what Phase 2 does — it overlaps the remaining posting with the find/land/held check (on warm reused tabs after 1.0.46). So the ~4s/group Phase-1 verify-reload is redundant for two-phase COMMENT posts, and the existing `skipInlineVerify` setting already skips exactly that. Flipped it **default-on**: `DEFAULT_SETTINGS.skipInlineVerify=true` + a one-time `normalize()` migration that flips a stale persisted `false` (the old opt-in default — nobody deliberately opted *out* of an opt-in) to true, with a `sivMigrated` marker so a later deliberate toggle is preserved. The true async-background-tab approach was rejected (would force `markDelivered` onto the double-post guard, add concurrent FB loads on one IP, and could strand a held bare post) — bare/pending posts keep the synchronous reload; only two-phase comment posts skip it, and Phase 2 still routes held → moderator. `markDelivered` stays synchronous → double-post guard untouched.

**Gap-closers (from the Note-1 review):**
- Fixed a `_pool.live` over-count: `_dropPrefetch`'s stale-phase branch closed a tab without decrementing `live` (would leave Phase 2 under-provisioned after a skip-during-prefetch).
- Removed the now-dead `_closePrefetch` (replaced by `_endPostPhase` in 1.0.46).

Verified: `node --check`; **258/258** (added a migration test) **+ 27/27**. Requires an app restart. On first load your stale `skipInlineVerify:false` migrates to on automatically.

## [1.0.46] — 2026-07-11 — PERF: keep the tab pool across the post→comment boundary (reuse, not close+reopen)

The post→comment (Phase-1→Phase-2) boundary called `_closePrefetch()`, which **closed every idle pool tab and reset `live=1`** — so Phase 2 rebuilt the multi-tab pool from scratch (N tab closes + N `newPage()`s per account). New `_endPostPhase()` **keeps** the idle pool (`_pool.free` + `live`) across the boundary so Phase 2 **reuses** Phase-1's warm tabs; it only settles the in-flight group-prefetches back into the pool and bumps `epoch` (so `_dropPrefetch`'s stale-phase guard still fires). Recycle-every-12 still applies per tab, `_reapOrphans` still bounds the count, and the guaranteed `browser.close()` at account end reaps whatever's left (no leak). No-op at `tabsPerBrowser=1`.

Adversarially verified (2 lenses): no tab leak past account end, no pool over-grow (any `live` drift is toward over-count → Phase 2 under-provisions, perf-only, self-limited), and no wrong-group/double — Phase 2's comment path re-navigates any reused tab whose live URL isn't `/groups/<gid>` before scanning, so tab provenance is irrelevant to correctness. Verified: `node --check`; **257/257 + 27/27**. Requires an app restart.

## [1.0.45] — 2026-07-11 — RETIRE the Phase-2 permalink path for identical-caption setups (feed-scan primary)

Decision after the wrong-post incident: the operator posts an IDENTICAL caption + the SAME account to every group, so neither caption nor author can disambiguate our posts — **only the post id can**. The permalink-page comment path (added in 1.0.42) trusted the caption whenever the page didn't expose the id (common: FB often returns id=? so `expectedPostId` is null), and produced double / miss / wrong-post over three runs. A parallel investigation confirmed the tab pool is NOT the bug and that the id-anchored guards self-heal — but ONLY when a clean FB id is present; the null-id case falls through to the caption+author check, which identical captions defeat.

So Phase-2 comments now go through the **group-scoped, id-strict feed-scan** (the path that was always correct and the operator's original behavior): it finds OUR post by id when captured, else the lone recent our-caption post in the CORRECT group, and **refuses ambiguity → held** rather than guessing. It can never comment cross-group (the scan is group-scoped) and never on an old duplicate (it refuses multiple same-author matches).

- Phase-2 passes `permalink=null` to `addFirstComment` → the permalink block (and its document-wide box selection) is skipped; the article-scoped feed-scan is the sole path.
- The Phase-2 pipeline is **repurposed** to pre-load the group **FEED** (not the permalink), so the feed-scan runs immediately — the speed of the pre-load is kept, the wrong-post-prone permalink navigation is gone.
- Guard against a mis-served pre-load: the feed goto is skipped ONLY when the tab is confirmed on THIS group's feed (`/groups/<gid>`), else it navigates to the correct group.
- The 1.0.44 id-gate remains live for the single-phase inline / rescue callers that still pass a permalink.

Verified: `node --check`; **257/257 + 27/27**. Requires an app restart.

## [1.0.44] — 2026-07-11 — FIX Sacred wrong-post: all comments landing on one post (identical-caption id-gate)

The operator saw **all 4 deferred comments land on ONE post, the other 3 posts left with none**. Root cause: since 1.0.42 made the link-capture reliable, Phase 2 comments via the post's **permalink page** (+ a pipelined pre-load). The per-post verification trusts the **caption** when the page URL doesn't expose the post id (`forceContentVerify` branch) — but the operator posts an **identical caption + the same account** to every group, so caption AND author are useless as disambiguators; **only the post id can tell our posts apart**. When a permalink/pre-loaded page resolved to the wrong (or an unconfirmable) post, the identical caption still "confirmed" it → the comment landed on the wrong post.

**Fix — final wrong-post gate:** whenever we hold a trusted post id, the comment page must **positively show that exact id** (URL first, else the article DOM) before we comment on it; if it can't be confirmed EQUAL, we **demote to the id-checked group feed-scan** — which finds OUR post by that id in the CORRECT group (id-strict: `idHit && capHit` for a network id, so it picks the exact post or refuses to held, never a caption-only wrong-post). Monotonic: the gate only ever confirms-and-comments or demotes-to-a-safe-path — it can never itself cause a wrong-post. The fast permalink path is kept when the id confirms (the common, correct case) and only falls back when the page is wrong/unconfirmable.

Verified: `node --check`; **257/257 + 27/27**. Requires an app restart. The gate logs "this page is NOT confirmed to be OUR exact post by id (page=… expected=…)" when it demotes — watch for it to see how often the pre-load resolves wrong.

## [1.0.43] — 2026-07-11 — FIX comment double/miss: robust submit-confirm + box-render poll (Sacred)

After 1.0.42 made the link-capture reliable, Phase-2 comments now go to the post's PERMALINK single-post page for most posts — and that page is often "not fully interactive" on a residential IP (27× in the log), which produced the operator's report: **some posts got two comments, others none**.

**Root causes (both from commenting on a half-hydrated page):**
- **DOUBLE:** the post-submit confirm re-pressed Enter whenever the box hadn't emptied within 4s (fired 7× in the log). On a laggy page the first Enter is accepted but the box clears late (or both keypresses queue) → the re-press posts a SECOND comment.
- **MISS:** after clicking "Leave a comment" the box was read ONCE at a fixed delay; the composer's render animation meant it often read empty a beat too early → demoted to the feed fallback → some posts ended with no comment.

**Fixes:**
- **Double-safe re-submit:** re-press Enter / click send ONLY with positive proof the first submit did NOT land — the box must PROVABLY still hold the full comment text (FB clears it synchronously on accept, so a still-full box ⇒ nothing was accepted), the confirm window is EXTENDED (8s) on slow pages so a queued/in-flight Enter flushes first, and a positive `commentLanded()` check (is our comment already visible under OUR post?) suppresses any re-submit. When ambiguous, PREFER a recoverable miss over an unrecoverable double.
- **Box-render poll:** after "Leave a comment", poll for the comment box (mirrors the feed path) instead of one early read → far fewer spurious demotions/misses. No Enter here (can't submit).
- **Genuine miss → RESCUE (not silent):** a genuinely-unplaced comment (box still LIVE holding un-submitted text, comment not visible) now returns a non-landed `'unplaced'` so a reserve re-places it — a post is never silently left without its link. Double-safe (nothing posted → a reserve can't double; a detached/empty box is treated as maybe-posted → not rescued).
- **`commentLanded` hardened:** excludes the composer box STRUCTURALLY (text-node walk, not string-subtraction), matches a 45-char PATH-unique prefix (was 25 = domain-only), and is **scheme-agnostic** (FB renders a URL comment without `https://`, so a raw match missed a posted link) — reliably detecting a posted link is what suppresses a wrong `'unplaced'` rescue on a lost-ack (committed-but-unacked) submit.

**Adversarially verified** (4 independent reviewers across double / miss / wrong-post / scope lenses). Fixes applied for every finding: the silent-miss regression (→ `'unplaced'` rescue, both callers verified), the `commentLanded` false-negatives (structural exclusion + scheme-agnostic), and a send-button `withTimeout`. Read-only helpers can only SUPPRESS a re-submit, never place a comment (no wrong-post). **Known residual (narrow):** a lost-ack where FB has rendered no comment yet could still let `'unplaced'` route to a reserve → a cross-account double; the robust close is a pre-comment idempotency scan in the rescue path (flagged as follow-up). Verified: `node --check`; **257/257 + 27/27**. Requires an app restart.

## [1.0.42] — 2026-07-11 — FIX link-capture timing race: the comment no longer always falls back to the feed-scan

Live-log forensics (23k lines): the create-story link-capture was coming up empty on ~11 of 16 posts, ALWAYS with reason `create-story seen but no gid-scoped URL`. The **same groups** appeared in both the success and empty lists, and the 5 successes matched the exact same `/groups/<gid>/posts/<id>` shape — so it was a **timing race, not a URL-shape mismatch**. The log's own timeline proved it: capture gave up at **6.7s** after the Post click (1.8s grace), but the publish wasn't even confirmed until **12.8s**. Facebook **streams** the create-story response (`@defer`), so `resp.text()`'s body isn't fully read until several seconds after the composer closes — long after the old 1.8s grace expired and disposed the listener (and the verify-reload then navigated, aborting the in-flight body read). So every slow response → "empty" → the comment fell back to a caption+position feed-scan (`id=?`, no id verification).

**The fix (lifecycle-defer, zero happy-path latency):**
- `_netCapture` is now **loop-outer**, so disposal is guaranteed by dispose-leftover-at-arm + dispose-after-loop (a mid-group `break`/`continue` can't leak the `response` listener on a pooled tab).
- The early read now only waits (~3s) on a client `timeout`/`error` (for H3's double-post guard — strictly ≥ the old 1.8s, so never a regression); a clean `published` reads with **no wait**.
- A **finalize** block re-reads the capture with a **bounded** grace (~3s fast / ~4.2s normal, exits the instant the id arrives) right before the comment decision — **reusing the post-publish settle time for free**, so the streamed body is caught without re-scanning the feed and without adding latency when it was already captured.

**Adversarially verified** (3 independent reviewers — wrong-post, listener-leak, H3/latency): leak-safe on every exit path; H3 preserved (wider, safer window); byte-identical when `capturePostLinkFromNetwork` is off; zero happy-path latency. One reviewer caught a **new** wrong-post vector — the longer-armed listener was still attached during the *timeout* feed-rescan (a feed full of our old identical-caption posts) — now closed by disposing the capture **before** that reload. Net wrong-post **improvement**: a pending post now takes the id-first feed match, which refuses an old-duplicate the old caption path could have commented on. Known low-rate fail-safe trade: a *public* post in a moderated group whose numeric id doesn't hydrate within the 16s verify-poll can be held (never wrong-posted) — watch `absentById` held rates.

Verified: `node --check`; **257/257 + 27/27**. Requires an app restart. Live signal to confirm: the ratio of "🔗 Captured the post's link" vs "link-capture empty" should invert.

## [1.0.41] — 2026-07-11 — HARDEN tabs: bound the open-tab count (no more "9 tabs for 4 groups")

The live test with a multi-tab pipeline (`tabsPerBrowser>1`) left more tabs open than the pool should hold. The pool caps *counted* tabs at `tabsPerBrowser`, but two things escaped that cap: (1) `_makeTab` opened `browser.newPage()` and then hardened it — if hardening threw, the catch returned `null` but **left the opened tab orphaned** (uncounted, never closed), so the pool over-grew; (2) FB-spawned popups (checkpoint tabs, `target=_blank`) were adopted by `targetcreated` for geo/auth but **never closed**. Both accumulate within a phase (phase boundaries already reset the pool, so this was never cross-phase). Two fixes, both pure tab-lifecycle robustness (the `(post,gid)` dedup keying and every wrong-post/double-post trap are untouched):
- **Close the orphan:** `_makeTab` now closes its `newPage()` if hardening throws — a harden failure can no longer leak an uncounted tab.
- **Reap strays:** a new `_reapOrphans` closes any page **this run did not open** (an FB popup / a close that a slow `.close()` missed) — tracked via an `_ownedTabs` set seeded with the active page and every `_makeTab` tab, so it can **only ever close untracked pages, never the active page or a pool tab**. Runs each group and at both phase boundaries.

Gated behind `tabsPerBrowser>1`: the default single-tab path never calls `_makeTab`/`_reapOrphans`, so it is behaviorally unchanged. Verified: `node --check`; **257/257 + 27/27**. Requires an app restart.

## [1.0.40] — 2026-07-11 — FIX click reliability: re-read a button's position before clicking (fewer "missed taps")

The live test surfaced the comment step retrying because its clicks "missed": the real-mouse click reads the button's rect, then the human mouse-move takes real time, and FB's dynamic feed/composer **shifts the button** in that window — so the click lands on the old spot and misses (the comment box then "did not render" → a full-reload retry). Three fixes, all pure *targeting* robustness (the wrong-post scoping is untouched):
- **Re-read before click:** the comment button (`scanFeed`) and the Post button (`clickPostButton`) are now marked, and their **current** center is re-read right before the click — so the click lands where the button *is*, not where it was.
- **Poll for the comment box:** the scoped-box detection now **polls** for the box to render (returning as soon as it appears) instead of a single fixed-delay read — so a slightly-slow render (or a React re-render that briefly drops our marker) no longer reads "not rendered" and forces a retry. Also faster in the common case.

Net: fewer missed clicks + fewer full-reload retries = smoother and more human-like. Verified: `node --check`; **257/257 + 27/27**. Requires an app restart.

## [1.0.39] — 2026-07-11 — FIX composer-open: a mis-click on a group TAB no longer errors the group

Surfaced by the live test run: the composer-open click occasionally landed on a group **tab** (Events/Media/…), which **navigates off the feed** — so the composer wasn't there, all 4 retries then failed on the wrong page, and the group was skipped with a "Could not open composer" error. `openComposer` is a pre-publish, read-only step (no double-post path), so it's safe to harden. Two fixes:
- **Recover:** if a click navigated to a group tab (`/groups/<gid>/events|media|about|members|posts|permalink|…`), return to the group feed before the next attempt — so a stray click no longer cascades into a skip. Human-like (a person would navigate back).
- **Prevent:** the composer-trigger scan now rejects tab labels (events/media/members/…), so it won't pick a wrapper element that spans a nav tab (whose random click point could land on the tab).

Verified: `node --check`; **257/257 + 27/27**. Requires an **app restart** to take effect (the running instance has the pre-fix code).

## [1.0.38] — 2026-07-11 — R4: close the lone-caption wrong-post on both feed pickers

B+C made the MULTI-match wrong-post structurally impossible, but a LONE caption match was still accepted without an author check — so a reserve commenting on another account's post (or the worker when its own post was absent) could land on a STRANGER's (or the reserve's OWN) identical-caption post. Now both pickers (the comment feed-scan `_scanFeedRaw` and the verify-reload find-poll) refuse a lone match when its author is **readable and different** from the expected author; an **unreadable or unknown** author still accepts (no coverage loss on a flaky render). Adversarially verified: the change is **monotonic** (strictly stricter — it only refuses more, never selects a different post), so it can never cause a wrong-post; degrades a refused match to the moderator/rescue queue, never a wrong comment. Its one narrow missed-comment edge (a >60-char display name) is closed by also slicing the expected author to 60 to match `authorOf`.

Verified: `node --check`; **244/244 + 27/27**; adversarial verification (4 checks, all safe, monotonic).

## [1.0.37] — 2026-07-11 — R5: crash-durability — a hard kill mid-run no longer re-posts delivered groups

Completes the R5/R6 crash-durability cluster (R6 shipped in 1.0.36). This is R5 — the crash-recovery fold — implemented, adversarially verified (which found + fixed **2 critical double-post holes**), and re-verified clean.

**The gap:** per-group delivered state lived only in the in-memory `_cycleDelivered` (rebuilt each cycle); the durable dealt/rotation pointer was persisted only after an account finished. A HARD kill (OOM / power loss / force-kill) mid-account lost both → on restart the post was re-posted to already-delivered groups (double-post).

**The fix ("Hardened Approach A"):**
- A durable append-only journal (`pcu-inflight.jsonl`) writes one line per (agent,post,group) delivery at `markDelivered`.
- On run start, `_recoverInflightJournal` FOLDS the crash-surviving lines back into the SAME durable structures a clean account-return would write — the rotation pointer + `_owed` ledger (daily-rotation/campaign-plan), or `_dealt` + a durable per-group guard `_inflightDelivered` (unique/sequence) — then compacts the journal. Supersession is a per-agent atomic `icommit`/`inflightSeq` watermark stamped with the pointer, so a clean commit makes the fold a no-op next run (**zero behavior change on the happy path**).
- It escapes the v1 "cross-midnight seed-lifetime trap" that made single-post daily-rotation post once and never again: daily-rotation re-delivers via the normal daily-quota (the durable guard is **unique/sequence-ONLY** — those never re-deliver; a durable guard on daily-rotation would permanently suppress its legit re-delivery).

**Verification:** implemented by a focused agent → adversarial verification found **2 critical double-post holes** (a unique/sequence partial re-posting delivered groups; a rotation owed-discharge re-owing prior-delivered groups) → both fixed → re-verified: both closed, no new hole, the durable guard provably never touches daily-rotation, clean-path is a no-op. `node --check`; **250/250** (incl. **6 committed R5-fold regression tests** — `tests/orchestrator-r5-fold.test.js`: both fixed holes, the v1 daily-rotation-suppression guard, supersession, idempotency) + **27/27**. **Residual (irreducible):** a hard kill *during* the one-line journal `appendFileSync` loses that single group's mark → that one group can still be re-posted (bounded to one group, down from a whole account run). **Live-FB validation owed:** a real Electron-kill smoke test on throwaway accounts (kill mid-account, restart, confirm only un-reached groups post + next day re-delivers).

## [1.0.36] — 2026-07-11 — R6: close the Phase-4 crash-re-arm double-post (reserve-liveness); R5 fold deferred

From the R5/R6 crash-durability redesign. The R6 half — a contained, fail-safe fix — ships; the R5 half (the crash-recovery "fold") is designed but deliberately **not** shipped (below).

- **R6 — Phase-4 reserve-liveness double-post (`orchestrator.js` + `repost.js`).** With the moderator off, a held post is re-posted by a reserve (Phase-4). A crash between the reserve's FB-publish and its `markResolved` re-armed the re-post, but the liveness check (`isContentLive`) was keyed ONLY to the ORIGINAL poster's author — so it couldn't recognize the RESERVE's own live copy → returned 'absent' → re-posted a duplicate. Fix: preserve the reserve identity (`repostedBy` + new `repostedByDisplay`) across the superseded→failed revert; pass BOTH authors (`expectedAuthors: [original, reserve]`) to `isContentLive`; and when a reserve author exists, an 'absent' on the original permalink now falls through to the author-aware feed scan (matching EITHER of our authors). **Adversarially verified** (5 checks): the change only ever GROWS the author match-set (monotonic), so it can never turn a live post into a re-posted duplicate — it fails strictly toward **missed-not-double** (its one new behavior — a reserve's own identical-caption post read as live — is the same accepted caption-match trade already present for the original author).
- **Inflight-journal infrastructure (`store.js`, inert):** added `appendInflight`/`loadInflight`/`compactInflight` helpers (a crash-durability journal), exported but not yet wired — the foundation for the R5 fold.

**R5 (the crash-survival fold) is DEFERRED — not shipped.** A safe design exists ("Hardened Approach A": journal each delivery, then on run-start FOLD survivors into the rotation pointer / owed / dealt exactly as a clean account-return would), but it's a large, complex reconstruction of the crown-jewel double-post ledger whose `owed = assignedGroups − deliveredGroups` reconstruction must be exactly right — a bug there *manufactures* the double-post it prevents. It needs a focused implementation + a dedicated adversarial verification + a live Electron-kill smoke test (rested accounts only), so it was not rushed. Full design + 8-item verification plan captured.

Verified: `node --check`; **244/244 + 27/27**; adversarial verification of R6 (all safe).

## [1.0.35] — 2026-07-11 — Instant-mode speed: safe cosmetic trims + an opt-in fast-publish settle

Instant mode was already heavily optimized (a full audit confirmed most delays are correctness gates or anti-spam floors). This squeezes the remaining genuinely-cosmetic delays and adds one opt-in lever.

- Trimmed cosmetic instant-mode settles that a later verify/poll already covers: the post-composer-open settle (200→80ms, all posts) and the two image-comment attach/re-focus settles (300→150ms, image-comments only). No correctness gate or anti-detection floor touched. Deliberately **left alone**: the paste-landed verify settle (a premature read would re-paste → **double-text** — the audit misjudged it as cosmetic; caught on review), the comment-landing poll windows, the anti-spam floors (`comment: 4000ms`), the publish-confirm wait, and the create-story capture grace.
- **`fastPublish` (opt-in, default OFF):** cuts the ~1.8s post-publish "held for review" toast settle to **600ms** on the fast tiers. That settle only matters for **moderated** groups (to catch the held toast); for an **admin of his OWN groups** the toast never fires, so it's ~1.2s/post of dead wait. Off = byte-identical; on = the operator accepts that a *slow* toast on a group he doesn't moderate could be missed. Enable via the setting or `ZA_FAST_PUBLISH=1`.

Verified: `node --check`; **244/244** (+1) + **27/27**.

## [1.0.34] — 2026-07-11 — Leak sweep: a rescue per-task hang can't drive the shared page into the next task

R9 from the round-2 audit. `rescue.js` placed each orphaned link-comment via `Promise.race([addFirstComment(...), timeout(300s)])`. On a per-task hang the timeout won the race but `addFirstComment` kept running — driving the SAME shared page — while the loop advanced to the next task, so the hung call's Enter could land on the NEXT task's post (a wrong-post / double-comment). Now a per-task timeout **stops the rescuer** (remaining comments stay pending for a fresh rescuer next cycle), and the racing call has a `.catch` so a late rejection can't surface as an unhandledRejection. (R10 — undetached CDP sessions in `applyProxyGeo` — was assessed and **skipped**: Chrome auto-reclaims a page's CDP sessions on close, and detaching mid-session risks reverting the anti-ban geo overrides; not a real leak.)

Verified: `node --check`; **243/243 + 27/27**.

## [1.0.33] — 2026-07-11 — Durability part 1: close the timeout/error double-post + harden the held/comment/rescue ledger

Three no-double-post / no-lost-record fixes from the round-2 durability audit (H3 + R2 + R3), each adversarially verified. (The rest of the cluster — the R5/R6 crash journal, R3's idempotency scan, and the reserve pre-post check — is **deferred**: the crash-journal design failed its own adversarial check with a missed-post regression, so it needs a redesign, not a rushed ship.)

- **H3 — committed-but-client-unconfirmed double-post (`worker.js`).** Facebook can commit a post server-side while the CLIENT sees a publish 'timeout' (70s ceiling) or an 'error' toast — the post never got `markDelivered`, so the owed/reserve path **RE-POSTED** it. Fix: FB's create-story **RESPONSE** (already captured for B+C, default-on) is the server's proof the post exists — if we captured our post's id, treat a 'timeout'/'error' as **published** (never re-post). Definitive, no feed-scan false-negative risk, and it can never false-confirm a post that didn't publish (the id is only set from OUR gid-scoped create-story response). Also excluded the OPEN composer dialog from the pending-notice scan (it can now be reached with the composer still open).
- **R2 — held/comment persistence made HALT-on-fail symmetric (`orchestrator.js`).** The held-record and orphaned-comment writes only *logged* on a disk/lock failure while the post was already marked dealt — so the record was lost forever. Now each write **retries** a transient lock (3×), and on persistent failure sets a sticky halt that stops the pool **after** the post is durably dealt — so a lost record can never become a re-owned double-post; the operator is told to fix the disk. (Reset on Stop→Start so recovery works.)
- **R3 FIX A — the rescue 'done' marker is now AWAITED (`orchestrator.js` + `rescue.js`).** It was fire-and-forget: a kill/lock between placing a comment on FB and its 'done' status reaching disk re-dispatched it next cycle → a **double-comment**. `markResult` now returns its persist promise; the rescuer awaits + confirms it (retrying a landed 'done' write) before advancing/closing.

Verified: `node --check`; **243/243 + 27/27**; adversarial verification of R2+R3 (5 invariants — all hold) and H3 (4 checks — all safe). Live-FB validation owed.

## [1.0.32] — 2026-07-11 — FIX the wrong-post + false-held root: a no-wrong-post floor + trusted-id targeting (B+C)

The operator posts **byte-identical captions** to the same groups, so an OLDER own-post with the identical caption often sits in the feed. The post-publish feed picker took `ours[0]` = topmost-DOM among same-author + same-caption matches with **no recency/id anchor** — so on a non-chronological feed it could comment on the OLD post (**wrong-post**), or, missing our fresh post past the scan window, **false-hold a PUBLIC post** (comment lost). Both are one root: caption alone can't distinguish two identical own-posts.

- **No-wrong-post floor (both pickers).** The verify-reload find-poll and the comment feed-scan now accept a **LONE own caption-match only**; MULTIPLE same-author matches → **REFUSE** (skip-not-guess) instead of guessing topmost. The wrong-post between two indistinguishable own-posts is structurally impossible on the caption path.
- **Trusted-id targeting (default-on capture).** The gid-scoped network URL-capture (memory-compliant — the banned *field* capture stays gone) is now **default-on** and armed for **single-phase** too. When FB's publish response yields our post's unique id, we comment via the **direct link** (caption-rechecked on the post's own page), bypassing the picker; and the verify-reload is now **ID-FIRST** for pending posts (find OUR unique id, immune to the identical-caption confusion). A capture hit also **skips the ~4–16s verify-reload** (instant-mode speed win).
- **False-held fixed.** "Held" fires only on **CONFIRMED-absent** (id-not-in-feed, or caption-not-found) — never on "couldn't-confirm." An ambiguous-but-present result and a captured-id LIVE match are never held; a genuinely-held post is recorded **with its comment** for post-approval.
- **Instrumentation.** Every empty capture logs *why* (ambiguity-reject / no-URL / no-create) so the operator can measure the empty-capture rate (== the floor's skip rate) live.

Adversarially verified in **two rounds** (round 1 caught a lone-old-duplicate wrong-post the design missed → fixed with id-first; round 2 confirmed safe-to-keep). Verified: `node --check`; **243/243 + 27/27**. **KNOWN RESIDUAL** (negligible for an admin of his own groups, whose posts aren't held): a *genuinely-held* pending post with an *empty* capture + a lone public old duplicate can still comment on the old dup — held posts normally return the capture id (id-first then holds correctly), so this needs the capture to *also* miss on a held post. Live-FB validation owed.

## [1.0.31] — 2026-07-11 — HARDENING pass: six robustness / data-safety fixes (no happy-path behavior change)

A full defensive pass over the boot, store, launch-lifecycle, and watchdog paths. Each fix removes a way the app could **silently lose data, wedge an account, or hang** under an edge (OS file lock, crash mid-seed, proxied close-hang, malformed import). None change the posting/comment/held logic; the Sacred invariants and the happy path are untouched.

- **Data-loss on boot (store clobber) — `main.js clearInterruptedLoginStates` + `lib/store.js`.** The post-crash boot cleanup did a **bare `store.save(data)`** that bypassed the `_primaryUnreadable` guard `update()` has. If `data.json` was transiently **unreadable** at boot (Defender / OneDrive lock — likeliest right after a crash, which is exactly when this runs), `load()` rebuilt `data` from stale `.bak`; flipping an interrupted `logging_in` account then `save()`-d that stale snapshot **over the good-but-locked primary**. Now guarded via a new `store.primaryUnreadable()` reader — the save is skipped when the primary couldn't be read (same protection `update()` already applies). The synchronous load-trigger that surfaces the boot recovery dialog is preserved.
- **Account skipped forever (close-hang) — `main.js check-account-memberships`.** The success path `await`-ed `browser.close()` **unbounded** and deleted the `membershipChecks` entry only *after*; a proxied CLOSE_WAIT hang leaked the entry, so `isCheckOpen` made the orchestrator skip that account **every future cycle until an app restart**. Now: delete the entry **first**, then a **bounded** close (8s race) + **SIGKILL** fallback — the same pattern worker/rescue/repost/moderator already use. Applied to both the success and error paths.
- **Fresh-install wedge (migration order) — `main.js migrateLegacyUserDataOnce`.** The one-shot seed copied `data.json` **first**, then cookies/images. A crash between them left a fresh install with accounts but **no cookie jars**, and the `data.json`-exists skip-guard then never retried the seed. Reordered: cookies + images **first**, `data.json` **last** — a partial seed now retries cleanly on the next launch.
- **Bulk import could reject the whole batch — `main.js add-posts-bulk`.** One `null`/garbage record threw out of the `store.update` mutator and lost the entire paste. `posts[i] || {}` (matches the already-guarded `/api/posts/bulk` HTTP sibling).
- **Watchdog could never fire (overflow) — `automation/worker.js`.** The per-account watchdog budget `targetGroups.length * perGroupMs` could grow to an effectively-infinite timeout on a very large group list, so a genuinely-stuck account would never be force-timed-out. Clamped to **≤ 24h** (with the existing ≥ 10min floor).
- **Timer leak — `automation/repost.js`.** A progress `setInterval` in `_goto` wasn't cleared if the navigation threw before its normal clear. Hoisted the handle + `.finally(() => clearInterval(iv))`.

Verified: `node --check` on all four files; **243/243** unit + **27/27** anti-spam, no regression. Each fix was independently re-verified against the live code before applying (the audit workflow's adversarial-verify stage did not fire — nothing was rated `high` — so verification was done by hand). Considered and **rejected**: a CDP-session `detach()` in `lib/browser.js applyProxyGeo` — detaching risks reverting the `Emulation` timezone/locale overrides that keep the proxy geo coherent (an anti-ban signal), and the session is bounded per-page and auto-freed on page close, so it is not a real leak.

## [1.0.30] — 2026-07-10 — FIX false-held: a public post's TRANSIENT "might be reviewed" toast was losing its comment

The operator checked the groups and found posts that were **public** but the app had marked "Spam potentiel" — held, with **no comment placed**. Root cause: Facebook shows a **transient** "your post might be reviewed" toast even for posts that then go public; the old **FAST HELD-EXIT** trusted that toast and held the post **without checking the feed** — skipping the very confirmation its own log promised ("will confirm against the feed"). So a public post was falsely held and its link-comment silently dropped.

- **A pending notice now CONFIRMS against the feed before holding.** `pendingAtPublish` forces the verify-reload ON; its caption+author feed-find is the ground truth. If OUR post is LIVE in the public feed → the notice was transient → comment normally (LIVE OVERRIDE). Only a post **confirmed absent** from the feed after the reload is routed to the moderator/held queue (the new HELD RESOLUTION). The blind FAST HELD-EXIT is gone.
- **Trade-off:** a genuinely-held post now pays the ~4–16s feed-reload (vs. the old instant skip) — but that beats silently losing a public post's comment. With post-approval turned OFF at the group level, most pending notices are FB's transient toast (false-positives), so the reload mostly *confirms the post live* and comments it.

Double-post safety intact (`markDelivered` at-most-once; `publishClicked` untouched); genuinely-held posts still held (HELD RESOLUTION for no-comment/two-phase, comment-`notfound` for single-phase); non-pending flow byte-identical. Verified: `node --check`; **243/243 + 27/27**; independent adversarial review of 6 hypotheses (double-post, held-still-held, false-held-fixed, no-comment held, non-pending unaffected, ledger — **all SAFE**).

## [1.0.29] — 2026-07-10 — Verify-later (opt-in): skip the redundant inline post-landed reload in two-phase

After publishing, two-phase mode did an inline feed-reload (~4s/group) to "verify the post landed" and try to capture its permalink — but that permalink is usually empty (`id=?`), so the Phase-2 comment pass feed-scans for the post **anyway**. The inline reload is therefore a redundant earlier scan.

- **Opt-in, default OFF** (`skipInlineVerify` setting, or `ZA_SKIP_INLINE_VERIFY=1`), two-phase only. When on, a comment-bearing post skips the inline reload; the deferred Phase-2 comment finds OUR post via its own feed-scan (top-8, caption+author+recency, skip-not-guess) — the **same guarded path** already used whenever the inline capture came up empty. Saves ~4s/group. OFF → byte-identical.
- **Nothing else changes:** the `feedConfirmed` flag the reload set feeds **only a log line** (verified — no auto-delete / completion / ledger dependency); `markDelivered` still fires at publish (double-post ledger intact); no-comment posts still reload (their sole check); the network-capture fast path is untouched; held detection is preserved (Phase-2 `notfound` → moderator, identical to the inline path).

Verified: `node --check`; **243/243** unit (+1) + **27/27** anti-spam; independent adversarial review of 6 hypotheses (byte-identical-off, wrong-post/double-comment, no-comment posts, network fast-path, `feedConfirmed` downstream, held detection — **all refuted**). Live-FB validation of the ~4s/group saving is owed (enable the flag on a run). (An earlier composer-pre-open attempt was built + reverted — it regressed the multi-tab pipeline; see the session notes.)

## [1.0.28] — 2026-07-10 — FIX a wrong-post comment window + make the author guard actually populate (root cause)

An adversarial audit of the Sacred invariants (double-post/double-comment traps) found the double-post/persistence/owed/moderator/pool traps all HOLD, but surfaced two real gaps in **comment targeting**, both rooted in the **author-match key being empty** ("logged in as (unknown)"). Fixed the one true code defect and the *root cause*, and deliberately did NOT take the tempting symptom-flips (each would trade a bounded strand/missed-post for an **unbounded double-post**).

- **Wrong-own-post comment (INV-07) — fixed at `worker.js` captured-link verify.** In the network-captured-id branch (`forceContentVerify`), the post's own page was confirmed on **caption OR author**. But a mis-parsed id is drawn from *our own* create-story response, so its page author equals ours **even when the id points at a DIFFERENT (older) post of ours** with another caption — author-alone then confirmed the WRONG post. The feed-scan fallback on the same DOM already required the caption for an untrusted id; the permalink path now matches it: **caption is REQUIRED, author is read/logged but never a sole confirmer** (and, as before, a stale/unknown name never *rejects* our caption-confirmed post). Only bites once display names are set — so it was latent today and would have activated the moment the operator set them.

- **Author guard never populated — fixed the capture + the field mismatch in `main.js`.** The wrong-post/strand guards (repost liveness `isContentLive`, the publish-timeout feed rescan, the moderator, and the above corroborator) all key off `account.fbDisplayName`. But the status check captured the name with a single English-only `[aria-label="Your profile"]` read (usually empty → "logged in as (unknown)") **and stored it into `fbName`, a different field the guards don't read**. Now the status check uses the same robust `CurrentUserInitialData.NAME` capture the posting run uses (multilingual, authoritative), and **seeds `fbDisplayName` when the operator hasn't set one** (never overriding a manual value or a prior capture). A plain "Check" now arms the author guards with no per-account manual step.

- **Consequence — the two remaining audit items resolve at the source, no Sacred edit.** With `fbDisplayName` now reliably present: `isContentLive`'s author-aware fallback correctly treats a readable **stranger's** same-caption post as NOT-live (no strand / no mis-homed comment), and the publish-timeout rescan requires OUR author (no missed-post false-confirm on a stranger's caption). `repost.js`'s `if (!author) return true` and the timeout-rescan's short-caption gate stay **untouched** — flipping them would risk duplicating our own auto-released posts, the crown-jewel invariant.

Verified: `node --check` on both files; full suite **242/242** green + **27/27** anti-spam (no behavior-lock regression). The comment-targeting logic lives in `page.evaluate` callbacks (DOM-only, not unit-testable) — validated by reasoning against `_scanFeedRaw`'s reference semantics and the existing suite. Live-FB re-verification of the captured-link path and the seeded author guard is still owed (see HANDOFF).

> **Follow-up (not built):** a unique per-post caption *marker* would make targeting bulletproof even when two accounts share a display name — deferred because it injects content (an ADR-0001 detection trade-off) that the read-only display-name capture avoids entirely.

## [1.0.27] — 2026-07-08 — FIX a double-comment: network-captured link could point at the WRONG post (identical captions)

The operator verified on Facebook and found **two comments on one post and none on the next** — a comment meant for
post Y placed on post X. Root cause: the operator posts an **identical caption + the same account** to every group,
many runs/day, so caption AND author are identical across all posts — the **group + recency** are the only
disambiguators, and the network-capture comment path relied on neither strongly enough.

Two distinct holes (both found via adversarial review), both fixed at the capture point:
- **Cross-group (removed):** `armPostIdCapture` had a non-group-scoped `post_id`/`story_fbid` field fallback. During a
  fast run, a *previous group's* create-story response can arrive late in *this* group's capture window; the field
  grabbed its id → we built `/groups/<thisGid>/posts/<otherGroupsId>` → resolved to the other group's post. **Removed**
  the field fallback — capture is now only from a `/groups/<OUR-exact-gid>/posts/<id>` URL, which another group's
  response can never carry.
- **Same-group, older post (fixed):** the URL regex took the *first* match with no recency check, so an older
  same-group post URL embedded in the response (pinned-post edge / out-of-order `@defer` chunk) could be captured →
  comment lands on the old post. **Now a global scan captures only when the response has exactly ONE distinct
  same-group post id** (unambiguously the new post); if several, it captures nothing → the **group-scoped feed-scan**
  runs (picks the newest matching post, refuses when unsure — never a blind older-post comment).
- **Defense-in-depth:** a **group check** at comment time — if an opened link resolves to a different group than
  intended, demote to that group's feed-scan.

Verified: 4-vector adversarial hunt (cross-group race, same-group recency, tab-adoption, feed-scan ambiguity). The
same-group-recency hole was CONFIRMED and is what this closes; the others cleared. 242 tests green.

> **Operator note:** with identical captions, the safest targeting relies on **recency** (the newest matching post in
> the correct group). The feed-scan picks the newest *only when the account's display name is set* (it groups by author
> then takes the topmost); if the account shows "logged in as (unknown)", it will **refuse and route the comment to
> rescue** rather than risk the wrong post. Setting each account's display name makes those comments land on the newest
> post instead of deferring. (A tiny unique per-post caption marker would make targeting bulletproof, but that's your call.)

## [1.0.26] — 2026-07-08 — Trim the INSTANT inter-group / inter-comment pacing (operator-requested)

Operator asked to cut the wait between groups. These gaps are **anti-spam velocity pacing** (not dead overhead — the
next group already pre-loads during them), so this is a deliberate speed↔block-risk tradeoff, kept measured: still
jittered, still floored (~0.5s) so the cadence never goes metronomic/sub-human on a single IP.

- **Inter-group gap (instant):** `rand(1000, 3000)` → `rand(500, 1800)` (posting pass + the held-post exit path).
- **Comment-to-comment cadence (Phase 2, instant):** `rand(800, 2500)` → `rand(500, 1600)` (kept slightly above the
  post gap — link-drops are a touch more spam-sensitive).

Left unchanged (load-bearing, not overhead): the post→comment aging gap, the ~1.8s post-publish settle (held-toast
hydration), `waitForPublish`'s confirm + ceiling, and all non-instant tiers. 242 unit + 27 anti-spam checks green.

> The within-post steps are already trimmed to the bone (v1.0.19–1.0.25); the remaining per-post time is mostly
> Facebook's own publish (~5s) + render (~2s), which we can't cut. The real throughput multiplier is running the safe
> max **parallel accounts** (capped at 3 concurrent on one real IP by v1.0.17) — that's 3× the posts/hour without
> touching any per-post safety.

## [1.0.25] — 2026-07-08 — Network-capture comment: confirm by caption (stop the false "author mismatch" fallback)

Live monitoring showed the network-capture **post** phase working great (~6–8s, feed re-scan skipped), but **every
comment** then logged *"the captured link did not positively confirm OUR post (author mismatch) — falling back to the
group feed"* and did the slow feed-scan anyway. Root cause: the captured id was correct (the fallback found OUR post
by caption at pos=1 every time), but the content-verify let an **author mismatch reject a good caption match** — and
the account's display name is unreliable (FB reports *"logged in as (unknown)"*), plus the permalink page is often
*"not fully interactive (timeout)"* when read. So a reliable positive signal (caption) was being overridden by an
unreliable negative one (author).

- **Confirm by caption, corroborate by author.** The network content-verify now confirms OUR post on a **positive
  caption match** — the same single-article standard the feed-scan already uses (`_scanFeedRaw`: "one caption match →
  ours"). Author match is a *positive* corroborator; a bare author mismatch no longer rejects a caption-confirmed post.
- **Poll for slow renders.** It re-reads the post page for up to ~5s (accepting the instant it matches) instead of a
  single early read that misfired on a not-yet-rendered permalink.
- **Diagnostic.** On a genuine miss it now logs the author it actually read (`author read="…"`) to speed future triage.

Wrong-post safety is preserved: a foreign/mis-parsed id whose page does not carry our caption never confirms here
(→ feed-scan fallback, which is itself wrong-post-guarded via `idHit && capHit` for network ids). Net effect: public
posts now comment via the **direct link** (skipping the feed-scan) instead of always falling back. 242 tests green.

## [1.0.24] — 2026-07-08 — Fix: `droppedImage is not defined` crash at the end of a clean run (live-monitor catch)

Monitoring a live test run, an account **crashed at completion** with `droppedImage is not defined`, then retried.
Root cause (introduced in v1.0.16's gap hunt, latent until now): `droppedImage` was `let`-declared **inside** the
account's main `try` block (worker.js:2337) but read in the function's **final `return`** (worker.js:3500, after
the `finally`) — out of scope → a `ReferenceError` on **every clean completion**. It stayed hidden because (a) the
previously-running Electron instance held older in-memory code, and (b) the many early-exit returns (proxy/auth/etc.)
don't reference it — only a *fully successful* run reaches the final return. The v1.0.20–1.0.23 speedups made clean
completions the norm, surfacing it.

- **Hoisted `let droppedImage = false;` to function scope** (worker.js:2024, beside `posted`/`heldRecords`/
  `commentQueue`); line 2337 is now a plain assignment. In scope at every reference.

Why it mattered beyond the crash: the thrown `ReferenceError` **discarded the run's return value** — `heldRecords`,
`commentQueue`, and the `fullyPosted` deal-marking — so held posts / rescue comments could be dropped and a
completed library post could be re-posted next cycle. 242 tests green. **Requires an app restart to take effect.**

## [1.0.23] — 2026-07-08 — Trim the comment-locate "nudge" loop (log-driven)

Reading the owner's `automation.log` from a live run, the new dominant per-post cost (after the v1.0.20/1.0.21
fixes) was the **comment-locate feed-scan**: `addFirstComment`'s fallback nudges the feed to lazy-render, up to 6
times per check across **two** full checks (1st load + reload), with a flat `sleep(2000)` (1200 instant) between
scans. On a silently-held post that never appears publicly, this burned ~30s only to conclude "held → moderator".

- **Ramped the render-wait** in both nudge loops: flat `2000ms` (normal) / `1200ms` (instant) → `1100/1700ms`
  (normal) and `700/1100ms` (fast/instant), shorter on the early passes. `scanFeed` re-checks the feed on **every**
  pass, so a slow-rendering public post is still located — just sooner — and a genuinely-held post gives up faster
  (~8–12s off the worst case). The wrong-post guard lives entirely inside `scanFeed` and is untouched: this changes
  only *how often* we re-check, never *what* is accepted. 242 tests green.

> Note: that logged run was executed by a stale Electron instance started **before** the v1.0.20–1.0.22 commits, so
> it still showed the 12s image-vary and 19.5s verify-reload those versions already eliminated. Restart required.

## [1.0.22] — 2026-07-08 — Capture the post link from Facebook's publish response (skip the slow feed re-scan)

The slowest, flakiest step of a comment-bearing post was **taking the post's URL**: reload the group, scroll,
caption-match, then a hover + `sleep(700)` + re-read dance to force Facebook's now-usually-hidden permalink to
render — and it *still* often came up empty (the code says so: *"FB's current DOM rarely exposes a numeric
post-id"*). The professional fix: stop scraping the feed for the link and read it straight from Facebook's own
**publish response** — the `create-story` GraphQL mutation returns the new post's id. Capture that and the whole
verify-reload is unnecessary.

### Added — opt-in, two-phase only, **default OFF**
- **Setting `capturePostLinkFromNetwork`** ("🔗 Grab the post link from Facebook's response (faster, experimental)").
  When on, `armPostIdCapture()` attaches a response listener right before the Post click, reads OUR post id from the
  create-story mutation's response (a `/groups/<gid>/posts/<id>` URL for our exact group, or a `post_id`/`story_fbid`
  field), and the two-phase flow uses it as the permalink — **skipping the feed reload/scroll/hover entirely**.
- **Wrong-post-safe by construction.** The captured id is a *candidate* only. Phase 2 opens the link and
  `forceContentVerify` requires a **positive caption OR author match on the post's own page** before commenting —
  for both the `urlId===id` and the `urlId===null` (redirect) cases — else it demotes to the article-scoped,
  caption-matched feed-scan fallback. A mis-parsed or foreign id can never blind-comment on the wrong post.
- **Held detection preserved.** A silently-held post's link resolves to a non-public page → no comment box → the
  feed-scan fallback finds it absent from the public feed → `notfound` → moderator queue, exactly as before.
- **Off = zero change.** With the setting false, `forceContentVerify` is always false and the legacy cascade is
  byte-identical; no listener is attached.

### Verified
Two adversarial-review rounds (find→refute→adjudicate, 5 vectors). Round 1 **confirmed a real wrong-post hole**:
a bad captured id could redirect the permalink to the group root, nulling `urlId`, so the content-verify was
skipped and the id-only branch could comment on the top feed post. Fixed by (a) tightening the capture regex to
our exact group id (no `\d+` wildcard) and (b) making the network path *always* require a positive caption/author
confirmation regardless of `urlId`. Round 2 confirmed the gap closed with the legitimate own-post path intact.
242 tests green.

## [1.0.21] — 2026-07-08 — Question-every-step: trim the verify/publish/caption deadlines (fast/instant)

A systematic "question every step" pass over the per-post flow (grounded in the test-log timings) confirmed the
remaining time is mostly Facebook render + safety confirms — plus a handful of over-long fixed waits *between*
re-checks. Trimmed only those: each keeps the SAME confirmation and just samples for it faster. Ten unsafe candidates
were rejected (the tested 800ms composer render floor; the clear-editor settle that guards against a double-caption;
the toast-hydration gate that catches held posts; skipping any auth/rate-limit check).

### Changed (fast/instant tiers)
- **Post-landed verify (the biggest chunk, ~19.5s):** the find-poll's inter-miss re-scan sleep 1.5s → 0.5–0.9s
  (~2–4s/group), and the "≥3 articles" pre-wait 5s → 1.5s (up to ~3.5s on a sparse feed). The caption+author
  wrong-post guard, the 16s ceiling, and break-on-match are unchanged — it just finds your post sooner.
- **Caption verify:** poll interval 400ms → 150ms (~1s), so a late-committing caption is seen a tick sooner (the
  landed test + survival re-entry unchanged); instant React-commit pad 120ms → 60ms.
- **Publish confirm (waitForPublish):** poll cadence fast 900ms → 500ms, pre-check settle fast 500ms → 200ms
  (~0.5–0.8s). The dialog-close confirmation (the double-post guard) and the timeout ceiling are untouched.
- **Post-nav settle** fast tier 1000ms → 500ms (kept a 500ms hydration floor); **dismissPopups** only settles when it
  actually clicked a popup (the common no-popup path pays nothing).

242 tests green. Every trim samples an existing confirmation faster or removes a fixed pad — no publish-confirm,
wrong-post guard, caption-drop guard, or anti-spam gap was weakened.

## [1.0.20] — 2026-07-08 — Fix the ~8s per-group image-vary stall (the "long pause after the composer opens")

Reading the test log, the long pause right after the composer opens was **image variation**: jimp's hue rotation
(a full pure-JS RGB→HSL→RGB conversion per pixel) cost ~6.5s per image on its own — the entire `varyImage` bottleneck.
Profiled and replaced.

### Fixed
- **Image varying is ~8× faster (~8s → ~1s per group).** The per-group image perturbation used jimp's
  `color([{apply:'hue'}])`, which cost ~6.5s alone (profiled: read 350ms · crop 80ms · brightness 31ms · **hue 6508ms**
  · write 488ms). Replaced with a cheap per-channel color tint — one fast pixel pass (~50ms) that shifts the color
  distribution + hash the same way. Anti-dedup is unchanged (**verified: two groups still get different images**); only
  the slow implementation is gone. Also caps an oversized source at 1600px first (FB downscales uploads anyway).
- **Honest "image varied" log.** It logged "Image varied" even when jimp couldn't read the format (notably **WEBP**,
  which jimp can't decode — those upload identical to every group = an image-dedup risk). The log now says so and
  recommends JPG/PNG. (Your active posts use JPG image URLs, which vary fine; this is a heads-up for WEBP uploads.)

242 tests green. The anti-dedup protection is unchanged — the varied image still differs per group.

## [1.0.19] — 2026-07-08 — Trim redundant steps from the posting path (INSTANT optimality)

A focused audit for genuinely UNNECESSARY/redundant steps (not just slow waits) found the posting path already lean —
only two safe removals, applied here. It correctly rejected removing the caption-accept `editableLen` re-read (a
deliberate double-caption guard).

### Changed
- **INSTANT skips the redundant Post-button diagnostic scan.** A 3rd DOM scan of the enabled Post button (already gated
  by the `waitForFunction` above and re-scanned by `clickPostButton`) ran before every publish purely to log a drift
  breadcrumb — now skipped in instant mode (kept in slow modes for troubleshooting). It gates nothing.
- **The image-first caption seed's verify result is reused when it already landed.** `enterCaptionOnce` ends by
  returning a caption-landed check, which was discarded and immediately re-run on the same unmutated editor. When the
  seed already reports landed, the loop reuses it (skipping a duplicate ~1.5s poll); a not-yet-landed seed still gets
  the full patient re-read (its internal timeout differs), so a slow-rendering caption is never re-pasted early.

242 tests green. Both changes are outcome-identical — no double-post/comment trap, wrong-post/caption guard, or
anti-spam floor touched (the audit's unsafe candidate was rejected; a timeout mismatch on the second was caught and guarded).

## [1.0.18] — 2026-07-08 — Posting speedups for the single-IP setup (safe — no anti-spam change)

With one IP the safe way to go faster is more groups/hour PER ACCOUNT, not more concurrency. A focused audit found
four overhead/pipelining wins that recover wasted time WITHOUT touching the anti-spam gaps, the v1.0.17 concurrency
cap, or any double-post/comment safety. (It also rejected the unsafe ideas — e.g. cutting the anti-spam pacing.)

### Changed
- **Multi-tab pipelining is now ON by default (`tabsPerBrowser` 1 → 2).** While an account posts to one group, the
  NEXT group's page pre-loads in a hidden tab, so slow navigation OVERLAPS posting instead of blocking it (~1.5–4 min
  saved per account per cycle at 20–30 groups). Publishing stays strictly sequential; every anti-spam gap and
  double-post trap is unchanged; it's still one browser / one live IP per account (no extra IP concurrency). Set it
  back to 1 for classic one-tab behavior, or 3–4 on strong hardware.
- **Trimmed recoverable overhead in the posting/verify flow** (not anti-spam gaps): the normal post-nav settle 3s → 1.5s
  (the auth/rate-limit checks re-read the DOM with their own waits anyway); the no-comment verify's redundant "≥3
  articles" pre-wait 15s → 5s (the find-poll that follows is the real landed-check); the direct-permalink comment
  interactivity wait 10s → 4s (the box-selector wait + retry are the real gate). ~30–90s more saved per account.

242 tests green. All changes recover overhead only — the anti-spam floors, the real-IP concurrency cap + pacing
(v1.0.17), and the double-post/comment/wrong-post guards are untouched. Validate on the dev clone that per-account
wall-time drops with delivered counts identical and no double-posts.

## [1.0.17] — 2026-07-08 — Real-IP (no-proxy) posting hardening — the main method

A focused audit of the real-IP path (the whole fleet posting from ONE residential IP — the main deployment) found
and fixed the biggest ban-risk patterns for that configuration.

### Changed / Fixed
- **Concurrency on one IP is now capped for safety, not just by RAM.** With no proxies the fleet was limited only by
  parallelAccounts/RAM — a beefy machine could run ~16 accounts posting simultaneously from one residential line (a
  coordinated-inauthentic-behavior signal). Real-IP concurrency is now capped at a small, IP-plausible default (3,
  tunable via `realIpMaxConcurrent`), independent of RAM. Your current default (2) is unchanged.
- **Real-IP launches are paced.** Completion-triggered top-ups no longer fire back-to-back into the shared IP — each
  real-IP start is spaced by a jittered gap (5–13s instant, 15–45s otherwise), so a burst of fast-failing accounts
  can't hammer the line.
- **The fleet no longer shares one browser fingerprint.** With every account on one host, only the viewport varied, so
  ~1 in 6 accounts were byte-identical (a linked-account cluster). Each account now presents a stable, plausible
  `hardwareConcurrency` (seeded by name, capped at the real core count) — the one axis safe to vary, because it has no
  contradicting HTTP client-hint header (unlike `deviceMemory`, deliberately left alone; see ADR-0001).

242 tests green. The pool changes only ever LOWER concurrency (no double-post/anti-link impact); the fingerprint change
was reviewed for HTTP client-hint coherence (the ADR-0001 captcha-loop lesson — the review caught a deviceMemory
header mismatch, which is why deviceMemory is not spoofed).

### Deferred (a dedicated real-IP pass)
- An IP-level circuit breaker (stop marching healthy reserves into an already-throttled shared IP).
- Viewport-vs-monitor geometry coherence (avoid a window larger than the reported screen).

## [1.0.16] — 2026-07-08 — Gap hunt round 2 (6 fixes: Chrome-import, licensing, Quick Setup, settings, images)

A second adversarial gap hunt on the surfaces round 1 didn't target (settings/UI, campaign-plan builder,
Chrome-import, licensing, image/media, app lifecycle) found 7 gaps; **6 are fixed here** — the 7th (a client-side
expiry re-check) was left in place deliberately as defense-in-depth. No double-post/comment invariant was touched.

### Fixed
- **Chrome import can no longer silently destroy an account.** A Chrome import whose typed label sanitized to the
  same name as a DIFFERENT, already-set-up account would overwrite that account's login cookies + credentials with
  the wrong Facebook identity. It now adopts a name-match only when the target is a genuine empty placeholder (no
  saved login/session); a real collision creates a new, distinct account instead.
- **A valid license can no longer be wrongly locked out on a transient hiccup.** Reading the machine id could
  momentarily fail (antivirus/registry lock) and fall back to a different value that read as "bound to a different
  machine" — locking out a paying customer (and even the owner) and tearing down a running overnight campaign. The
  machine id is now remembered once read, and a transient failure is treated as "re-check later," never a lockout.
- **Quick Setup can now remove an account by clearing its groups.** Deselecting all of an account's groups in the
  wizard previously left the old assignment on disk, so it kept posting to its old groups; the wizard now clears it.
- **Settings/post-set saves no longer clobber freshly auto-detected proxy timezone/locale** (a stale UI snapshot
  could revert the detected geo, leaking the host clock/language over a proxy IP).
- **A multi-image post with a missing image file is now loud and safe** — it logs the dropped file and keeps the
  library post (blocks auto-delete) instead of silently publishing fewer images and then deleting the source.
- **Login-window credential capture uses a serialized write** so it can't clobber a concurrent Chrome-bridge update.

242 tests green. The two HIGH fixes + the auto-delete gate were cleared by an adversarial verify (which caught one
follow-on defect, fixed).

## [1.0.15] — 2026-07-08 — App-wide gap hunt (11 fixes)

A full-power adversarial gap hunt across eight subsystems (find → independent refute → adjudicate) surfaced 14 real
gaps; **11 are fixed here.** The remaining 3 — a moderation-recovery write-ordering durability gap and two
daily-schedule cycle-counter durability issues — are deferred to a dedicated, separately-verified pass because they
need coordinated persisted-state + resume changes. No double-post / double-comment invariant was touched.

### Fixed
- **Comment images are no longer deleted before a reserve/moderator can use them.** With image variation on (the
  default), a live-but-couldn't-comment post handed its comment image to the rescue/moderator queue, but the temp file
  was unlinked at account end — so the later rescue failed (image-only comments lost; text+image comments lost their
  image). The image is now kept until its consumer runs, with a startup sweep reclaiming any crash-orphaned temp.
- **Two accounts holding the same post in the same group both get recovered.** A held-record dedup keyed only on
  post+group dropped the second account's card; it now scopes by poster, so both are approved and both comments placed.
- **Moderation: an approved post whose comment can't be placed is retried, not lost** (moderation is off by default). A
  transient "not in feed" no longer strands the link behind a stale "approved" record — the post is re-opened for the
  moderator (bounded to 3 re-opens, then surfaced as failed) instead of silently vanishing under a false "100% delivered".
- **Remote API hardening:** `POST /api/automation/interval` no longer 500s (leaking a stack) on an empty body, and a
  terminal error middleware routes malformed-JSON / upload-limit errors through the generic-message contract (no
  stack/path leak to a tunnel-exposed client).
- **Bulk account import validates names** (letters/numbers/underscore, like single-add) so a pasted name can't corrupt a
  profile path or inject into a card's `id` — plus those `id` attributes are escaped as defense-in-depth.
- **Proxy passwords containing `:` survive the Proxies-table edit round-trip** (were truncated on save).
- **Rapid group/pace/filter toggles can't lost-update each other** — renderer account writes are serialized.
- **Progress-ledger durability:** a corrupt ledger is quarantined instead of overwriting the good backup, and the
  in-memory rollup commits only after a successful write (a failed write no longer diverges from disk).
- **Migrated cookies land where the app reads them** (sanitized account key) so accounts with special-character names
  keep their session.
- **Reserve / moderator / re-post browsers hard-kill on a close-hang** so a stuck Chromium can't orphan on the profile.

242 tests green. Fixes touching posting/recovery paths were cleared by an adversarial multi-agent verify.

## [1.0.14] — 2026-07-08 — Per-account group membership check

A new operator tool: for any account, check whether it's actually a **member** of each of its assigned groups
*before* running a campaign — so you catch "not a member yet / pending / logged out" groups up front instead of
discovering them as failed posts.

### Added
- **"🔎 Check membership" button on each account card.** Opens a hidden browser as that account (through its own
  proxy, same identity as posting) and visits each assigned group, reporting **member / pending / not a member /
  logged out / unavailable** as a status list, with live progress in the log. Read-only — it never posts. Refuses
  to run while a campaign or a login window is using that account's profile (one browser per profile). Detection is
  tuned for the English Facebook UI (set accounts to English).

### Fixed
- **A campaign started *during* an in-flight check can no longer disturb the profile.** The worker now sees an
  in-flight membership check (a new `isCheckOpen` guard, threaded exactly like the existing login-browser guard) and
  **skips** that account for the cycle instead of force-killing the check's browser and deleting its lock files —
  which risked profile corruption. (Found by the code review of this feature.)

242 tests green.

## [1.0.13] — 2026-07-08 — Persistent rotating tab pool (ADR-0018)

Implements [ADR-0018](docs/decisions/ADR-0018-persistent-rotating-tab-pool.md). With multi-tab posting
(`tabsPerBrowser` ≥ 2), the app no longer opens a fresh browser tab for every group and throws it away —
it keeps a small pool of tabs open and reuses them by re-navigating, which is more like a real person and
avoids a constantly-churning set of Facebook tabs.

### Changed
- **Multi-tab posting reuses a persistent pool instead of a new tab per group.** Up to `tabsPerBrowser`
  hardened tabs are opened once and rotated: while a group is being posted on the active tab, an idle pool
  tab pre-loads the next group; on advance, the just-finished tab returns to the pool (it is no longer
  closed) for a later group. This preserves in-tab history/referrer continuity and a stable, small tab
  count. Tabs are recycled after ~12 navigations to avoid Facebook single-page-app memory creep. The
  two-phase comment pass shares the same pool. Publishing stays sequential; every double-post/double-comment
  guard is unchanged (they are keyed by post+group, independent of which tab is used).
- **`tabsPerBrowser = 1` is unchanged** — the pool is never grown or rotated, so single-tab behavior is
  byte-identical to before.

### Fixed (found by the adversarial verify of this change)
- **Caption could land in the wrong (idle) tab** if an adopted tab's CDP session failed to initialize: the
  session binding is now always rebound to the active tab (re-created if missing), so the caption paste and
  the off-screen window parking always target the tab being posted to — never the just-released one.
- A tab dropped mid-prefetch across the post→comment phase boundary is now closed rather than briefly
  leaked back into the next pool.

Verified by a 5-dimension adversarial pass (double-post, double-comment, tab-accounting, CDP rebind,
async races) → no double-post/double-comment/wrong-group/leak; the two non-blocking defects above were the
only findings and are fixed. 242 tests green.

## [1.0.12] — 2026-07-08 — Held-post recovery + login-cookie safety

An audit of the "held for review" recovery flow (moderator approval + backup re-post) and the manual-login window
found several gaps, fixed here.

### Fixed
- **No more duplicate re-post of a post Facebook auto-released.** When a held post is recovered by a backup account,
  the app first checks the original isn't already public. That check only scanned the top of the feed — but the
  recovery runs ~90 min later, by which time an auto-released post has scrolled far down, so the check missed it and
  the backup re-posted it (a visible duplicate). It now confirms via the post's own link directly, and its feed
  fallback is deeper and checks the poster's name — so a duplicate is no longer produced, and a *different* account's
  same-caption post can no longer be mistaken for yours (which used to strand your held post).
- **The manual-login window no longer wipes a good saved session.** Opening a login window for an account whose
  session had lapsed used to overwrite its saved cookies with the logged-out ones within 5 seconds, destroying the
  jar the app needs to auto-recover it. It now only saves cookies once the account is actually logged in.
- **The moderator no longer risks approving a stranger's held post** that happens to share a layout container with
  yours (it now refuses an ambiguous match rather than guessing).
- **End-of-run report is honest about comments.** It no longer says "every comment delivered" when a live post's
  comment couldn't be placed — it lists those posts so you can add the comment manually.
- Comment-recovery bookkeeping is scoped per account, so it can't mark the wrong account's pending comment.

## [1.0.11] — 2026-07-07 — Caption/comment content fixes (Arabic + emoji)

A focused audit of the compose→type→attach path found three content-surface gaps, all fixed here.

### Fixed
- **Emoji in captions/comments no longer get garbled.** The human-like typing split text into fixed-size chunks
  by UTF-16 code unit, which could cut an emoji in half at a chunk boundary and publish a broken "�" where the
  emoji should be — and, worse, that corrupted caption then couldn't be matched to place its comment. Typing now
  chunks by whole characters, so emoji (and emoji + Arabic together) always come out intact. **Important for
  Arabic captions carrying emoji.**
- **An image-only comment is no longer counted as "sent" when Facebook silently drops its image.** The app now
  waits for the image preview to actually appear; if it doesn't, that comment is handed to a backup account
  instead of pressing Send on an empty box.
- **A caption template that randomly evaluates to empty no longer stops a healthy account.** If your caption uses
  spintax with an empty option (e.g. `{صباح الخير|}`) and it happens to pick the empty side for a group, the app
  now re-rolls, and if it's still empty with no image it skips just that group with a clear "fix the caption
  template" message — instead of opening a blank composer that used to be mistaken for an unsupported-language block.

## [1.0.10] — 2026-07-07 — Two-phase comment pass: pipelined + direct-to-post

Completes the **"Post everything first, then comment"** mode so its comment pass is as fast and reliable as the
posting pass.

### Changed
- **Each comment now goes straight to its post.** When posting in two-phase mode, the app captures each post's own
  link as it publishes, so the comment pass opens the post **directly** instead of reloading the group and
  re-finding the post by its caption — faster, and far more reliable when many accounts post similar captions.
- **The comment pass is pipelined.** While one comment is being placed, the next post's page **pre-loads in a
  background tab** (using the same "parallel group tabs" setting as posting), so the pass no longer stalls waiting
  for each page to load. A post whose link couldn't be captured falls back to the old feed-scan for just that one.

Verified (before and after) not to double-comment or comment on the wrong post: a pre-loaded tab is only ever used
for one post, is re-checked to be *your* post before commenting, and a retry always re-navigates; single-phase and
single-tab behaviour is unchanged.

## [1.0.9] — 2026-07-07 — Owed-groups × rest × reserve interaction fixes

A cross-feature audit found two cases where a dropped account's un-reached groups could still be silently skipped —
each only happening when the "rest a blocked account", "owed-groups ledger" and "reserve takeover" features combine.

### Fixed
- **A rested account's owed groups are never dropped.** If an account partially delivered a post, then got blocked
  and was rested, a backup account used to be handed the *next* post — and the un-reached groups of the earlier post
  were silently forgotten. Now a backup finishes the **owed** post first (to only the missed groups), and the ledger
  can no longer be cleared by work done for a *different* post.
- **An account stuck on an unrecognised language still gets its groups covered.** An account that can't post
  (unsupported Facebook UI language) never recovers on its own; its owed groups are now handed to a backup account
  instead of waiting forever. (Also: set such accounts to English — see the run-book.)
- **A backup account that hits a comment block now rests** instead of being re-picked into the same wall next cycle.

These paths were verified (before and after the fix) not to double-post: a backup only ever delivers a post to a
group that hasn't received it, and an owed post is finished by exactly one path.

## [1.0.8] — 2026-07-07 — Multi-account fix for the owed-groups ledger

An adversarial re-audit of the 1.0.7 ledger caught a regression before it shipped, fixed here.

### Fixed
- **Two accounts can share a group again in Daily Rotation.** 1.0.7's new per-group delivery ledger was tracked
  fleet-wide, which was correct for the one-post-per-group modes but wrong for Daily Rotation: if two accounts were
  assigned the **same group** and landed on the **same post** the same day, whichever posted first "claimed" the
  group and the **second account silently, permanently skipped it** — the exact silent-miss the ledger was meant to
  prevent, for the most common multi-account setup. The ledger is now scoped **per account** for Daily Rotation
  (each account independently posts to its own groups) while the one-post-per-group modes stay fleet-wide. Every
  read and write of the ledger uses the same scope, so a delivered group is never re-posted and an un-reached one is
  never dropped.
- **Correct daily count when backups split the work.** When several backup accounts each cover part of a dropped
  account's un-reached groups, the covered account's daily-post count is now incremented once (not once per backup),
  so it can't be wrongly blocked from the rest of its configured daily posts.

## [1.0.7] — 2026-07-07 — Persistent owed-groups ledger (no silently-skipped groups)

Closes the two partial-delivery gaps deferred from the 1.0.6 audit. When an account in **Daily Rotation** or
**Campaign Plan** posted to *some* of its groups and then dropped mid-run (logged out, checkpoint, crash), the
un-reached groups could be permanently skipped: the account's rotation pointer advanced as if the post were
finished, so nobody ever delivered it to the groups it missed. The fix carries that unfinished work forward
without ever re-posting a group that already got the post.

### Fixed
- **A partial delivery is never silently lost.** Every group an account was supposed to reach with a post is now
  tracked. If it reaches only some and then drops, the un-reached groups are remembered (a persistent "owed"
  ledger saved with the rotation state) and finished on the next cycle/day — either by the account itself or by a
  healthy backup account — targeting **only** the groups that were missed.
- **Never a double-post on the retry.** The groups that already received the post are excluded from the owed set,
  so finishing the remainder can never re-post to a group that already has it. Daily-rotation now also uses the
  same per-post/per-group delivery ledger the other modes use, so even a mid-run browser crash-and-retry can't
  double-post a group it already reached.
- **Pacing is unchanged.** Still one post per account per day (or your configured amount): a partial delivery
  finishes its owed groups *before* the account moves on to the next post, and it never posts more than its daily
  quota. When nothing is owed (the normal case) behaviour is byte-for-byte identical to before.
- **Campaign completion waits for owed work.** A campaign no longer reports "100% delivered" (or reshuffles a new
  round) while any group still owes an earlier post.
- Un-assigning a group from an account safely drops any owed work for that group (no stuck rotation).

## [1.0.6] — 2026-07-07 — Posting-engine robustness (failure handling)

An adversarial audit of the whole post/comment flow and every account-failure recovery path. Each fix was
independently re-verified for double-post / double-comment / lost-comment / deadlock safety.

### Fixed
- **No double-post on a slow publish.** A short or image-only post that took a long time to publish (common with
  many browsers on one home connection) could be misread as "failed" and then re-posted by a backup account. The
  app now waits and re-checks that the composer actually closed before ever concluding a post failed.
- **No double-comment after a rate-limit.** If Facebook showed a comment-limit message *right after* a comment
  actually posted, the app used to treat it as un-posted and a backup account re-commented. A comment that landed
  is now never re-placed, while the account is still rested.
- **Blocked accounts are no longer hammered.** A checkpointed / logged-out / disabled account used to be
  re-launched — and, if it had a saved password, re-submit the login form — **every cycle** (a real ban risk).
  It now rests (3h logged-out / 6h checkpoint / 12h disabled), a backup account covers its groups, and it rejoins
  automatically the moment it recovers (a single successful post clears the rest immediately).
- **Two-phase posting no longer keeps trying to comment through a disabled account.**

### Added
- **Arabic detection fallback.** The app already recognized Facebook's rate-limit / checkpoint / "pending review"
  / Post-button / comment-box text in English, French, Spanish, German, Italian, Portuguese and Hungarian; it now
  also recognizes the common Arabic wording. **Recommended:** set your accounts' Facebook language to English for
  the most reliable detection — this is a safety net for any that aren't.
- **"Unsupported language" guard.** If the Post button can't be found on two groups in a row (the signature of a
  Facebook UI in a language the app doesn't recognize), the account is flagged with a clear "set it to English"
  message and its groups are covered by a backup account — instead of silently posting nothing.

### Known / next
- Partial-delivery coverage in *daily-rotation* and *campaign* modes when an account drops mid-run after posting to
  only some groups: safe fix requires a persistent per-group delivery ledger (in progress) so retries never re-post
  an already-posted group.

## [1.0.5] — 2026-07-07 — Two-phase posting (post all, then comment all)

### Added
- **Post-then-comment mode** (Settings → "📝➡️💬 Post everything first, then comment"). Opt-in, off by default. Each
  account posts the image+caption to **all** its groups first, then makes a second pass to place every post's first
  comment. The time spent posting the other groups **becomes the wait before commenting**, so the per-post
  comment delay is absorbed for free — and **every post lands before any comment work**, so an interrupted run
  never leaves posts un-made. Combines with the parallel-tabs prefetch for a further speedup.

  Safety (verified by an adversarial audit across double-post, double-comment, lost-comment, and regression):
  the post still publishes and is marked delivered at the same instant as before (so a post can never be made
  twice), the comment pass never re-types a submitted comment, held ("Spam potentiel") posts and any blocked or
  interrupted comment route to the reserve/moderator queues exactly like the classic per-group flow (a post is
  never left without its link), and with the setting off the per-group behavior is unchanged.

## [1.0.4] — 2026-07-07 — Pre-launch reliability audit

A 9-dimension adversarial audit of the whole 1.0.3 candidate (each finding cross-checked by an independent
skeptic panel; each fix independently regression-reviewed). Double-post safety, the multi-tab pipeline, the
store write-chain, the IPC surface, and the Chrome-group auto-assign all came back clean. Six real defects were
fixed — the top two matter most for an unattended client run:

### Fixed
- **License never locks out a valid customer on an I/O blip (critical).** A transient lock on `license.json`
  (Windows Defender / OneDrive / the search indexer scanning the data folder — or the app's own license-cache
  rewrite) used to read as "not licensed": at the ~6h re-validation it **stopped a running overnight campaign**
  and popped the activation window; at launch it dropped an already-activated customer to the activation screen
  (also blocking crash-resume / auto-start). The re-validation now keeps the last-known-good license and retries;
  launch retries briefly, then opens provisionally and re-verifies within ~2 minutes. Only a genuinely absent or
  invalid/revoked license ever gates the app. (The owner key still activates offline/unlimited.)
- **No more silent "saved!" on a locked data file (high).** Editing an account (assigned groups, credentials,
  alias) while `data.json` was briefly locked would show "Account updated successfully!" but **discard the edit**.
  The save now surfaces the skip ("not saved — retry in a moment") instead of a false confirmation; on-disk data
  was never at risk, but the operator no longer loses an edit believing it saved.
- **Concurrent remote-pushed posts are never dropped.** A full-window save from the UI no longer overwrites the
  post/group library — posts pushed by the remote API (`POST /api/posts/bulk`, including `replace`) while the
  window is open are preserved, and a group added in the background is merged back rather than clobbered.
- **License gate covers the remote login endpoint.** The remote API's per-account login now refuses on an
  enforced build that isn't activated (matching the automation-start gate); its response reports the block
  truthfully instead of a misleading "login window opened".
- **Big-run concurrency no longer serializes on a momentary low-memory reading.** The RAM-based pool ceiling is
  re-read as each slot frees instead of frozen once per cycle, so a single low free-memory snapshot at cycle
  start can't drop a 400-account cycle to one-at-a-time; it still throttles down under genuine memory pressure.

## [1.0.3] — 2026-07-06 — Import from Chrome (session onboarding)

Onboard accounts that are already logged in as Chrome profiles, carrying their **device identity** so the
switch to the app doesn't trip a "new device" checkpoint.

### Added
- **Import from Chrome** (Accounts → 🌐 Import from Chrome). A tiny companion extension (generated per-install,
  localhost-only, token-gated) reads each profile's full Facebook cookie set — **including `datr`** — via Chrome's
  own `chrome.cookies` API and sends it to the app, which creates/updates the account (keyed by the FB id, so
  re-sending never duplicates) and stores the encrypted jar. The app's own Chromium then runs the account with the
  same device + session on the same IP — no re-login.
- Reads your Chrome profile labels (e.g. `BB24`) for naming, and a live import counter.

### Hardening (adversarial audit of the feature)
- **No overwrite-by-collision**: importing a profile whose label sanitizes to an existing account's name can no
  longer hijack that account (rebind its FB id / overwrite its cookies & login). A collision now creates a new,
  disambiguated account; only the *same* Facebook account (matched by id) updates in place.
- **Logged-out detection**: an import missing Facebook's `xs` session cookie is flagged loudly ("arrives logged
  out — re-send while logged in") instead of a silent success; empty cookies are dropped.
- **Token stability**: if the bridge token can't be saved, the app warns that the helper will need re-generating
  after a restart (instead of silently rejecting every import).

### Why an extension (not a folder copy)
- Chrome 127+ **App-Bound Encryption** seals session cookies (`c_user`/`xs`) so only the running Chrome can decrypt
  them — a raw profile-folder copy or direct DPAPI/SQLite read lands the account **logged out**. The in-Chrome
  extension is the only reliable path; it's also future-proof against Chrome's ongoing anti-extraction hardening.

## [1.0.2] — 2026-07-06 — scaling + reliability pass

Toward the 400-account client deployment. Focus: **never miss a post from a small error**, and
scale one machine to hundreds of accounts. 205 unit tests + 27 anti-spam checks green.

### Reliability — never miss a post
- **Caption retyping/loss fixed.** The composer text is now read from the marked editor exclusively
  (whole-doc fallback only when unmarked), so a draft can no longer spoof "caption landed" and the
  post no longer publishes with a half-typed or empty caption. Caption-after-image survival loop
  re-enters the caption if FB clears the draft.
- **Caption-less image post guard.** If every caption-entry path fails on an image post, the run
  retries pre-publish instead of publishing the image alone and counting it a success.
- **Comment landing hardened.** Send-button fallback, focus-before-Enter, box-resolution rescue
  (no-button / zero-bounds / click-fail), and a **second feed check** when the post isn't found on
  the first pass — so a comment that didn't attach is retried, not silently dropped.
- **Feed-confirmed labelling.** A post the verify-reload can't find in the feed is reported as
  "publish confirmed but not feed-confirmed (may be in Spam potentiel)" instead of a flat success.

### Scale — hundreds of accounts on one machine
- **Bulk account import** (cookies + optional proxy/credentials): safe filenames, de-duplication,
  and a per-account cookie jar written on import.
- **`datr` device-cookie warning.** Imports (bulk and single) now flag accounts missing Facebook's
  `datr` cookie — they log in but look like a new device (more checkpoints) — so weak exports are
  caught before those accounts run.
- **Real-IP concurrency.** No-proxy accounts (the operator's own residential line) now run
  concurrently up to `parallelAccounts` instead of one at a time; proxy accounts stay strictly
  one-per-distinct-IP (anti-link).
- **Hardware-aware pool sizing** (free-RAM + CPU-core ceiling) so a large fleet can't oversubscribe
  the machine.
- **Large-fleet UI**: account list virtualization (renders a capped window with an "N more" notice)
  and debounced data-update refresh.

### Pre-launch audit hardening (adversarially verified — 9 confirmed defects fixed)
- **Reserve-takeover no longer hangs.** The end-of-cycle reserve-takeover pool could spin at 100% CPU
  forever (event loop starved, no Stop) when two queued reserves shared one proxy IP — it now breaks
  the fill loop and waits for a slot, matching the main pool.
- **Bulk import can't report false success.** If `data.json` was transiently locked (AV/sync/indexer),
  the save was silently skipped while the UI said "imported N" and cleared the paste — the importer now
  fails loudly and keeps the paste so the operator can retry. Cookie-write failures are counted/surfaced.
- **Bulk "assign groups" actually assigns.** It was wired to a backend action that didn't exist, so it
  reported success while changing nothing — now implemented (add/replace), verified end-to-end.
- **Bulk-action toasts tell the truth.** A batch that matched 0 accounts no longer shows a green success.
- **Caption-after-image can't drop the caption.** The image-first fast path is seeded/marked before the
  survival check, so a stray editor (Messenger draft, feed composer) can't spoof "caption landed" into
  publishing an image-only post.
- **Publish-timeout feed rescue is author-aware** — a genuinely-failed post is no longer confirmed by
  another account's identical-caption post (wrong-post guard at scale).
- **Remote `/api/posts/bulk` persists again** — the hook was unwired (silently dropped every pushed post).
- **Manual Start posts now** — the one-shot daily-quota bypass is spent by the real run, not the read-only
  plan preview, so a daily/campaign account that already posted today still posts on a manual Start.

### 400-scale hardening
- **Disk-space preflight**: warns at Start (and periodically, throttled) if the drive can't hold ~400
  account profiles — a full disk otherwise halts posting fleet-wide via ENOSPC with no warning.
- **Live-ops IPC coalescing**: the per-account dashboard snapshot (a 400-element array) is now emitted
  on a leading+trailing throttle instead of on every state tick, so it stops stealing CPU from the pool;
  the in-memory state stays synchronously current so no update is lost.
- **Per-cycle write elision**: a no-op account outcome (reserves, already-posted-today, skipped) no longer
  triggers a full `data.json` rewrite — only real deliveries and flags persist (immediately, unchanged),
  removing the bulk of per-cycle write amplification with zero durability loss.
- **Daily cap aligned to the local day**: the per-account daily cap now uses the local calendar date, so it
  agrees with the local-day posting pace and schedule (no ~1h near-midnight straddle); the monotonic
  forward-only rollover still blocks a backward-clock reset.

### Delivery
- In-place upgrade: first-run migration seeds from a prior userData name only when the new one is
  empty (never overwrites existing data); per-seat license enforcement via a build-time marker;
  portable-zip deliverable.

## [1.0.0 – 1.0.1] — 2026-06 → 2026-07 — hardening + first client delivery

Twelve find→verify→fix hardening sweeps (~37 fixes) that converged to zero new confirmed faults,
plus the first packaged delivery. Highlights: read-vs-parse data-loss protection (data.json +
license.json no longer quarantine a good-but-locked file), all browser/proxy close paths bounded
against hangs, cross-phase record-lifecycle leaks closed, license lockout of a legitimate client
fixed (transient-lock + backward-clock grace), anti-detection leak audit (real-IP/WebRTC + proxy
geo consistency, non-forging), profile-first session persistence (stop clobbering a fresh session
with a stale cookie snapshot), and observability for multi-hour runs. Delivered as
`Za-Post-Comment-Tool-1.0.1-portable.zip` (per-seat enforced, non-bytenode).

## [Unreleased] — completion pass (M1–M4)

A reliability/security/quality pass taking the app toward a complete, shippable product. Full item
list and rationale in `COMPLETION_PLAN.md`; architecture in `CODEBASE_MAP.md`.

### Reliability
- Image upload now retries and **aborts the group instead of silently publishing an image-less post** (post + comment + URL paths).
- A **rotation-state write failure halts the run** instead of risking duplicate posts on resume.
- Per-account **daily cap is UTC + monotonic** — a clock change can't reset it.
- **Per-account Chromium profile-lock recovery** before each launch (a force-killed browser no longer bricks the next run).
- **Per-account crash backoff** — a crash-looping account is skipped and flagged, not run forever.
- **Connectivity probe** is interruptible with a longer window (no false-offline stalls).
- Store/audit write failures are **surfaced**, not swallowed; a concurrent status check can't wipe a live rate-limit/checkpoint flag.

### Facebook automation
- Composer / post-button / comment-box / rate-limit / checkpoint / pending detection **broadened across 7 locales** + URL/DOM cues, with one tested source of truth and **selector-drift logging**.

### Licensing
- **Per-seat tiered licensing enforced in the backend** (not UI-only); **7-day offline grace**; 3s validation timeout.
- VPS server: per-IP **rate limiting**, `/health`, **Bearer-token admin**, **AES-256-GCM encrypted key store** + audit log.
- `gen-key.js` takes a tier; `revoke.js` has graceful, distinct exit codes.

### Security
- **FB credentials encrypted at rest** (Electron safeStorage / DPAPI); transparent decrypt, legacy plaintext still works.
- **SSRF guard** + size/content-type limits on remote image downloads.
- **Proxy + cookie-import validation**.
- **Tunnel access token no longer written to logs.**

### Quality / build / docs
- `npm test` suite (node:test) — 50+ unit/integration tests across 11 suites.
- Fixed the spintax `variantCount` **nested-alternation overcount bug**.
- **Reproducible portable build** (winCodeSign version auto-detected, no hardcode).
- **GitHub Actions CI** (test + portable build) and a VPS image workflow.
- Settings: warm-up runs + cool-down hours now editable; **"Finish after batch"** control; live attention badges.
- Docs: `ENV.md`, corrected `OPERATIONS.md` licensing section, migration defaults aligned to the app.

### Still open (need owner input or are manual)
- Confirm the live **HTTPS** endpoint for `DEFAULT_SERVER` and the plaintext owner key.
- **Code-sign** the desktop build (`CSC_LINK`/`CSC_KEY_PASSWORD`) — needs a certificate.
- **At-scale live verification** (M4-10) — a real multi-account/multi-group run.
