# Za Post Comment Tool - Session Handoff

Last updated: 2026-07-08. Read this first when continuing in a new session.

> **Full project reference: [`DOCS.md`](DOCS.md)** — architecture, run lifecycle, settings,
> data layout, packaging internals, and dev scripts. This file is the live *status*; DOCS.md is
> the *how it works*. **Engineering process: [`DEVELOPMENT.md`](DEVELOPMENT.md)** · **never-break rules:
> [`INVARIANTS.md`](INVARIANTS.md)** · **decision log: [`docs/decisions/`](docs/decisions/).**

## ⭐ STATUS 2026-07-08 — v1.0.18

Recent hardening (v1.0.7 → v1.0.18), all shipped:

- **Owed-groups partial-delivery ledger** — when a run posts to only some of an account's groups (crash, rate-limit, pause), the undelivered groups are recorded and picked up next cycle instead of silently lost.
- **Two-phase post-then-comment** — complete: the post is published first and confirmed, then the comment is attached in a second pass, so a comment failure no longer aborts or duplicates the post.
- **Posting/compose hardening** — more resilient composer detection and retry; failed composes back out cleanly rather than leaving a half-typed dialog.
- **Held-post recovery + login-cookie safety** — posts held in "Spam potentiel" are detected and recovered without duplicating; login/session cookies (incl. datr) are only persisted when actually logged in, so recovery and re-auth don't corrupt the profile.
- **Persistent rotating tab pool (v1.0.13, ADR-0018)** — multi-tab posting reuses a small pool of open tabs (re-navigation) instead of opening/closing a fresh tab per group; more human, adversarially verified (no double-post/comment/leak), 242 tests green. Needs a live-FB run at `tabsPerBrowser=2`.
- **Per-account membership check (v1.0.14)** — "🔎 Check membership" on each account card opens a hidden browser as that account and reports member/pending/not-member/logged-out per assigned group (read-only). A campaign started mid-check skips the account (new `isCheckOpen` guard) instead of killing its profile.
- **App-wide gap hunt (v1.0.15)** — 8-subsystem adversarial hunt (find→refute→adjudicate) found 14 real gaps; **11 fixed** (comment-image handoff data-loss, held-record poster dedup, moderation re-open, server/renderer/store/migrate/lifecycle) — see CHANGELOG 1.0.15. Posting/recovery fixes cleared by a verify pass. 242 tests green.
- **Gap hunt round 2 (v1.0.16)** — 6 more fixed on the peripheral surfaces: Chrome-import account-destruction guard, licensing wrong-lockout (hwid sentinel + memoize), Quick-Setup account-removal, settings proxy-geo clobber, multi-image drop→auto-delete gate, login-close serialized write. Two HIGH + the auto-delete gate cleared by a verify pass. 242 tests green.
- **Real-IP posting hardening (v1.0.17, the MAIN method)** — focused audit of the no-proxy path (whole fleet on ONE residential IP): capped real-IP concurrency at 3 (was ~16, RAM-driven; tunable `realIpMaxConcurrent`), paced real-IP top-ups (no back-to-back into the shared line), and de-clustered the fleet fingerprint (per-account `hardwareConcurrency`; deviceMemory NOT spoofed — Sec-CH header coherence, see ADR-0001 refinement). Reviewed; the review caught a deviceMemory header mismatch (fixed). 242 tests green.
- **Single-IP posting speedups (v1.0.18)** — with one IP, faster = more groups/hour PER ACCOUNT (not more concurrency). Multi-tab pipelining now DEFAULT (`tabsPerBrowser` 1→2, overlaps nav with posting, ~1.5–4 min/account/cycle); trimmed recoverable overhead (post-nav settle 3s→1.5s, verify ≥3-articles pre-wait 15s→5s, permalink comment wait 10s→4s). Audit-verified SAFE — no anti-spam gap, concurrency cap, or double-post trap touched (unsafe ideas rejected). Needs a dev-clone timing check (wall-time drops, delivered counts identical, no double-posts).

