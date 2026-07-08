# ADR-0017: Robustness-over-security as the guiding priority for remaining work

- **Status:** Accepted
- **Date:** 2026-07-06
- **Deciders:** owner + engineering

## Context
The app is operated by the owner to run a single reliable large end-to-end campaign on the owner's own machine. It is not a multi-tenant public service, and its threat model is single-operator, own-machine. Finite engineering effort had to be allocated between two competing goals: reliability of a big run and security hardening. An explicit priority was needed so future work is weighed consistently rather than case-by-case.

## Decision
Prioritize ROBUSTNESS over security hardening when the two compete. Robustness means a reliable end-to-end big run: no missed or double posts, no stalls or leaks, and recovery from every failure path.

Security fixes are still done where they don't trade against reliability: credentials encrypted at rest, SSRF/remote-error guards, proxy/cookie validation, the token kept out of logs, CSV formula-injection escaping, and constant-time token comparison. But the audit energy centers on double-post / double-comment / lost-comment / deadlock safety.

Concretely, where the two priorities collide the app favors availability: it fails OPEN on license I/O ambiguity and boots provisionally on an unreadable `license.json`, and there is no CSP hardening layer — `contextIsolation` plus `nodeIntegration: false` and the preload IPC-channel allowlist (`preload.js`) are the primary defense. The renderer loads only a bundled local file, so there is no arbitrary-navigation surface to gate.

## Alternatives considered
- **Security-first hardening** — deprioritized. The single-operator, own-machine threat model does not justify spending the reliability budget on hardening against attackers who are not in the model.
- **Balancing both equally** — rejected. Without an explicit priority, every future trade-off would be re-litigated; setting robustness as the tiebreaker makes the weighing deterministic.

## Consequences
- Repeated adversarial reliability audits: each fix is re-verified against the double-post / double-comment / lost-comment / deadlock invariants before it is accepted.
- Some security items are intentionally deferred (e.g. code-signing, which needs a certificate). These are known gaps, not oversights — do not re-flag them as new bugs.
- Fail-open behaviors (license I/O ambiguity, unreadable `license.json`) must be preserved: a licensing edge case must never be allowed to stall or abort a big run.
- Future work is weighed against whether it improves a reliable big run; a change that hardens security at the cost of reliability needs an explicit exception to this ADR.

## References
- MEMORY: `za-post-robustness-over-security`
- CHANGELOG 1.0.6
- `RELIABILITY_HIDE_SPEC.md`
