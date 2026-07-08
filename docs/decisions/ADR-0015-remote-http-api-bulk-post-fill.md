# ADR-0015: Token-gated remote HTTP API to fill the post library from an external server

- **Status:** Accepted
- **Date:** 2026-07-08
- **Deciders:** owner + engineering

## Context
Posts could only enter the app by being typed into the UI. The operator wanted to feed the post library from an external, automated source — including from off-machine — so that posts generated elsewhere could land in the app without manual re-entry. That means exposing an HTTP surface, which immediately raises the tension the rest of this decision resolves: the app must be reachable from outside when the operator wants it, but must not become a broadly-open door, and remote writes must not corrupt or race the store that the UI also writes.

## Decision
The app ships an Express HTTP API (`server.js`) whose central endpoint is `POST /api/posts/bulk`. It accepts either a bare array of posts or a `{posts, replace}` object, capped at 1000 posts per request, and either merges or replaces the library. The design holds several invariants together:

- **Auth is always on whenever the server runs.** `main.js` generates the token unconditionally at module load (`main.js:192`) and passes it to the server unconditionally at startup (`main.js:588`); the tunnel enable/disable logic never sets or clears it. So the token gate is active at all times the server runs — including local-only use with no tunnel — over `/api` and the `/uploads` + `/images` static dirs. (`server.js` does support a conditional local bypass when no token is supplied, but `main.js` never exercises it.) Callers authenticate with the `X-Access-Token` header or a `?token=` query parameter, compared in **constant time** to defeat timing attacks.
- **Rate limiting sits in front of the gate.** Per-IP rate limiting is mounted **before** the token check, so an unauthenticated flood is throttled before it can hammer the comparison or the endpoints.
- **The store stays the single source of truth.** The API never writes the store directly. All state mutations delegate back to `main.js` through injected hooks, so remote pushes flow through the same merge-preserving write path as the UI.
- **The same gates as automation apply.** The remote login endpoint respects the same license gate as starting automation. The server binds `127.0.0.1` unless a host explicitly widens it, and `apiErr` returns only generic errors to remote clients so internals are not leaked.

## Alternatives considered
- **UI-only post entry** — keep the current typed-in-only flow. Rejected: it blocks the entire point, which is feeding posts from an external automated source.
- **An open / unauthenticated endpoint** — expose `/api/posts/bulk` with no auth. Rejected: an off-machine, tunnel-reachable write surface with no token is an open door; the endpoint is token-gated.
- **Let a UI save and a remote push race freely** — allow both writers to overwrite the store independently. Rejected: it dropped posts when a full-window save clobbered a concurrent remote push. Fixed by routing all writes through merge-preserving writes in `main.js`.

## Consequences
- Concurrency-safety now lives on the store write-chain: remote-pushed posts must survive a full-window UI save. Do not add a code path that writes the store outside the `main.js` hooks, or that race returns.
- The access token must be kept out of logs; treat it as a secret on both the tunnel and the API side.
- The public tunnel URL is scraped from `cloudflared` stdout because the package's built-in `url` event is broken on current builds. If that parsing is touched, verify the URL is still captured before relying on the tunnel being reachable.

## References
- `server.js:103`
- `server.js:158`
- `server.js:16`
- CHANGELOG 1.0.4