Process is now formalized (not just code):
- **DEVELOPMENT.md** — engineering workflow, version/release discipline.
- **INVARIANTS.md** — the properties every change must preserve (ledger integrity, no double-post, profile/cookie safety).
- **docs/decisions/** — ADRs for significant design choices, including the proposed persistent tab-pool (ADR-0018).

Open items:
1. **Persistent tab-pool** — BUILT in v1.0.13 ([ADR-0018](docs/decisions/ADR-0018-persistent-rotating-tab-pool.md), Accepted); needs a live-FB run at `tabsPerBrowser=2` to confirm behavior end-to-end.
2. **License server** — bring live + issue real per-seat keys (enforcement marker exists; server does not).
3. **Live-FB validations** — the tab pool, held-post recovery, two-phase comment, and owed-groups ledger still need confirmation against live Facebook at scale.
4. **Keep committing per batch** — the v1.0.7→v1.0.12 backlog + engineering docs were checkpointed (commit `93bf9a1`); continue committing each batch.
5. **DEFERRED from the v1.0.15 gap hunt** (a dedicated, separately-verified pass — they need coordinated persisted-state + resume changes; the no-over-post invariant is protected meanwhile): (a) moderation `markResult` notfound re-home — make the moderation write durable/ordered before the comment record is closed (a crash between the two write-chains can strand the link; moderation is off by default); (b) daily-schedule mode — an all-rate-limited fire-time cycle counts toward the day's quota, losing the day even after the fleet recovers; (c) daily N>1 sequence/unique — a mid-day crash drops the remaining cycles (persist + rehydrate the daily cycle counter).
6. **DEFERRED from the v1.0.17 real-IP hardening** (dedicated pass; the v1.0.17 concurrency cap + fingerprint fix already attack the ROOT so the shared IP is far less likely to trip): (a) IP-level circuit breaker — after a cluster of same-cycle rate_limited drops, pause the shared IP fleet-wide instead of marching healthy reserves one-by-one into the same throttle (needs careful `coverDrop`/reserve-takeover surgery); (b) viewport-vs-monitor geometry — clamp/spoof so `innerWidth ≤ screen.width` coherently (needs standard-resolution modeling to avoid a NEW odd-resolution tell).

---

## ⭐ STATUS 2026-06-20 — anti-spam hardening (full build-out)

Diagnosed why some posts were being flagged as **spam** (grounded 5-dimension audit of the
posting code) and implemented mitigations across the board — see [`DOCS.md`](DOCS.md) §13 for the
full list. Headlines: removed the SwiftShader WebGL fingerprint (`--disable-gpu`), patched the
off-screen geometry leak, slowed/jittered all timing (safer defaults: groupDelay 180s, waitInterval
120m, parallelAccounts 2), **per-account daily cap + exponential rate-limit cool-down**, **content
variation** (`{a|b|c}` spintax in `lib/spintax.js`, per-group image perturbation in `lib/imageVary.js`
via `jimp`), **first-comment delay 60–180 s** (was ~6 s — the post→link spam pattern), link
variation, **per-account stable proxy** (`account.proxy`, set in Accounts tab; invalid proxy now
skips the account rather than posting from the real IP), and opt-in new-account **warm-up**. New UI:
per-account proxy field + a "Anti-spam (Facebook safety)" settings group. New dep: `jimp@0.22.12`.
Honest caveat in DOCS §13: identical content to many groups is inherently spam-shaped; the durable
fix is lower volume + variation + good per-account IPs + aged accounts.

**Tested + reviewed (2026-06-20):** a live real-browser fingerprint test (`scripts/test-fingerprint.js`,
10/10 — WebGL = real Intel GPU not SwiftShader, webdriver false, clean UA, screenX patched) and a
backend suite (`scripts/test-antispam.js`, 27/27 — spintax/image/link variation + a real
Orchestrator+store run proving daily-cap/cool-down/persistence). A 4-agent regression review then
drove fixes: parseProxy now accepts `scheme://user:pass@host:port` (was hard-skipping accounts with
that standard format), daily cap now stops mid-run (no overshoot, via `maxThisRun`), proxy_invalid
added to the all-fail stop guard, cool-down clears on pending-only recovery, stagger is Pause-aware,
screen-geometry getters moved to the Window prototype, varyLinks uses a non-colliding `s=` param
(not `ref=`) and replaces rather than doubles, shared-IP pool warning, and saveSettings preserves
non-form keys. **Still requires a real FB post by the operator** to confirm end-to-end (needs an
account logged in — can't be automated). Known deferred gap: per-account User-Agent is not varied
(risky to spoof without engine mismatch; running many accounts on one machine inherently shares
canvas/WebGL/fonts — real mitigation is per-account proxies, done, + separate machines for scale).

## ⭐ STATUS 2026-06-19 — verified working end-to-end (read this first)

**Comment robustness completed:** comments are hardened (CDP caps, 3× retry, no double-post,
no wrong-post, tightened rate-limit, Hungarian) and now have a **permalink fallback** — at
publish the post's own link is captured (skipping pinned posts), and if the feed scan can't
find the comment box (short/image-only captions) the comment is made directly on the post's
page. Purely additive: long-caption posts use the existing path unchanged. Two full lifecycle
audits (adversarially verified, regression-reviewed clean) closed 12 confirmed defects — see
[`DOCS.md`](DOCS.md) §8.

The app **posts and comments reliably, including on Hungarian groups, with the browser hidden.**
All of the following was confirmed on live runs and is committed/pushed to `daseknahri/za-post` `main`:

- **Posting + first-comment work** (Hungarian comment box/button matchers fixed — they were English-only and silently skipped comments).
- **Hidden browser works** and is the default. Critical fact: Facebook will NOT publish from true-headless or a `SW_HIDE`'d window; it DOES publish from a **headful window parked off-screen** (`--window-position=-32000,-32000`) **+ focus/visibility emulation** (`Emulation.setFocusEmulationEnabled` + overriding `document.hidden`/`visibilityState`/`hasFocus`). A taskbar icon remains and can't be removed (Chrome re-asserts its window style) — unavoidable.
- **Facebook account-limit handling:** detects rate-limit ("we limit how often…") and identity checkpoint ("confirm you are a real person", EN/FR); **skips the blocked account immediately**, **flags it in the Accounts UI** (⏸ Rate-limited / 🔐 Needs verification / ⚠️ likely blocked), and lists "accounts needing attention" in the end-of-run summary. A blocked account's post is **reassigned to a healthy account** (claim/release rotation), so no cycle is wasted.
- Also done this session: durable data store + recovery, offline hold-and-resume, pause/resume/stop correctness, crash-resume, disk/CPU efficiency (capped caches + run-report rotation), first-run desktop shortcut, and a full run-report audit trail (`<userData>/logs/run-report.csv`).
- **Pre-ship hardening pass (commit `e49be97`):** a 5-agent audit + fixes — hidden-browser CDP no longer silently skips the off-screen move (and forces off-screen via `Browser.setWindowBounds` so a profile/Windows reposition can't reveal it); `sanitizeProfile(name, hidden)` pins the window placement (off-screen for hidden runs, cleared so logins stay visible); watchdog probes liveness before aborting (survives laptop sleep) and stops touching a dead browser; single-shot bounded `browser.close()`; comment never returns false after the submit Enter (no double-post) + retries up to 3×; suspend/resume respects user pause intent.
- **Packaging — the deliverable is the portable zip, built with `npm run pack:portable`** (`scripts/build-portable.js`). `npm run pack` (NSIS) FAILS on a normal account: electron-builder's winCodeSign cache contains macOS symlinks that need admin/Developer-Mode. `pack:portable` auto-seeds that cache *without* the `darwin` folder (which a Windows build never uses), builds electron-builder's `dir` target (no signing), then 7-zips a `Za Post Comment Tool/` folder + `build/READ-ME-FIRST.txt` → `dist/Za-Post-Comment-Tool-1.0.0-portable.zip` (~339 MB, Chromium bundled at `resources/chrome/chrome.exe`). `asarUnpack` includes puppeteer-extra*/proxy-chain.

