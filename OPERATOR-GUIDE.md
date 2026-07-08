# Za Post — Operator Guide

How to run posting campaigns with the app. This is the practical, day-to-day guide; `DOCS.md` is the
developer/architecture reference.

---

## What it does

Posts your content to Facebook **groups** from **multiple accounts**, and (optionally) drops the first
**comment** (usually your link) on each post — automatically, on a human-like schedule, unattended.

---

## 1. One-time setup

1. Launch the app. It opens to the **Dashboard**.
2. If this laptop will run 24/7 and you manage it over **Remote Desktop**, do the RDP setup once — see
   **`SETUP-RDP.md`** (or click **Open setup folder** on the reminder banner that appears when you connect over
   RDP). Without it, a run can stall the first time you disconnect.

---

## 2. Add accounts (Accounts tab)

1. **Add account** → give it a name (and optional alias).
2. **Login** → a real browser opens; sign in to Facebook. The session is saved to that account's profile.
   (Or **Cookies** → paste a Cookie-Editor JSON export.)
3. **Check status** → a healthy account shows **Logged In** (green). Re-login if it shows *Not Logged In* /
   *Needs verification*.
4. **Proxy** (recommended): one stable proxy per account — `scheme://ip:port[:user:pass]`. Leave blank to use
   your own IP / the global pool.
5. **FB display name**: how the account appears as a post author. Auto-captured at login; set it manually only
   if moderator approval can't match the account's posts.

Each account has two quick toggles next to its name:

- **On / Off** — Off = disabled, skipped entirely (you can re-enable any time).
- **Primary / 🟡 Standby** — see §7.

---

## 3. Add groups (Groups tab)

Add each target group (its Facebook group URL / ID). You must be a **member** of a group to post in it.

---

## 4. Add posts (Posts tab)

Each post = a **caption** (optional image) + an optional **first comment** (your link, optional comment image).

- The caption is **pasted** into the composer (fast, exactly like a person copying their content), then
  verified — it won't be re-typed if the paste landed.
- Spintax `{a|b|c}` in captions/comments is expanded per post (Vary Content) so every post differs.

---

## 5. Assign groups to accounts

On each account card, **Select Groups** → tick the groups that account should post to. (Or use **Assign
groups to a batch of agents** to give several accounts the *same* groups — that makes them a Campaign Plan
team, see §6.)

---

## 6. Choose how it posts (Posting Method, per account)

| Method | What it does | Use when |
|---|---|---|
| **Post to All Groups** | Posts every eligible post to all its groups each cycle | Blanket many groups from each account |
| **Random (Shuffle)** | Same, shuffled order | Same as above, less patterned |
| **One Post Per Account (Unique)** | Exactly one post/cycle, each post used once across all accounts | Spread a library across accounts, no repeats |
| **Random (No Repeat)** | Unique, shuffled deal order | Same, less patterned |
| **Progressive (Sequential)** | One post/cycle in order, rotating across accounts | Ordered drip |
| **📅 Daily Rotation** | This account posts **1 new post/day** to its groups, advancing on its own | "Each account posts one post a day to its groups; next day the next post" |
| **🗓️ Campaign Plan** | Accounts sharing the same groups **split the whole library**, 1/account/day | A *team* covering one group-set fast (e.g. 9 posts ÷ 3 accounts = 3-day batch) |

**Recommended "1 post/day per account" setup** (the classic workflow):
- Set each account's method to **Daily Rotation**.
- Settings → **Schedule** = *Daily*, set the daily time.
- Add more accounts (each with its own groups) → they run in parallel for scale.

---

## 7. Standby (backup) accounts

Mark an extra account **🟡 Standby** (toggle next to its name) to keep it in reserve for **its assigned
groups**. A Standby account **never posts in a normal cycle** — it steps in automatically **only when needed**:

- a working account in its group **drops** (rate-limited / logged out / blocked) → it delivers that post;
- a post stays **held** in Spam-potentiel and can't be approved → it re-posts (if Re-post is on);
- a post went live but its **comment** couldn't be placed → it places the comment.

So: assign a group's primary posters, then add extra accounts to the same groups and flip them to Standby —
they wait in the wings and take over on demand. (You still need at least one **Primary** account to Start.)

---

## 8. Speed (Settings → Posting speed)

One click sets all the timing ranges:

- **🐢 Slow** — safest / most human. **⚖️ Normal** — balanced. **⚡ Fast** — quickest still-safe.
- **⚡⚡ Turbo (power user)** — extremely fast (instant typing, minimal gaps). Higher spam risk — use only with
  **warmed accounts on dedicated proxies**.

Every gap is randomized within its range, so the cadence is never robotic. You can fine-tune any number after
picking a preset.

---

## 9. Moderation & held posts (if you admin the groups)

- If a group holds new posts for review, designate a **moderator account** (Groups tab) and enable
  **Settings → Moderation** — it approves your held posts so post + comment go live.
- **Settings → Re-post held**: if a post stays held and can't be approved, a healthy reserve/Standby account
  re-posts it to that group so it still goes live (a live-feed check first avoids duplicates).
- Best fix is fewer holds at the source: **warmed accounts + stable proxies**.

---

## 10. Run it

- **Start** — needs at least one account that is enabled, **Primary** (not Standby), logged in, with ≥1 group.
- **Pause / Resume** — holds at the next safe point (never mid-publish).
- **Stop** — ends after the current safe boundary.
- Watch the **live log**; expand per-account logs to see each account's activity. A run summary is emitted at
  the end (including which accounts went bad and should be replaced).
- **Completion mode** (Settings): for finite campaigns, keep self-healing until *every* post is published and
  *every* comment placed / held post approved, then auto-stop + report.

Account **status** colors: green = Logged In; amber = Rate-limited (waits, retries itself) / Checking;
red = Error / Not Logged In / Needs verification (open that account and fix it).

---

## 11. Running unattended on a home laptop (over RDP)

Install on a laptop that stays on, run the **`SETUP-RDP.md`** setup once, then: Start a run and disconnect —
it keeps going. Reconnect any time to add posts or Stop/Start. The app blocks sleep while running and
auto-resumes after a reboot.

---

## 12. Troubleshooting

| Symptom | Do this |
|---|---|
| Account **Not Logged In** | Accounts → Login → sign in → Check status |
| **Needs verification** (🔐) | Open that account, complete Facebook's check, then Start again |
| **Rate-limited** | Nothing — it cools down and retries automatically; lower the speed if frequent |
| Posts keep getting **held** | Warm the accounts, use stable proxies, add a moderator / enable Re-post |
| Run **stalls after I disconnect RDP** | You skipped `SETUP-RDP.md` — run it once as admin |
| "Only Standby accounts are ready" on Start | Toggle at least one account to **Primary** |

---

## 13. Staying under the radar

- Warm new accounts; one stable proxy each.
- Don't run Turbo on cold accounts.
- Keep the link in the **first comment**, not the post body (already the default).
- Fewer groups per account per day is safer; use **Daily Cap** (Settings) for young accounts.
