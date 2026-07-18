# ADR-0019: Campaign Plan is frozen within a round — a mid-round edit is deferred to the next round, never a live re-partition

- **Status:** Accepted (implemented in v1.0.96)
- **Date:** 2026-07-15
- **Deciders:** owner + engineering

## Context
Campaign Plan partitions the whole post library into per-agent daily slices (`agentLists`) and stamps the partition with a `batchId` — a djb2 hash of the posts **and** the roster (each agent's name + `sig(a)`, where `sig` covers the agent's assigned groups and post-set). Delivery progress is a single per-agent pointer, `perAccountRotation[name].lastPostId`; `_campaignNextIdx` resumes each agent at `indexOf(lastPostId) + 1` in its slice.

The `_loop` plan-build block ran every cycle: if `batchId` changed, it recomputed the plan **and deleted every agent's pointer** so distribution "restarted cleanly." The reserve-rotation flavor of that churn was already neutralized by CP1 (the plan roster is the stable full fleet, not the per-cycle `active` set). But a **genuine operator edit mid-round** — turning an account on/off, changing a group assignment or post-set, or adding/removing/reordering posts — still flips `batchId`, and the pointer wipe then restarts every agent at slice[0]. Because Campaign-Plan posts are deliberately **not** in the fleet-wide `_dealt` set (each group-set must receive the whole library), nothing else blocks cross-cycle re-delivery once the pointer is wiped. The result is a **whole-library re-burst** onto the shared IP — the single ban-risk axis. Only operator discipline ("edit between rounds") stood between the run and that burst.

## Decision
Build the Campaign Plan **once per round, then freeze it.** A mid-round `batchId` change is **detected but deferred**: the active plan (its `agentLists` + pointers) is held for the rest of the round, and the edit is applied at the next legitimate boundary — the loop-wrap recompute (`_campaignAllFinished()` → `roundOffset++` → recompute with the fresh roster/posts) or a Stop→edit→Start. The operator is told once per distinct edit that the change is held for the next round.

The one consistency step applied immediately is a **roster shrink**: an agent that *left* the campaign (operator turned it OFF, cleared its groups, or switched it off campaign-plan → gone from `_campaignRoster()`) has its slice pruned from `agentLists`. Its pointer can never advance (it never runs again), so leaving it would wedge `_campaignAllFinished` / `_campaignRemaining` forever (the loop would never wrap and completion would never fire). Pruning leaves every **surviving** agent's slice untouched (no re-partition → no re-burst); the freed posts redistribute at the next round. `_owed` is left intact so standby coverage of a removed agent's partial delivery still runs. A benched or reserve-held agent stays enabled in `_campaignRoster()`, so it is **not** pruned — preserving CP1's no-premature-reloop guarantee.

This is implemented as `_reconcileCampaignPlan(fresh, planAgents, planPostsLen)`, called once per cycle from `_loop`.

## Alternatives considered
- **(a) Status quo — recompute + wipe pointers on any `batchId` change.** Rejected: a mid-round edit re-bursts the whole library on the shared IP (the ban-risk axis), gated only by operator discipline.
- **(b) Apply the edit immediately without re-bursting, via a durable per-(post,group) delivered ledger.** The partition could reshuffle live while each agent skipped already-delivered pairs. Rejected for now: it needs new persisted state and couples into the run-to-completion engine (ADR-0009) — the highest-risk area to change — for a benefit (mid-round edits taking effect instantly) that a ban-safety-first campaign does not actually want. Left as a future option if immediate mid-round effect ever becomes a hard requirement.
- **(c) Preserve pointers across the recompute (re-derive `indexOf(lastPostId)` in the new partition).** Rejected: after a repartition an agent's `lastPostId` may belong to a *different* agent's new slice, so resuming "after it" both re-delivers some posts and skips others — incorrect in both directions.

## Consequences
- A mid-round edit no longer takes effect until the next round. For a **looping** campaign the next round applies it cleanly; for a **non-looping** (run-to-completion) campaign there is no next round, so the operator must Stop→edit→Start. This matches the pre-existing "edit between rounds" guidance and trades a dangerous over-delivery (re-burst) for a safe deferral (at worst, under-delivery of a just-added post until restart).
- Removing an agent mid-round is safe: its slice is pruned, its groups' partial obligations are still covered by standby via `_owed`, and its freed posts redistribute next round.
- `_reconcileCampaignPlan` is the sole writer of `_campaignPlan` during a run (outside the round-boundary recompute and Start Fresh). Anyone re-introducing a mid-round recompute must preserve this invariant, or the re-burst returns.

## References
- `automation/orchestrator.js` — `_reconcileCampaignPlan` (the build-once-then-freeze reconcile); the `_loop` plan-build block that calls it; the round-boundary recompute (`🔁 Campaign Plan: … new round started`); `_campaignRoster` / `_campaignNextIdx` / `_campaignAllFinished`.
- `tests/orchestrator-campaign-plan.test.js` — the `#2:` cases (first build, frozen edit + preserved pointers, roster-shrink prune, benched-not-pruned).
- `docs/never-stop-and-batch-content.md` — operator-facing reshuffle semantics.
- ADR-0009 (run-to-completion engine), CHANGELOG 1.0.96.
