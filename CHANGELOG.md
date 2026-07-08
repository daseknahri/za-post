# Changelog

Notable changes to za-post. Format loosely follows Keep a Changelog; versions follow SemVer.

## [1.0.25] — 2026-07-08 — Network-capture comment: confirm by caption (stop the false "author mismatch" fallback)

Live monitoring showed the network-capture **post** phase working great (~6–8s, feed re-scan skipped), but **every
comment** then logged *"the captured link did not positively confirm OUR post (author mismatch) — falling back to the
group feed"* and did the slow feed-scan anyway. Root cause: the captured id was correct (the fallback found OUR post
by caption at pos=1 every time), but the content-verify let an **author mismatch reject a good caption match** — and
the account's display name is unreliable (FB reports *"logged in as (unknown)"*), plus the permalink page is often
*"not fully interactive (timeout)"* when read. So a reliable positive signal (caption) was being overridden by an
unreliable negative one (author).

- **Confirm by caption, corroborate by author.** The network content-verify now confirms OUR post on a **positive
  caption match** — the same single-article standard the feed-scan already uses (`_scanFeedRaw`: "one caption match →
  ours"). Author match is a *positive* corroborator; a bare author mismatch no longer rejects a caption-confirmed post.
- **Poll for slow renders.** It re-reads the post page for up to ~5s (accepting the instant it matches) instead of a
  single early read that misfired on a not-yet-rendered permalink.
- **Diagnostic.** On a genuine miss it now logs the author it actually read (`author read="…"`) to speed future triage.

Wrong-post safety is preserved: a foreign/mis-parsed id whose page does not carry our caption never confirms here
(→ feed-scan fallback, which is itself wrong-post-guarded via `idHit && capHit` for network ids). Net effect: public
posts now comment via the **direct link** (skipping the feed-scan) instead of always falling back. 242 tests green.

## [1.0.24] — 2026-07-08 — Fix: `droppedImage is not defined` crash at the end of a clean run (live-monitor catch)

Monitoring a live test run, an account **crashed at completion** with `droppedImage is not defined`, then retried.
Root cause (introduced in v1.0.16's gap hunt, latent until now): `droppedImage` was `let`-declared **inside** the
account's main `try` block (worker.js:2337) but read in the function's **final `return`** (worker.js:3500, after
the `finally`) — out of scope → a `ReferenceError` on **every clean completion**. It stayed hidden because (a) the
previously-running Electron instance held older in-memory code, and (b) the many early-exit returns (proxy/auth/etc.)
don't reference it — only a *fully successful* run reaches the final return. The v1.0.20–1.0.23 speedups made clean
completions the norm, surfacing it.

- **Hoisted `let droppedImage = false;` to function scope** (worker.js:2024, beside `posted`/`heldRecords`/
  `commentQueue`); line 2337 is now a plain assignment. In scope at every reference.

Why it mattered beyond the crash: the thrown `ReferenceError` **discarded the run's return value** — `heldRecords`,
`commentQueue`, and the `fullyPosted` deal-marking — so held posts / rescue comments could be dropped and a
completed library post could be re-posted next cycle. 242 tests green. **Requires an app restart to take effect.**

## [1.0.23] — 2026-07-08 — Trim the comment-locate "nudge" loop (log-driven)

Reading the owner's `automation.log` from a live run, the new dominant per-post cost (after the v1.0.20/1.0.21
fixes) was the **comment-locate feed-scan**: `addFirstComment`'s fallback nudges the feed to lazy-render, up to 6
times per check across **two** full checks (1st load + reload), with a flat `sleep(2000)` (1200 instant) between
scans. On a silently-held post that never appears publicly, this burned ~30s only to conclude "held → moderator".

- **Ramped the render-wait** in both nudge loops: flat `2000ms` (normal) / `1200ms` (instant) → `1100/1700ms`
  (normal) and `700/1100ms` (fast/instant), shorter on the early passes. `scanFeed` re-checks the feed on **every**
  pass, so a slow-rendering public post is still located — just sooner — and a genuinely-held post gives up faster
  (~8–12s off the worst case). The wrong-post guard lives entirely inside `scanFeed` and is untouched: this changes
  only *how often* we re-check, never *what* is accepted. 242 tests green.

> Note: that logged run was executed by a stale Electron instance started **before** the v1.0.20–1.0.22 commits, so
> it still showed the 12s image-vary and 19.5s verify-reload those versions already eliminated. Restart required.

## [1.0.22] — 2026-07-08 — Capture the post link from Facebook's publish response (skip the slow feed re-scan)

The slowest, flakiest step of a comment-bearing post was **taking the post's URL**: reload the group, scroll,
caption-match, then a hover + `sleep(700)` + re-read dance to force Facebook's now-usually-hidden permalink to
render — and it *still* often came up empty (the code says so: *"FB's current DOM rarely exposes a numeric
post-id"*). The professional fix: stop scraping the feed for the link and read it straight from Facebook's own
**publish response** — the `create-story` GraphQL mutation returns the new post's id. Capture that and the whole
verify-reload is unnecessary.

### Added — opt-in, two-phase only, **default OFF**
- **Setting `capturePostLinkFromNetwork`** ("🔗 Grab the post link from Facebook's response (faster, experimental)").
  When on, `armPostIdCapture()` attaches a response listener right before the Post click, reads OUR post id from the
  create-story mutation's response (a `/groups/<gid>/posts/<id>` URL for our exact group, or a `post_id`/`story_fbid`
  field), and the two-phase flow uses it as the permalink — **skipping the feed reload/scroll/hover entirely**.
- **Wrong-post-safe by construction.** The captured id is a *candidate* only. Phase 2 opens the link and
  `forceContentVerify` requires a **positive caption OR author match on the post's own page** before commenting —
  for both the `urlId===id` and the `urlId===null` (redirect) cases — else it demotes to the article-scoped,
  caption-matched feed-scan fallback. A mis-parsed or foreign id can never blind-comment on the wrong post.
- **Held detection preserved.** A silently-held post's link resolves to a non-public page → no comment box → the
  feed-scan fallback finds it absent from the public feed → `notfound` → moderator queue, exactly as before.
- **Off = zero change.** With the setting false, `forceContentVerify` is always false and the legacy cascade is
  byte-identical; no listener is attached.

### Verified
Two adversarial-review rounds (find→refute→adjudicate, 5 vectors). Round 1 **confirmed a real wrong-post hole**:
a bad captured id could redirect the permalink to the group root, nulling `urlId`, so the content-verify was
skipped and the id-only branch could comment on the top feed post. Fixed by (a) tightening the capture regex to
our exact group id (no `\d+` wildcard) and (b) making the network path *always* require a positive caption/author
confirmation regardless of `urlId`. Round 2 confirmed the gap closed with the legitimate own-post path intact.
242 tests green.

## [1.0.21] — 2026-07-08 — Question-every-step: trim the verify/publish/caption deadlines (fast/instant)

A systematic "question every step" pass over the per-post flow (grounded in the test-log timings) confirmed the
remaining time is mostly Facebook render + safety confirms — plus a handful of over-long fixed waits *between*
re-checks. Trimmed only those: each keeps the SAME confirmation and just samples for it faster. Ten unsafe candidates
were rejected (the tested 800ms composer render floor; the clear-editor settle that guards against a double-caption;
the toast-hydration gate that catches held posts; skipping any auth/rate-limit check).

### Changed (fast/instant tiers)
- **Post-landed verify (the biggest chunk, ~19.5s):** the find-poll's inter-miss re-scan sleep 1.5s → 0.5–0.9s
  (~2–4s/group), and the "≥3 articles" pre-wait 5s → 1.5s (up to ~3.5s on a sparse feed). The caption+author
  wrong-post guard, the 16s ceiling, and break-on-match are unchanged — it just finds your post sooner.
- **Caption verify:** poll interval 400ms → 150ms (~1s), so a late-committing caption is seen a tick sooner (the
  landed test + survival re-entry unchanged); instant React-commit pad 120ms → 60ms.
- **Publish confirm (waitForPublish):** poll cadence fast 900ms → 500ms, pre-check settle fast 500ms → 200ms
  (~0.5–0.8s). The dialog-close confirmation (the double-post guard) and the timeout ceiling are untouched.
- **Post-nav settle** fast tier 1000ms → 500ms (kept a 500ms hydration floor); **dismissPopups** only settles when it
  actually clicked a popup (the common no-popup path pays nothing).

242 tests green. Every trim samples an existing confirmation faster or removes a fixed pad — no publish-confirm,
wrong-post guard, caption-drop guard, or anti-spam gap was weakened.

## [1.0.20] — 2026-07-08 — Fix the ~8s per-group image-vary stall (the "long pause after the composer opens")

Reading the test log, the long pause right after the composer opens was **image variation**: jimp's hue rotation
(a full pure-JS RGB→HSL→RGB conversion per pixel) cost ~6.5s per image on its own — the entire `varyImage` bottleneck.
Profiled and replaced.

### Fixed
- **Image varying is ~8× faster (~8s → ~1s per group).** The per-group image perturbation used jimp's
  `color([{apply:'hue'}])`, which cost ~6.5s alone (profiled: read 350ms · crop 80ms · brightness 31ms · **hue 6508ms**
  · write 488ms). Replaced with a cheap per-channel color tint — one fast pixel pass (~50ms) that shifts the color
  distribution + hash the same way. Anti-dedup is unchanged (**verified: two groups still get different images**); only
  the slow implementation is gone. Also caps an oversized source at 1600px first (FB downscales uploads anyway).
- **Honest "image varied" log.** It logged "Image varied" even when jimp couldn't read the format (notably **WEBP**,
  which jimp can't decode — those upload identical to every group = an image-dedup risk). The log now says so and
  recommends JPG/PNG. (Your active posts use JPG image URLs, which vary fine; this is a heads-up for WEBP uploads.)

242 tests green. The anti-dedup protection is unchanged — the varied image still differs per group.

## [1.0.19] — 2026-07-08 — Trim redundant steps from the posting path (INSTANT optimality)

A focused audit for genuinely UNNECESSARY/redundant steps (not just slow waits) found the posting path already lean —
only two safe removals, applied here. It correctly rejected removing the caption-accept `editableLen` re-read (a
deliberate double-caption guard).

### Changed
- **INSTANT skips the redundant Post-button diagnostic scan.** A 3rd DOM scan of the enabled Post button (already gated
  by the `waitForFunction` above and re-scanned by `clickPostButton`) ran before every publish purely to log a drift
  breadcrumb — now skipped in instant mode (kept in slow modes for troubleshooting). It gates nothing.
- **The image-first caption seed's verify result is reused when it already landed.** `enterCaptionOnce` ends by
  returning a caption-landed check, which was discarded and immediately re-run on the same unmutated editor. When the
  seed already reports landed, the loop reuses it (skipping a duplicate ~1.5s poll); a not-yet-landed seed still gets
  the full patient re-read (its internal timeout differs), so a slow-rendering caption is never re-pasted early.

242 tests green. Both changes are outcome-identical — no double-post/comment trap, wrong-post/caption guard, or
anti-spam floor touched (the audit's unsafe candidate was rejected; a timeout mismatch on the second was caught and guarded).

## [1.0.18] — 2026-07-08 — Posting speedups for the single-IP setup (safe — no anti-spam change)

With one IP the safe way to go faster is more groups/hour PER ACCOUNT, not more concurrency. A focused audit found
four overhead/pipelining wins that recover wasted time WITHOUT touching the anti-spam gaps, the v1.0.17 concurrency
cap, or any double-post/comment safety. (It also rejected the unsafe ideas — e.g. cutting the anti-spam pacing.)

### Changed
- **Multi-tab pipelining is now ON by default (`tabsPerBrowser` 1 → 2).** While an account posts to one group, the
  NEXT group's page pre-loads in a hidden tab, so slow navigation OVERLAPS posting instead of blocking it (~1.5–4 min
  saved per account per cycle at 20–30 groups). Publishing stays strictly sequential; every anti-spam gap and
  double-post trap is unchanged; it's still one browser / one live IP per account (no extra IP concurrency). Set it
  back to 1 for classic one-tab behavior, or 3–4 on strong hardware.
- **Trimmed recoverable overhead in the posting/verify flow** (not anti-spam gaps): the normal post-nav settle 3s → 1.5s
  (the auth/rate-limit checks re-read the DOM with their own waits anyway); the no-comment verify's redundant "≥3
  articles" pre-wait 15s → 5s (the find-poll that follows is the real landed-check); the direct-permalink comment
  interactivity wait 10s → 4s (the box-selector wait + retry are the real gate). ~30–90s more saved per account.

242 tests green. All changes recover overhead only — the anti-spam floors, the real-IP concurrency cap + pacing
(v1.0.17), and the double-post/comment/wrong-post guards are untouched. Validate on the dev clone that per-account
wall-time drops with delivered counts identical and no double-posts.

## [1.0.17] — 2026-07-08 — Real-IP (no-proxy) posting hardening — the main method

A focused audit of the real-IP path (the whole fleet posting from ONE residential IP — the main deployment) found
and fixed the biggest ban-risk patterns for that configuration.

### Changed / Fixed
- **Concurrency on one IP is now capped for safety, not just by RAM.** With no proxies the fleet was limited only by
  parallelAccounts/RAM — a beefy machine could run ~16 accounts posting simultaneously from one residential line (a
  coordinated-inauthentic-behavior signal). Real-IP concurrency is now capped at a small, IP-plausible default (3,
  tunable via `realIpMaxConcurrent`), independent of RAM. Your current default (2) is unchanged.
- **Real-IP launches are paced.** Completion-triggered top-ups no longer fire back-to-back into the shared IP — each
  real-IP start is spaced by a jittered gap (5–13s instant, 15–45s otherwise), so a burst of fast-failing accounts
  can't hammer the line.
- **The fleet no longer shares one browser fingerprint.** With every account on one host, only the viewport varied, so
  ~1 in 6 accounts were byte-identical (a linked-account cluster). Each account now presents a stable, plausible
  `hardwareConcurrency` (seeded by name, capped at the real core count) — the one axis safe to vary, because it has no
  contradicting HTTP client-hint header (unlike `deviceMemory`, deliberately left alone; see ADR-0001).

242 tests green. The pool changes only ever LOWER concurrency (no double-post/anti-link impact); the fingerprint change
was reviewed for HTTP client-hint coherence (the ADR-0001 captcha-loop lesson — the review caught a deviceMemory
header mismatch, which is why deviceMemory is not spoofed).

### Deferred (a dedicated real-IP pass)
- An IP-level circuit breaker (stop marching healthy reserves into an already-throttled shared IP).
- Viewport-vs-monitor geometry coherence (avoid a window larger than the reported screen).

## [1.0.16] — 2026-07-08 — Gap hunt round 2 (6 fixes: Chrome-import, licensing, Quick Setup, settings, images)

A second adversarial gap hunt on the surfaces round 1 didn't target (settings/UI, campaign-plan builder,
Chrome-import, licensing, image/media, app lifecycle) found 7 gaps; **6 are fixed here** — the 7th (a client-side
expiry re-check) was left in place deliberately as defense-in-depth. No double-post/comment invariant was touched.

