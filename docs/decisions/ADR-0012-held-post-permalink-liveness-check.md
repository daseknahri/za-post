# ADR-0012: Held-post recovery via author-aware permalink-direct liveness check, not a feed scan

- **Status:** Accepted
- **Date:** 2026-07-06
- **Deciders:** owner + engineering

## Context
The held-post recovery flow (moderator approval + backup re-post) fires roughly 90 minutes after the original post was submitted. Before a reserve account re-posts a held post, we must know whether the original has since become public — otherwise the backup produces a visible duplicate.

The original approach was a shallow top-of-feed scan. Two failure modes broke it:

- **Missed auto-releases.** Posts auto-released from moderation during the ~90-minute wait have, by then, scrolled far down the feed. A top-of-feed scan never reaches them, so the recovery wrongly concludes the post is absent and re-posts a duplicate.
- **Stranger false-positives.** A caption-only scan can match a *different* account's post that happens to share the same caption, wrongly concluding our post is live and stranding our still-held post forever.

Recovery reads and writes must also never leak to the real IP: if proxies are configured but unavailable, or the session is logged out, the flow must bail rather than fetch from the bare connection.

## Decision
Before a reserve re-posts a held post, confirm liveness with `isContentLive`:

1. Check the original post's **own permalink page first**, matching on id / caption / **author**.
2. Only if that is inconclusive, fall back to a deeper **author-aware chronological feed** scan (12 scrolls, up to 60 articles).

Return semantics:
- Return `'live'` — mapped to `{ alreadyLive: true }`, **no re-post** — whenever *our* post is confirmed public.
- A readable **stranger's** same-caption post is **NOT** `'live'`.
- An **unreadable author** is treated as **possibly-ours** (conservative — we would rather skip a re-post than strand a held post or duplicate).
- Errors **fail-SAFE to `'absent'`**; the cap-1 bound limits any resulting duplicate to at most one.
- `proxies-on-with-no-proxy` returns `'no_proxy'` and `logged-out` returns `'session_expired'`; **both bail** — never read or re-post from the real IP.

## Alternatives considered
- **Shallow top-of-feed caption scan** (the original) — missed scrolled-down auto-releases and matched captions from the wrong account. Rejected as the root cause of duplicate and stranded posts.
- **No liveness check before re-post** — guarantees a duplicate on every auto-release. Rejected.
- **Caption-only match without author check** — strands held posts and produces stranger false-positives. Rejected.
- **Short-circuit to `'absent'` on any "content unavailable" page text** — a live post can embed a since-deleted reshare, so that text does not imply our post is gone. Rejected.

## Consequences
- More robust recovery, at the cost of one extra permalink fetch per held post.
- Ties directly into the moderator-approval gate and reserve-takeover flow; changes to either must preserve the `live` / `absent` / `no_proxy` / `session_expired` contract above.
- All three recovery phases **proxy fail-closed** and bound `browser.close()` with `Promise.race(sleep 8s)` so a hung close cannot block recovery.
- Invariant an engineer must not break: never read or re-post from the real IP when proxies are configured, and never treat a readable stranger's post as ours.

## References
- `automation/repost.js:151`
- `automation/repost.js:122`
- `automation/repost.js:80`
- CHANGELOG 1.0.12
