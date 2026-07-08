# Big-Test Operator Runbook

A plain-language guide to running a large campaign and reading what the app tells you.
Keep this open on a second screen during the run.

---

## 1. Before you start (5 minutes)

Run the read-only readiness check from the app folder:

```
node scripts/readiness.js
```

It prints **GO / WARN / NOT-READY**. Fix anything it flags, especially:

- **Accounts NOT logged in** → log them in (Accounts tab → Check / open the login browser).
- **Accounts assigned a post-set with 0 posts** → either tag posts to that set (Posts tab) **or** clear the account's post-set. *(An account with an empty set posts nothing all run.)*
- **Accounts with no groups** → assign groups (Accounts tab).
- **No reserves** → mark a few spare accounts **Standby** so a dropped account is auto-covered.
- **Proxied accounts missing timezone/locale** → set **`proxyTimezone`** + **`proxyLocale`** (Settings) to your proxies' region/language (or fill them per account). *(Without them a proxied browser leaks this machine's clock/language — the geo-alignment silently can't fire. The check lists exactly which accounts are missing each.)*

> The same checks also run as pop-ups when you click **Start** — you can "Start anyway", but it's better to fix them first.

---

## 2. Starting the run

When you click **Start**, the app shows a warning dialog for each problem it finds (not-logged-in, no groups, empty post-set, empty library, moderator-not-ready). Each lets you **Start anyway** or cancel and fix it. If everything's clean, it just starts.

For your current setup, the manual items to clear first are: **tag your 8 posts to the post-set (or clear it)** and **log in B4 / B7**.

---

## 3. While it runs — reading the dashboard

Each account has a **row** (state + one-line action) and a **collapsible log** (every step). What the signals mean:

