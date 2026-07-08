# ADR-0008: Persistent per-group 'owed' ledger, scoped per-agent in Daily Rotation and fleet-wide otherwise

- **Status:** Accepted
- **Date:** 2026-07-06
- **Deciders:** owner + engineering

## Context
When an account running in Daily Rotation or Campaign Plan mode posted to some of its groups and then dropped mid-run (logout, checkpoint, or crash), its rotation pointer advanced as if the post had finished. The groups it never reached were permanently and silently skipped — no retry, no report, no trace. A first attempt to fix this with a single fleet-wide ledger introduced the opposite bug: when two accounts were assigned the same group on the same post/day, the first account to reach it "claimed" the group, and the second account silently skipped it. Both failure modes drop work without telling the operator, which is unacceptable for a tool whose whole value is delivering every assigned post to every assigned group.

## Decision
Track every group an account was supposed to reach for a post in a persistent `this._owed` ledger. The ledger is written in lock-step with the pointer advance — the same `saveRotation` call persists both, via the inline `_reconcileOwedFor` call — so a crash can never leave the pointer ahead of the ledger. Un-reached groups are finished on the next cycle/day, either by the original account or a healthy reserve, targeting **only** the missed groups; groups already delivered are excluded so a retry never double-posts, and groups no longer assigned are pruned to avoid a livelock.

The ledger key is scoped by `_dkScope`:
- **Per-agent** (`name::`) for **Daily Rotation**, because two agents may legitimately share a group and must each deliver to it independently.
- **Fleet-wide** (`''`) for **unique / sequence / campaign** modes, where a group is delivered once across the fleet.

This scope must be applied **consistently** across `markDelivered`, `alreadyDelivered`, and every owed filter — a mismatch on any one of them reintroduces one of the two original bugs.

## Alternatives considered
- **Advance the pointer on partial delivery** (the original behavior): rejected — silently drops every un-reached group when an account fails mid-run.
- **A single fleet-wide ledger for all modes**: rejected — breaks multi-account Daily Rotation by letting the first account claim a shared group and silently skip the second.
- **Re-post the whole post to all groups on retry**: rejected — double-posts to groups that already received the post.

## Consequences
- Owed work is finished before an account moves on to its next post, and never pushes an account past its daily quota.
- Completion reporting waits for owed work before declaring 100%, so "done" means done.
- A covered account's daily count increments exactly once even when reserves split its owed work.
- Costs: extra persistent bookkeeping and adversarial re-audits. The scoping is a load-bearing invariant — `markDelivered`, `alreadyDelivered`, and all owed filters must agree on `_dkScope`, or the ledger regresses to one of the two bugs above. The 1.0.7 ledger shipped exactly such a regression, caught and fixed in 1.0.8.

## References
- `automation/orchestrator.js:2867` — `_reconcileOwedFor` definition; `automation/orchestrator.js:1804` — its inline reconciliation call site
- `automation/orchestrator.js:1808` — `saveRotation` lock-step persist of pointer + ledger
- `automation/orchestrator.js:2855` — `_dkScope` per-mode ledger-key scoping
- CHANGELOG 1.0.7–1.0.9 — initial ledger, 1.0.8 scoping-regression fix, subsequent hardening
