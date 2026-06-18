# Za Post Comment Tool — Session Handoff

> Last updated: 2026-06-18. Read this first when resuming in a new session.

## What this project is
An **Electron desktop app** that automates posting to Facebook groups using
**Puppeteer + stealth** (headful Chromium). One-time campaign goal: post **120 posts**
across **10 accounts** to **4 groups**, each post published **exactly once** then
**auto-deleted**, run **stops automatically** when the post library is empty.

- **Source of truth (clean rebuild):** `C:\Users\Dell\za-post-restored`
- The `C:\Users\Dell\AppData\Roaming\za-post` folder is **runtime/userData only** — NOT source.
- Private GitHub repo: `daseknahri/za-post` (only commit `1820018` is pushed; see "Pending").

## Architecture (key files)
| File | Role |
|---|---|
| `main.js` | Electron main process; IPC handlers; injects `uploadDir`/`chromiumPath` hooks; account defaults |
| `renderer/renderer.js` | UI logic (tabs, settings save/load, log pane, start/stop) — 1689 lines |
| `automation/orchestrator.js` | Batching, cycles, delays, rotation, **per-cycle auto-delete** of posted IDs |
| `automation/worker.js` | Drives one account's browser: navigate group, compose, type caption, attach image, post, comment |
| `lib/chromium.js` | `chromiumPath()` → bundled `resources/chrome/chrome.exe` when packaged, else Puppeteer path |
| `lib/store.js` | JSON data store; atomic `saveRotation` (tmp+rename); `sanitizeProfile()` (tab-restore fix) |
| `server.js` | Local express server; `UPLOAD_DIR` from injected `hooks.uploadDir` (writable userData/uploads) |
| `scripts/bundle-chromium.js` | Copies Puppeteer Chromium → `chrome-bin/` before packaging |
| `package.json` | `build` config: `extraResources` maps `chrome-bin` → `resources/chrome` |

## Key behaviors / decisions
- **post-centric-unique** posting order: each account in a cycle posts a DIFFERENT post
  (stable per-account offset = account index in `data.accounts`). This is the default for
  new accounts (set in `main.js`).
- **Per-cycle auto-delete (backend):** orchestrator collects `postedIds` from workers and
  deletes them from the store at the end of each cycle, emits `data-updated`. Renderer just
  calls `loadData()` on stop. (Old fragile client-side log-parsing was removed.)
- **NaN guard (`intOr`)** in `saveSettings()`: blank/invalid numeric inputs fall back to
  defaults instead of passing `NaN` (a NaN `groupDelay` once disabled inter-group delays → ban risk).
- **Bundled Chromium:** all 3 launch sites (worker, checkStatus, openLoginBrowser) use `chromiumPath()`.
- **Writable uploads:** `UPLOAD_DIR = userData/uploads` (not the read-only asar path).
- **Tab-restore fix:** `sanitizeProfile()` clears `Default/{Current,Last} {Session,Tabs}` and sets
  `Preferences` exit flags before every launch (stops "restore tabs" popups).

## Current status — WORKING
- All source files syntax-check clean (`node --check`).
- Start flow verified via a stubbed dry-run of the **real** orchestrator: PASS on both
  (1) 10 distinct posts → 10 accounts, auto-delete fires, run ends cleanly; (2) Stop halts cleanly.
- **Portable build rebuilt & verified:**
  - `dist/win-unpacked/` (785 MB, Chrome bundled at `resources/chrome/chrome.exe`)
  - `dist/Za-Post-Comment-Tool-1.0.0-portable.zip` (**323 MB, 1701 files**, exe + Chrome present)

## How to rebuild the portable app
```powershell
cd C:\Users\Dell\za-post-restored
npm run bundle:chromium          # copies Puppeteer Chrome -> chrome-bin\ (~412 MB)
npx electron-builder --dir       # builds dist\win-unpacked\ (winCodeSign symlink error is NON-FATAL)
# then zip it:
cd dist
Compress-Archive -Path win-unpacked -DestinationPath Za-Post-Comment-Tool-1.0.0-portable.zip -CompressionLevel Optimal
```
**Notes / gotchas:**
- Use `--dir` NOT the NSIS installer — NSIS needs symlink privilege (Developer Mode/admin) this machine lacks.
- The `winCodeSign ... Cannot create symbolic link` error during build is **expected and non-fatal** for `--dir`.
- `chrome-bin/` is git-ignored and gets deleted when freeing disk — **always run `bundle:chromium` first**.
- Keep **>1 GB free** before building; the disk has hit 0 GB before and truncated `renderer.js` to 0 bytes
  (recovered via `git restore`). Watch free space.