| You see | Means | Do |
|---|---|---|
| `✓ posted to N groups` | Delivered to N groups | nothing — healthy |
| `✓ posted to N groups · ⚠️ M failed` | Posted to N, but **M groups failed** | expand the log to see which/why (selector drift, navigation, block) |
| `⏭️ Posted nothing — <reason>` | Account idled on purpose (**no groups / empty post-set / filter excludes all**) | fix the named reason; this account is doing nothing until you do |
| `⏳ N pending approval` | Posts were **held by Facebook** ("Spam potentiel") | needs a moderator or reserve re-post to go live (see §5) |
| `rate-limited` | Facebook throttled this account | it auto-cools down (a reserve covers its groups); comes back on its own |
| `needs login` / `checkpoint` | Session expired / identity check | it now **rests** (~3h logout, 6h checkpoint) and a **reserve covers its groups** — it does **not** retry every cycle (that's a ban risk). Log it in + re-check to bring it back sooner; it **auto-rejoins** once it posts again |
| `⛔ … resting Xh` (in the action line) | A blocked/logged-out account is deliberately paused | nothing — a reserve is covering it; fix + re-check the account to speed its return |
| `set it to English` (in the log) | The Post button wasn't found — the account's Facebook UI is a language the app can't read | switch that account's Facebook language to **English** (see §7); a reserve covers it meanwhile |
| `error` | Couldn't post (no progress) | expand the log; may be a transient FB/DOM issue |

**In the per-account log**, two messages are worth knowing:

- `Confirmed LIVE — our post is in the feed` → genuinely delivered + visible.
- `Posted (publish confirmed) — NOT yet feed-confirmed … may be in "Spam potentiel"` → the publish went through but the app could **not** see the post in the group feed. For a no-comment post this often means Facebook **held it for review**. Worth spot-checking that group manually.

---

## 4. When it finishes — the report

At the end the app logs a summary:

- `📊 Delivered this run: X published, Y pending-approval, Z error(s)` — the headline numbers.
- `🔧 Accounts to REPLACE/check (went bad this run): …` — accounts that got rate-limited / logged out / flagged. **Warm or replace these before the next run.**
- `🚧 N (post,group) pair(s) UNDELIVERABLE — held even after a replacement re-post: …` — groups whose spam gate rejected the content. Use warmer/older accounts there, or different content.
- If posts stayed **held** with no moderator/reserve to recover them, it tells you to turn on **Moderator Approval** or **Reserve Re-post**.

---

## 5. Common situations & fixes

- **An account shows `⏭️ Posted nothing`** → it's a config issue, not a Facebook block. The message names the cause (groups / post-set / filter). Fix and it posts next cycle.
- **Posts are `pending approval` / held** → designate a **moderator** account (Groups tab → 🛡️ Group Moderator) and log it in, **or** turn on **Reserve Re-post** so a standby account re-posts the held content. Moderator approval is currently **OFF**.
- **An account dropped (logout / rate-limit)** → if you have **Standby** accounts, one automatically covers the dropped account's remaining groups this run. Re-login or replace the dropped one afterward.
- **A whole group keeps failing for everyone** → that group may have changed its layout or is blocking; check it manually; `scripts/inspect-fb.js` can capture its current DOM if a selector drifted.

---

## 6. Reserves & takeover — how coverage works

Your **Standby** accounts (toggle in the Accounts tab) are your reserves — they don't post on their own; they step in when an active account **drops** (logout / rate-limit / checkpoint / crash) or when Facebook **holds** a post. What to know:

- **Takeover is automatic.** When an active account drops, a healthy standby that covers its groups takes over that account's posting **the same cycle** (and re-posts content Facebook held). Nothing for you to do.
- **Split coverage (new).** A drop is now covered even when **no single** standby has *all* of the dropped account's groups — multiple standbys split the groups between them. So assign your standbys groups that, **together**, cover your posters' groups; a group that **no** standby is a member of still can't be covered.
- **Smart reserve picks (new).** Among eligible standbys, the app prefers the **closest group-match** (least over-exposure), then **fewest recent rate-limit strikes**, then the most-established account — so each takeover is as low-risk as possible.

**Two Settings dials (new — Settings → Reserve):**
- **Reserve accounts held back** — hold back N healthy *posters* as extra reserves each cycle. **Set 0** to use *only* your Standby accounts as reserves (all posters post). *(This had no UI control before.)*
- **Max takeovers per reserve / cycle** — how many drops one reserve may cover. **1 (default)** = one job per account/cycle (safest). Raise to **2–5** only if drops regularly outnumber your reserves and you accept more activity per reserve.

> Rule of thumb: more **Standby** accounts (with the right groups) + more **proxies** beats raising the per-reserve job cap — coverage and de-correlation are the real levers.

---

## 7. New behaviours you'll see (this version)

A few things changed recently — worth knowing so nothing surprises you mid-run.

- **Set each account's Facebook language to English (important).** The app reads Facebook's own on-screen wording to
  spot a "temporarily blocked" / checkpoint / "pending review" wall **and to find the Post button**. It understands
  English, French, Spanish, German, Italian, Portuguese, Hungarian — and now some Arabic — but **English is the most
  complete and reliable.** An account whose Facebook is in a language the app can't fully read may fail to find the
  Post button and **post nothing**; when that happens the app flags it *"set it to English"* and a reserve covers its
  groups. So for a big run, **switch each account to English** (Facebook → Settings & privacy → Language) — it's the
  single most reliable setting for both posting and blockade-detection.
- **Blocked accounts now REST instead of hammering.** When Facebook logs an account out, checkpoints it, or disables
  it, the app **rests** it (~3h logout, 6h checkpoint, 12h disabled) and a reserve covers its groups — instead of
  re-launching it and re-submitting its login every cycle (which escalates a block toward a ban). It **rejoins on its
  own** the moment it recovers (one successful post clears the rest); fixing + re-checking it brings it back sooner.
- **A partial delivery is never silently lost (Daily Rotation / Campaign).** If an account posts today's post to
  *some* of its groups then drops, the **un-reached groups are remembered** and finished next cycle/day — by the
  account itself or a reserve — targeting **only** the missed groups (a group that already got the post is never
  re-posted). Two accounts assigned the **same** group both still post to it (that's intended amplification).
- **"Post everything first, then comment" (optional, Settings).** Posts the image+caption to **all** your groups
  first, then goes back and adds each post's comment. The time spent posting the others becomes the wait before
  commenting, and **every post lands before any comment work.** Off by default — turn it on for faster runs once your
  accounts are warm.

---

## 8. Known limits for this setup

- **Proxies: 24 posters share 5 IPs (~5 per IP).** This is the biggest correlation/ban risk and **cannot be fixed in software** — accounts on the same IP hitting the same groups look related to Facebook. The real mitigations: **more proxies** (fewer accounts per IP), and the app's built-in per-account spread (distinct viewport / screen position / timezone / isolated profile) + inter-account stagger. Set **`proxyTimezone`** *and* **`proxyLocale`** (Settings) to your proxies' region + language so each browser's clock **and** language match its IP — your machine is in Morocco (`Africa/Casablanca` / French), so on a foreign proxy these would otherwise leak. *(Every browser — posting, login, status-check, moderator, reserve — applies them; un-proxied accounts are left on the host values on purpose.)*
- **Instant speed** posts with minimal delay (you chose this for throughput over stealth). Faster = a bit more bot-like; that's the trade you accepted.
- **First post per group**: posting your first post to a new group manually (then letting the app continue) helps Facebook trust the account in that group.

---

*Quick reference:* `node scripts/readiness.js` (go/no-go) + `node scripts/hardening-check.js` (verify anti-detection: webdriver hidden, real Chrome UA, timezone/locale override) before • watch the dashboard rows + per-account logs during • read the end-of-run summary after.
