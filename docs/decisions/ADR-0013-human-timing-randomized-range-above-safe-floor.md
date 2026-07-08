# ADR-0013: Human-timing / anti-spam model: every delay a randomized range above a preserved safe floor

- **Status:** Accepted
- **Date:** 2026-07-06
- **Deciders:** owner + engineering

## Context
Constant, predictable delays are a bot signature, and Facebook rate-limits posting cadence. The operator wanted the cadence to look unpredictable and the knobs to be configurable — but never so fast that it trips FB's spam limits, and never in a way that risks a double-post or corrupted post text. The tension is between two goals that pull in opposite directions: maximal randomness/speed for realism and throughput, versus hard safety limits that must hold regardless of what the operator dials in.

## Decision
Every human-facing gap — inter-group, inter-cycle, account stagger, pre-publish dwell, feed dwell, comment delay — is a random draw from an operator-configurable min/max range, with micro-delays jittered. Randomization is bounded below: it never shortens a delay past a safe spam floor (group gap ~120s in normal pace; the comment floor is never 0, because an instant post→link is FB's top ban trigger). A `humanizeMaster` toggle gates jitter/stagger/dwell but deliberately does **not** gate the comment-delay window, which stays independently enforced. Legacy single-value settings migrate to a range (min 0.8x, max 1.2x of the old value) via a backward-compatible normalize step; the legacy key is retained for rollback. All reliability additions are pre-publish-click or read-only, so none can double-post or corrupt text. Speed presets down to INSTANT/Turbo still honor the floors, and selecting a "safe" pace strips any inherited fast `speedMode`.

## Alternatives considered
- **Fixed constant delays** — rejected: a predictable, machine-regular cadence is itself a bot signature.
- **Pure randomization with no floor** — rejected: an unlucky draw could breach the spam floor and trip FB's rate limits or ban triggers.
- **Routing the comment-delay window through `humanizeMaster`** — rejected: the comment floor is a hard ban-safety control and must stay enforced even when humanization is toggled off; it is kept independent.
- **Letting reliability retries re-click or re-type after the publish click** — rejected: any post-publish re-action risks a double-post or corrupted text, so all reliability logic is confined to pre-click or read-only steps.

## Consequences
This makes the cadence configurable and unpredictable while keeping ban-safety invariant. It costs a settings schema of min/max pairs plus `timingVariance` weights, and a normalize migration that must stay backward-compatible (legacy key preserved for rollback). The watchdog budget must be keyed to `groupDelayMax` so that a draw landing at the max end of the range never false-aborts a healthy run. Multiple speed presets exist but all remain subject to the floors. A ~1–2s/group slowdown is accepted as the price of jitter.

Invariants a future engineer must not break: the comment delay is never 0 and is never gated by `humanizeMaster`; randomization never draws below the spam floor; no reliability step may act after the publish click; the watchdog budget stays tied to the max-end delay.

## References
- `automation/worker.js:103`
- `lib/store.js:181`
- `HUMANIZE_TIMING_SPEC.md`
