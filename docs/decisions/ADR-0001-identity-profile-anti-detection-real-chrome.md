# ADR-0001: Anti-detection by identity=profile with real Chrome and no fingerprint forging

- **Status:** Accepted
- **Date:** 2026-07-08
- **Deciders:** owner + engineering

## Context
The product drives many Facebook accounts from a single physical machine. Facebook links accounts primarily by provenance/account age, then IP, then behavior, and — weighted least — by browser fingerprint. An early attempt to lean on the least-weighted signal backfired: forging a fake/old user-agent through the stealth plugin left the browser internally inconsistent (a real, current Chrome build advertising an old UA). Facebook detected the mismatch and punished it with an endless captcha loop, even from the real residential IP. The lesson: a coherent real browser beats a "stealthier" but self-contradictory one, and effort spent on fingerprint forging attacks the wrong (weakest) signal.

## Decision
Run real Chrome — never a fake or spoofed browser — through the single `launchStealth` chokepoint so every launch shares one enforced policy. Hide only the automation flag (`ignoreDefaultArgs: ['--enable-automation']`, and no `--no-sandbox`). Give each account its own persistent profile (cookies/login state), its own proxy IP, timezone, and language, so isolation is real and per-account. Deliberately disable the stealth `user-agent-override` evasion so Chrome emits its own coherent UA / UA-CH / locale. Do not forge or randomize fingerprints, and do not adopt anti-detect browsers. Concurrency is capped by hardware headroom (~450 MB per browser, roughly 2× core count, bounded by keeping ~60% of RAM free).

## Alternatives considered
- **Per-account forged/randomized fingerprints via the stealth plugin** — rejected. This is exactly what caused the captcha loop; forging the least-weighted signal creates internal inconsistencies that Facebook catches.
- **Anti-detect browsers (AdsPower / GoLogin / Dolphin)** — deferred. Real recurring cost to improve only the least-weighted signal; poor return versus proxies and behavior.
- **One real device per account / cloud phones** — deferred to a ~12-month horizon. Would be a near-total rewrite of the runtime.

## Consequences
This buys strong, correct per-account isolation: separate profiles, IPs, timezones, and locales, all funneled through one auditable launch path. The hard ceiling it accepts: every account shares the one hardware fingerprint that no software can honestly change. Therefore the real levers for scale are residential proxies (moving toward one clean IP per account) and human-like behavior — not the browser layer. Invariant to protect: the stealth `user-agent-override` evasion must stay disabled, and all launches must continue to go through `launchStealth` so no code path reintroduces UA forging or a fake browser.

## References
- `lib/browser.js:22`
- `lib/browser.js:70`
- `docs/PERSONA-ROADMAP.md`
- CHANGELOG 1.0.0–1.0.1
