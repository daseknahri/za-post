# Za Post Comment Tool — Project Documentation

A Windows desktop app (Electron + Puppeteer) that automatically posts to Facebook groups
from multiple accounts, with a first "link" comment on each post. Built for unattended,
ban-aware campaigns (e.g. 120 posts across 10 accounts and several groups).

> **New to this project / resuming in a new session?** Read this file, then `HANDOFF.md`
> for the latest status. The deep, non-obvious facts live in the assistant's memory files
> under `…/memory/` (notably `za-post-working-state.md`).

---

## 1. Quick start

```bash
npm install
npx puppeteer browsers install chrome   # one-time: downloads the Chromium the build bundles
npm start                                # run the app in dev
npm run pack:portable                    # build the send-ready portable zip (see §11)
```

- **Dev run:** `npm start` (Electron loads `main.js`). Data lives in `%APPDATA%\za-post-restored`.
- **Profiles:** `npm run start:base` / `--profile=<name>` gives an isolated data dir + instance lock.

---

## 2. Architecture

```
main.js ............. Electron main process: window, IPC handlers, login browsers,
                      run-state, power/suspend, single-instance lock, startup cleanup,
                      desktop notifications, remote server boot.
automation/
  orchestrator.js ... The run engine: cycles, batches, account rotation, post
                      distribution (claim/release), pause/resume/stop, offline holds,
                      flag→status, end-of-run summary, auto-delete, stall breaker.
  worker.js ......... One account's browser session: launch (hidden/visible), auth
                      (cookies → credential auto-login), navigate, open composer,
                      caption (paste/type), image upload, publish, pending-approval
                      detection, block detection, first-comment, per-account watchdog.
lib/
  store.js .......... JSON data store (data.json), durable atomic writes + .bak recovery,
                      write-serialization mutex, rotation state (pcu-state.json), cookies,
                      images, run-report (audit). DEFAULT_SETTINGS lives here.
  chromium.js ....... Resolves the Chromium exe (bundled resources/chrome when packaged,
                      else Puppeteer's cache).
server.js ........... Local Express API + remote dashboard (port 3000), token-gated.
renderer/ ........... Desktop UI (index.html + renderer.js): accounts, groups, posts,
                      settings, start/pause/stop, live log, run summary.
preload.js .......... contextBridge: exposes electronAPI.* IPC channels to the renderer.
scripts/ ............ Build + diagnostic scripts (NOT shipped). See §12.
```

**Process model:** orchestrator + worker run **inside the Electron main process** (Node
context), not a worker thread. Workers drive Chromium via Puppeteer/CDP.

---

## 3. The run lifecycle (start → end)

1. **Start** — `orchestrator.start(getData)` (IPC `start-automation`, or remote, or auto-resume).
   Guarded against double-start; sets the durable run-active flag.
2. **Cycle loop** (`_loop`) — each cycle re-reads `data.json` fresh (so mid-run edits apply),
   filters **enabled** accounts, and distributes posts:
   - **post-centric / random:** each account posts all its eligible posts each cycle.
   - **unique / sequence:** each post is dealt **once** across accounts (round-robin), tracked
     in `_dealt` (persisted to `pcu-state.json`). Posts are **claimed** at run time and
     **released** on failure so a healthy account picks up a blocked account's post.
3. **Batches** — accounts run in batches of `parallelAccounts` (Promise.all, crash-isolated
   per account). Between batches: `accountDelay`. Pause/offline hold here.
4. **Per-account** (`worker.runAccount`) — launch browser → auth → for each assigned group:
   navigate → block checks → open composer → caption → optional image → **Post** → confirm →
   pending-approval check → `posted++` → **first comment**. A re-checkable **watchdog** caps
   the account's total time and probes liveness before aborting (survives laptop sleep).
5. **Comment** (`addFirstComment`) — reload the group, find OUR post (by caption), comment in
   its box; retry up to 3×. **Permalink fallback:** if the feed scan can't find the box
   (short/image-only captions), open the post's own page (captured at publish) and comment there.
6. **Blocks** — rate-limit / identity-verification / disabled detected → **skip the account
   immediately**, flag it (UI status + end-of-run "needs attention"), and fire a **desktop
   notification**. Released posts are reassigned to healthy accounts.
