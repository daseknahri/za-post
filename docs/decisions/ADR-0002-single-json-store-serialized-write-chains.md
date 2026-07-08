# ADR-0002: Single JSON store + sidecar state files with serialized per-domain write chains

- **Status:** Accepted
- **Date:** 2026-07-06
- **Deciders:** owner + engineering

## Context
The orchestrator loop, IPC handlers, and the remote HTTP server all mutate the same on-disk state from a single process, across `await` points. When two of these overlap, their independent load → mutate → save cycles race: the later save is computed from a stale in-memory snapshot and silently overwrites the earlier change (a classic lost-update). In practice this dropped held posts, orphaned comments, and reverted account status with no error surfaced. The app had also already suffered 0-byte and torn-file corruption from interrupted or partial writes. We needed durable, concurrency-safe persistence without introducing operational weight the owner doesn't want.

## Decision
Persist state as human-inspectable JSON under Electron `userData`:

- `data.json` — posts, groups, accounts, settings, proxies.
- Independent sidecar files — `pcu-state.json` (rotation), `moderation-state.json`, `pending-comments.json`, `daily-progress.json`, and the append-only `run-report.jsonl` / `.csv`.

Every critical file is written through `writeFileAtomic`: write a tmp file via a looped `writeSync`, `fsync`, then `rename` over the target. Durability against a bad write is layered on top by the per-domain savers (`save`, `saveRotation`, `saveModeration`, `saveComments`, `saveProgress`), which copy the current good file to a `.bak` snapshot *before* calling `writeFileAtomic`; other callers (cookies, run-count, Preferences) keep no `.bak`. All read-modify-write cycles are funneled through three **independent** promise chains so that operations within a domain serialize but domains never block each other:

- `_writeChain` — `data.json` / `store.update`
- `_modChain` — `updateModeration`
- `_comChain` — `updateComments`

This is deliberately not a database and not a single global lock.

## Alternatives considered
- **Embedded/relational DB (SQLite).** Rejected. Human-inspectable JSON plus the normalize/clamp layer covers our integrity needs; a DB adds a binary dependency, migrations, and opacity for a state file the owner wants to hand-edit and eyeball.
- **One monolithic JSON file for everything.** Rejected. High-churn parallel-pool writes (comments, moderation) would repeatedly contend with, and lost-update, low-churn config (settings, proxies) that shares the file.
- **One shared global mutation lock.** Rejected. It would needlessly serialize `data.json` writes behind every held-post and comment append, throttling the hot path to protect the cold one.

## Consequences
- Each data domain serializes and recovers independently; a stall in one chain cannot starve another.
- The normalize/clamp layer runs on load, so hand-edited or partially-valid files are coerced back into a safe shape rather than crashing consumers.
- Corruption handling distinguishes a **transiently UNREADABLE** primary (e.g. an OS file lock) from **PROVABLE corruption** (a successful read that fails to parse). Only the latter quarantines the file as `.corrupt-<ts>` and recovers from `.bak`; a transient read failure never clobbers good data.
- Invariant to preserve: never widen quarantine to cover read failures, keep each domain on its own chain, and route *all* mutations of a file through its chain — a single direct `writeFile` that bypasses the chain reopens the lost-update hole this ADR closed.

## References
- `lib/store.js:1` — store module entry
- `lib/store.js:207` — `writeFileAtomic` (tmp → writeSync loop → fsync → rename; the `.bak` snapshot is taken by the per-domain savers before they call this)
- `lib/store.js:237` — UNREADABLE vs. PROVABLE-corruption handling / `.corrupt-<ts>` quarantine + `.bak` recovery
- `lib/store.js:293` — per-domain serialized write chains (`_writeChain` / `_modChain` / `_comChain`)
