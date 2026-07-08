# ADR-0016: Portable-zip delivery with a separate userData folder, build-time enforce marker, and non-overwriting first-run migration

- **Status:** Accepted
- **Date:** 2026-07-06
- **Deciders:** owner + engineering

## Context
The app ships to non-technical clients who upgrade by extracting a zip and replacing a folder. That workflow must never lose their accounts, groups, or data. At the same time, one codebase has to produce two artifacts: an unlimited build for the owner/dev and a per-seat-enforced build for clients — without forking source.

The obvious packaging paths fight us here. electron-builder's NSIS/portable targets extract a winCodeSign 7z that contains macOS symlinks; creating those symlinks on Windows requires admin rights or Developer Mode, which non-technical clients do not have. We need a delivery format that never touches code signing and never depends on symlink privileges.

## Decision
Ship a single portable zip containing a bundled Chromium, a `READ-ME-FIRST.txt`, and a `start.bat`. Build it with the unsigned electron-builder `dir` target and self-zip the output with 7-Zip, so the signing/symlink path is never exercised.

Keep client data out of the app folder. It lives in a separate userData folder at `%APPDATA%\za-post-restored`, so replacing the extracted app folder on upgrade carries the data over untouched.

Make per-seat enforcement an opt-in property of the artifact, not the source. When `ENFORCE_LICENSE=1` at build time, the build writes `resources/enforce-license.flag`. The *same* runtime code checks for that marker, so one codebase produces both the unlimited and the enforced build with zero source divergence.

On first run, `migrateLegacyUserDataOnce` seeds the new userData folder from a prior product-name userData directory **only when the new folder has no `data.json`**. It is one-shot and marker-guarded, so it never overwrites existing client data. `start.bat` bakes the API token and tunnel address from build-time environment variables.

## Alternatives considered
- **electron-builder NSIS/portable targets** — rejected: their winCodeSign extraction needs symlink creation that requires admin/Developer Mode on Windows.
- **A traditional installer** — rejected: heavier than a folder-replace for non-technical clients.
- **Data stored inside the app folder** — rejected: the folder-replace upgrade would wipe it.
- **Baking enforcement into source, or maintaining separate builds** — rejected: the runtime marker keeps a single codebase and avoids a divergent enforced branch.
- **A runtime env flag for the license server** — not needed: the server URL is already overridable at runtime. The License-screen "Server URL" field persists into a per-install `license-config.json`, which `licenseServerUrl()` (`main.js`) reads in preference to the `DEFAULT_SERVER` fallback (`lib/license.js:21` — `process.env.LICENSE_SERVER_URL || 'https://lisence.ibnbatoutaweb.com'`). (`start.bat` bakes only `ZAPOST_API_TOKEN` and `ENABLE_TUNNEL`, not the license URL.) So no separate mechanism is required.
- **Unconditional first-run migration** — rejected: it could overwrite existing client data.

## Consequences
- Shipping is a manual discipline: pick the correctly enforced zip and delete older, superseded, or buggy zips so a wrong artifact can't go out.
- The license server must be live before any enforced build ships, or enforced clients will fail to validate.
- The BYTENODE anti-theft path must restore the source `.js` in a `finally` block, or a failure mid-build leaves the tree in a compiled state.
- Cookie jars copy as-is only under the same-machine, same-OS-user assumption: DPAPI cookie envelopes decrypt verbatim only there. Moving a jar across machines or OS users will not decrypt.

## References
- `scripts/build-portable.js:124-126` — enforce-marker write (`ENFORCE_LICENSE=1` → `resources/enforce-license.flag`)
- `scripts/build-portable.js:163` — 7-Zip self-zip step
- `scripts/build-portable.js:68` — build entry (async IIFE); env wiring at 124 / 142-143
- `main.js:48` — `migrateLegacyUserDataOnce` first-run seed
- MEMORY: `za-post-delivery`
