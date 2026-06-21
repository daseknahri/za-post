# za-post — Robust first-comment flow

> From a 16-agent analysis (10 changes adversarially verified safe). The first comment is the payload — it must land on the RIGHT post, reliably, exactly once.

## 0. Principles (invariants)
- **I1 Right post.** Comment only where we can PROVE it's our post (permalink page = one article). Else skip — a wrong-post comment is worse than a missing one.
- **I2 Exactly-once.** The submitting `Enter` fires at most once; the `submitted` guard means once Enter is pressed, `addFirstComment` never returns the retryable value. Verification never re-enters the submit path.
- **I3 Fail loud.** Outcomes: `posted` (text verified visible) / `not_visible` (Enter pressed, text absent on rescan) / `unconfirmed` (Enter pressed, verify timed out) / `failed` (never pressed Enter — retryable) / `skipped` (deliberately not attempted) / `none`.
- **I4 Slow-net patient.** Wait for interactivity (an article AND a candidate box), not just domcontentloaded; degrade gracefully, never hang (evalTimed/withTimeout caps).
- **I5 Anti-spam cadence.** Honor the human gap before EVERY comment attempt, not just the first.

## 1. Target flow
1. **Capture permalink verified-ours** right after publish (before the anti-spam wait): read the newest non-pinned article's `/posts|/permalink/` link AND its caption; accept only if the caption matches our post (or there's no caption to verify for image-only). Retry ≤2×.
2. **Comment via the post's OWN page as PRIMARY** (permalink-direct). The post is the only article there → unambiguous box.
3. Feed-scan only as FALLBACK (no/failed permalink), with the ≥12-char caption match AND a top-3 recency check.
4. Short-caption + no-permalink → **skip** (never guess).
5. Interactive-readiness gate before each box scan.
6. Focus → (image, 15s preview wait) → type (Shift+Enter for newlines) → **single Enter** → set `submitted`.
7. Verify: box emptied (one guarded no-op re-press) + **landing check** (comment text visible under the post, read-only).
8. Report the granular outcome; caller retries only on `failed`, honoring the per-attempt gap.

## 2. Changes (all verified safe)
C0 clarify `submitted` semantics · C1 4-state outcome enum · C2 per-retry anti-spam gap · C3 comment-image preview 8s→15s · C4 interactive-readiness gate before scans · C5 verified permalink capture (caption match + ≤2 retries) · C6 short-caption+no-permalink → skip · C7 permalink-direct PRIMARY / feed-scan fallback · C8 feed-scan top-3 recency check · C9 post-submit landing verification (read-only).

## 3. Placement decision
- Permalink available → permalink-direct (works for long/short/image-only).
- No permalink + long caption → feed-scan with ≥12-char match + top-3 position.
- No permalink + short/image-only caption → skip.

## 4. Exactly-once
Single `Enter` guarded by `submitted`; caller retries only on `failed` (produced only on pre-Enter paths); the one post-submit re-press fires only if the box didn't empty and is a no-op on an empty FB box; the landing check is read-only.

## 5. Watch after
Log signals: `caption verified: match`, `Feed ready: N articles / M boxes`, `opening the post directly via its link` as primary, `submitting (Enter)` exactly once per group, `landing verified`. Report distribution should be mostly `posted`, rare `unconfirmed`/`not_visible`, `skipped` only on short-caption-no-permalink. A spike in `failed`/`skipped` = selector drift or capture regression.
