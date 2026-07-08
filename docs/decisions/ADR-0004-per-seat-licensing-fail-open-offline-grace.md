# ADR-0004: Per-seat tiered licensing enforced in the backend with 7-day offline grace, failing open on I/O ambiguity

- **Status:** Accepted
- **Date:** 2026-07-08
- **Deciders:** owner + engineering

## Context
The app ships per-seat and must not be shareable, yet it also has to run unattended overnight and stay usable offline for stretches. These two forces pull against each other: strict enforcement wants to distrust anything it cannot verify, but an overnight campaign cannot be allowed to stop just because a file was momentarily unreadable.

An early implementation made exactly that mistake. It treated a transient lock on `license.json` — from Defender, OneDrive, or the search indexer, or even from the app's own cache rewrite during `store.update` — as "not licensed." The result: a running campaign was killed at the roughly-6-hour re-check, and legitimately activated customers were dropped back to the activation screen on launch. Enforcement was punishing paying users for an I/O hiccup.

## Decision
Enforce per-seat tiers in the backend, device-locked on first activation via `hwid`. All tiers currently map to `{ maxAccounts: Infinity, maxGroups: Infinity }` — the key gates **ACCESS** (validity, expiry, device-lock, revocation), not usage counts.

Rules that must hold:

- **Offline grace:** customers get a 7-day grace measured from the last *successful* server validation. The owner key is always valid offline and unlimited.
- **Ambiguity fails open:** an unreadable or locked license file is treated as AMBIGUOUS — keep the last-known-good state and retry. It is never interpreted as invalid.
- **`lastValidated` only advances on a real server check** — never on a local read, so grace cannot be extended by touching the file.
- **Device-lock fails CLOSED:** a missing or mismatched `hwid` is a hard reject.
- **The 7-day bound is forward-only,** with no backward-clock guard (accepted limitation; see Consequences).

The distinction is deliberate: I/O ambiguity fails open, identity/authorization failures fail closed.

## Alternatives considered
- **UI-only enforcement** — rejected; trivially bypassed.
- **Online-required / no grace** — rejected; breaks the unattended offline runs that are a core use case.
- **Fail-closed on any unreadable file** — rejected; this was the original bug that stopped live campaigns and evicted activated customers.
- **Trusting an unreadable planted file as valid** — rejected; that is an enforcement bypass. Ambiguity means "keep last-known-good," not "assume valid."
- **Tiered account/group caps** — rejected by owner decision on 2026-06-26; the model is pure per-seat, so all tiers are uncapped.

## Consequences
- A VPS license server is a **hard prerequisite** before shipping an enforced build. It must provide per-IP rate limiting, `/health`, Bearer-authenticated admin, and an AES-256-GCM key store with an audit log. Separately, the client caps each validation request at 3s so a slow server cannot stall the gate.
- The dominant failure mode to guard against: a **fresh install with no cached license parks on the License screen** if the server is unreachable. This is the #1 way to brick a client, so server availability is operationally load-bearing.
- Boot opens **provisionally** and re-verifies within ~2 minutes, so a reachable server recovers a cold start quickly.
- Because grace is forward-only with no backward-clock guard, a user who rolls their system clock back can extend offline validity. This is a known, accepted trade-off — protecting unattended offline operation was judged more important than defeating deliberate clock tampering.
- Invariants a future engineer must not break: never let a read failure downgrade a valid license; never advance `lastValidated` off a local read; keep device-lock failing closed.

## References
- `lib/license.js:80`
- `lib/license.js:121`
- `lib/license.js:139`
- `main.js:607`
- CHANGELOG 1.0.4