### Fixed
- **Chrome import can no longer silently destroy an account.** A Chrome import whose typed label sanitized to the
  same name as a DIFFERENT, already-set-up account would overwrite that account's login cookies + credentials with
  the wrong Facebook identity. It now adopts a name-match only when the target is a genuine empty placeholder (no
  saved login/session); a real collision creates a new, distinct account instead.
- **A valid license can no longer be wrongly locked out on a transient hiccup.** Reading the machine id could
  momentarily fail (antivirus/registry lock) and fall back to a different value that read as "bound to a different
  machine" — locking out a paying customer (and even the owner) and tearing down a running overnight campaign. The
  machine id is now remembered once read, and a transient failure is treated as "re-check later," never a lockout.
- **Quick Setup can now remove an account by clearing its groups.** Deselecting all of an account's groups in the
  wizard previously left the old assignment on disk, so it kept posting to its old groups; the wizard now clears it.
- **Settings/post-set saves no longer clobber freshly auto-detected proxy timezone/locale** (a stale UI snapshot
  could revert the detected geo, leaking the host clock/language over a proxy IP).
- **A multi-image post with a missing image file is now loud and safe** — it logs the dropped file and keeps the
  library post (blocks auto-delete) instead of silently publishing fewer images and then deleting the source.
- **Login-window credential capture uses a serialized write** so it can't clobber a concurrent Chrome-bridge update.

