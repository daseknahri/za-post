# Architecture Decision Records

An Architecture Decision Record (ADR) captures a single significant architectural or design choice — the context that forced the decision, the option chosen, and the consequences that follow — as a short, immutable, numbered document. This project keeps ADRs because it is a long-lived, single-owner codebase where many non-obvious choices (identity=profile anti-detection, fail-open licensing, run-to-completion campaigns, the moderator dark feature) were made deliberately and against plausible alternatives; recording the *why* prevents future work from re-litigating settled trade-offs or "fixing" intentional behavior, and gives a client, collaborator, or future self a durable map of the system's load-bearing decisions.

## Template location and format

The template lives at [`ADR-template.md`](ADR-template.md). Each ADR is a Markdown file named `ADR-<id>-<slug>.md` (zero-padded four-digit id, kebab-case slug) and follows this structure:

```
# ADR-<id>: <Title>

- **Status:** <Proposed | Accepted | Superseded>
- **Date:** <YYYY-MM-DD>

## Context
What forces are at play — technical, product, operational — that make a decision necessary.

## Decision
The choice made, stated plainly.

## Consequences
What becomes easier, harder, or constrained as a result. Include trade-offs accepted.

## Alternatives considered
Options rejected and why.
```

## Adding a new ADR

1. Pick the **next number**: take the highest existing id and add one (the next is `0022`).
2. Copy `ADR-template.md` to `ADR-<id>-<slug>.md`, choosing a short kebab-case slug that names the decision.
3. Fill in the sections. Set the initial **status**:
   - **Proposed** — under consideration, not yet committed.
   - **Accepted** — the decision is in force and reflected in the code.
   - **Superseded** — replaced by a later ADR; note which one (e.g. "Superseded by ADR-0025") and leave the original text intact for history.
4. Add a row to the table below.

ADRs are append-only: to change a decision, write a new ADR and mark the old one **Superseded** rather than editing it in place.

## ADR log

| ID | Title | Status |
|----|-------|--------|
| [0001](ADR-0001-identity-profile-anti-detection-real-chrome.md) | Anti-detection by identity=profile with real Chrome and no fingerprint forging | Accepted |
| [0002](ADR-0002-single-json-store-serialized-write-chains.md) | Single JSON store + sidecar state files with serialized per-domain write chains | Accepted |
| [0003](ADR-0003-context-isolated-ipc-allowlist-bridge.md) | Context-isolated IPC bridge gated by a hardcoded ALLOWED_CHANNELS allowlist | Accepted |
| [0004](ADR-0004-per-seat-licensing-fail-open-offline-grace.md) | Per-seat tiered licensing enforced in the backend with 7-day offline grace, failing open on I/O ambiguity | Accepted |
| [0005](ADR-0005-anti-link-proxy-concurrency.md) | Anti-link proxy concurrency: fleet parallelism equals distinct working proxies | Accepted |
| [0006](ADR-0006-post-id-trust-anchor-comment-targeting.md) | Post-ID as the trust anchor for first-comment targeting (permalink-direct primary, skip rather than guess) | Accepted |
| [0007](ADR-0007-dynamic-concurrency-pool-per-completion-persistence.md) | Dynamic RAM-bounded concurrency pool with per-completion dealt persistence, replacing the fixed batch barrier | Accepted |
| [0008](ADR-0008-owed-groups-ledger-scoped-per-mode.md) | Persistent per-group 'owed' ledger, scoped per-agent in Daily Rotation and fleet-wide otherwise | Accepted |
| [0009](ADR-0009-run-to-completion-campaign-engine.md) | Run-to-completion campaign engine: deliver 100%, then auto-stop and report honestly | Accepted |
| [0010](ADR-0010-two-phase-post-then-comment.md) | Two-phase posting: post everything first, then comment in a pipelined second pass | Accepted |
| [0011](ADR-0011-moderator-auto-approval-dark-by-default.md) | Moderator auto-approval — dark by default, fail-open author veto, dry-run gated | Accepted |
| [0012](ADR-0012-held-post-permalink-liveness-check.md) | Held-post recovery via author-aware permalink-direct liveness check, not a feed scan | Accepted |
| [0013](ADR-0013-human-timing-randomized-range-above-safe-floor.md) | Human-timing / anti-spam model: every delay a randomized range above a preserved safe floor | Accepted |
| [0014](ADR-0014-chrome-import-companion-extension.md) | Import existing logged-in Chrome profiles via a companion extension, not a profile-folder copy | Accepted |
| [0015](ADR-0015-remote-http-api-bulk-post-fill.md) | Token-gated remote HTTP API to fill the post library from an external server | Accepted |
| [0016](ADR-0016-portable-zip-delivery-enforce-marker-migration.md) | Portable-zip delivery with a separate userData folder, build-time enforce marker, and non-overwriting first-run migration | Accepted |
| [0017](ADR-0017-robustness-over-security-priority.md) | Robustness-over-security as the guiding priority for remaining work | Accepted |
| [0018](ADR-0018-persistent-rotating-tab-pool.md) | Persistent rotating tab pool for multi-tab posting (reuse tabs by re-navigation instead of newPage/close churn) | Accepted |
| [0019](ADR-0019-campaign-plan-frozen-within-round.md) | Campaign Plan frozen within a round — a mid-round edit defers to the next round, never a live re-partition | Accepted |
| [0020](ADR-0020-interchangeable-account-pool-weighted-shared-posting.md) | Interchangeable account pool — weighted shared-pool posting (evolve unique/sequence, not campaign-plan slices) | Proposed |
| [0021](ADR-0021-owed-ledger-extended-to-unique-sequence.md) | The owed ledger covers unique/sequence too — the fleet-wide dealt-set is a pointer, so a PARTIAL must stay recoverable (amends 0008) | Accepted |
