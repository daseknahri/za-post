# ADR-NNNN: <short title of the decision>

- **Status:** Proposed | Accepted | Superseded
- **Date:** YYYY-MM-DD
- **Deciders:** owner + engineering

## Context

What forces are at play — technical, product, operational — that make a decision
necessary. State the problem and the constraints, not the solution. If this decision
was driven by a specific incident (a ban, a data-loss bug, a scaling wall), name it.

## Decision

The choice made, stated plainly, in one or two sentences up front — then the detail.
Describe what the code actually does, and cite it (see References). An ADR that
disagrees with the code is worse than no ADR.

## Alternatives considered

The options that were rejected, and *why*. This is the most valuable section: it stops
future work from re-litigating a settled trade-off or "fixing" intentional behaviour.

## Consequences

What becomes easier, harder, or constrained as a result. Include the trade-offs
accepted and any invariant this decision must not break (link to `INVARIANTS.md`).

## References

`file.js:line` anchors, CHANGELOG versions, commit hashes, or related ADRs. Keep these
accurate — a reader will follow them to confirm the decision against the code.

<!--
Naming: ADR-<id>-<slug>.md  (zero-padded four-digit id, kebab-case slug).
ADRs are append-only. To change a decision, write a new ADR and mark this one
"Superseded by ADR-XXXX" rather than editing the decision in place.
-->