242 tests green. The two HIGH fixes + the auto-delete gate were cleared by an adversarial verify (which caught one
follow-on defect, fixed).

## [1.0.15] — 2026-07-08 — App-wide gap hunt (11 fixes)

A full-power adversarial gap hunt across eight subsystems (find → independent refute → adjudicate) surfaced 14 real
gaps; **11 are fixed here.** The remaining 3 — a moderation-recovery write-ordering durability gap and two
daily-schedule cycle-counter durability issues — are deferred to a dedicated, separately-verified pass because they
need coordinated persisted-state + resume changes. No double-post / double-comment invariant was touched.

### Fixed
- **Comment images are no longer deleted before a reserve/moderator can use them.** With image variation on (the
  default), a live-but-couldn't-comment post handed its comment image to the rescue/moderator queue, but the temp file
  was unlinked at account end — so the later rescue failed (image-only comments lost; text+image comments lost their
  image). The image is now kept until its consumer runs, with a startup sweep reclaiming any crash-orphaned temp.
- **Two accounts holding the same post in the same group both get recovered.** A held-record dedup keyed only on
  post+group dropped the second account's card; it now scopes by poster, so both are approved and both comments placed.
- **Moderation: an approved post whose comment can't be placed is retried, not lost** (moderation is off by default). A
  transient "not in feed" no longer strands the link behind a stale "approved" record — the post is re-opened for the
  moderator (bounded to 3 re-opens, then surfaced as failed) instead of silently vanishing under a false "100% delivered".
