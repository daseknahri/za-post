# iProyal → Za Post: buy, grab, and fill (step-by-step)

> For a multi-account Facebook group poster, the goal is **one stable IP per account** (an account that
> keeps changing IP looks suspicious). So pick a proxy type that gives sticky/static IPs.

## 1. Which iProyal product to buy
| iProyal product | Good for FB? | Why |
|---|---|---|
| **Royal Residential — STICKY session** | ✅ recommended | real residential IPs; you make **one sticky session per account** → each account keeps its own IP |
| **ISP / Static Residential** | ✅ best (pricier) | a fixed static residential IP per account — never rotates |
| Residential — rotating | ⚠️ only if you must | IP changes per request → an account's IP keeps moving (less ideal for FB) |
| Datacenter | ❌ avoid | easily flagged by Facebook |

**Pick Residential (sticky)** for the best price/safety, or **ISP** if budget allows. Buy at least **as many sticky sessions / static IPs as you have posting accounts** (1 IP per account). Choose your target **country** to match where the accounts/groups are.

## 2. What to grab from the iProyal dashboard
After purchase, open the proxy product → "Access" / "Setup" / "Generate". Copy these **4 things**:
1. **Host (gateway)** — e.g. `geo.iproyal.com`
2. **Port** — e.g. `12321` (HTTP) — iProyal also offers a SOCKS5 port; either works.
3. **Username** — your proxy username (often long).
4. **Password** — your proxy password.

For **sticky sessions**, iProyal lets you append session settings to the **username**, e.g.:
`USERNAME_country-us_session-acct1_lifetime-30m`
→ make a **different `session-XXXX` per account** (`session-acct1`, `session-acct2`, …) so each account locks to its own IP. (For **ISP/static**, you instead get a distinct host:port or user per IP — no session needed.)

## 3. What to fill into Za Post
The app accepts a proxy string in this form (scheme is **required**):
```
scheme://username:password@host:port
```
- `scheme` = `http` (or `socks5`) — match the iProyal port you copied.
- For sticky residential, put the **session-laden username** in the username slot.

**Examples (replace with YOUR values):**
- Residential sticky, account #1:
  `http://USERNAME_country-us_session-acct1:PASSWORD@geo.iproyal.com:12321`
- Residential sticky, account #2 (only the session changes):
  `http://USERNAME_country-us_session-acct2:PASSWORD@geo.iproyal.com:12321`
- ISP/static (one per account):
  `http://USERNAME:PASSWORD@ISP_HOST:PORT`
- SOCKS5 variant: `socks5://USERNAME:PASSWORD@geo.iproyal.com:PORT`

> The app also accepts the compact form `scheme://host:port:username:password` — but for iProyal's
> session usernames the **`user:pass@host:port` form above is cleaner**.

### Where to paste it
**Accounts tab → open an account card → expand "Account Proxy" → paste that account's string → click away.**
It auto-saves and shows a green **✓ format OK**. Do this per account, giving each its **own `session-XXXX`** (or its own static IP). A per-account proxy always wins over the global pool.

## 4. Confirm it works (3 quick checks)
1. **Format:** the green ✓ badge appears as soon as you paste a valid string.
2. **Reachable:** close the app, then run `node scripts/diagnose-proxies.js` — it should report **✓ alive** for each proxy. (Tell me when you've added them and I'll run this for you.)
3. **Real IP:** Settings → turn **Hide Browser OFF**, run **one** account on **one** group, watch the browser, open `whatismyipaddress.com` in that window → it should show the **proxy's** IP/country, not yours. (WebRTC leak protection is always on.)

## Quick recommendation
Start with **Royal Residential (sticky), 1 session per account, country = your audience**. Grab host/port/user/pass, build one `http://USER_session-acctN:PASS@HOST:PORT` per account, paste into each account's "Account Proxy", then run check #2 and #3. Once you've added them, ping me — I'll verify they're alive and that the browser is posting from the proxy IP.