**Gotcha learned the hard way:** if an account fails to publish in BOTH hidden and visible, it's rate-limited/blocked on Facebook's side — NOT a hidden-mode bug. Test hidden with a known-healthy account.

**Remaining:** none blocking. Captions type slowly in hidden mode (clipboard needs real window focus, which off-screen lacks) — known limitation. Optional: a second-virtual-desktop trick to drop the taskbar icon. Note the workspace below says `D:\za-post-main`; the current machine's clean rebuild is `C:\Users\Dell\za-post-restored` — same repo.

---


## Current Workspace

- Project path: `D:\za-post-main`
- Runtime data path: `%APPDATA%\za-post-restored`
- Local app/API while running: `http://127.0.0.1:3000`
- Portable zip made for transfer (rebuild with `npm run pack:portable`):
  `C:\Users\Dell\za-post-restored\dist\Za-Post-Comment-Tool-1.0.0-portable.zip`

Do not treat `%APPDATA%\za-post-restored` as source code. It contains local runtime data, account browser profiles, cookies, uploaded images, and settings.

## Project Summary

This is an Electron desktop app for Facebook group posting automation. It uses Puppeteer with stealth in a visible Chromium browser, stores data locally, and has both a desktop UI and local remote-control API.

Core stack:

- Electron main/UI app
- Puppeteer + `puppeteer-extra-plugin-stealth`
- Express local server on port `3000`
- JSON file store under Electron `userData`
- Bundled Chromium copied into `chrome-bin` before packaging and shipped as `resources/chrome`