- **Remote API hardening:** `POST /api/automation/interval` no longer 500s (leaking a stack) on an empty body, and a
  terminal error middleware routes malformed-JSON / upload-limit errors through the generic-message contract (no
  stack/path leak to a tunnel-exposed client).
- **Bulk account import validates names** (letters/numbers/underscore, like single-add) so a pasted name can't corrupt a
  profile path or inject into a card's `id` — plus those `id` attributes are escaped as defense-in-depth.
- **Proxy passwords containing `:` survive the Proxies-table edit round-trip** (were truncated on save).
- **Rapid group/pace/filter toggles can't lost-update each other** — renderer account writes are serialized.
- **Progress-ledger durability:** a corrupt ledger is quarantined instead of overwriting the good backup, and the
  in-memory rollup commits only after a successful write (a failed write no longer diverges from disk).
- **Migrated cookies land where the app reads them** (sanitized account key) so accounts with special-character names
  keep their session.
- **Reserve / moderator / re-post browsers hard-kill on a close-hang** so a stuck Chromium can't orphan on the profile.

242 tests green. Fixes touching posting/recovery paths were cleared by an adversarial multi-agent verify.

## [1.0.14] — 2026-07-08 — Per-account group membership check

A new operator tool: for any account, check whether it's actually a **member** of each of its assigned groups
*before* running a campaign — so you catch "not a member yet / pending / logged out" groups up front instead of
discovering them as failed posts.

### Added
- **"🔎 Check membership" button on each account card.** Opens a hidden browser as that account (through its own
  proxy, same identity as posting) and visits each assigned group, reporting **member / pending / not a member /
  logged out / unavailable** as a status list, with live progress in the log. Read-only — it never posts. Refuses
  to run while a campaign or a login window is using that account's profile (one browser per profile). Detection is
  tuned for the English Facebook UI (set accounts to English).

### Fixed
- **A campaign started *during* an in-flight check can no longer disturb the profile.** The worker now sees an
  in-flight membership check (a new `isCheckOpen` guard, threaded exactly like the existing login-browser guard) and
  **skips** that account for the cycle instead of force-killing the check's browser and deleting its lock files —
  which risked profile corruption. (Found by the code review of this feature.)

242 tests green.

## [1.0.13] — 2026-07-08 — Persistent rotating tab pool (ADR-0018)

Implements [ADR-0018](docs/decisions/ADR-0018-persistent-rotating-tab-pool.md). With multi-tab posting
(`tabsPerBrowser` ≥ 2), the app no longer opens a fresh browser tab for every group and throws it away —
it keeps a small pool of tabs open and reuses them by re-navigating, which is more like a real person and
avoids a constantly-churning set of Facebook tabs.

### Changed
- **Multi-tab posting reuses a persistent pool instead of a new tab per group.** Up to `tabsPerBrowser`
  hardened tabs are opened once and rotated: while a group is being posted on the active tab, an idle pool
  tab pre-loads the next group; on advance, the just-finished tab returns to the pool (it is no longer
  closed) for a later group. This preserves in-tab history/referrer continuity and a stable, small tab
  count. Tabs are recycled after ~12 navigations to avoid Facebook single-page-app memory creep. The
  two-phase comment pass shares the same pool. Publishing stays sequential; every double-post/double-comment
  guard is unchanged (they are keyed by post+group, independent of which tab is used).
- **`tabsPerBrowser = 1` is unchanged** — the pool is never grown or rotated, so single-tab behavior is
  byte-identical to before.

### Fixed (found by the adversarial verify of this change)
- **Caption could land in the wrong (idle) tab** if an adopted tab's CDP session failed to initialize: the
  session binding is now always rebound to the active tab (re-created if missing), so the caption paste and
  the off-screen window parking always target the tab being posted to — never the just-released one.
- A tab dropped mid-prefetch across the post→comment phase boundary is now closed rather than briefly
  leaked back into the next pool.

Verified by a 5-dimension adversarial pass (double-post, double-comment, tab-accounting, CDP rebind,
async races) → no double-post/double-comment/wrong-group/leak; the two non-blocking defects above were the
only findings and are fixed. 242 tests green.

## [1.0.12] — 2026-07-08 — Held-post recovery + login-cookie safety

An audit of the "held for review" recovery flow (moderator approval + backup re-post) and the manual-login window
found several gaps, fixed here.

