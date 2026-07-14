# Ship hardening — protecting the app when sending to clients

> What stops a client from copying/redistributing the app, and the exact steps to lock it down.
> Status as of 2026-06-24.

## Current protection level (before this pass)
- **License gate exists but is OFF by default.** `main.js` only enforces when `ENABLE_LICENSE=1` (env) or `settings.licenseEnabled=true`. The shipped `start.bat` does **not** set it → **every client today runs unlicensed/unlimited.**
- **Source is fully readable.** The portable build packs `resources/app.asar`, but it's **plain, commented JS** — anyone can `asar extract app.asar` and read `main.js`, `lib/license.js`, `automation/*`, etc. Not minified, not obfuscated.
- **Internal docs + tests were inside the asar** (AUDIT.md, SPEC files, 52 test files) — exposed the architecture. ✅ **Fixed this pass** (excluded from the build).
- **Baked secrets:** a hardcoded license-server URL fallback (the configured license server — `LICENSE_SERVER_URL`, see `lib/license.js`) and the owner-key SHA-256 are in `lib/license.js` (and thus the asar). The FB credentials (DPAPI) and the API token (env, not baked) are correctly protected.

## ✅ Implemented (2026-06-24)
- **Internal docs/tests excluded from the asar** (`package.json` build.files) — `*.md`, `tests/`, `docs/`, `devboot.*`. A thief who extracts the asar no longer gets specs/plans/test vectors.
- **License enforcement wired** (`main.js`): `LICENSE_ON = ENABLE_LICENSE || settings.licenseEnabled || _enforceLicenseMarker()`, where the marker = the build is packaged **AND** `resources/enforce-license.flag` is present (opt-in via `ENFORCE_LICENSE=1` at build time). → a packaged build enforces **only when built with the enforce flag** (an ordinary packaged build does NOT always enforce); the **dev clone** (`electron .`) stays open; the **owner key bypasses fully offline**. License tests green.
- **Server URL configurable** (`lib/license.js`): `DEFAULT_SERVER = process.env.LICENSE_SERVER_URL || '<ip fallback>'`. Set `LICENSE_SERVER_URL=https://license.yourdomain.com` at build time (start.bat) to hide the IP; the runtime License-screen override still wins.
- **bytenode pipeline (flag-gated, zero risk to normal builds)**: `scripts/compile-jsc.js` compiles the 12 main-process modules to V8 bytecode **under Electron** (ABI-correct); `scripts/build-portable.js` with `BYTENODE=1` transiently swaps each `.js` for a 2-line stub loader, builds, and **always restores the source** in `finally`. No `require()` rewrites (stubs keep module paths). **Verified:** all 12 modules compile + a `.jsc` loads back as a working module under Electron. Renderer/preload are intentionally NOT compiled.

### Producing the FINAL protected build (once the Coolify server is live)
```
# from C:\zpost\za-post, with your domain + token:
set LICENSE_SERVER_URL=https://license.yourdomain.com
set ZAPOST_API_TOKEN=<your token>
set BYTENODE=1
npm run pack:portable
```
Then **verify**: launch the produced `.exe` → it should show the **License window** (proves the bytecode app launched + enforcement fired). Enter the **owner key** → runs unlimited offline (confirms the happy path). A customer key activates against the live server. Distribute only after the server is confirmed live + you've issued keys (`vps-server/gen-key.js`).

> ⚠️ Do NOT ship a `BYTENODE=1`/enforced build before the license server is live — non-owner clients with no cached activation would be locked out. Sequence: deploy server → set `LICENSE_SERVER_URL` → build → verify with owner key → issue client keys → distribute.

## Remaining protection layers (apply + verify at final-build time)
bytenode covers the **main-process** modules (engine, license, server). Two gaps remain — both best applied during the final protected build and **verified by launching the packaged exe** (so the UI is confirmed working before distribution):

### A. Renderer protection — `renderer/renderer.js` is still plain JS
bytenode can't compile the renderer (it's loaded via `<script>` in `index.html`, not `require()`), so the wizard/dashboard/UI logic is readable after `asar extract`. The engine + license logic are bytecode, so this is the **lesser** sensitive surface — but to close it:
1. `npm install --save-dev javascript-obfuscator`.
2. In `scripts/build-portable.js`, under a new `OBFUSCATE=1` flag (mirror the bytenode pattern: swap → build → **always-restore** in `finally`), run javascript-obfuscator on `renderer/renderer.js` (+ `index.html` inline scripts if any) with conservative options (identifier renaming + string array; **avoid** aggressive control-flow flattening / self-defending first — they can break DOM/event code). Write the obfuscated copy in place of the original for the build, restore after.
3. **Verify by launching the packaged exe and exercising the wizard + dashboard** — obfuscation can subtly break UI logic, so this MUST be UI-tested, not just "it built."
> Risk: medium (can break the UI). Do it isolated, test thoroughly. If anything misbehaves, ship bytenode-only (engine protected) and skip renderer obfuscation.

