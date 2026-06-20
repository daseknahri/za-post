# Za Post Comment Tool — Operations Guide

Day-to-day guide for running the restored Facebook auto-poster. For architecture and the
restoration story, see `README.md`.

---

## 1. Start the app

```powershell
cd C:\Users\Dell\za-post-restored
npm start            # King set   (aliases B1–B50)  -> userData: AppData\Roaming\za-post-restored
npm run start:base   # Base set   (aliases A1–A50)  -> userData: AppData\Roaming\za-post-restored-base
npm run dev          # same as start, with DevTools
```

The two sets are isolated instances (separate data, profiles, cookies). Run one at a time
per port (the remote server binds `:3000`).

---

## 2. The daily workflow

```
 Login accounts  ->  Prep (readiness + membership sync)  ->  Add posts & groups  ->
 Configure settings  ->  Start  ->  watch the log / 📊 summary
```

### a) Log accounts in  ⟵ THE most important step
The migrated cookies are **stale** — accounts intermittently show Facebook's
"Continue as…" picker. For dependable posting you must create **fresh** sessions:

- **Accounts → Login** on an account → a real Chrome window opens → sign in (password / 2FA /
  clear any checkpoint) → **close the window**. The fresh session is saved to that account's profile.
- Then **Check status** → it should read **`logged_in`**.

Disabled accounts (toggle the **On/Off** pill on the account card) are skipped by automation.

### b) Prep — readiness + membership sync (recommended before every run)
```powershell
node scripts/prep-accounts.js                  # all accounts
node scripts/prep-accounts.js account1 account5 # a subset
node scripts/prep-accounts.js enabled           # only enabled accounts
```
For each account it confirms login and prunes `assignedGroups` to the groups it can actually
post in, then prints a summary:
- **READY** — logged in + ≥1 postable group (will post)
- **NEEDS LOGIN** — re-login required
- **LOGGED IN / NO GROUPS** — assigned to groups it isn't a member of (join them or reassign)

Single account: `node scripts/sync-memberships.js <account>`.

### c) Posts & groups
- **Posts**: caption + image + an optional **first comment** (your link). The worker posts the
  caption+image, then drops the comment on the published post.
- **Groups**: add by ID or paste a group URL. Assign groups to each account on its card.
- **Prefer un-moderated groups.** In moderated groups the post goes to the **admin approval
  queue** (counted as `pending`, comment skipped — it isn't in the feed yet).

### d) Settings (per cycle)
| Setting | Meaning |
|---|---|
| `parallelAccounts` | accounts running at once |
| `Max Groups per Account (per cycle)` (`postsPerGroup`) | cap on groups each account hits per cycle |
| `accountDelay` | minutes between parallel batches |
| `waitInterval` | minutes between full cycles |
| `groupDelay` | seconds between groups within one account |
| `maxCycles` | 0 = run continuously; N = stop after N cycles |
| `commentWithImage` | also attach the post image to the comment |
| `autoDeletePosted` | delete a post locally after it's posted |

### e) Run & monitor
**Automation → Start.** The live log shows each step; per account you get a
**`📊 [name] posted=X pending=Y errors=Z`** summary. Stop any time.

---

## 3. Remote control (optional)
The app serves a dashboard on `http://localhost:3000` and, when `cloudflared` connects, a
public URL (shown on the Dashboard tab). From a phone you can Start/Stop, watch logs, see
account statuses, change the interval, and manage the post queue.

---

## 4. Troubleshooting
| Symptom | Cause | Fix |
|---|---|---|
| Account shows "Continue as…" / `not_logged_in` | stale session | **Accounts → Login** (fresh sign-in) |
| `Post button not found` / `composer did not open` | not the composer trigger / slow load | usually transient — the worker retries; if persistent the group layout changed |
| `not logged in / not a member` | account isn't in that group | join it on FB, or `prep-accounts` to drop it |
| `PENDING ADMIN APPROVAL` | group moderates posts | use un-moderated groups, or wait for an admin |
| Post "succeeds" but isn't visible | FB queued/filtered it (account standing) | use freshly-logged-in, warmed accounts |
| Many `chrome.exe` left after testing | killed/aborted Puppeteer runs | the app cleans up normally; for scripts, kill chrome whose cmdline matches `za-post-restored` |

> Reliability rule of thumb: **fresh logins + un-moderated groups + member accounts** = posts land.
> Everything else (the code path) is verified working.

---

## 5. Scripts reference
| Script | Purpose |
|---|---|
| `scripts/migrate.js [king\|base]` | import an old shipped-app runtime into this app |
| `scripts/prep-accounts.js [names…]` | batch login-check + membership sync + readiness report |
| `scripts/sync-memberships.js <acct>` | sync one account's groups to its real memberships |
| `scripts/live-post.js <acct> <groupId> <postIdx>` | run the worker for one account→group→post (verification) |
| `scripts/*` (inspect/diag/test) | live DOM diagnostics used during tuning — **run headful**, FB hides composer/comment boxes in headless |

---

## 6. Turning this into a sellable product
**Licensing is now IMPLEMENTED (opt-in).** Per-seat machine-bound keys with tiered limits
(`trial`/`standard`/`pro`), revocation, expiry, and a 7-day offline grace period are built and
enforced in the backend — see `vps-server/` (server + `gen-key.js`/`revoke.js`) and `lib/license.js`.
Turn the client gate on with `ENABLE_LICENSE=1` (or `settings.licenseEnabled`). The VPS key store is
encrypted at rest with `KEYS_ENCRYPTION_KEY`. See `ENV.md` for all env vars and `vps-server/DEPLOY-COOLIFY.md`
for deployment (run it behind an HTTPS proxy).

Still open / optional: confirm the live HTTPS endpoint for `lib/license.js` `DEFAULT_SERVER`
(currently `http://144.91.127.7:3509`), code protection (bytenode/obfuscation), an auto-updater, and
code-signing the desktop build (set `CSC_LINK`/`CSC_KEY_PASSWORD` — see `ENV.md`).