### Fixed
- **No more duplicate re-post of a post Facebook auto-released.** When a held post is recovered by a backup account,
  the app first checks the original isn't already public. That check only scanned the top of the feed — but the
  recovery runs ~90 min later, by which time an auto-released post has scrolled far down, so the check missed it and
  the backup re-posted it (a visible duplicate). It now confirms via the post's own link directly, and its feed
  fallback is deeper and checks the poster's name — so a duplicate is no longer produced, and a *different* account's
  same-caption post can no longer be mistaken for yours (which used to strand your held post).
- **The manual-login window no longer wipes a good saved session.** Opening a login window for an account whose
  session had lapsed used to overwrite its saved cookies with the logged-out ones within 5 seconds, destroying the
  jar the app needs to auto-recover it. It now only saves cookies once the account is actually logged in.
- **The moderator no longer risks approving a stranger's held post** that happens to share a layout container with
  yours (it now refuses an ambiguous match rather than guessing).
- **End-of-run report is honest about comments.** It no longer says "every comment delivered" when a live post's
  comment couldn't be placed — it lists those posts so you can add the comment manually.
- Comment-recovery bookkeeping is scoped per account, so it can't mark the wrong account's pending comment.

## [1.0.11] — 2026-07-07 — Caption/comment content fixes (Arabic + emoji)

A focused audit of the compose→type→attach path found three content-surface gaps, all fixed here.

### Fixed
- **Emoji in captions/comments no longer get garbled.** The human-like typing split text into fixed-size chunks
  by UTF-16 code unit, which could cut an emoji in half at a chunk boundary and publish a broken "�" where the
  emoji should be — and, worse, that corrupted caption then couldn't be matched to place its comment. Typing now
  chunks by whole characters, so emoji (and emoji + Arabic together) always come out intact. **Important for
  Arabic captions carrying emoji.**
- **An image-only comment is no longer counted as "sent" when Facebook silently drops its image.** The app now
  waits for the image preview to actually appear; if it doesn't, that comment is handed to a backup account
  instead of pressing Send on an empty box.
- **A caption template that randomly evaluates to empty no longer stops a healthy account.** If your caption uses
  spintax with an empty option (e.g. `{صباح الخير|}`) and it happens to pick the empty side for a group, the app
  now re-rolls, and if it's still empty with no image it skips just that group with a clear "fix the caption
  template" message — instead of opening a blank composer that used to be mistaken for an unsupported-language block.

## [1.0.10] — 2026-07-07 — Two-phase comment pass: pipelined + direct-to-post

Completes the **"Post everything first, then comment"** mode so its comment pass is as fast and reliable as the
posting pass.

### Changed
- **Each comment now goes straight to its post.** When posting in two-phase mode, the app captures each post's own
  link as it publishes, so the comment pass opens the post **directly** instead of reloading the group and
  re-finding the post by its caption — faster, and far more reliable when many accounts post similar captions.
- **The comment pass is pipelined.** While one comment is being placed, the next post's page **pre-loads in a
  background tab** (using the same "parallel group tabs" setting as posting), so the pass no longer stalls waiting
  for each page to load. A post whose link couldn't be captured falls back to the old feed-scan for just that one.

Verified (before and after) not to double-comment or comment on the wrong post: a pre-loaded tab is only ever used
for one post, is re-checked to be *your* post before commenting, and a retry always re-navigates; single-phase and
single-tab behaviour is unchanged.

## [1.0.9] — 2026-07-07 — Owed-groups × rest × reserve interaction fixes

A cross-feature audit found two cases where a dropped account's un-reached groups could still be silently skipped —
each only happening when the "rest a blocked account", "owed-groups ledger" and "reserve takeover" features combine.

### Fixed
- **A rested account's owed groups are never dropped.** If an account partially delivered a post, then got blocked
  and was rested, a backup account used to be handed the *next* post — and the un-reached groups of the earlier post
  were silently forgotten. Now a backup finishes the **owed** post first (to only the missed groups), and the ledger
  can no longer be cleared by work done for a *different* post.
- **An account stuck on an unrecognised language still gets its groups covered.** An account that can't post
  (unsupported Facebook UI language) never recovers on its own; its owed groups are now handed to a backup account
  instead of waiting forever. (Also: set such accounts to English — see the run-book.)
- **A backup account that hits a comment block now rests** instead of being re-picked into the same wall next cycle.

These paths were verified (before and after the fix) not to double-post: a backup only ever delivers a post to a
group that hasn't received it, and an owed post is finished by exactly one path.

## [1.0.8] — 2026-07-07 — Multi-account fix for the owed-groups ledger

An adversarial re-audit of the 1.0.7 ledger caught a regression before it shipped, fixed here.

### Fixed
- **Two accounts can share a group again in Daily Rotation.** 1.0.7's new per-group delivery ledger was tracked
  fleet-wide, which was correct for the one-post-per-group modes but wrong for Daily Rotation: if two accounts were
  assigned the **same group** and landed on the **same post** the same day, whichever posted first "claimed" the
  group and the **second account silently, permanently skipped it** — the exact silent-miss the ledger was meant to
  prevent, for the most common multi-account setup. The ledger is now scoped **per account** for Daily Rotation
  (each account independently posts to its own groups) while the one-post-per-group modes stay fleet-wide. Every
  read and write of the ledger uses the same scope, so a delivered group is never re-posted and an un-reached one is
  never dropped.
- **Correct daily count when backups split the work.** When several backup accounts each cover part of a dropped
  account's un-reached groups, the covered account's daily-post count is now incremented once (not once per backup),
  so it can't be wrongly blocked from the rest of its configured daily posts.