7. **End of cycle** — auto-delete fully-published posts (opt-in), persist rotation, then either
   stop (campaign complete / all accounts need attention / **3 zero-progress cycles**) or wait
   `waitInterval` and loop.
8. **Stop** — manual Stop, `maxCycles`, dead-fleet, or stall-breaker. Clears run-active.

---

## 4. Posting modes & settings (`lib/store.js` DEFAULT_SETTINGS)

| Setting | Meaning |
|---|---|
| `parallelAccounts` | accounts run concurrently per batch (1–20) |
| `waitInterval` | minutes between full cycles |
| `accountDelay` | minutes between batches (UI calls it between-accounts) |
| `groupDelay` | seconds between groups within one account |
| `postsPerGroup` | posts per account per cycle (non-unique modes; 0 = all) |
| `maxCycles` | 0 = run continuously; N = stop after N cycles |
| `commentWithImage` | reuse the post image as the comment image |
| `autoDeletePosted` | delete a post after it **fully** publishes to all its groups |
| `hideBrowser` | **true** = off-screen + silent; **false** = visible-in-background |
| `loopCampaign` | unique modes: recycle the library and rotate content forever |
| `resumeOnStartup` | auto-resume an interrupted run on next launch (only if work remains) |
| `launchOnStartup` | register as a Windows login item |
| `enableTunnel` | start a Cloudflare tunnel for the remote dashboard |

**Per-account:** `enabled` (On/Off toggle — disabled accounts sit out, even mid-run),
`assignedGroups`, `postFilter`, `postingOrder`, `email`/`password` (for auto-login), `alias`.

---

## 5. Hidden vs. visible browser (hard-won, see memory)

