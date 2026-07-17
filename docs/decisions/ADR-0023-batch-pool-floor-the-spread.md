# ADR-0023: Batch/Pool — floor the spread, unbind the pool, earn the ledger

- **Status:** Accepted (direction). Phases 1–4 approved; Phases 5–6 **evidence-gated and may correctly never ship.**
- **Date:** 2026-07-17
- **Deciders:** owner + engineering
- **Relates to:** ADR-0019 (campaign plan frozen within a round), ADR-0020 (interchangeable account pool — superseded by this), ADR-0021 (**rejected** — owed ledger for unique/sequence), ADR-0022 (owed-ledger coherence)

## Context

The owner's goal, in their words:

> *"the main idea is we only care about putting the 100 posts in that batch of groups, that all. find the way to only optimise this, and that will add to the ability of scale of the app, as it have clear work."*
> *"the reserve is already include in the system, as in a batch of groups each account work and other are waiting, so we could start low for new account and add more and more with time."*

A **batch** = { a set of groups, a set of posts, a pool of accounts }. The only goal: every `(post, group)` pair delivered **exactly once**. The reserve stops being a feature and becomes *depth* — accounts not currently delivering **are** the reserve. This is a better model than what the code has, and it is the accepted direction.

### The evidence that reshaped the plan

A design pass produced five candidate designs. All five — **and the engineer briefing them** — reasoned from defaults. Reading the live files (`data.json`, `run-report.jsonl`) refuted six shared premises. The four that matter:

1. **"~19 healthy accounts were idled by the planner."** FALSE. Exactly **five** were (`a2, d4, e4, c5, d5`), proven by simulating Pass 1+2 over the real roster (25 campaign accounts, 2 groups each, 10–13 distinct groups, 30 posts, clusters K=[6,5,5,5,4], globalMaxLen=8). The rest were **rate-limited or erroring** (`c1/c3/c4` carry `rateLimitedUntil`; b1 16 err, a3 13, d1 11 — that is the run's 57 errors). On 2026-07-14 **all 27 accounts posted**, zero idle.
2. **"The ~30s anti-spam floors are the ceiling / the protection."** FALSE. The fleet runs `speedMode:'max'`; `lib/speed.js:25` maps **max → 'instant'**; `worker.js:3987/4166` = `speedMode === 'instant' ? rand(100,1000) : withFloor(...)`. The gap is **0.1–1.0s and `withFloor`/`antiSpamFloors` are never called**. With `realIpMinPostGapSec:1` and `dailyCap:0`, **the ban budget is already spent** — the throttles and rate-limits are the bill.
3. **"~100 posts/hour, gap-bound."** FALSE. 2026-07-14: **1438 publishes / 402 min = 215/hr** at 3 concurrent ⇒ ~50s per publish of which **~0.55s is gap**. **~99% is real work** (nav, composer, upload, publish, comment). Cutting delays buys nothing.
4. **"`realIpMaxConcurrent` is the throughput lever."** FALSE. `orchestrator.js:2391` `_livePoolTarget = min(_wanted=parallelAccounts=3, _proxyCeil=5, _liveHwCeil=14)` → **`parallelAccounts=3` binds**; `realIpMaxConcurrent=5` is inert.

**The decisive consequence:** the pool is **concurrency-bound at 3**. A pull-dispatch rewrite therefore adds **zero** throughput. Its entire prize is five benched accounts. That inverts the ordering: do the cheap, reversible things first and let evidence decide whether the rewrite is ever justified.

There is also a deeper defect to *measure* before rewriting anything: Pass 2 paces the library over `globalMaxLen` **days** assuming "1 post/day" (its own comment at `orchestrator.js:3733`), but at `cyclesPerDay=20` a slice burns in under a day and every agent then idles at `:831` until the slowest finishes.

## Decision

**Adopt batch/pool as the direction; reject it as the opening move.** Six phases. Phases 1–4 delete nothing and touch no delivery guard.

| # | Phase | Ships alone |
|---|---|---|
| 1 | **`campaignMinAgents`** — floor `Keff` so the planner stops benching agents | ✅ |
| 2 | **N-cycles-in-ONE-process harness + per-account idle attribution** | ✅ |
| 3 | **Unbind the pool** (`parallelAccounts` binds — *not* `realIpMaxConcurrent`) | ✅ |
| 4 | **Per-account ramp** that can only **lower** an allowance | ✅ |
| 5 | Durable pair-ledger in **shadow**, behind its **own persisted `_batchEpoch`** | evidence-gated |
| 6 | Pull-dispatch behind `postingOrder:'batch'`, opt-in, one batch at a time | evidence-gated |

### Phase 1 — the mechanics that make it safe

- One expression: `orchestrator.js:3749` `Keff = max(1, min(K, ceil(cPosts.length / globalMaxLen)))` → floor it with the new setting. The `min` with `K` means it can never invent a seat.
- The partition property holds for **any** `Keff` (`idx % Keff === rank`; ranks `0..Keff-1` non-empty, the rest `[]`). Verified by execution over the live topology (P=30, globalMaxLen=8): K=4/5/6 → **30/30 covered, 0 dupes, 0 empty**.
- **It lands with NO fingerprint change and NO Start Fresh.** `loopCampaign=true` is live and `orchestrator.js:3339` recomputes the plan **unconditionally** at each round boundary from live settings, never consulting `batchId`. With a 6–8 post slice at `cyclesPerDay=20`, the boundary arrives **every ~1–2 hours**. ADR-0019's freeze stays intact.

## Rejected (with reasons — do not re-tread)

- **Big-bang pull-dispatch as Phase 1.** Rewrites a 3,900-line crown jewel that has produced a HIGH double-post on nearly every recent change — to fix five benched accounts, while adding zero throughput (pool bound at 3).
- **Adding the dial to the `batchId` fingerprint (`:3769`).** `batchId` is **durable** and compared **across versions**. Any formula change makes every persisted plan mismatch forever — permanently disabling the parked-slice restore (`:3837`) and firing the re-burst prompt (`:3845`) on upgrade, unprovoked. Unnecessary: `:3339` recomputes unconditionally.
- **"Stop → edit → Start applies the dial."** `orchestrator.js:1953` reloads the persisted plan → `_reconcileCampaignPlan` takes the **freeze** branch. The code refutes this verbatim at `:3847-3850`. Repeating it walks the operator to Start Fresh = a whole-library re-burst.
- **`_roundOffset` as the ledger epoch.** Two writers (`:3323` campaign reloop, `:2228` unique/sequence recycle) plus a disk reset at `:2229`. A unique account exhausting its library would purge the campaign's ledger; a ledger-authoritative dispatch would then read the empty set as *"the whole library is undelivered"* → full-library re-burst. Phase 5 mints a **private persisted `_batchEpoch`** instead.
- **Naming the dial `groupPostsPerDay`.** Pass 2 **skips** the pace-setting cluster (`if (curLen >= globalMaxLen) continue`, `:3748`), so such a dial cannot govern the one cluster guaranteed to exist.
- **`realIpMaxConcurrent` as the speed lever.** Dominated by `parallelAccounts` in the `min()`.
- **Deleting `_campaignStandins` / `_owedStandins` / `_splitCover` / `_owed` early.** They encode real scars (the gids fix at `:2424` is v1.0.127; the CONSUMED rule at `:3868`). Gated behind 30 days of live batch-mode operation.
- **Raising `cyclesPerDay` for throughput.** Already 20 — and it is what collapses Pass 2's day-model.

## Consequences

**Good.** The owner's bleeding wound (benched accounts) is fixed by a one-expression change that lands within ~2h, with no re-burst and no data migration. Attribution (Phase 2) ends the guessing that made both owner and engineer misread 5 as 19. Phase 3 addresses the throughput lever that actually binds. Every phase is independently releasable and reversible.

**Accepted cost.** The batch model's elegance is deferred. That is deliberate: it buys nothing measurable until the pool is unbound, and it would be bought with the most dangerous refactor available.

**Testing note.** The crash-fold reconciles durable state from the journal on **every process start**, so stale in-memory state is silently cleared on restart. Any test that models "the next cycle" as a **new process** watches a bug self-heal — a fully green suite has repeatedly coexisted with live recurring double-posts. Every phase must be tested **across N cycles in ONE process**. That harness is Phase 2 precisely because nothing after it is trustworthy without it.

## Operator decisions (not engineering's to make)

- **The floors are off.** `speedMode:'max'` bypasses the anti-spam floors; `realIpMinPostGapSec:1`; `dailyCap:0`; `cyclesPerDay:20`. 215/hr may be a deliberate trade — but it is a **business risk the owner owns**, and it explains the throttling. The honest engineering move is to offer to **undo** it, not to quietly tune around it.
- **Proxies.** One proxy for many accounts moves the correlation, it does not remove it: Facebook links on the IP, and the anti-link gate then serializes on that host — so throughput does not improve either.

## Open risks (need a live run to settle)

- Whether flooring `Keff` re-introduces the burst that the spread was written to prevent — at `cyclesPerDay=20` the day-model is already broken, so this must be **measured**, not assumed.
- Whether the five benched accounts are healthy enough to add throughput, or merely add exposure on one IP.
- Whether Phase 3's real ceiling is hardware, Facebook, or the IP.