## [1.0.7] — 2026-07-07 — Persistent owed-groups ledger (no silently-skipped groups)

Closes the two partial-delivery gaps deferred from the 1.0.6 audit. When an account in **Daily Rotation** or
**Campaign Plan** posted to *some* of its groups and then dropped mid-run (logged out, checkpoint, crash), the
un-reached groups could be permanently skipped: the account's rotation pointer advanced as if the post were
finished, so nobody ever delivered it to the groups it missed. The fix carries that unfinished work forward
without ever re-posting a group that already got the post.

### Fixed
- **A partial delivery is never silently lost.** Every group an account was supposed to reach with a post is now
  tracked. If it reaches only some and then drops, the un-reached groups are remembered (a persistent "owed"
  ledger saved with the rotation state) and finished on the next cycle/day — either by the account itself or by a
  healthy backup account — targeting **only** the groups that were missed.
- **Never a double-post on the retry.** The groups that already received the post are excluded from the owed set,
  so finishing the remainder can never re-post to a group that already has it. Daily-rotation now also uses the
  same per-post/per-group delivery ledger the other modes use, so even a mid-run browser crash-and-retry can't
  double-post a group it already reached.
- **Pacing is unchanged.** Still one post per account per day (or your configured amount): a partial delivery
  finishes its owed groups *before* the account moves on to the next post, and it never posts more than its daily
  quota. When nothing is owed (the normal case) behaviour is byte-for-byte identical to before.
- **Campaign completion waits for owed work.** A campaign no longer reports "100% delivered" (or reshuffles a new
  round) while any group still owes an earlier post.
- Un-assigning a group from an account safely drops any owed work for that group (no stuck rotation).

## [1.0.6] — 2026-07-07 — Posting-engine robustness (failure handling)

An adversarial audit of the whole post/comment flow and every account-failure recovery path. Each fix was
independently re-verified for double-post / double-comment / lost-comment / deadlock safety.

### Fixed
- **No double-post on a slow publish.** A short or image-only post that took a long time to publish (common with
  many browsers on one home connection) could be misread as "failed" and then re-posted by a backup account. The
  app now waits and re-checks that the composer actually closed before ever concluding a post failed.
- **No double-comment after a rate-limit.** If Facebook showed a comment-limit message *right after* a comment
  actually posted, the app used to treat it as un-posted and a backup account re-commented. A comment that landed
  is now never re-placed, while the account is still rested.
- **Blocked accounts are no longer hammered.** A checkpointed / logged-out / disabled account used to be
  re-launched — and, if it had a saved password, re-submit the login form — **every cycle** (a real ban risk).
  It now rests (3h logged-out / 6h checkpoint / 12h disabled), a backup account covers its groups, and it rejoins
  automatically the moment it recovers (a single successful post clears the rest immediately).
- **Two-phase posting no longer keeps trying to comment through a disabled account.**

### Added
- **Arabic detection fallback.** The app already recognized Facebook's rate-limit / checkpoint / "pending review"
  / Post-button / comment-box text in English, French, Spanish, German, Italian, Portuguese and Hungarian; it now
  also recognizes the common Arabic wording. **Recommended:** set your accounts' Facebook language to English for
  the most reliable detection — this is a safety net for any that aren't.
- **"Unsupported language" guard.** If the Post button can't be found on two groups in a row (the signature of a
  Facebook UI in a language the app doesn't recognize), the account is flagged with a clear "set it to English"
  message and its groups are covered by a backup account — instead of silently posting nothing.

### Known / next
- Partial-delivery coverage in *daily-rotation* and *campaign* modes when an account drops mid-run after posting to
  only some groups: safe fix requires a persistent per-group delivery ledger (in progress) so retries never re-post
  an already-posted group.

## [1.0.5] — 2026-07-07 — Two-phase posting (post all, then comment all)

### Added
- **Post-then-comment mode** (Settings → "📝➡️💬 Post everything first, then comment"). Opt-in, off by default. Each
  account posts the image+caption to **all** its groups first, then makes a second pass to place every post's first
  comment. The time spent posting the other groups **becomes the wait before commenting**, so the per-post
  comment delay is absorbed for free — and **every post lands before any comment work**, so an interrupted run
  never leaves posts un-made. Combines with the parallel-tabs prefetch for a further speedup.

  Safety (verified by an adversarial audit across double-post, double-comment, lost-comment, and regression):
  the post still publishes and is marked delivered at the same instant as before (so a post can never be made
  twice), the comment pass never re-types a submitted comment, held ("Spam potentiel") posts and any blocked or
  interrupted comment route to the reserve/moderator queues exactly like the classic per-group flow (a post is
  never left without its link), and with the setting off the per-group behavior is unchanged.

## [1.0.4] — 2026-07-07 — Pre-launch reliability audit

A 9-dimension adversarial audit of the whole 1.0.3 candidate (each finding cross-checked by an independent
skeptic panel; each fix independently regression-reviewed). Double-post safety, the multi-tab pipeline, the
store write-chain, the IPC surface, and the Chrome-group auto-assign all came back clean. Six real defects were
fixed — the top two matter most for an unattended client run:

### Fixed
- **License never locks out a valid customer on an I/O blip (critical).** A transient lock on `license.json`
  (Windows Defender / OneDrive / the search indexer scanning the data folder — or the app's own license-cache
  rewrite) used to read as "not licensed": at the ~6h re-validation it **stopped a running overnight campaign**
  and popped the activation window; at launch it dropped an already-activated customer to the activation screen
  (also blocking crash-resume / auto-start). The re-validation now keeps the last-known-good license and retries;
  launch retries briefly, then opens provisionally and re-verifies within ~2 minutes. Only a genuinely absent or
  invalid/revoked license ever gates the app. (The owner key still activates offline/unlimited.)
