# ADR-0022: Owed-ledger coherence — one predicate gates BOTH the producer and every consumer

- **Status:** Accepted (implemented in v1.0.112)
- **Date:** 2026-07-16
- **Deciders:** owner + engineering
- **Relates to:** ADR-0008 (owed ledger), ADR-0009 (completion engine), ADR-0021 (**rejected** — the unique/sequence extension)

## Context

`this._owed` is the persistent partial-delivery ledger: *agent A still owes post P to groups [g…]*. Two kinds of code touch it:

- **The producer** — the `_cycleObligation` gate on the account return path. It records what an agent was responsible for this cycle; end-of-pool `_reconcileOwedFor` turns that into (or clears) an `_owed` entry.
- **The consumers** — everything that turns an entry back into a **delivery**:
  - `_hasPersistentOwed` — opens the end-of-pool takeover block,
  - the persistent-owed **synthesis** — materialises `_cycleOwed` from the ledger,
  - `_owedStandins` — pairs the owed agent with a reserve,
  - `_owedSelf` → `_onlyGroups` — scopes an agent's own re-pick.

An entry is only ever discharged by an **owed pick-override**, which re-picks the owed post scoped to just its un-reached groups. **Only the per-agent-pointer modes have one** (`daily-rotation`, `campaign-plan`).

**The defect:** the consumers were **mode-agnostic** (they matched on `postId`/`gids`/library membership alone) while the producer was **mode-restricted**. Nothing enforced that these two agree.

## The failure this caused

An entry whose owner **cannot discharge it** becomes **immortal**:

1. No pick-override runs for that mode, so nothing prunes or narrows the entry.
2. No `_cycleObligation` is recorded, so `_reconcileOwedFor` **early-returns on `!ob`** — the ledger never moves, even after a *successful* cover.
3. `_hasPersistentOwed` still sees the entry → the takeover block opens **every cycle**.
4. The synthesis still materialises it → `_owedStandins` dispatches a reserve to the **identical gids**.
5. A stand-in has `_uniqueSeqGuard === false`, so `alreadyDelivered` consults only `_cycleDelivered` — which **resets every cycle**.

**Net: a reserve re-posts the same `(post,group)` pair every cycle, forever, on the one shared IP.** That is the ban axis.

**Reachable two ways:**
- **Pre-existing:** a pointer-mode agent accrues an entry, the operator flips it to `post-centric`/`unique` (the Accounts-tab bulk bar); the `!unique` branch returns before any cleanup and the entry never dies.
- **Amplified by ADR-0021:** extending the producer to unique/sequence gave *every* unique agent an entry, and a unique fleet makes `_uniqueMode` true by default.

**Why it survived a full green suite and an adversarial confirm-dry sweep:** the crash-fold reconciles `_owed` from the journal on **every process start**, so a stale entry is cleared on restart. Any test (or reviewer) that models "the next cycle" as a **new process** watches the bug self-heal. It only accumulates in a **healthy days-unattended run** — the fold runs once, then cycles continue in-process with stale state. **Crashes self-heal; health accumulates.**

## Decision

**One predicate — `owedDischargeableMode(postingOrder)` — is the single source of truth, and BOTH sides gate on it.**

```js
function owedDischargeableMode(postingOrder) {
  const o = String(postingOrder || '');
  return o === 'daily-rotation' || o === 'campaign-plan'; // the only modes with an owed pick-override
}
```

- **Producer:** the `_cycleObligation` gate records **only** for a dischargeable mode → *never create an entry nothing can discharge.*
- **Consumers:** `_owedDischargeable(name)` (which wraps the predicate over the owner's **current** mode) gates `_hasPersistentOwed`, the synthesis, and `_owedSelf` → *never consume an entry the owner cannot discharge.*
- **Self-heal:** the synthesis **drops-and-logs** an entry whose owner is no longer dischargeable (e.g. an operator mode-flip), so it cannot outlive the mode change. Dropping is the safe direction: the groups **strand** (recoverable — the post is already live in the groups it reached) rather than being re-delivered.

### Invariants

1. **An `_owed` entry exists only if some path can discharge it.**
2. **An `_owed` entry is consumed only by an owner that can discharge it.**
3. Widening the predicate to a mode with **no** pick-override re-opens the double-post. Do not do it without adding an override *and* live validation.
4. `_owedSelf` must never scope a **broadcast** mode's run — a stale entry matching one of its normally-picked posts would silently starve its other groups.

## Consequences

**Good**
- The immortal-entry class of double-post is closed at the root — including the **pre-existing** pointer→broadcast mode-flip path that predates ADR-0021 and survived the confirm-dry loop.
- Producer and consumer can no longer drift apart: they are the same function. Mutation-verified — widening it fails the suite.
- The ledger is self-healing across operator mode changes.

**Accepted cost**
- A **unique/sequence partial strands** when no same-cycle reserve covers it (ADR-0021 reverted). Measured ~1.1% of pairs (17/1491), all in the shared-IP throttle tail. Deliberate: **a strand is recoverable; a double-post is a ban.**
- ADR-0009's "`total === 0` means everything deliverable was delivered" is weakened for unique/sequence partials, which are no longer tracked. **Open follow-up:** record strands in a *read-only* report-only list (never consumed by any delivery path) so completion reports them as undeliverable instead of implying 100%. Deliberately kept separate from `_owed` — the moment a record can become a post, it needs this whole invariant again.

## Testing note

The blind spot is structural, so it is called out here: **the crash-fold masks stale-ledger bugs on restart.** Any test for this area must run **N consecutive cycles in ONE process with no fold in between**, or it will pass against a live double-post. The predicate is exported and unit-tested; both mutations (widening the predicate, and making the consumers mode-agnostic) fail the suite.
