# ADR-0014: Import existing logged-in Chrome profiles via a companion extension, not a profile-folder copy

- **Status:** Accepted
- **Date:** 2026-07-06
- **Deciders:** owner + engineering

## Context
Onboarding accounts that are already logged in as Chrome profiles is the least-flaggable way to bring them into za-post: the session carries the real device identity, so Facebook sees a continuation rather than a fresh login. But Chrome 127+ App-Bound Encryption seals session cookies (`c_user`/`xs`) so that only the running Chrome instance can decrypt them. A raw profile-folder copy — or a direct DPAPI/SQLite read of the cookie store — recovers encrypted blobs it cannot open, landing the account logged out. Any viable import must also carry the `datr` device cookie; without it the switch trips a new-device checkpoint on first use.

## Decision
Import from Chrome through a tiny, per-install, localhost-only, token-gated companion extension. The extension reads each profile's full Facebook cookie set — including `datr` — via Chrome's own `chrome.cookies` API (which sees decrypted values inside the running browser) and sends it over a localhost bridge to the app.

The app creates or updates the account keyed **strictly by the FB `c_user` id**:
- Re-sending the same profile never duplicates — it updates the existing account.
- A name/label collision with a *different* `c_user` creates a new, disambiguated account; it never hijacks an existing one.

The app stores the encrypted jar and writes the full jar only when a live `xs` cookie is present, so a stale or logged-out capture cannot overwrite good session state.

## Alternatives considered
- **Copy the Chrome profile folder** — rejected. App-Bound Encryption means the copied cookie store can't be decrypted outside its origin Chrome; the account lands logged out.
- **Direct DPAPI / SQLite read of the cookie store** — rejected. Same block: App-Bound Encryption defeats DPAPI-only decryption, so the recovered `c_user`/`xs` are unusable.
- **Key imports by profile label** — rejected. A label collision could silently hijack an existing account. Keying by `c_user` makes identity authoritative; collisions produce a disambiguated new account instead.

## Consequences
- Ships a per-install localhost bridge, a generated extension, and a generated token — more moving parts than a file copy, but the only path that yields a usable session.
- Logged-out detection is loud: when `xs` is missing the import surfaces it rather than silently writing a dead jar.
- `datr`-missing imports raise a warning, since the device-cookie gap is what causes downstream new-device checkpoints.
- Bulk Import (cookies/proxy/creds) remains the alternative for accounts that aren't in Chrome.
- The bridge create path deliberately omits the `overLimit` gate — all tiers are `Infinity`, so import is never capped.
- Invariant to preserve: imports must stay keyed by `c_user`, and the full jar must only be written when a live `xs` is present. Do not relax either, or imports can hijack accounts or clobber good sessions.

## References
- `main.js:357`
- `main.js:407`
- CHANGELOG 1.0.3
- MEMORY: za-post-chrome-import