- **No more silent "saved!" on a locked data file (high).** Editing an account (assigned groups, credentials,
  alias) while `data.json` was briefly locked would show "Account updated successfully!" but **discard the edit**.
  The save now surfaces the skip ("not saved — retry in a moment") instead of a false confirmation; on-disk data
  was never at risk, but the operator no longer loses an edit believing it saved.
- **Concurrent remote-pushed posts are never dropped.** A full-window save from the UI no longer overwrites the
  post/group library — posts pushed by the remote API (`POST /api/posts/bulk`, including `replace`) while the
  window is open are preserved, and a group added in the background is merged back rather than clobbered.
- **License gate covers the remote login endpoint.** The remote API's per-account login now refuses on an
  enforced build that isn't activated (matching the automation-start gate); its response reports the block
  truthfully instead of a misleading "login window opened".
- **Big-run concurrency no longer serializes on a momentary low-memory reading.** The RAM-based pool ceiling is
  re-read as each slot frees instead of frozen once per cycle, so a single low free-memory snapshot at cycle
  start can't drop a 400-account cycle to one-at-a-time; it still throttles down under genuine memory pressure.

## [1.0.3] — 2026-07-06 — Import from Chrome (session onboarding)

Onboard accounts that are already logged in as Chrome profiles, carrying their **device identity** so the
switch to the app doesn't trip a "new device" checkpoint.

### Added
- **Import from Chrome** (Accounts → 🌐 Import from Chrome). A tiny companion extension (generated per-install,
  localhost-only, token-gated) reads each profile's full Facebook cookie set — **including `datr`** — via Chrome's
  own `chrome.cookies` API and sends it to the app, which creates/updates the account (keyed by the FB id, so
  re-sending never duplicates) and stores the encrypted jar. The app's own Chromium then runs the account with the
  same device + session on the same IP — no re-login.
- Reads your Chrome profile labels (e.g. `BB24`) for naming, and a live import counter.

### Hardening (adversarial audit of the feature)
- **No overwrite-by-collision**: importing a profile whose label sanitizes to an existing account's name can no
  longer hijack that account (rebind its FB id / overwrite its cookies & login). A collision now creates a new,
  disambiguated account; only the *same* Facebook account (matched by id) updates in place.
- **Logged-out detection**: an import missing Facebook's `xs` session cookie is flagged loudly ("arrives logged
  out — re-send while logged in") instead of a silent success; empty cookies are dropped.
- **Token stability**: if the bridge token can't be saved, the app warns that the helper will need re-generating
  after a restart (instead of silently rejecting every import).

### Why an extension (not a folder copy)
- Chrome 127+ **App-Bound Encryption** seals session cookies (`c_user`/`xs`) so only the running Chrome can decrypt
  them — a raw profile-folder copy or direct DPAPI/SQLite read lands the account **logged out**. The in-Chrome
  extension is the only reliable path; it's also future-proof against Chrome's ongoing anti-extraction hardening.

## [1.0.2] — 2026-07-06 — scaling + reliability pass

Toward the 400-account client deployment. Focus: **never miss a post from a small error**, and
scale one machine to hundreds of accounts. 205 unit tests + 27 anti-spam checks green.

### Reliability — never miss a post
- **Caption retyping/loss fixed.** The composer text is now read from the marked editor exclusively
  (whole-doc fallback only when unmarked), so a draft can no longer spoof "caption landed" and the
  post no longer publishes with a half-typed or empty caption. Caption-after-image survival loop
  re-enters the caption if FB clears the draft.
- **Caption-less image post guard.** If every caption-entry path fails on an image post, the run
  retries pre-publish instead of publishing the image alone and counting it a success.
- **Comment landing hardened.** Send-button fallback, focus-before-Enter, box-resolution rescue
  (no-button / zero-bounds / click-fail), and a **second feed check** when the post isn't found on
  the first pass — so a comment that didn't attach is retried, not silently dropped.
- **Feed-confirmed labelling.** A post the verify-reload can't find in the feed is reported as
  "publish confirmed but not feed-confirmed (may be in Spam potentiel)" instead of a flat success.

### Scale — hundreds of accounts on one machine
- **Bulk account import** (cookies + optional proxy/credentials): safe filenames, de-duplication,
  and a per-account cookie jar written on import.
- **`datr` device-cookie warning.** Imports (bulk and single) now flag accounts missing Facebook's
  `datr` cookie — they log in but look like a new device (more checkpoints) — so weak exports are
  caught before those accounts run.