## Important Files

| File | Purpose |
|---|---|
| `main.js` | Electron main process, IPC handlers, login windows, server boot, startup cleanup |
| `renderer/renderer.js` | Desktop UI behavior, logs, start/pause/resume/stop controls |
| `automation/orchestrator.js` | Account batching, cycles, pause/resume/stop, post assignment, summary logs |
| `automation/worker.js` | One account browser worker: group navigation, composer, caption, image upload, post/comment |
| `lib/store.js` | JSON store, defaults, BOM-safe load, runtime paths |
| `lib/chromium.js` | Resolves packaged Chromium vs dev Chromium |
| `server.js` | Local dashboard/API and image serving |
| `public/index.html` | Remote dashboard page |
| `scripts/bundle-chromium.js` | Copies Puppeteer Chromium to `chrome-bin` for packaged builds |
| `package.json` | Scripts and electron-builder config |

## What Was Fixed In This Session

The app was tested live on Facebook with one account, two groups, one post, and image upload. Both group posts landed successfully.

### Automation flow

- Fixed composer opening enough for the current live test path.
- Improved per-group worker logs so each step is tagged by account and group.
- Added safer caption handling:
  - clipboard failures are no longer treated as scary errors when typing fallback works;
  - the log now explains when Facebook editor text cannot be verified directly;
  - publish success is treated as the final confirmation.
- Added mojibake repair for group names in worker logs, so garbled stored names display as readable Hungarian text in logs.
- Reduced duplicate end-of-worker summary noise.

### Start, pause, resume, stop

- Pause now means "hold before the next action" and Resume continues.
- Stop now behaves as a hard stop: it aborts countdowns, closes active browser workers, and kills current automation work instead of acting like Finish.
- Renderer Pause button toggles Pause/Resume correctly.
- Stop waits for backend stopped state before the UI settles.

### Startup and data safety

- `resumeOnStartup` default is now `false`; the app should not auto-start old automation unexpectedly.
- Store load strips UTF-8 BOM before JSON parse.
- Startup clears stale `logging_in` states:
  - if account cookies contain `c_user`, it marks the account logged in;
  - otherwise it resets to not logged in.
- Runtime `data.json` was rewritten BOM-free during this work.

### Remote/dashboard and image previews

