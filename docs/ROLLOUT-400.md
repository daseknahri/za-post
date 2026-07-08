# 400-Account Client Rollout — Operator Runbook

Everything the software needed for a 400-account deployment is done (v1.0.3). This is the exact order to roll it out.
The one thing the code can't solve is **proxies** — fleet parallelism = number of distinct proxies (see step 6).

---

## 0. Before you build (license prerequisites — READ THIS, it's the #1 way to brick a client)
The client build **requires activation on first launch**. A fresh install has **no cached license**, so if the
server is unreachable or the key isn't issued, the app **parks on the License screen and cannot open** (the 7-day
offline grace only applies *after* one successful activation). Before shipping, confirm ALL of:
- [ ] Your **license server is live and reachable** — the app calls **`https://lisence.ibnbatoutaweb.com`** by default.
      That host is fixed in `lib/license.js` (`DEFAULT_SERVER`); to point at a different server, **edit that constant and
      rebuild** (there is no build-time env or `start.bat` variable that changes it).
- [ ] You've **issued a per-seat key** for this client and confirmed it returns *valid* (it device-locks on first activation).
- [ ] Ideally: **activate the built zip once on a clean machine** against the live server before you ship it.
- If any of the above isn't ready, build **without** `ENFORCE_LICENSE=1` (unlimited) and switch to an enforced build later.

## 1. Build the client zip
```
ENFORCE_LICENSE=1 npm run pack:portable
```
→ `dist/Za-Post-Comment-Tool-<version>-portable.zip` (~335 MB, bundled Chromium, per-seat enforced). The version comes
from `package.json` — today that is **1.0.2**. Ship *that* file; delete/ignore any older `1.0.0`/`1.0.1` zips still in `dist/`.
*(Add `ZAPOST_API_TOKEN=<token>` before the command only if the client will push posts via the remote API.)*

## 2. Install on the client laptop
- Send the single `.zip`. Client extracts it, runs **`Za Post Comment Tool.exe`** (replaces the old folder).
- Their data lives in `%APPDATA%\za-post-restored` (separate from the folder → carries over untouched).
- First launch: **License screen → enter the key → Activate** (needs internet once; then 7-day offline grace).
- **If activation fails** ("could not reach license server"): check the client's internet, confirm the server is up and
  the key is issued for their machine, then retry. Until it activates, the app stays on the License screen — this is why
  step 0's pre-ship check matters.

## 3. Add the accounts
**If they're already logged in as Chrome profiles → Accounts → 🌐 Import from Chrome** (best: carries each
account's `datr` device identity via a one-time helper extension, so the switch doesn't trip a new-device check —
see READ-ME-FIRST). Otherwise use **📦 Bulk Import**. One account per line, fields split by `|` / tab / comma:
```
name | alias | proxy | email | password
```
- Only **name** is required. Proxy: `host:port` or `host:port:user:pass`.
- Optional **🍪 cookies folder**: a folder of `<name>.json` (Cookie-Editor exports) matched by name.
- **Cookies are the best way in** (include `datr`, not just c_user+xs) — the app seeds a fresh profile on the client
  machine (DPAPI-correct), then the profile is the durable identity from run 2 on. No browser opens during import.
- Duplicates + names that collide on disk are skipped safely (no profile overwrite).

## 4. Assign groups to accounts
Add your groups (Groups tab → 📦 Bulk Import Groups), then Accounts tab → select accounts → **assign groups**
(each account posts to *its* groups). Matches the A1/B1/… "each profile → its groups" model.

## 5. Settings for a large fleet
- **Speed mode**: pick per your risk appetite (Instant is fastest; the anti-spam floors still apply).
- **Cycles per run** + **Time between cycles**: your daily cadence.
- **Parallel accounts**: set what you want — the app **auto-caps it by the laptop's free RAM/CPU** (≈450 MB per
  browser) so it can't swap-thrash. It logs `⚠️ Pool capped …` if your value is above what the machine holds.
- **Start = runs now** (immediately); the daily time only drives the unattended next-day auto-start.

## 6. Proxies — the real throughput limit (not code)
Two accounts on the **same exit IP never run at once** (anti-link). So **parallelism = distinct working proxies**:
- ~400 proxies (1/account) → full parallelism.
- Dozens shared → ~dozens run at a time; a full 400-account cycle is long but works.
- Few/none → the fleet serializes to ~1 browser → a cycle takes many hours (can't finish in a day).

Plan the proxy count against how fast you need a full cycle. More proxies = more throughput; there is no code lever.

## 7. Run
Click **Start**. Watch the dashboard live-ops panel + the Accounts tab (virtualized — smooth at 400).
Logs: the app's `…\logs\automation.log`.

---

### Health caps already in place (nothing to configure)
- Pool auto-capped by free RAM/CPU (step 5).
- Each browser's disk cache capped so 400 profiles don't fill the SSD.
- Accounts tab virtualized + debounced (no freeze at 400).
- Every publish is confirmed and dealt-tracked — a post can't land twice, a comment can't hit the wrong post.
