# ADR-0007: Dynamic RAM-bounded concurrency pool with per-completion dealt persistence, replacing the fixed batch barrier

- **Status:** Accepted
- **Date:** 2026-07-06
- **Deciders:** owner + engineering

## Context
The original orchestrator ran accounts in fixed batches behind a barrier: the entire batch had to finish before the next one started. Idle slots — freed by fast accounts, or by accounts gated on daily-cap or cooldown — sat unused until the slowest member of the batch completed, and account 0 was perpetually the freshest. At 400 accounts on a single machine this wasted a large fraction of available capacity and was structurally unfair to later accounts in the ordering. Any replacement had to preserve exactly-once dealt/rotation state: no re-dealing a post, no double-posting.

## Decision
Replace the batch barrier with a dynamic pool that feeds all active accounts and launches the next account the moment a slot frees, rather than waiting on a batch boundary.

- Start-order rotates per cycle so fairness is spread across accounts instead of always favoring account 0.
- Stagger decays over retries.
- The RAM ceiling — `min(parallelAccounts, distinct-proxy count, 60%-free-RAM / 450MB, ~2x cores)` — is re-read as each slot frees, not frozen once per cycle, so a transient memory dip no longer serializes the whole fleet.
- All gates (daily cap, rate-limit cooldown, offline-hold) are evaluated before an account is queued.
- Dealt-state is persisted per completion, not at batch end.
- Both drain loops MUST break — not spin — when no proxy IP is free.

## Alternatives considered
- **Keep the fixed batch barrier** — rejected: wastes idle slots and is unfair to accounts later in the ordering.
- **Freeze the pool ceiling once per cycle** — rejected: a momentary low-memory snapshot would serialize the entire fleet for the rest of that cycle.
- **Gate dealt-state on comment outcome** — rejected: a failed comment would leave the post undealt, causing it to be re-dealt and re-posted.

## Consequences
- The existing crash and rotation tests pass unchanged; a dedicated crash-mid-pool case is still pending.
- The reserve-takeover pool now uses the same slot-wait discipline; it previously spun at 100% CPU forever when two reserves shared a single IP, and was fixed to match this loop's break-on-no-free-IP rule.
- The ceiling only ever *lowers* the requested concurrency, never raises it, so it cannot weaken the anti-link or double-post guarantees.
- Invariant an engineer must not break: both drain loops must `break` when no proxy IP is free — reintroducing a spin here brings back the 100% CPU hang.

## References
- `automation/orchestrator.js:1612`
- `automation/orchestrator.js:1950`
- `CORE_ENHANCEMENT_SPEC.md`
- CHANGELOG 1.0.2
- CHANGELOG 1.0.4
