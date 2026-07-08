# ADR-0003: Context-isolated IPC bridge gated by a hardcoded ALLOWED_CHANNELS allowlist

- **Status:** Accepted
- **Date:** 2026-07-06
- **Deciders:** owner + engineering

## Context
The renderer needs to reach about 59 main-process handlers, and several of them are sensitive: `get-account-credentials` decrypts a stored account email (returning only a `hasPassword` boolean, never the password itself), and `batch-account-action` can bulk-delete accounts and wipe their browser profiles. If the renderer could call `ipcRenderer.invoke` directly against any channel, then any injected or XSS-delivered page script would inherit the full authority of the main process — reading stored account data or destroying it. The IPC surface has to be usable from the UI while remaining a hard boundary against untrusted page code.

## Decision
Expose a single context-isolated `window.electronAPI` through Electron's `contextBridge`, with `contextIsolation: true`, `nodeIntegration: false`, and no `require` reachable from the renderer. That bridge offers a generic `invoke()` that rejects any channel not present in a hardcoded `ALLOWED_CHANNELS` `Set`. Named, typed wrapper methods exist on top of it for readability, but the `Set` — not the wrappers — is the enforceable choke point. Every channel the renderer uses must both appear in `ALLOWED_CHANNELS` and have a matching `ipcMain.handle` registration; this pairing is a hand-maintained contract between preload and main.

## Alternatives considered
- **Expose `ipcRenderer.invoke` unguarded.** Rejected: every channel becomes reachable from page context, so any XSS is a full compromise.
- **Ship only named wrappers with no generic `invoke` path.** Rejected: less flexible for adding channels, and it carries the identical security burden without the benefit of one auditable allowlist.
- **Rely on renderer-side validation.** Rejected: the HTTP API bypasses the UI entirely, so trust cannot live in the renderer — it must be enforced at the process boundary.

## Consequences
The allowlist *is* the security boundary. Adding an `ipcMain.handle` without also allowlisting its channel makes the handler unreachable from the renderer — an intentional fail-closed default. Conversely, exposing a generic passthrough or wildcard in `invoke()` would silently dissolve the boundary and must never be added. Because the HTTP API can drive the same handlers without going through the UI, settings arriving from either the renderer or the HTTP API are re-clamped server-side via `clampSettings` before being persisted, so bounds are never trusted from the caller.

## References
- `preload.js:6` — `ALLOWED_CHANNELS` Set definition
- `preload.js:26` — generic `invoke()` channel guard
- `main.js:483` — `contextIsolation: true`, `nodeIntegration: false` on the `BrowserWindow` webPreferences
- `main.js:718` — first `ipcMain.handle` registration (`get-data`); ~59 handlers run through here (contract pair)
- `main.js:1216` — `get-account-credentials` handler (sensitive: decrypts the stored email, returns only `hasPassword`)
- `lib/store.js:495` — `clampSettings` server-side re-clamp
