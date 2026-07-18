# ADR-0021: The persistent owed ledger covers unique/sequence too — the fleet-wide dealt-set is a pointer, and a PARTIAL must stay recoverable

- **Status:** ❌ **REJECTED / REVERTED in v1.0.112** (was: Accepted, implemented in v1.0.110 — live for ~1 hour, never shipped)
- **Date:** 2026-07-16
- **Deciders:** owner + engineering
- **Amends:** ADR-0008 (owed ledger, previously scoped to the per-agent-pointer modes)
- **Superseded by:** ADR-0022 (owed-ledger coherence: one predicate gates both producer and consumers)

> ## ⚠️ REVERTED — read this before re-attempting
>
> This design was implemented (v1.0.110), then **reverted in v1.0.112**. The reasoning below about the *problem* is
> sound and worth keeping. The **solution is not** — and re-attempting it naively will get the fleet banned.
>
> **What happened.** An adversarial audit of the implementation returned **11 confirmed findings, 7 HIGH — five of them
> recurring double-posts** on the one shared IP: a delivered `(post,group)` re-posted **every cycle, forever**. One HIGH
> was found and patched first (v1.0.111); the *next* audit found five more, two of which **bypassed that patch**. The
> defect rate went UP after patching, not down.
>
> **Why the whole suite stayed green (the trap).** The crash-fold reconciles `this._owed` from the journal on **every
> process start**, so a stale ledger entry is silently cleared on restart. Any test — or reviewer — modelling "the next
> cycle" as a **new process** sees the bug self-heal. Duplicates only accumulate in a **healthy days-unattended run**:
> the fold runs once, then cycles continue in the same process with stale state. **Crashes self-heal; health
> accumulates** — i.e. the failure targets precisely the product's purpose. 18 tests + 370/370 green missed all of it.
>
> **The root cause is architectural and PRE-DATES this ADR.** The ledger's **consumers** (`_hasPersistentOwed`, the
> persistent-owed synthesis, `_owedStandins`, `_owedSelf`) were **mode-agnostic**, while the **producer** of its
> discharge record (the `_cycleObligation` gate) was **mode-restricted**. An entry whose owner cannot discharge it is
> therefore **immortal**: nothing prunes it, no obligation is recorded, `_reconcileOwedFor` early-returns on `!ob`, and
> the synthesis re-dispatches the identical gids to a reserve every cycle — while a stand-in has `_uniqueSeqGuard=false`,
> so only the per-cycle `_cycleDelivered` guards it. Extending the ledger to unique/sequence did not create this hole; it
> **multiplied its blast radius** from "a pointer agent whose mode was flipped" to "every unique agent on a unique fleet".
> See ADR-0022 for the coherence fix, which is retained.
>
> **Why the problem is not worth this risk.** Measured on the owner's own finished campaign: **17 of 1491 pairs (1.1%)**
> permanently lost, all in the shared-IP throttle tail — and the **same-cycle** reserve cover (`_cycleOwed`, unchanged
> and dry-verified) already recovers most partials. This ADR only added **cross-cycle** carry: a fraction of 1.1%. The
> asymmetry decides it — **a strand costs ~1%; a ban costs the entire fleet.** The real lever for that tail is
> **proxies** (87% of the campaign's errors were shared-IP throttle), not cross-cycle re-delivery.
>
> **If you re-attempt this, you MUST have:** (a) live validation on real accounts, (b) a test that runs **N cycles in ONE
> process with no fold in between**, and (c) a coherent ledger lifecycle (ADR-0022) — never a mode-agnostic consumer.
> Today the trade is taken deliberately: a unique/sequence partial **strands** (recoverable) rather than risking a ban.

## Context
ADR-0008 introduced `this._owed` so a **partial** delivery — an account that posted to some but not all of its groups before dropping — finishes the un-reached groups later, targeting only those groups. It was wired for **daily-rotation** and **campaign-plan** only: `_cycleObligation` (the persistent carry-over) was gated to those two modes, because the carry-over is discharged by an *owed pick-override* that re-picks the SAME post next cycle, and only the per-agent-pointer modes had one.

Unique/sequence was left with the same-cycle transient `_cycleOwed` alone, and that is not equivalent — it is the one mode where a partial is **irrecoverable** without the ledger. Unique/sequence supersedes via the fleet-wide `_dealt` set, and a partial delivery is added to it (correctly: it is live in the groups it reached, and re-dealing the whole post would double-post). Once dealt, the post is filtered out of every account's `remaining` — so if the end-of-pool reserve pass found no covering reserve, the un-reached groups stranded **permanently**, with no trace. `_outstandingWork` then reported a false 100% (the post is dealt → not counted; owed gids were tallied only over the campaign roster), so completion mode stopped and declared success with groups un-served. This violated both ADR-0008's "a partial is never silently skipped" and ADR-0009's "`total === 0` means everything deliverable was delivered."

The naive repair — don't mark a partial dealt — is **unsafe**: `_inflightDelivered` is populated only by the crash-fold, so a re-picked post targets its full assigned set and re-posts the already-delivered groups. A double-post is the one ban-risk axis.

## Decision
Extend the ADR-0008 ledger to unique/sequence rather than inventing a parallel mechanism. For unique/sequence, **the dealt-set is the pointer**, so ADR-0008's rules apply verbatim with `_dealt` substituted for `perAccountRotation`:

1. `_cycleObligation` is recorded for **every** dedup mode (the mode gate is gone).
2. Unique/sequence gets its own **owed pick-override** in `_postsForAccount`, mirroring `owedDR`/`owedCP`: re-pick the same post first, scoped by `_owedSelf` → `onlyGroups` to only the still-owed groups. It is gated on the post still being `_dealt` (a Loop-campaign recycle re-delivers the whole library to all groups; a leftover owed subset must not narrow that) and drops a stale entry on a real pick.
3. `_reconcileOwedFor` is called **inline before `_persistDealt`**, so the ledger is written in the same `saveRotation` as the dealt-set — ADR-0008's lock-step rule, which for unique/sequence must bracket `_dealt` rather than the pointer.
4. `_outstandingWork` counts unique/sequence owed gids over the **account roster** (not `active` — the CP1 anti-pattern), guarded to stay honest rather than merely conservative: only dealt posts (an un-dealt owed post is already counted whole) and only posts still in the library (a deleted post has no recovery path).

The load-bearing addition is `_owedDelivered(agent, postId, gid)` — the single delivered-predicate every owed filter routes through. ADR-0008 already demanded that `markDelivered`, `alreadyDelivered` and every owed filter agree; unique/sequence adds a third source of truth, the crash-fold's durable `_inflightDelivered` guard, and the ledger must honor it. A reserve stand-in deliberately does **not** consult that guard (rotation/campaign legitimately re-deliver), so any crash-proven-delivered group left in the ledger would be handed to `_owedStandins` and re-posted. Two supporting rules follow:

- `_persistDealt` no longer purges `_inflightDelivered` for a **still-owed** post. A dealt id no longer implies full delivery, and the guard is the only durable proof of which groups a pre-crash run reached.
- The crash-fold prunes `_owed` against the groups it just proved delivered, in the same fold that seeds the guard.

`_owedDelivered` promotes a guard hit into `_cycleDelivered` (which only grows within a cycle). This is what makes `_reconcileOwedFor` **idempotent across the guard purge**: the inline reconcile and the end-of-pool sweep run the same obligation twice, and without the promotion the second pass would recompute against a purged guard and resurrect already-delivered groups into the ledger.

## Alternatives considered
- **(a) Don't mark a partial dealt (the naive fix).** Rejected: verified unsafe. `_inflightDelivered` is crash-path-only, so the re-pick re-posts every delivered group — a double-post on the shared IP.
- **(b) Leave unique/sequence on same-cycle `_cycleOwed` and rely on reserves.** Rejected: that is the status quo, and it strands the groups whenever no healthy in-set reserve exists — precisely the deferred finding. A fleet with no reserve has no recovery path at all.
- **(c) Let the reserve stand-in consult `_inflightDelivered` instead of pre-filtering the ledger.** Rejected: the stand-in gate excludes the guard deliberately — campaign-plan shares the empty `_dkScope` prefix, so a campaign lookup of a shared post id could collide with a unique post's guard key. Keeping the ledger clean is the narrower, safer invariant, and it also keeps `_outstandingWork` honest.
- **(d) A separate unique/sequence-only recovery mechanism.** Rejected: a second partial-delivery ledger to keep in agreement with the first is exactly the coupling ADR-0008 warns produces regressions.

## Consequences
- A unique/sequence partial now behaves like a rotation partial: the un-reached groups persist, are re-picked next cycle targeting only them, and block completion until served. `total === 0` regains its ADR-0009 meaning for the fleet's most common mode.
- The `_owed` ledger is no longer mode-scoped. **`_dkScope`'s key scoping is unchanged** (per-agent for daily-rotation, fleet-wide otherwise) — this ADR widens *which modes carry an entry*, not how entries are keyed.
- The coupling ADR-0008 flagged now has a third participant. `markDelivered`, `alreadyDelivered`, `_inflightDelivered` **and** every owed filter must agree on what counts as delivered; `_owedDelivered` is the single point where that agreement is expressed, and owed filters must route through it rather than probing `_cycleDelivered` directly.
- Two ordering invariants are now load-bearing and easy to break silently: the guard is purged only once a post is no longer owed, and the reconcile must stay idempotent across that purge. Both are pinned by tests.
- A dealt post can now be incompletely delivered. Anything that reads `_dealt` as "fully delivered" is wrong — `_persistDealt`'s purge made exactly that assumption.

## References
- `automation/orchestrator.js` — the unique/sequence owed pick-override in `_postsForAccount`; `_owedDelivered` / `_isUniqueSeqAgent` / `_owedRefsPost`; the inline reconcile before `_persistDealt`; the unique/sequence branch of `_recoverInflightJournal`; the unique/sequence owed tally in `_outstandingWork`.
- `tests/orchestrator-owed-uniqueseq.test.js` — the full invariant set (no double-post via re-pick or stand-in, no silent skip, completion waits, purge idempotency, recycle disarm).
- ADR-0008 (the ledger this amends), ADR-0009 (completion coupling), CHANGELOG 1.0.110.