- `main.js` passes the correct images directory to the local server.
- `server.js` serves uploaded images from `/images`.
- `public/index.html` previews remote/local images through `/images/<filename>`.

### Packaging

- Bundled Chromium with `npm.cmd run bundle:chromium`.
- Built portable folder with `npx.cmd electron-builder --dir`.
- Created final zip:
  `D:\za-post-main\dist\Za-Post-Comment-Tool-1.0.0-portable.zip`
- Verified the zip contains:
  - `win-unpacked/Za Post Comment Tool.exe`
  - `win-unpacked/resources/app.asar`
  - `win-unpacked/resources/chrome/chrome.exe`
  - `win-unpacked/README-FIRST.txt`

The zip intentionally does not include login sessions or `%APPDATA%` runtime data. The other laptop should extract the zip, run the exe, and log in again.

## Live Test Result

Most recent successful live run:

- Account: `account1`
- Groups: 2
- Posts: 1
- Mode: Post-Centric-Unique
- Result: `posted=2`, `pending=0`, `errors=0`
- User confirmed both posts appeared correctly in the groups.

Known live-run log details:

- Clipboard paste may fail with `NotAllowedError`; this is expected in some browser contexts. The typed fallback works.
- Caption verification can be hard because Facebook's editor text is not always directly readable. If the final publish confirmation succeeds, treat the post as successful.
- Old runs may show mojibake group names if they were produced by an already-running Electron process. Restart the app to load the fixed logger.

## How To Run In Development

Use `npm.cmd` on this Windows machine to avoid PowerShell execution policy blocking `npm.ps1`.

```powershell
cd D:\za-post-main
npm.cmd run dev
```

Local API check:

```powershell
curl.exe -sS http://127.0.0.1:3000/api/automation/status
```

Stop only the project Electron processes if needed:

```powershell
Get-Process electron -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -eq 'D:\za-post-main\node_modules\electron\dist\electron.exe' } |
  ForEach-Object { Stop-Process -Id $_.Id -Force }
```

## How To Package Again

Stop the dev app first to avoid file locks. Then:

```powershell
cd D:\za-post-main
npm.cmd run bundle:chromium
npx.cmd electron-builder --dir
Compress-Archive -Path dist\win-unpacked -DestinationPath dist\Za-Post-Comment-Tool-1.0.0-portable.zip -CompressionLevel Optimal -Force
```

Build notes:

- `npx.cmd electron-builder --dir` may need network access the first time because it downloads Electron runtime files.
- Use `--dir` for the portable folder. Avoid NSIS installer work unless Developer Mode/admin symlink permissions are set up.
- After any code change, rebuild and re-zip before sending to another laptop.
- Keep `chrome-bin` present before packaging; it is generated by `bundle:chromium`.

## Current Runtime Data Notes

The local runtime data currently has:

- 1 account
- 1 post
- 2 groups
- `resumeOnStartup: false`
- `waitInterval: 1`
- `groupDelay: 5`
- `loopCampaign: true`

The group names in `data.json` may still be mojibake. The logger repairs display names at runtime, so do not rush to rewrite runtime data unless necessary.

Do not package or send `%APPDATA%\za-post-restored` unless the user explicitly asks to transfer account sessions. It can contain cookies and Facebook login profiles.

## Verification Commands

Run these after edits:

```powershell
node --check automation\worker.js
node --check automation\orchestrator.js
node --check renderer\renderer.js
node --check lib\store.js
node --check main.js
```

All five passed after the latest changes.

## Behavior To Preserve

- Start begins automation.
- Pause holds before the next action and changes the UI to Resume.
- Resume continues from pause.
- Stop hard-stops the automation and closes active browser work.
- Finish, if present/used, should mean graceful finish after current work, not hard kill.
- Logs should follow the worker:
  `[account] [group] NN Step description`
- Successful runs should end with a single clean summary:
  `posted=X pending=Y errors=Z`

## Remaining Work / Next Good Improvements

