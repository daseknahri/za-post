# za-post — First-comment targeting hardening (verified design)

> Goal: the first comment always lands on OUR just-published post even when other users post during the 60–180s wait — never a stranger's post, never our own older duplicate (loop mode), never a double-comment. The **post-ID** is the trust anchor; permalink URL and feed scan are just routes to it.

## Build order (lowest-risk first; `npm test` after each)
1. **Logging + id parse + thread `expectedPostId`** through `addFirstComment` (default null); add id to log lines. No behavior change.
2. **Feed fallback hardening:** widen top-3 → top-8, normalized 40-char match, **first-match-wins (topmost = newest)**, scroll-once on no-match, and **`idmismatch` → skip** (a same-caption post whose id ≠ expected is refused).
3. **PRIMARY identity/caption validation:** before commenting on the permalink page, confirm the page resolved to OUR post (id from URL/DOM, or caption with identical normalization); mismatch → demote to feed fallback (never a blind comment).
4. **Permalink force-render (riskiest, last):** Node-side `hover()` on the caption-matched article's timestamp to force FB's lazy `<a href>`, plus id extraction from `data-feedback-id` / embedded `post_id` JSON; build `…/groups/<gid>/posts/<id>/` when no anchor renders.

## Safety invariants (must hold)
- **Exactly-once:** the `submitted` flag is untouched — after Enter, only non-retryable outcomes return; all new id/caption checks `return` *before* Enter (cleanly skippable/retryable).
- **Wrong-post:** capture matches caption in **top-3 only**; PRIMARY validates destination id/caption; fallback requires `expectedPostId` match and refuses on `idmismatch`.
- **Own duplicate (loop mode):** top-3 capture window + first-match-wins (newest) + id check — the old copy has a different id → `idmismatch` → skip.
- **Missed comment:** top-8 + one scroll-load + Tier-B id extraction widen reach; only when no id exists at all do we degrade to caption-only (logged as `id=?`).

## Key log lines (success)
- `Confirmed LIVE — our post is in the feed (id=NNN). Commenting on it directly.`
- `Comment: opening the post directly via its link (primary — id=NNN …)` → `Comment: posted and verified ✅ (visible under the post) (id=NNN)` (the two NNN match).
- `Comment: our post found in feed (id=NNN, pos=K)` (K may be >3 — proves the widened window earns its keep).
- Refusal (must never be followed by a posted/verified): `Comment: a same-caption post in feed is NOT ours (found id=…, expected=…) — NOT commenting`.
