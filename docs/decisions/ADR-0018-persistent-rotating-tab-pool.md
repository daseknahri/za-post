# ADR-0018: Persistent rotating tab pool for multi-tab posting (reuse tabs by re-navigation instead of newPage/close churn)

- **Status:** Accepted (implemented in v1.0.13)
- **Date:** 2026-07-08
- **Deciders:** owner + engineering

## Context
The posting pipeline handles multi-tab behavior in two different ways depending on `tabsPerBrowser`. With `tabsPerBrowser=1` a single tab is reused, navigating group -> group with no churn, but strictly serially. With `tabsPerBrowser>=2` the current prefetch pipeline (`_prefetchGroup`) opens a NEW tab per group via `browser.newPage()`, then adopts it and closes the old one to hide page-load latency behind the previous group's work.

That prefetch speed win comes at a cost: it churns a tab per group. Each new page resets in-tab history and referrer continuity, so every group arrival looks like a fresh, context-free page load. Worse, the constant open/close of Facebook tabs is itself a recognizable automation tell — a real user does not cycle through a new tab for every group they post to.

## Decision
Maintain a PERSISTENT pool of `tabsPerBrowser` hardened tabs. Open and harden each tab ONCE, then ROTATE across them by re-navigation (reuse) instead of `newPage`/close per group. Tabs are closed only at account end. To bound Facebook SPA memory creep, add an occasional recycle of a pool tab (~every 10-15 navigations).

This keeps the prefetch speed win (a second tab can still pre-load the next group while the active tab posts) while gaining history/referrer continuity within each tab and a stable, small tab count for the account's lifetime.

## Alternatives considered
- **(a) Status-quo per-group churn** — rejected. It loses history/referrer continuity and presents a churning-tab pattern that reads as automation.
- **(b) One tab per group, all kept open (e.g. 40 tabs)** — rejected. At 400 accounts this is a memory blowup, and 40 simultaneous open Facebook tabs is itself an automation tell.

## Consequences
On every tab switch we must rebind the CDP session, `hiddenWindowId`, and focus-emulation to the now-active tab. The adopt path already performed exactly this rebinding, so the implementation keeps that logic and drops only the `_old.close()` call; the occasional recycle is added on top to release SPA memory. Double-post traps are keyed by `(post, group)`, so pool reuse cannot weaken them. The cost is a modest, bounded increase in resident memory per browser.

## Implementation (v1.0.13)

The prefetch pipeline was converted to a bounded pool (`_pool = { free, live, activeNavs, epoch }`) shared by both the Phase-1 posting pass and the Phase-2 two-phase comment pass:

- `_acquireTab` takes an idle tab from `_pool.free` (recycling any whose `navs >= _RECYCLE_EVERY` = 12), else grows the pool up to `tabsPerBrowser`, else returns `null` (the group then navigates on the active tab — graceful, never blocks).
- On adopt, the just-finished active tab is `_releaseTab`'d back to `_pool.free` (reused, not closed); the pre-loaded tab becomes `page`.
- `_hardenTab` was split so `_bindCdp` can re-bind a CDP session to an adopted tab if its original harden failed — so `cdpSession`/`hiddenWindowId` **always** track the active tab (never the just-released one).
- A phase `epoch` guards a late `_dropPrefetch` release from leaking a stale-phase tab into the next pool.

Cleared by a 5-dimension adversarial verify (double-post, double-comment, tab-accounting, CDP-rebind, async-races) — **no sacred-invariant violation**; two non-blocker defects it surfaced (the CDP-null adopt drift and the cross-phase drop leak) were fixed. With `tabsPerBrowser=1` the pool is never grown or rotated (byte-identical to before).

## References
- `automation/worker.js` — `_pool` / `_makeTab` / `_acquireTab` / `_releaseTab` / `_bindCdp` (pool infra)
- `automation/worker.js` — Phase-1 adopt block (comment `ROTATE (ADR-0018)`) and the `_cpf` Phase-2 mirror
- `CHANGELOG.md` 1.0.13
- proposed + accepted 2026-07-08
