# Za Post Comment Tool — Restored (clean source)

> **📖 Full, current reference: [`DOCS.md`](DOCS.md)** (architecture, run lifecycle, settings,
> data layout, hidden/visible browser, packaging internals, robustness) · **Latest status:
> [`HANDOFF.md`](HANDOFF.md)**. This README is the original reconstruction overview; DOCS.md
> reflects the current hardened state. **To build the distributable:** `npm install` →
> `npx puppeteer browsers install chrome` → `npm run pack:portable`.

Facebook multi-account auto-poster (Electron + Puppeteer-extra/stealth). This is a
**clean, fully-editable reconstruction** of the shipped "King" app, whose backend had
been compiled to V8 bytecode (the original `main.js` source was lost). The renderer/UI
here is the genuine recovered source; the backend was rebuilt against its IPC contract.

## Run

```bash
npm install        # pulls Electron + Puppeteer's Chromium (large, first time only)
npm start          # launch the app
npm run dev        # same, with DevTools open
```

## Layout

| Path | Purpose |
|---|---|
| `main.js` | Electron main process — every IPC handler, account login/status, license stub, server wiring |
| `preload.js` | `window.electronAPI` bridge (recovered, unchanged) |
| `renderer/` | UI: `index.html`, `renderer.js`, `styles.css` (recovered, unchanged) |
| `lib/store.js` | JSON data store + per-account profile/cookie/image paths |
| `automation/orchestrator.js` | Posting cycle: per-account filters, parallel batches, delays, stop control |
| `automation/worker.js` | One account → its groups: open composer, upload image, caption, post, first comment |
| `server.js` | Express remote-control dashboard + best-effort Cloudflare tunnel |
| `public/index.html` | Remote dashboard page (recovered) |

## Data & state

All runtime data lives under Electron's `userData` dir:

- `data.json` — `{ posts, groups, accounts, settings, proxies, useProxies }`
- `accounts/<name>/chrome-profile/` — persistent Chromium profile per account
- `accounts/<name>/cookies.json` — imported/saved cookies
- `storage/images/` — decoded post & comment images

## Migrated data

`scripts/migrate.js [king|base]` imports an existing shipped-app runtime into this app's
data model. **Both sets are migrated** (100 FB accounts total):

| Set | Aliases | Launch | userData |
|---|---|---|---|
| King (premium) | B1–B50 | `npm start` | `…\Roaming\za-post-restored` |
| Base | A1–A50 | `npm run start:base` | `…\Roaming\za-post-restored-base` |

Each set = 50 posts (+images), 4 groups, 50 accounts (+per-account `cookies.json`), settings.
They run as **isolated instances** (separate userData via `--profile=base`) because account names
collide across sets. Re-run `npm run migrate` / `npm run migrate:base` any time to refresh.

## Account prep / readiness

Before a run, check which accounts are ready and prune each account's groups to the ones
it can actually post in:

```bash
node scripts/prep-accounts.js                       # all accounts
node scripts/prep-accounts.js account1 account17     # a subset
node scripts/prep-accounts.js enabled                # only enabled accounts
```

It auth-checks each account, syncs `assignedGroups` to real memberships, and prints a
summary: **READY** (logged in + ≥1 postable group), **NEEDS LOGIN**, **LOGGED IN/NO GROUPS**.
Accounts can also be enabled/disabled individually in the Accounts tab (disabled = skipped
by automation). Single-account sync: `node scripts/sync-memberships.js <account>`.

## ⚠️ Facebook sessions are expired — re-login needed before posting

The migrated cookies/profiles identify each account but their **Facebook sessions are no
longer active** (verified: the home page shows the "Continue as …" account picker, and
groups show "Join Group / Log in"). Posting cannot succeed until each account is
re-authenticated. Use **Accounts → Login** (opens a real browser; sign in; the session is
captured into that account's profile), then **Check status** — a healthy account reports
`logged_in`. `check-account-status` now detects the picker correctly instead of reporting
a false `logged_in`.

## Remote dashboard

`public/index.html` is served by `server.js` and talks to `/api/automation/*` and
`/api/posts*` (add uses multipart upload via `multer`). A Cloudflare quick-tunnel exposes
it publicly when available; the URL is pushed to the desktop UI.

## Notes / what to tune next

- **License** is a permissive **local stub** (`get-license-info` returns lifetime + 9999 limits);
  there is no validation server. Replace `get-license-info` / `validate-license-async` in
  `main.js` if you want real gating.
- **Facebook selectors** in `automation/worker.js` are best-effort with fallbacks; Facebook's
  DOM changes often, so these are the first thing to verify/tune on a live run.
- Posting requires accounts that are actually logged in — use **Accounts → Login** (opens a real
  browser) or **Cookies** (paste a Cookie-Editor JSON export), then **Check status**.

## Restored automation features

- **Per-account `postingOrder`** (account-centric engine in `orchestrator.js`): `post-centric`
  (all posts), `random`, `sequence` (next post, rotating), `post-centric-unique` / `random-unique`
  (one post per account, offset so accounts post different content). Rotation persists in
  `pcu-state.json` (mirrors the original).
- **Per-account `postFilter`**: `all` / `with-comments` / `without-comments`.
- **Authenticated SOCKS5 proxies** via `proxy-chain` (Chrome can't do SOCKS5 auth directly);
  unauthenticated proxies pass straight through.
- **Remote image URLs**: posts with `imageUrl` / `commentImageUrl` are downloaded (axios) at post time.
- **Comment-with-image**: explicit comment image, a remote comment-image URL, or the post image
  when `commentWithImage` is enabled.
- **Auto-delete posted**: the worker emits `✅ Successfully posted … <caption>` so the renderer's
  auto-delete tracker matches and removes posted items when enabled.
- **Anti-detection / robustness** (recovered from the original worker): human chunked typing
  (`humanType`), popup/consent/notification dismissal (`dismissPopups`), rate-limit detection +
  back-off (`checkRateLimit`), and multi-step composer focus (`focusEditable`).
- **Per-account crash isolation + restart**: each account runs guarded; a crash is retried once and
  never aborts the batch/cycle (approximates the original master-round-robin supervisor).
- **Remote dashboard parity**: `/api/automation/status|start|stop|logs`, `/api/automation/interval`,
  `/api/posts*`, `/api/accounts`, `/api/accounts/:name/login|close-login`, `/api/groups`.
- **Public tunnel** via bundled `cloudflared` (the dashboard URL shown in-app actually works now).

Author of the original app: Abdelilah. Reconstruction: 2026-06.
