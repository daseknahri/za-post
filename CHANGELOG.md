# Changelog

Notable changes to za-post. Format loosely follows Keep a Changelog; versions follow SemVer.

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
