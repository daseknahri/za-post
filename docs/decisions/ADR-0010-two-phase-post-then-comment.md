# ADR-0010: Two-phase posting: post everything first, then comment in a pipelined second pass

- **Status:** Accepted
- **Date:** 2026-07-08
- **Deciders:** owner + engineering

## Context
The first comment is the payload — it carries the link the whole run exists to deliver — so it must land on the correct post, never a neighbour's. The classic per-group flow had each account post to a group and then immediately comment on that same group before moving on. Two problems compounded at scale. First, an interrupted run could stop between phases, leaving some targets posted-but-uncommented and others not posted at all, with no clean seam to resume from. Second, the inline comment wait serialized poorly: the account sat idle between its own post and comment instead of advancing its posting throughput. Worst of all, when many accounts posted similar captions into the same group, the comment pass that re-found the post by caption could match the wrong post, and the payload landed under someone else's image.

## Decision
Add an opt-in **"Post everything first, then comment"** mode, off by default. Phase 1 publishes and `markDelivered`s the image plus caption to ALL of a group's targets, capturing each post's permalink at publish time and deferring its comment. Phase 2 then places every deferred comment, navigating straight to the captured permalink — driven by its own permalink-prefetch pipeline so navigation overlaps placement the way the posting pass overlaps publishes. A comment is a separate, non-post action that never re-types after Enter is pressed; deferring it therefore changes **nothing** about the existing double-post and double-comment safety guarantees. The natural aging between the two passes IS the anti-spam post-to-comment gap we used to insert by hand.

## Alternatives considered
- **Keep only the classic per-group post-then-comment flow.** Retained, but as the default: with the mode off, behavior is byte-for-byte identical to before, so nothing regresses for existing operators.
- **Reload the group and match the post by caption for every comment.** Rejected as the primary path — it is exactly the source of wrong-post payload placement when captions collide. Kept only as a fallback, used solely when a permalink could not be captured at publish time.
- **Always comment inline (never defer).** Rejected: the inline wait stalls the account's posting throughput and reintroduces the interrupted-run seam problem the two-phase split exists to remove.

## Consequences
- A whole second pipeline now exists and was adversarially audited across three failure classes: double-post, double-comment, and lost-comment.
- Held posts and blocked comments still route to the reserve-account and moderator queues; the second pass inherits that routing rather than bypassing it.
- Single-phase behavior and single-tab behavior are unchanged when the mode is off.
- Invariant to protect: a comment must never re-type after Enter, and Phase 2 must prefer the captured permalink — falling back to caption-matching only when no permalink was captured. Do not let the fallback become the default path, or wrong-post payload placement returns.

## References
- `automation/worker.js:2316`
- CHANGELOG 1.0.5
- CHANGELOG 1.0.10
