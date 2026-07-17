# ADR-0020: Interchangeable account pool — weighted shared-pool posting (evolve unique/sequence, not campaign-plan slices)

- **Status:** Superseded by [ADR-0023](ADR-0023-batch-pool-floor-the-spread.md) — the direction is retained; the opening move is not. Live data showed the pool is concurrency-bound at parallelAccounts=3, so pull-dispatch adds ZERO throughput; ADR-0023 sequences the cheap reversible wins first and gates the rewrite on evidence.
- **Date:** 2026-07-16
- **Deciders:** owner + engineering

## Context
The operator wants to treat the accounts that share a set of groups as **fungible "writers"**: a "batch" is *a set of groups + a set of posts + a pool of accounts*, and WHO posts which post should not matter — the pool collectively drains the post-set into the groups, respecting cooling/limits, and accounts can be added / removed / **swapped freely**. They are account-limited today and need that flexibility; they also want an **unequal share** (older/established accounts post more) and **same-cycle pickup** so a healthy account drains a backed-off account's groups even with no designated reserve.

The current **Campaign Plan** mode is the opposite of this: each account gets a FIXED per-round slice (`_campaignPlan.agentLists`) that is frozen within a round (ADR-0019), so a roster edit defers to the next round and account management feels rigid. Meanwhile the existing **unique/sequence** mode already IS the fungible model: `_postsForAccount` builds `remaining` = posts not in the fleet-wide `_dealt` set and not in the per-cycle `_claimed` set; any account claims any undelivered post; the positional deal falls through to the first still-available post so a healthy account is never idle while content waits; and a **partial** delivery re-pools automatically — a post is added to `_dealt` only on FULL delivery, so an owed (post,group) pair stays claimable by ANY account next cycle while the per-(post,group) guards (`alreadyDelivered`/`_inflightDelivered`) prevent re-posting a reached group. A batch is expressible today as accounts sharing one `postSetId` + one `assignedGroups` set in unique/sequence (post-set filtering runs before `_dealt`, so multiple batches never contend).

## Decision
Build the interchangeable pool as an **evolution of unique/sequence**, not an extension of campaign-plan slices, and not a new mode. Add three layers, smallest-first:

- **P1 — Weighting (unequal share).** `account.weight` = f(account age, `priorRuns`) with a per-account manual override; bias the claim order and allow a weighted account to claim **>1 post/cycle**, HARD-CAPPED by the v1.0.92 daily-cap accounting and the per-action anti-spam floors. A limited account's share redistributes to healthy accounts for free (the pool is shared). Touches `_postsForAccount` (unique branch) + `_dailyQuotaBlocks`; new state = `account.weight` only.
- **P2 — Same-cycle pool pickup.** When a pool account backs off (limit / pushback / needs-login), a healthy pool account drains its remaining un-dealt pairs THIS cycle — generalize `_campaignTakeover`/`_campaignStandins` to the unique pool. (This is Issue-2 #4.) Minimal new state — owed pairs already re-pool.
- **P3 — First-class batch.** A named `batch` = {groupSet, postSet, accountPool} in `store.js` (+ migration from per-account `postSetId`/`assignedGroups`), with UI to add/remove/swap accounts as one unit.

## Alternatives considered
- **Extend campaign-plan slices** — rejected: slices are frozen per round (ADR-0019); a roster edit re-partitions and defers, and it would mean rebuilding the reserve/takeover subsystem just to *simulate* the fungibility unique/sequence has natively.
- **A new posting mode** — rejected: it would duplicate the shared-pool + `_dealt` + `_owed` machinery that already exists and is battle-tested.

## Consequences
- **Swap-freedom is nearly free** — the pool is keyed on post-ids, not per-account slices, so add/remove/swap of an account triggers ZERO re-partition.
- **Weighted volume and same-cycle pickup INCREASE per-IP burst risk.** Both MUST stay gated by the daily-cap accounting, the ~30s anti-spam floors, and single-IP serialized pacing; aggressiveness is **proxy-gated** (parallel/fast only across DISTINCT proxies). Reinvest reclaimed time into warming, not raw speed.
- The load-bearing **ban-safety invariants are unchanged** — this changes only the account↔post assignment, never the pacing, the per-(post,group) no-double-post guards, the rate-limit rest ladder, or the no-mid-round-re-burst rule (ADR-0019).
- **P1 is the smallest real-behavior change** — ship it first behind the daily-cap ceiling and validate on a live run before P2/P3.

## References
- `automation/orchestrator.js` — `_postsForAccount` (unique branch), `_dailyQuotaBlocks`, the reserve-takeover pass.
- `lib/store.js` — `account.weight` (P1); a `batch` entity + migration (P3).
- ADR-0008 (owed ledger), ADR-0009 (run-to-completion engine), ADR-0019 (campaign frozen within a round).
- MEMORY: posting-plan-redesign-direction.
