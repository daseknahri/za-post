# Za Post Comment Tool - Session Handoff

Last updated: 2026-06-18. Read this first when continuing in a new Codex session.

## Current Workspace

- Project path: `D:\za-post-main`
- Runtime data path: `%APPDATA%\za-post-restored`
- Local app/API while running: `http://127.0.0.1:3000`
- Portable zip made for transfer:
  `D:\za-post-main\dist\Za-Post-Comment-Tool-1.0.0-portable.zip`

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
