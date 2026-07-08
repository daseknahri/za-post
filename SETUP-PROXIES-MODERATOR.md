============================================================
  Za Post — Proxies & Moderator setup
============================================================

This covers two things that make multi-account posting safe and reliable:
  1) a dedicated PROXY (own IP) per account, and
  2) a MODERATOR (admin) account that approves posts Facebook holds for review.

────────────────────────────────────────────────────────────
1. PROXIES — one IP per account
────────────────────────────────────────────────────────────

WHY
  Facebook links accounts that share or hop IP addresses. The safest setup is
  ONE stable proxy (one IP) per account — including the moderator account. This
  lets all your accounts run in parallel without looking related.

WHAT TO BUY
  • One proxy per account (so 10 accounts = 10 proxies/IPs).
  • Sticky / residential or mobile proxies are best (stable IP, high trust).
  • Supported types: HTTP, HTTPS, SOCKS4, SOCKS5.

THE FORMAT (type it exactly like this)
  scheme://ip:port                      e.g.  socks5://1.2.3.4:1080
  scheme://ip:port:user:pass            e.g.  socks5://1.2.3.4:1080:john:secret
  scheme://user:pass@ip:port            e.g.  http://john:secret@1.2.3.4:8080

HOW TO ASSIGN (recommended: per account)
  • Accounts tab → open an account → "🌐 Account Proxy" → paste the proxy.
  • The app shows "✓ format OK" or a red "⚠ invalid format" hint right away.
  • Once a run has happened, a small health chip appears: ● healthy / ⚠ cooling / ✗ failing.
  • Bulk: select several accounts → "🌐 Proxy" in the action bar → paste one proxy
    for all of them (only do this if they should share — usually they shouldn't).

GLOBAL POOL (optional alternative)
  • Proxies tab → add a list of proxies + tick "Enable Proxy Pool".
  • Accounts WITHOUT their own proxy then get one from the pool (stable per account).
  • A per-account proxy always wins over the pool.

IMPORTANT — fail-closed
  • If you ENABLE proxies but an account has NO proxy (and the pool is empty),
    that account is SKIPPED — it will NOT post from your real IP. Assign it a
    proxy, or turn the global toggle off if you want that account on bare IP.
  • A malformed proxy also skips the account (so it never leaks your real IP).

────────────────────────────────────────────────────────────
2. MODERATOR — approve held posts
────────────────────────────────────────────────────────────

WHY
  Facebook holds posts from low-trust accounts in the group's "Spam potentiel" /
  "Publications en attente" (pending approval) queue. A MODERATOR account that is
  an ADMIN of the group can approve them, so the post goes live and its comment
  lands. Works in French and English.

WHAT YOU PROVIDE
  • An ADMIN/moderator account in EACH group you post to (it must be a real group
    admin to see "Outils du modérateur"). One admin can cover many groups.
  • A dedicated PROXY for that moderator account too (its own IP) — set it the
    same way as any account (Accounts tab → Account Proxy).
  • The moderator account must be LOGGED IN (Accounts tab → Login).

HOW TO SET IT UP
  1. Accounts tab → open the admin account → turn ON the "Moderator" toggle.
     (A moderator never posts; it only approves. It's excluded from the posting fleet.)
  2. Give it its own proxy (above) and log it in.
  3. Settings → enable "Moderator approval" (moderationEnabled).
  4. FIRST TIME: also enable "Dry run" (moderationDryRun) and Start a run. Watch the
     log: you should see "🛡️ [moderator] … queue WITH our post …" and "WOULD APPROVE".
     That confirms it finds the French/English Approve buttons. Then turn Dry run OFF
     for real approvals.

WHAT IT DOES (per cycle)
  • Detects a held post → opens the moderator's browser (its own IP) → navigates the
    Spam-potentiel / Publications-en-attente queue → finds the card whose AUTHOR is
    one of YOUR accounts AND whose caption matches → clicks Approuver/Approve →
    confirms it left the queue → your post goes live and its link-comment is placed.
  • It only ever approves YOUR posts (author + caption matched), never anything else.

TIPS
  • The real fix for holds is account TRUST: dedicated proxies + warm-up + human
    pacing. The moderator is the safety net, not a substitute for trusted accounts.
  • If you turn OFF "hide browser" (Settings), the moderator window is visible so you
    can watch it approve.

============================================================
