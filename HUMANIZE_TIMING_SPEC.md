# za-post — Posting humanization, timing & reliability overhaul

> From a 39-agent analysis (18 changes adversarially verified safe). Goal: posting works ~100% and its cadence is UNPREDICTABLE (every gap a random value in a range), with the timing/browsing knobs operator-configurable.

## 0. Principles
- **No constant human-facing delay** — every settle/dwell/pre-publish/inter-group/inter-cycle gap is a random draw from a range.
- **Ranges are operator-configurable** (min/max pairs in Settings); micro-delays stay internal but jittered.
- **Randomization never shortens below a safe floor** (spam floor preserved).
- **Reliability fixes never double-post or corrupt text** — all reliability work is pre-publish-click or read-only; the `publishClicked` guard and permalink-before-wait flow are untouched.

## 1. New / changed settings (backward-compatible via normalize migration: old single key → min=floor(0.8·old), max=ceil(1.2·old))
| key | default | clamp |
|---|---|---|
| `waitIntervalMin` / `waitIntervalMax` (min) | 90 / 180 | 0–1440 (replaces `waitInterval`) |
| `accountDelayMin` / `accountDelayMax` (min) | 1 / 4 | 0–1440 (replaces `accountDelay`) |
| `groupDelayMin` / `groupDelayMax` (s) | 120 / 300 | 0–3600 (replaces `groupDelay`) |
| `commentDelayMin` / `commentDelayMax` (s) | 60 / 180 (existing) | 0–86400 |
| `pageScrollDwellSecMin` / `Max` (s) | 3 / 15 | 0–600 (feed browsing dwell; 0/0 skips) |
| `commentDwellSecMin` / `Max` (s) | 1 / 4 | 0–300 |
| `prePublishDwellSecMin` / `Max` (s) | 3 / 8 | 0–60 |
| `composerOpenInitialDelayMs` | 1500 | 800–3000 |
| `humanizeMaster` (bool) | true | gates jitter/stagger/dwell (NOT the comment-delay window) |
| `timingVariance` {interact:.4,settle:.35,pause:.3,wait:.25} | — | each 0–0.6 |

## 2. Timing randomization — helpers + T1–T17
Helpers (worker.js by `jitter`, mirrored in orchestrator.js): `rand(min,max)`, `rangeMs(settings,minKey,maxKey,defMin,defMax,floorSec)`, `humanDelay(base,settings,variant)` (honors humanizeMaster; off → exact base).
- **T1** pre-publish re-read → `rangeMs(prePublishDwell*,3,8)`
- **T2** inter-group → `rangeMs(groupDelay*,120,300)` (floor ≥120s)
- **T3** inter-cycle → `rangeMs(waitInterval*,90,180)·60000`
- **T4** account stagger → `rand(accountDelay*)·60000` capped, jittered
- **T5** feed dwell → `pageScrollDwell*` range
- **T6–T11, T17** micro settles/pauses (`sleep(400/600/1500/2000/500/...)`) → `humanDelay(base,settings,variant)`
- **T12** keystroke timing → keep (already strongest), gate the 10% "thinking" bonus on humanizeMaster
- **T13–T16** orchestrator internal sleeps → jittered
- **Watchdog:** `_gd` budget uses `groupDelayMax` (not legacy `groupDelay`) so a max-end draw never trips it.

## 3. Reliability (R1–R4) — all pre-publish / read-only
- **R1** blur+Escape a focused search/"type ahead" overlay before opening the composer (the `Exit typeahead` we saw).
- **R2** scroll-to-top + dismissPopups BEFORE the attempt loop; attempt-1 settle = `composerOpenInitialDelayMs`.
- **R3** on composer-open failure, log a read-only readiness probe (article count, focused tag, composer-text matches) instead of blaming "selector drift".
- **R4** composer-open `waitForSelector` timeout scales: attempt 1 = 6s, retries = 9s.

## 4. Human behavior (H1–H3) — conservative, never touches caption/comment text
- **H1** 40% chance: brief re-read pause + micro-scroll before typing the comment.
- **H2** click at center ±(5–15%) within the element bounds; raise mouse jitter ±3→±8px.
- **H3** hover-before-click on composer-open + focusEditable (already in clickPostButton).

## 5. Build order
1. Settings schema + helpers (no behavior change) + tests. 2. Timing randomization (T1–T17). 3. Reliability (R1–R4). 4. Human behavior (H1–H3). `npm test` green at each step; watch live log for varied per-group/per-cycle waits and a higher attempt-1 composer-open rate.

## 6. Key risks
Spam-floor breach (clamp + floor + a 1000-draw test) · migration breakage (round-trip test, keep legacy keys) · double-post/text corruption (all changes pre-publish/read-only) · watchdog false-abort (use groupDelayMax) · slowdown (~1–2s/group, <1% of cycle).