- **Hidden (default):** Facebook will **not** publish from true-headless or an `SW_HIDE`'d
  window. It DOES publish from a **headful window parked off-screen** (`--window-position=
  -32000,-32000`) **plus focus/visibility emulation** (`Emulation.setFocusEmulationEnabled`
  + overriding `document.hidden`/`visibilityState`/`hasFocus`). The off-screen move is forced
  via CDP `Browser.setWindowBounds` after launch (a profile/Windows reposition can't reveal it),
  and `store.sanitizeProfile(name, hidden)` pins the saved window placement. A taskbar icon
  remains (unavoidable — the window must keep compositing).
- **Visible:** on-screen for the better flow, but pushed **behind** other windows via
  `SetWindowPos(HWND_BOTTOM, NOACTIVATE)` so it never steals focus. Login windows are always
  visible (`sanitizeProfile(..., false)` clears off-screen bounds).
- **Gotcha:** an account that fails to publish in BOTH hidden and visible is rate-limited/
  blocked on Facebook's side — NOT a hidden-mode bug. Test hidden with a known-healthy account.

---

## 6. Accounts, login & blocks

- **Login:** Accounts → Login opens a visible Chromium; the typed email/password are captured
  and saved so the worker can **auto-login** (`credentialLogin`) when cookies expire mid-run.
- **Captcha / 2FA / identity check:** auto-login returns `'checkpoint'` → the account is flagged
  `needs_verification` (distinct from a plain login failure) and a **desktop notification** fires.
- **Block flags:** `rate_limited` (auto-retries), `needs_login`, `needs_verification`,
  `account_disabled`, `likely_blocked`. Each maps to an account status + lastMessage and is
  listed in the end-of-run "accounts needing attention".

---

## 7. Data & file layout (`%APPDATA%\za-post-restored`)

```
data.json ............ posts, groups, accounts, settings, proxies (atomic + .bak recovery)
pcu-state.json ....... rotation: dealt post-ids + roundOffset (atomic + .bak recovery)
run-state.json ....... { active, ts } — crash/resume flag (synchronous fsync)
accounts/<name>/
  chrome-profile/ .... per-account Chromium user-data dir
  cookies.json ....... saved cookies
  last-run-success.txt
storage/images/ ...... decoded post & comment images
logs/
  automation.log ..... rotated session log
  run-report.jsonl ... per-(account,group,post) audit trail
  run-report.csv ..... same, spreadsheet-friendly (rotated at 5 MB)
uploads/ ............. remote-uploaded images
```

---

## 8. Robustness (what's hardened)

Two audit passes (Sonnet multi-agent, adversarially verified) hardened the full lifecycle:

- **Single-instance:** a 2nd instance that loses the lock does nothing (no `killOrphanChromium`
  killing the 1st instance's run).
- **Data integrity:** atomic writes + `.bak` recovery for `data.json` AND `pcu-state.json`;
  write-serialization mutex; rotation-save failures are surfaced (else a crash could re-post).
- **No data loss:** auto-delete only removes a post that **fully** published (a partial publish
  stays in the library); partial posts are never re-posted (no duplicates).
- **No infinite loops:** stall breaker stops after 3 zero-progress cycles (all-rate-limited /
  blocked / group-less / disabled fleets); group-less accounts are never dealt a post.
- **Resilience:** liveness-probing watchdog (survives sleep), single-shot bounded browser close,
  suspend/resume respects user pause, every CDP/eval/nav call is timeout-capped, offline
  hold-and-resume, crash-resume only when work remains, clean quit clears the run flag.
- **Comment:** CDP caps (no 90s hangs), 3× retry that bails on abort/disconnect, never
  double-posts, never comments on the wrong post, permalink fallback for short captions.

**Known limitations:** captions type slowly in hidden mode (clipboard paste needs real focus);
a taskbar icon is unavoidable in hidden mode; a pending post later rejected by an admin isn't
re-queued; Facebook DOM changes can break selectors (see `scripts/` diagnostics).

---

## 9. Build & packaging — see also §11

`npm run pack:portable` → `dist\Za-Post-Comment-Tool-1.0.0-portable.zip` (~315 MB): a
`Za Post Comment Tool\` folder (the app + bundled Chromium) + `READ-ME-FIRST.txt`. The
recipient extracts and runs `Za Post Comment Tool.exe`; data still lives in `%APPDATA%`.

---

## 10. Resuming work

- **Status:** `HANDOFF.md` (top section) is the live status.
- **Latest git:** check `git log --oneline -5`. All work is on `daseknahri/za-post` `main`.
- **To put new code into the user's installed app:** edit source → `npm run pack:portable` →
  user re-extracts the zip (editing source only updates the dev app).
- **Possible next steps (not blocking):** comment via permalink as the *primary* path (currently
  a fallback); re-queue admin-rejected pending posts; a second-virtual-desktop trick to drop the
  hidden-mode taskbar icon; per-(post,group) dealt tracking for exact partial-coverage retries.

---

## 11. Packaging internals (important gotcha)

`npm run pack` (NSIS) **fails on a normal account**: electron-builder's winCodeSign cache
contains macOS symlinks whose extraction needs admin / Windows Developer Mode. So we ship via
`scripts/build-portable.js` (`npm run pack:portable`):

1. `bundle-chromium.js` copies Puppeteer's Chromium → `chrome-bin` (→ `resources/chrome`).
2. `ensureWinCodeSign()` pre-seeds the winCodeSign cache **without** the `darwin` folder
   (which a Windows build never uses), so the build works without admin.
3. `electron-builder --win dir` (no signing) → `dist/win-unpacked`.
4. 7-Zip packs a `Za Post Comment Tool/` folder + `READ-ME-FIRST.txt` into the portable zip.

`asarUnpack` must include `puppeteer`, `puppeteer-core`, `puppeteer-extra*`, `proxy-chain`,
`cloudflared`, `bytenode`, `node-machine-id`. Runtime Chromium resolves to
`process.resourcesPath/chrome/chrome.exe` when `app.isPackaged`.

---

## 12. Dev & diagnostic scripts (`scripts/`, not shipped)

| Script | Purpose |
|---|---|
| `build-portable.js` | the portable build (`npm run pack:portable`) |
| `bundle-chromium.js` | copy Puppeteer Chromium → `chrome-bin` |
| `test-hidden-full.js` | verify the full hidden path (off-screen + focus/visibility) |
| `test-hide.js` | verify the CDP off-screen move isn't clamped by Windows |
| `test-bg-window.js` | verify visible-mode "send window to background" |
| `test-notif.js` | verify Windows toast notifications work |
| `test-comment.js`, `diag-comment.js`, `inspect-fb.js`, … | FB DOM diagnostics |
| `migrate.js`, `prep-accounts.js`, `sync-memberships.js` | data/account utilities |