## How to run / test (smoke test = 1 account / 1 group / 1 post)
Run dev: `npm start`  •  Or run the portable: extract zip → `Za Post Comment Tool.exe`
(SmartScreen → More info → Run anyway). Then: Accounts→Add→Login (full FB login, close window)
→ Groups→Add (a group the account is a member of, non-moderated) → assign group to account
→ Posts→Add (caption) → Settings: maxCycles=1, autoDeletePosted=OFF, parallel=1, groupDelay=30s
→ Start → watch log for `posted=1` → verify on Facebook → then scale up.

**Full-run settings:** parallel=2, accountDelay=10–15min, waitInterval=120–180min,
groupDelay=90s, maxCycles=0, autoDeletePosted=ON.

**Log red flags:** `composer not found` (can't post to that group), `PENDING ADMIN APPROVAL`
(moderated group), account `logged_out` (session expired → re-login), stale chrome processes
piling up (kill in Task Manager between runs).

## Technology used (and *why* each was chosen)
This section explains the full stack and how each piece contributes to the required result
(automated, undetected, repeatable Facebook group posting).

### Runtime & packaging
- **Electron 35** — desktop shell (Chromium UI + Node.js backend in one app). Chosen so the
  whole tool ships as a single double-click `.exe` with a GUI, no terminal needed by the operator.
- **electron-builder 24** (`--dir` target) — packages the app into `win-unpacked/`. We avoid the
  NSIS installer because it requires symlink-creation privilege this machine lacks; the portable
  folder is zipped instead. `extraResources` ships the Chromium binary; `asarUnpack` keeps
  native/puppeteer modules executable outside the asar archive.
- **Node.js (main process)** — orchestration, file I/O, IPC, the local express server.

### Browser automation (the core)
- **Puppeteer 24** — drives a real Chromium browser (navigate, click, type, upload). This is what
  actually opens each group, fills the composer, attaches the image, clicks Post, and writes the
  first comment.
- **puppeteer-extra + puppeteer-extra-plugin-stealth** — patches the ~20 signals Facebook uses to
  detect headless/automated browsers (navigator.webdriver, headless UA, missing plugins, etc.).
  Essential: without stealth, accounts get challenged/locked quickly. Runs **headful** (visible
  window) on purpose — comments and some composer elements only render reliably in a headful browser.
- **Bundled Chromium (Chrome 148)** — copied from Puppeteer's cache into `chrome-bin/` at build time
  and shipped at `resources/chrome/chrome.exe`. Guarantees the exact Chromium version on machines
  that don't have it; `lib/chromium.js#chromiumPath()` resolves bundled-vs-dev automatically.
- **proxy-chain** — (dependency) supports per-account upstream proxy if/when accounts need distinct IPs.

### Session & anti-ban mechanics
- **Per-account Chromium user-data dirs** — each Facebook account keeps its own cookies/login profile
  on disk, so logins persist between runs (log in once, reuse).
- **`store.sanitizeProfile()`** — before every launch, deletes Chromium's `Current/Last Session/Tabs`
  and sets the `Preferences` exit flags so the browser never shows the "restore tabs?" popup that
  would block automation.
- **Configurable human-like delays** — `accountDelay` (minutes between accounts), `waitInterval`
  (minutes between cycles), `groupDelay` (seconds between groups). The **`intOr` NaN guard** exists
  precisely because a blank `groupDelay` once became `NaN`, silently removing inter-group pauses and
  raising ban risk.

### Data, IPC & local services
- **JSON file store (`lib/store.js`)** — accounts, groups, posts, settings, rotation state. Writes are
  **atomic** (write tmp → rename) so a crash/disk-full mid-write can't corrupt the data file.
- **Electron IPC + `preload.js`** — bridges the renderer UI and the Node backend (start/stop
  automation, CRUD on accounts/groups/posts, live log streaming to the Logs tab).
- **express 5 + multer (`server.js`)** — local HTTP server for image uploads; `UPLOAD_DIR` points at
  the writable `userData/uploads`, never the read-only path inside the asar.
- **cloudflared / axios / node-machine-id** — present for licensing/remote bits (machine-id gating,
  HTTP calls, tunnel); not central to the posting flow.

### Orchestration logic
- **orchestrator.js** — runs accounts in parallel **batches** (`parallelAccounts`), each cycle assigns
  a **unique** post per account (`post-centric-unique`, stable offset = account index), collects the
  `postedIds` workers return, **deletes them from the store per cycle**, and **auto-stops** when the
  library empties or `maxCycles` is hit.
- **worker.js** — one account's full sequence: launch bundled Chromium → restore session → for each
  assigned group: navigate → open composer → type caption → attach image → Post → confirm → first
  comment → wait `groupDelay`. Returns the list of successfully posted IDs.

## Work still to be done
Ordered by priority. Items 1–2 are blockers for a trustworthy production run.

### 1. Protect the code (do first — it has been lost once)
- [ ] **Commit + push** everything after `1820018` to `daseknahri/za-post`. The current working tree
      is uncommitted; a disk-full event already truncated `renderer.js` to 0 bytes once.
- [ ] Confirm `.gitignore` excludes the large/derived dirs: `dist/`, `chrome-bin/`, `node_modules/`,
      and any per-account Chromium profiles. Don't commit 400 MB of Chromium.

### 2. Real-world validation on Facebook (not yet done)
- [ ] **1-account / 1-group / 1-post smoke test** against a live, non-moderated group the account
      is a member of. Settings: `maxCycles=1`, `autoDeletePosted=OFF`, `parallel=1`, `groupDelay=30s`.
      Confirm the log shows `posted=1`, the post appears on Facebook, and (with auto-delete ON later)
      it disappears from the Posts tab.
- [ ] Verify the **first-comment** step actually posts (it's headful-dependent and historically flaky).
- [ ] Verify **image attach** works end-to-end through the express upload path.

### 3. Scale-up hardening (before the 120/10/4 run)
- [ ] Log in **all 10 accounts** (each persists its own profile) and confirm each shows `logged_in`.
- [ ] Tune full-run delays for ban-safety: `parallel=2`, `accountDelay=10–15min`,
      `waitInterval=120–180min`, `groupDelay=90s`, `maxCycles=0`, `autoDeletePosted=ON`.
- [ ] Decide whether per-account **proxies** are needed (proxy-chain is wired but unused). If multiple
      accounts post from one IP, FB may cluster-ban them.
- [ ] Add **stale-Chrome cleanup**: orphaned `chrome.exe` processes pile up across runs and must be
      killed manually today. A kill-on-stop / kill-on-start sweep would make long runs reliable.

### 4. Robustness / nice-to-have
- [ ] Handle **`PENDING ADMIN APPROVAL`** explicitly — currently logged but the post is counted as
      done; decide if a pending post should still be auto-deleted or retried.
- [ ] Handle **session-expiry mid-run** (the "Continue as…" picker) — detect and surface a re-login
      prompt instead of silently failing that account.
- [ ] Detect **`composer not found`** (account can't post to a group: pending membership/banned) and
      skip that group cleanly rather than stalling.
- [ ] Optional: a small **progress dashboard** (posts remaining, posted this cycle, ETA) in the UI.
- [ ] Optional: persist a **run report** (which post → which group → which account → timestamp/result)
      for auditing the campaign.

### 5. Distribution
- [ ] Re-zip `dist/win-unpacked/` after any code change (`Za-Post-Comment-Tool-1.0.0-portable.zip`).
- [ ] The app is **unsigned** → SmartScreen warns on first run (More info → Run anyway). Optional:
      code-sign the exe to remove the warning if distributing widely.

## Recovery notes
- `renderer.js` was once truncated to 0 bytes by a disk-full Write. If it ever reads 0 lines:
  `git restore renderer/renderer.js` (commit `1820018`), then re-apply the 5 changes
  (settings intOr guard, group-delay/max-cycles inputs, simplified onAutomationLog &
  onAutomationStopped, removed `postedPostIds` set). See git history / prior session transcript.
