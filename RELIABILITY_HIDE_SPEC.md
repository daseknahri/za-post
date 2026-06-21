# za-post — Hide-mode + posting reliability (verified design)

> 18 adversarially-verified enhancements. Exactly-once is sacred: `publishClicked` stays at its pre-click position; no path re-clicks Post after it; slow-publish recovery is **read-only** (a feed rescan, never a re-publish). Risky proposals were dropped (see bottom).

## Implementing (high-value, safe)
- **Hide-mode H-1/H-2/H-3** — hoist `cdpSession`+`windowId` to account scope; every-3rd-group HIDDEN-only re-park if the window drifted on-screen; `reassertHidden(page)` after the verify reload to re-arm focus/hide if the CDP session died. All HIDDEN-scoped / no-ops in VISIBLE. (Plus the already-shipped `--disable-features=CalculateNativeWinOcclusion`.)
- **E-P5/E-P11** — `waitForPublish` 30s→45s; on residual `timeout`, do a **read-only** feed rescan for our caption before marking error — if found, treat as published (never re-click Post). Rescues slow-but-successful publishes (35–40s in hidden-in-use).
- **E-P7** — image upload failing after retries now throws `transient:` so the existing pre-publish retry gate re-tries it (was a silent group skip); `classifyGroupError` honors a `transient:` prefix. Safe: fires before `publishClicked`.
- **E-R7** — verify find scans top-8 (was top-3), topmost caption match wins → fewer live-posts-mislabeled-pending. Caption match still the gate (no stranger match).
- **E-P12** — re-check the post-specific pending notice once more on the reloaded feed (catches an async pending). Read-only.
- **E-R2** — track `currentPhase`; emit a report row on browser-lost so every group has a traceable outcome.
- **E-P14** — log caption commit detail (pasteOk / type count) so partial pastes are visible.

## Dropped (would risk double-post or break a mode)
- Moving `publishClicked` later; any blind composer re-open / re-click on timeout; a 3rd caption retype (mangles partial paste); gating orchestrator dealt-state on comment outcome (would re-deal → re-post).
- **E-R5 watchdog re-budget**: kept the current conservative `groupDelayMax`-based budget instead — a larger budget only fires on genuine hangs and never false-aborts a slow account ("never fail" favors the larger budget).

## Test hidden-while-in-use
hideBrowser=true, one account 8–10 groups; during the run actively type in other apps, drag windows, move the mouse, lock/unlock once. Pass: window never appears/steals focus, your typing is never interrupted, all groups reach `Confirmed LIVE` or a legit `PENDING`, no unrecovered `publish not confirmed (timeout)`.