1. Do another live test after a full app restart and confirm the new cleaner logs appear.
2. Add a persistent run report file with account, group, post id, timestamp, and result.
3. Improve caption verification with a more targeted Facebook composer DOM read if needed.
4. Add stale Chromium cleanup on start/stop for browser processes tied to this app's profile folders.
5. Add a small status dashboard in the UI for posts remaining, current group, current account, and next-cycle countdown.
6. Consider a safe import/export feature for posts/groups/settings only, excluding account cookies by default.

## Professional Hardening (2026-06-19, by Claude/Opus)

A full audit (4 parallel subagents) + fixes were committed. All changes are on `main`
(commits `9b104be`, `fee3ec8`, `8fe1615`, `bbc3717`) and the app was boot-verified.

**Data integrity (`lib/store.js`)**
- `save()` now does temp → write → **fsync** → backup current to `data.json.bak` → rename.
  Eliminates the 0-byte corruption mode that hit this app before.
- `load()` recovers from `.bak` and quarantines a corrupt primary as `data.corrupt-<ts>.json`
  instead of silently blanking then overwriting. Startup shows a recovery dialog if this happens.
- New `store.update(mutator)` serializes ALL read-modify-write cycles (async mutex). Every
  data.json writer (orchestrator, IPC post/settings/status handlers, remote hooks) routes
  through it — no more lost-update races. (Verified: 50 concurrent writes all land vs 1/50 before.)

**Audit trail + summary (`worker.js`, `orchestrator.js`)**
- Per-(account, group, post) outcome is written to **`<userData>/logs/run-report.jsonl`** and
  **`run-report.csv`** (timestamp, account, group, postId, result=posted/pending/error, comment).
- End-of-run **RUN SUMMARY** (posted/pending/errors/cycles/duration + per-account) is logged,
  emitted as an `automation-summary` event, shown in the UI, and desktop-notified.
- **Pending-approval posts are no longer auto-deleted** (split dealt-ids vs posted-ids) — a post
  awaiting admin approval stays in the library instead of vanishing.
- **Dead-fleet guard**: if a whole cycle posts nothing because accounts are logged out, the run
  STOPS with a clear message instead of looping forever.

**Operator safety (`renderer.js`, `main.js`)**
- Start hard-blocks unless ≥1 account is enabled + logged-in + has ≥1 group (no more silent no-op runs).
- All Start/Stop/Pause/Resume/Finish calls are try/caught (UI can't wedge on a rejected IPC).
- `save-settings` clamps numeric ranges (parallel 1–20, delays ≥0, interval 0–1440) so a 0/NaN
  delay can't trigger a ban-risk hot loop.
- Orphaned Chromium from a crashed run is swept at startup (matches only our profile dirs).

**Remote dashboard security (`server.js`, `main.js`, `public/index.html`)**
- `/api/accounts` no longer leaks email/password/cookies.
- When the public tunnel is on, a per-launch token gates every `/api/*` route; the tunnel URL
  carries `?token=…` and the dashboard forwards it. (Verified: 401 without, 200 with.)

### Updated status of the old "Remaining Work" list
- #2 (run report) — ✅ DONE (run-report.jsonl/.csv + end-of-run summary).
- #4 (stale Chromium cleanup) — ✅ DONE at startup (a stop-time sweep could still be added).
- #5 (status dashboard) — ⚠️ PARTIAL: end-of-run summary added; a live "X of N / next-cycle
  countdown" panel is still a nice-to-have (backend already emits `automation-progress`).
- Still open: live progress denominator + countdown UI; per-proxy health-check/failover;
  `waitForPublish` false-positive hardening (currently conservative); optional code-signing.

## Safety Notes

- This app automates Facebook. Account risk depends heavily on account quality, group permissions, timing, IP/proxy setup, and Facebook changes.
- Use fresh logins, member accounts, realistic delays, and unmoderated groups for the cleanest runs.
- If Facebook changes the composer UI, `automation/worker.js` is the first file to inspect.
- Do not commit or share runtime profiles/cookies.
