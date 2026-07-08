# za-post — Moderator auto-approval (verified design)

> Root problem: FB holds poster-accounts' posts in the group "Spam potentiel"/pending queue (not the public feed) → comment can't attach. Fix: a separate **moderator** account (admin of all groups) approves OUR held posts → live → poster comments. Ships behind `moderationEnabled` (default OFF = identical to today).

## Architecture: 3 serialized phases per cycle (reuses existing dealt-state + pendingApproval seams)
- **Phase 1 — Posting** (existing pool). On `pendingApproval`, persist a `held` record `{postId, gid, posterAccount, fbDisplayName, captionSnip, status:'held'}` to `moderation-state.json`. (Held posts already stay dealt-not-posted — exactly-once intact.)
- **Phase 2 — Moderation** (new `automation/moderator.js` `runModerator`). Moderator's own browser/cookies visits each group that has held records, approves OUR held posts **fail-closed**, flips status `held→approved`.
- **Phase 3 — Comment-only.** Re-enter the owning poster's browser with `commentOnly` (skip composer/publish), navigate the captured permalink, run existing `addFirstComment` → `status='commented'`.

## Designation + data (store.js)
- `normalizeAccount`: `isModerator` (bool, single moderator enforced in IPC), `fbDisplayName` (string — the author-match key; queue shows display name, not account.name).
- `fbDisplayName` captured best-effort at login in `runAccount` (nav profile name); empty → "cannot match" (fail-closed).
- `loadModeration()/saveModeration()` mirror `loadRotation/saveRotation` (atomic). `moderationEnabled` setting (default false) in DEFAULT_SETTINGS + clamp.

## Approval routine (fail-closed, instrumented)
- Queue URLs (try in order, validate a queue indicator, else skip — NEVER fall to the feed): `/groups/{gid}/pending_posts`, `/groups/{gid}/spam?sorting_setting=SPAM_POTENTIAL`, `/groups/{gid}/spam`.
- Per held card (`[aria-posinset], div[role="article"]`): extract author + caption (normText). Approve **only if BOTH**: author `===` (strict normalized) one of our `fbDisplayName` **AND** caption matches a *this-cycle* held `captionSnip` (≥12). Else skip (`not_ours`/`author_unclear`/`caption_mismatch`/`own_post`).
- Publier: button matching `/publ|appro/` (FR Publier/Approuver, EN Publish/Approve…). Click ONCE, no re-click. Confirmation probe (re-scan 3–5s): gone → `approved`+permalink; still there → `failed_unconfirmed` (retry). `checkRateLimit` after each → stop + pause posters.
- **Instrument every step** (queue title/indicator, per-post author/ours/caption_match/decision, confirmation, HTML dump on selector miss) — refine against real DOM live (the `[aria-posinset]` method).

## Build order (each ships behind `moderationEnabled`; dark until live-verified)
1. Store + designation (pure) + UI toggle/fbDisplayName + capture-at-login.
2. Persist held records in Phase 1 (instrument; verify records appear).
3. `moderator.js` **read-only DRY-RUN** (scan+log, NO click) → refine queue DOM live. ← instrumentation gate
4. Enable Publier click + confirmation probe (only after dry-run match decisions are correct).
5. Phase 3 comment-only mode in `runAccount`.
6. Orchestrator phase wiring; exclude moderator from posting pool; poster-pause on moderator rate-limit.
7. Dashboard surfacing.

## Safety (risk → guard)
Stranger spam → two-factor (author=== AND caption-match this cycle), fail-closed. Near-name spoof → strict equality (no substring). Own test post → skip if author==moderator. Double-approve → click once + confirmation probe + approved posts gone from queue. Re-approve stale → caption-match vs THIS cycle only. Double-comment/post → existing submitted/publishClicked guards; commentOnly never publishes. Moderator checkpoint → probe first, never auto-login. Moderator rate-limited → stop + pause posters. Crash → moderation-state.json atomic, status flips persisted.

## Tests
author normalized-equality (reject "Abdo Abdo 2"/empty/accents); two-factor fail-closed (only matching post approved); idempotency (re-run = 0 clicks; commented → Phase 3 no-op); commentOnly never calls clickPostButton/waitForPublish; state recovery (missing/corrupt moderation-state → empty, no crash).

## Honest logging
Phase 1: posted | pending(+held). Phase 2: mod:approved | skipped_not_ours | skipped_author_unclear | skipped_caption_mismatch | skipped_own_post | failed_unconfirmed | failed_selector(HTML) | rejected_gone | queue_not_found. Phase 3: comment:posted|skipped|failed. Never "approved" without the confirmation probe; held/failed loudly visible + retried.