- **Real-IP concurrency.** No-proxy accounts (the operator's own residential line) now run
  concurrently up to `parallelAccounts` instead of one at a time; proxy accounts stay strictly
  one-per-distinct-IP (anti-link).
- **Hardware-aware pool sizing** (free-RAM + CPU-core ceiling) so a large fleet can't oversubscribe
  the machine.
- **Large-fleet UI**: account list virtualization (renders a capped window with an "N more" notice)
  and debounced data-update refresh.

### Pre-launch audit hardening (adversarially verified — 9 confirmed defects fixed)
- **Reserve-takeover no longer hangs.** The end-of-cycle reserve-takeover pool could spin at 100% CPU
  forever (event loop starved, no Stop) when two queued reserves shared one proxy IP — it now breaks
  the fill loop and waits for a slot, matching the main pool.
- **Bulk import can't report false success.** If `data.json` was transiently locked (AV/sync/indexer),
  the save was silently skipped while the UI said "imported N" and cleared the paste — the importer now
  fails loudly and keeps the paste so the operator can retry. Cookie-write failures are counted/surfaced.
- **Bulk "assign groups" actually assigns.** It was wired to a backend action that didn't exist, so it
  reported success while changing nothing — now implemented (add/replace), verified end-to-end.
- **Bulk-action toasts tell the truth.** A batch that matched 0 accounts no longer shows a green success.
- **Caption-after-image can't drop the caption.** The image-first fast path is seeded/marked before the
  survival check, so a stray editor (Messenger draft, feed composer) can't spoof "caption landed" into
  publishing an image-only post.
- **Publish-timeout feed rescue is author-aware** — a genuinely-failed post is no longer confirmed by
  another account's identical-caption post (wrong-post guard at scale).
- **Remote `/api/posts/bulk` persists again** — the hook was unwired (silently dropped every pushed post).
- **Manual Start posts now** — the one-shot daily-quota bypass is spent by the real run, not the read-only
  plan preview, so a daily/campaign account that already posted today still posts on a manual Start.

### 400-scale hardening
- **Disk-space preflight**: warns at Start (and periodically, throttled) if the drive can't hold ~400
  account profiles — a full disk otherwise halts posting fleet-wide via ENOSPC with no warning.
- **Live-ops IPC coalescing**: the per-account dashboard snapshot (a 400-element array) is now emitted
  on a leading+trailing throttle instead of on every state tick, so it stops stealing CPU from the pool;
  the in-memory state stays synchronously current so no update is lost.
- **Per-cycle write elision**: a no-op account outcome (reserves, already-posted-today, skipped) no longer
  triggers a full `data.json` rewrite — only real deliveries and flags persist (immediately, unchanged),
  removing the bulk of per-cycle write amplification with zero durability loss.
- **Daily cap aligned to the local day**: the per-account daily cap now uses the local calendar date, so it
  agrees with the local-day posting pace and schedule (no ~1h near-midnight straddle); the monotonic
  forward-only rollover still blocks a backward-clock reset.

### Delivery
- In-place upgrade: first-run migration seeds from a prior userData name only when the new one is
  empty (never overwrites existing data); per-seat license enforcement via a build-time marker;
  portable-zip deliverable.

## [1.0.0 – 1.0.1] — 2026-06 → 2026-07 — hardening + first client delivery

Twelve find→verify→fix hardening sweeps (~37 fixes) that converged to zero new confirmed faults,
plus the first packaged delivery. Highlights: read-vs-parse data-loss protection (data.json +
license.json no longer quarantine a good-but-locked file), all browser/proxy close paths bounded
against hangs, cross-phase record-lifecycle leaks closed, license lockout of a legitimate client
fixed (transient-lock + backward-clock grace), anti-detection leak audit (real-IP/WebRTC + proxy
geo consistency, non-forging), profile-first session persistence (stop clobbering a fresh session
with a stale cookie snapshot), and observability for multi-hour runs. Delivered as
`Za-Post-Comment-Tool-1.0.1-portable.zip` (per-seat enforced, non-bytenode).

## [Unreleased] — completion pass (M1–M4)

A reliability/security/quality pass taking the app toward a complete, shippable product. Full item
list and rationale in `COMPLETION_PLAN.md`; architecture in `CODEBASE_MAP.md`.

### Reliability
- Image upload now retries and **aborts the group instead of silently publishing an image-less post** (post + comment + URL paths).
- A **rotation-state write failure halts the run** instead of risking duplicate posts on resume.
- Per-account **daily cap is UTC + monotonic** — a clock change can't reset it.
- **Per-account Chromium profile-lock recovery** before each launch (a force-killed browser no longer bricks the next run).
- **Per-account crash backoff** — a crash-looping account is skipped and flagged, not run forever.
- **Connectivity probe** is interruptible with a longer window (no false-offline stalls).
- Store/audit write failures are **surfaced**, not swallowed; a concurrent status check can't wipe a live rate-limit/checkpoint flag.

### Facebook automation
- Composer / post-button / comment-box / rate-limit / checkpoint / pending detection **broadened across 7 locales** + URL/DOM cues, with one tested source of truth and **selector-drift logging**.

### Licensing
- **Per-seat tiered licensing enforced in the backend** (not UI-only); **7-day offline grace**; 3s validation timeout.
- VPS server: per-IP **rate limiting**, `/health`, **Bearer-token admin**, **AES-256-GCM encrypted key store** + audit log.
- `gen-key.js` takes a tier; `revoke.js` has graceful, distinct exit codes.

### Security
- **FB credentials encrypted at rest** (Electron safeStorage / DPAPI); transparent decrypt, legacy plaintext still works.
- **SSRF guard** + size/content-type limits on remote image downloads.
- **Proxy + cookie-import validation**.
- **Tunnel access token no longer written to logs.**

### Quality / build / docs
- `npm test` suite (node:test) — 50+ unit/integration tests across 11 suites.
- Fixed the spintax `variantCount` **nested-alternation overcount bug**.
- **Reproducible portable build** (winCodeSign version auto-detected, no hardcode).
- **GitHub Actions CI** (test + portable build) and a VPS image workflow.
- Settings: warm-up runs + cool-down hours now editable; **"Finish after batch"** control; live attention badges.
- Docs: `ENV.md`, corrected `OPERATIONS.md` licensing section, migration defaults aligned to the app.

### Still open (need owner input or are manual)
- Confirm the live **HTTPS** endpoint for `DEFAULT_SERVER` and the plaintext owner key.
- **Code-sign** the desktop build (`CSC_LINK`/`CSC_KEY_PASSWORD`) — needs a certificate.
- **At-scale live verification** (M4-10) — a real multi-account/multi-group run.
