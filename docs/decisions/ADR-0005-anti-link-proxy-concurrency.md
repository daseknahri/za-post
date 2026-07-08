# ADR-0005: Anti-link proxy concurrency: fleet parallelism equals distinct working proxies

- **Status:** Accepted
- **Date:** 2026-07-08
- **Deciders:** owner + engineering

## Context
Facebook treats two accounts hitting it from the same exit IP at the same time as a strong "same person" link signal. The za-post fleet mixes two kinds of accounts: no-proxy accounts, which all share the operator's own residential line, and proxy accounts, each bound to a (possibly shared) exit IP. If the orchestrator ran accounts purely by a `parallelAccounts` count without regard to which IP each one leaves through, it would routinely place two distinct accounts on one shared proxy exit IP concurrently — exactly the correlation we are trying to avoid. Throughput matters, but not at the cost of linking identities that are supposed to look unrelated.

## Decision
The orchestrator refuses to run two accounts on the same proxy exit IP concurrently — accounts sharing an exit IP take turns instead of overlapping. The live pool's proxy set is pinned **once** per cycle and the resulting `proxyForAccount` mapping is handed to each worker unchanged; there is no mid-cycle re-bucketing, so an account's exit IP cannot shift under it while the cycle runs. No-proxy accounts are the sole exception: they all leave through the operator's own residential line, which is one legitimate identity, so they may run concurrently up to `parallelAccounts`. The consequence is deliberate and load-bearing: effective fleet throughput equals the number of distinct working proxies (plus the single residential slot), and there is no code lever to raise it beyond that.

## Alternatives considered
- **Full parallelism regardless of shared IPs** — run up to `parallelAccounts` browsers without checking exit IPs. Rejected: it puts multiple distinct accounts on one shared exit IP at the same instant, producing the same-person link signal this whole design exists to prevent.
- **Serialize even no-proxy accounts** — treat the residential line like any shared proxy and force those accounts to take turns too. Rejected: the operator's residential IP is one real, legitimate identity; making it run one-at-a-time throttles the fleet for no anti-link benefit.

## Consequences
- Throughput is proxy-bound. With few proxies the fleet serializes down to roughly one browser and a full cycle can take hours; this is expected, not a bug, and must not be "fixed" by loosening the concurrency gate.
- A proxy-health module tracks per-proxy failure and cooldown so dead exits drop out of the pinned set rather than stalling a worker.
- The number-one operator recommendation is to buy residential proxies toward one clean IP per account (see `docs/PERSONA-ROADMAP.md` and `docs/iproyal-proxy-guide.md`); that is the only supported way to increase parallelism.
- A no-proxy deployment on one real residential IP uses the single-residential-slot path.
- Invariant to protect: the proxy set and `proxyForAccount` mapping are pinned once per cycle. Do not re-bucket, reassign, or re-pool proxies mid-cycle, and do not allow two accounts on the same proxy exit IP to overlap.

## References
- `automation/orchestrator.js:1580`
- `docs/ROLLOUT-400.md`
- `docs/PERSONA-ROADMAP.md`
- CHANGELOG 1.0.2
