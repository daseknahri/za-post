# ADR-0009: Run-to-completion campaign engine: deliver 100%, then auto-stop and report honestly

- **Status:** Accepted
- **Date:** 2026-07-08
- **Deciders:** owner + engineering

## Context
Operators needed a campaign that reliably delivers the entire post library to its assigned groups and then stops on its own — rather than looping indefinitely or forcing a human to watch the run to know when it is "done." The engine must honor one-post-per-account-per-local-day pacing (the operator's model and anti-spam both require it) and must never double-post. The hard problem is defining "done" honestly: a run can look finished at the pointer level while individual (post, group) deliveries are still owed, and some held posts have no recovery path at all.

## Decision
Add a run-to-completion engine with two modes:

- **Daily Rotation** — each agent publishes one new post per local day, auto-advancing through the library with anti-repeat.
- **Campaign Plan** — each group-set receives the whole library, split across its agents at one post/day.

Delivery is tracked per (post, group). The engine self-heals — retrying, re-holding, and rescuing link-comments — until `_outstandingWork(...).total === 0`, at which point it auto-stops and emits an honest end-of-run report.

Completion explicitly waits for any **owed** partial-delivery work before it can report 100% or reshuffle: un-reached (post, group) pairs a Campaign-Plan agent still owes are counted as outstanding via the owed-groups ledger (`this._owed`), so `completionMode` cannot declare "100% delivered" while groups remain un-served.

`repost-off` posts that aged past the approval window to `failed` have **no** recovery path and are therefore **excluded** from the completion total — otherwise a held-heavy run could never complete. They are undelivered, so the report surfaces them loudly rather than silently dropping them. With repost **on**, `failed` and mid-flight `superseded` posts are counted as outstanding so a stop-and-report cannot fire a false "100%" before the re-post lands.

## Alternatives considered
- **Indefinite looping with manual stop** — rejected: never yields a clear "done"; requires human monitoring.
- **Report 100% as soon as each pointer advanced** — rejected: dishonest while owed groups still await the post.
- **Always count repost-off `failed` posts** — rejected: those posts have no recovery path, so the run could never reach `total === 0`.
- **Ignore daily pacing to finish faster** — rejected: violates anti-spam and the operator's one-post-per-account-per-day model.

## Consequences
- The end-of-run report is honest: it lists live posts whose comment could not be placed instead of claiming every comment was delivered.
- Introduces a Campaign-Plan team builder and per-agent collapsible logs.
- Completion correctness is **tightly coupled** to the owed-groups ledger (`this._owed`). Anyone changing partial-delivery tracking, the moderation status lifecycle (`held` → `failed`/`failed_held`/`superseded`), or the `repostEnabled` gate must preserve the invariant that `total === 0` means everything deliverable was delivered — and that undeliverable work is surfaced, never counted away into a false 100%.
- Set-restricted unique/sequence agents must keep counting only posts in their own set (`postsForSet`), or a finite run can never complete.

## References
- `automation/orchestrator.js:2528` — `_outstandingWork(active)`: the outstanding-work / completion ledger.
- `automation/orchestrator.js:2559` — `repostOn` gate and the `total` computation (repost-off `failed`/`superseded` excluded).
- `automation/orchestrator.js:2565` — `_emitCompletionReport(reason, out)`: the honest end-of-run report.
- CHANGELOG 1.0.12
- MEMORY: za-post-completion-audit
