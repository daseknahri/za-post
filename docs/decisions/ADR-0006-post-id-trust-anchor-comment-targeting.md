# ADR-0006: Post-ID as the trust anchor for first-comment targeting (permalink-direct primary, skip rather than guess)

- **Status:** Accepted
- **Date:** 2026-07-06
- **Deciders:** owner + engineering

## Context
The worker places a first comment on a group post after a human-like wait. During that wait, the target group is not static: other users — and, in loop mode, the account's own older near-duplicate — post near-identical captions to the same group. A comment landed on the WRONG post is worse than a missing comment: it looks like spam on a stranger's content and burns account trust. This ambiguity gets sharper at 400-account scale, where many accounts publish the *identical* campaign caption into the same group, so a caption alone can no longer identify "our" post.

## Decision
Treat the Facebook **post-ID as the trust anchor**. The permalink URL and the feed scan are merely routes to that ID, never proof on their own.

- **Primary route:** the post's OWN permalink page. One article on the page means an unambiguous target, but it is still re-verified as ours by id / caption / author before any comment is typed — the permalink is a *re-verified* route, not blind trust.
- **Fallback route:** the feed scan, used only when the permalink route is unavailable. It applies an author-aware top-N match and **refuses (skip) on an explicit id mismatch**.

A comment lands only when one of these holds: an FB-post-id match; a SINGLE unambiguous caption match; or, when multiple same-caption posts exist, the article authored by us. A short caption with no permalink resolves to **skip — never guess**.

Enter fires at most once, guarded by a `submitted` flag; post-Enter outcomes are never retried, so a partially-sent comment can never be duplicated by a retry.

## Alternatives considered
- **Caption-only feed matching** — rejected. Ambiguous at scale; can land on a stranger's identical caption.
- **Blind comment on the permalink page** (no id/caption/author validation) — rejected. Demoted to a re-verified route instead of trusted outright.
- **Best-guess comment on short-caption / no-permalink posts** — rejected in favor of an explicit skip. A safe miss beats a wrong landing.

## Consequences
- A granular outcome enum (illustrative) — `posted` / `not_visible` / `unconfirmed` / `failed` / `skipped` / `none` / `notfound` / `blocked_account` / `blocked_comment` / `blocked_*_landed` — where the caller retries **only** on `failed`. `notfound` = published but HELD in "Spam potentiel" (not public → no retry can help; routed to moderator approval, excluded from the `posted` report line). The non-landed `blocked_account` / `blocked_comment` leave a live post with no comment (rescue-eligible), while the landed-then-blocked variants (`blocked_*_landed`) exist precisely to stop a rescue path from firing a second comment.
- A **permalink-capture force-render step** in the post-publish feed-confirmation block (hover the post's timestamp permalink `<a href>` to force Facebook's lazy render so the post-id can be captured after publishing) is the riskiest single piece and the most likely to break when FB changes its lazy-render behavior — treat it as the first suspect on comment-targeting regressions.
- A slightly higher skip rate on short-caption / no-permalink posts, accepted as the safe trade.
- **Invariants not to break:** post-ID remains the sole trust anchor (URL/feed are routes, not proof); ambiguity resolves to skip, never to a guess; Enter fires at most once and post-Enter states are never retried.

## References
- `automation/worker.js:1193` — feed-scan fallback: author-aware top-N match + id-mismatch skip
- `automation/worker.js:1081` — permalink-direct primary route (`if (permalink)`) + our-post re-verification (id / caption / author) at `:1108`–`:1135`
- `COMMENT_TARGETING_SPEC.md` — full targeting decision spec and outcome enum
- CHANGELOG 1.0.2