### B. Tamper detection — asar integrity fuse
`npm install --save-dev @electron/fuses`. In an `afterPack`/post-build step, enable the **EnableEmbeddedAsarIntegrityValidation** + **OnlyLoadAppFromAsar** fuses on the built exe (for the exact Electron 35.x in use). Effect: the app **refuses to run if the asar was modified + repacked** (stops patch-and-redistribute). Doesn't prevent reading, but blocks the "extract → remove license check → repack → sell" path. Low risk (a flag flip on the exe), but test the exact Electron version.

**Net protection after all layers:** license (can't *use* without a key) + bytenode (can't *read* the engine/license) + renderer obfuscation (can't easily *read/rebrand* the UI) + integrity fuse (can't *patch-and-repack*). That's a strong, layered "don't get stolen" posture for a portable Electron app.

## The plan, by priority

### 1. Turn ON license enforcement (the core anti-theft) — **operational, needs your call**
The license system is fully built (per-seat tiers, HWID machine-binding, 7-day offline grace, revoke, periodic re-validation). Turning it on means **every client needs a key** validated against your VPS server.

**Prerequisites before flipping it on:**
- The license server (`vps-server/`, the configured license server — `LICENSE_SERVER_URL`, see `lib/license.js`) must be **running and reachable** from client machines.
- Generate one key per client: `node vps-server/gen-key.js` (tier: trial/standard/pro). Revoke with `revoke.js`.
- Your **owner key** bypasses everything (unlimited, offline) — keep it long + secret.

**How to enable (pick one):**
- **(A) Per build (simple):** add `set "ENABLE_LICENSE=1"` to the `start.bat` template in `scripts/build-portable.js`. ⚠️ Bypassable — a client who double-clicks the `.exe` directly skips it. Tell clients to launch via `start.bat` only.
- **(B) Robust (recommended) — ✅ SHIPPED:** the packaged build enforces via the enforce-marker, so it can't be bypassed: `const LICENSE_ON = ENABLE_LICENSE || settings.licenseEnabled || _enforceLicenseMarker()`, where the marker = packaged **AND** `resources/enforce-license.flag` present (opt-in via `ENFORCE_LICENSE=1` at build). The dev clone (not packaged) stays open for testing; a build made with `ENFORCE_LICENSE=1` enforces on every shipped copy; the owner key still bypasses. Build enforced copies only when the server + keys are ready (otherwise shipped clients are blocked).

### 2. Hide the server IP behind a domain + HTTPS — ✅ SHIPPED
`lib/license.js` no longer bakes a raw IP as the only option: `DEFAULT_SERVER = process.env.LICENSE_SERVER_URL || <fallback>`. Setting `LICENSE_SERVER_URL=https://license.yourdomain.com` at build time points clients at a domain behind Cloudflare (free TLS) — hiding the real IP and encrypting validation traffic; the runtime License-screen override still wins. See the configured license server (`LICENSE_SERVER_URL`) in `lib/license.js`.

### 3. Obfuscate the code so it can't be read/copied — **the real "can't steal it" step (multi-hour)**
Ranked by ROI:
- **bytenode (best ROI, already scaffolded).** `bytenode` is already a devDependency + in `asarUnpack`, and `npm run compile` exists — it's just not wired into the build. Compile the sensitive modules to V8 bytecode (`.jsc`): `main.js`, `lib/license.js`, `automation/worker.js`, `automation/orchestrator.js`, `server.js`. Ship the `.jsc`, exclude the `.js`. Result: the asar holds **bytecode, not readable source** — defeats casual `asar extract` + copy. (~4–8h: compile step, `require` shims, flip the build.files `.js`/`.jsc` inclusion, test the packaged app loads.)
- **javascript-obfuscator (layer on top).** Mangles names + encodes strings (incl. the server URL). Can combine with bytenode.
- **asar integrity fuse (`@electron/fuses`).** Tamper-detection (app refuses to run if the asar was modified). Doesn't stop reading, but stops patch-and-repack.

## Recommended order for the next client build
1. ✅ Exclude docs/tests from the asar (**done**).
2. Stand up the license server behind a domain+HTTPS; update `DEFAULT_SERVER`.
3. Turn on enforcement — option (B), once the server + per-client keys are ready.
4. bytenode-compile the critical modules (real code protection).
5. Rebuild + verify the packaged app: requires a key, owner key bypasses, source not readable.

> **Bottom line:** the license gate is what stops *use* without a key; **bytenode** is what stops *copying the code*. Do both for a build you can hand out safely. The doc/test exclusion (done) and the IP→domain change are quick wins along the way.
