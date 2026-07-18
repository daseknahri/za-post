# BUILD PROMPT: za-post → complete end-to-end product

> **How to use this file.** Paste the entire section below (everything under "─── PASTE FROM HERE ───") as the opening instruction to a fresh multi-agent build session with **zero memory** of any prior work. It is self-contained: everything needed to orient, build, and verify is inside it or reachable from the repo. The companion spec is [`docs/decisions/ADR-0024-daily-batch-target-model.md`](decisions/ADR-0024-daily-batch-target-model.md) — the build prompt references it as the authoritative contract.

─── PASTE FROM HERE ───

You are finishing **za-post-restored** — a Node/Electron desktop app, currently **v1.0.138**, that automates Facebook group posting for **one operator running it on their own machine with their own real Facebook accounts.** This is **production, not a sandbox**: the fleet is live, the accounts are real and bannable, a bad run costs real assets. Build accordingly. Treat every claim below as a starting hypothesis to re-confirm against the live code — `file:line` anchors are given so you can check each in one read.

## 0. Mission (keep this in view the whole run)

Make the app a **complete, coherent product built to one simplified mental model — the DAILY BATCH** (§3), replacing the older "many cycles inside a run" framing. The engine already contains most of the machinery; your work is **consolidation, hardening, UI truth, and finishing — not a rewrite.** A rewrite of the delivery core is out of scope unless a phase says otherwise.

**THE ONE SACRED CONSTRAINT — never violate it, never weaken a guard that enforces it:**

> The app must **NEVER deliver the same `(post, group)` pair twice.** All accounts post through **one shared exit IP** (the operator's home line; proxies optional and partial). A repeated `(post, group)` reads as spam and **gets the account/IP banned.** "We only care about posts and speed," and a double-post destroys both.

Any change — target behavior, refactor, "simplification" — that *could* re-post a `(post,group)`, weaken the publish-confirm, or loosen a delivery guard is **forbidden unless you flag it explicitly, state the mitigation, and prove the mitigation with a green adversarial test.** When in doubt, preserve current behavior. **Byte-identical-when-off** is the gold standard for every new dial.

## 0.1 How to work — autonomous team mode, token-aware

Run this as an **autonomous, coordinated multi-agent team** that drives itself to completion — not a chat that stops for approval at every step. A lead orchestrator owns the phase sequence; each phase it fans out a small team, verifies, commits, and moves on. The goal is to finish the project with the **least token waste**, which means spending tokens on the risky parts and refusing to spend them re-deriving what these docs already give you.

- **Auto mode — keep going.** Work continuously, phase by phase, without waiting for human input between steps. Do **not** stop to ask "should I continue?" — continue and commit. **Stop and report to the operator ONLY when:** (a) a phase's double-post / adversarial test cannot be made green; (b) a change would need to remove the partition guard or weaken the publish-confirm and you are not certain it is safe; (c) a phase needs a product decision the docs do not settle (e.g. opting into Phase 6 pull, or deliberately re-posting the same content to the same groups). Everything else — decide with the docs and proceed.
- **Agents as a team, parallel where independent.** Per phase run, concurrently when the work does not depend on itself: a **builder** (writes the change), an **adversarial reviewer** (tries to break the double-post guard before the phase is accepted), and a **docs agent** (keeps ADR-0024 + CHANGELOG truthful). Coordinate through the lead. Pass `file:line` anchors and small diffs between agents — **never whole-file dumps** (that is the biggest silent token sink).
- **Drive the app/harness to verify — don't re-read to verify.** Confirm behavior by driving the **real app** (UI, stopped/idle — never real posting, §6) and the **`tests/helpers/ncycle.js`** harness, then observe the output. A screenshot or a harness assertion is worth more than another pass over the tree. Verification is an *observation*, not a re-exploration.
- **Spend tokens where the risk is; save them everywhere else.** This prompt + ADR-0024 already give you the module map, the posting flow, every guard, and the anchors — **do not re-derive them.** Open the cited anchor, confirm it, act. **Reuse** the existing machinery (pool, owed ledger, reserve, crash-fold, `daily-progress.json`) instead of building parallel mechanisms. Prefer the **smallest change** that meets the acceptance criteria. Keep each agent's exploration scoped to its phase — do not re-read files a prior phase already established.
- **What you must NOT cut to save tokens.** The **N-cycles-in-one-process** runs, the **adversarial double-post assertion**, and the **mutation-verify** on every guard change (§5) are non-negotiable — they protect real, bannable accounts, and a single ban costs far more than any token budget. Economize on re-derivation and re-exploration, never on the safety gates. If a token limit forces a choice, stop at a committed phase boundary and report — do not ship an unverified delivery-path change.

## 1. Orientation — the repo, with zero prior context

- **Root:** `C:/Users/user/mitol` (Windows 11, PowerShell primary; a Bash tool is available for POSIX scripts). Git repo. Work on a feature branch off `main` (last active branch was `enhancements` — confirm with `git status`/`git branch`, branch from the current tip, do not assume).
- **Stack:** Electron 35 + Node, plain browser renderer (**no bundler**), Puppeteer (`puppeteer` + `puppeteer-extra` + stealth) driving real Chrome. Package manager: npm.
- **Run the app:** `npm start` (= `electron .`); `npm run dev` dev mode; `npm run start:base` secondary profile. **The app opens real browser windows and logs in as real accounts — do NOT start real posting during development.** Drive the engine through the test harness (§5).
- **Run tests:** `npm test` (= `node --test "tests/**/*.test.js"`). ~**80 test files, ~481 passing tests**, plus `npm run test:antispam` (34 checks). Green suite is the baseline; every phase keeps it green and adds to it.
- **The files that matter:**
  - `automation/orchestrator.js` (~4725 lines) — **the crown-jewel engine.** Plan, pool, per-account rotation pointers, owed/reserve ledger, crash recovery, completion. **Documented double-post history** (v1.0.96–1.0.113 references and `[FREEZE FIX]`/tripwire comments inside). Touch with maximum care.
  - `automation/worker.js` (~4409 lines) — **browser automation.** Composer, upload, publish, **publish-confirm** (`waitForPublish` at `worker.js:1039` — the DOM-level anti-double-post), post-id capture, comment. Timing floors.
  - `lib/store.js` (~965 lines) — settings schema (`DEFAULT_SETTINGS` `:18`), clamps (`clampSettings` `:623`), single-JSON persistence, the durable journals, `daily-progress.json` (`recordProgress` `:923`). New settings + clamps live here.
  - `lib/plan.js` (~430 lines) — campaign **preview** (read-only projection of what the engine will do). Note: it re-implements the partition (`computeCampaignAgentLists` `:211`) — a duplication that must stay in sync with the engine.
  - `renderer/index.html` (~1582) + `renderer/renderer.js` (~4976) — the UI, plain browser context, **no `require`**; talks to main via `preload.js` (~130 lines, context-isolated IPC allowlist). The renderer **mirrors** some engine math (slice computation) because it cannot import it — keep the mirror in sync.
  - `main.js` (~2278) — Electron main, IPC handlers, userData location (`ZA_USERDATA_DIR`, `main.js:153`), the `Orchestrator` instance, licensing.
- **Docs & decisions (read before Phase 0):**
  - `docs/decisions/ADR-0024-daily-batch-target-model.md` — **the authoritative target model** with full `file:line` evidence. Read it first.
  - `docs/decisions/ADR-0023-batch-pool-floor-the-spread.md` — the direction this continues; Phases 1–4 shipped, 5–6 evidence-gated; corrects its own earlier claims. Read in full.
  - ADR-0019 (plan frozen within a round), ADR-0022 (owed-ledger coherence), ADR-0009 (run-to-completion engine), ADR-0006 (post-id trust anchor). Index + next-number pointer: `docs/decisions/README.md`.
  - `CHANGELOG.md` entries **1.0.131–1.0.138** — dense with hard-won findings and refuted assumptions; read all eight.
  - `INVARIANTS.md`, `CODEBASE_MAP.md`, `OPERATOR-GUIDE.md`, `BIG-TEST-RUNBOOK.md` — supporting context (read if present).
- **Live operator data (read-only, for grounding — NEVER point the dev app at it):** `D:/za-post-restored/` (relocated from `%APPDATA%`). `data.json` = live store; `run-report.jsonl` = delivery log. Use these to **measure** real topology before assuming anything. The whole method: default assumption → read the file → usually refuted.

## 2. What already exists (build on it — do not re-derive)

Confirm each against its anchor, but do not waste a phase rediscovering:

1. **The concurrent pool already IS "a row of up to N browsers, fail-and-continue."** Accounts run up to a live concurrency cap, next launched the instant a slot frees, crash-isolated so one failure never stalls the pool. Cap = `_livePoolTarget() = min(_wanted, _proxyCeil, _liveHwCeil())` (`orchestrator.js:2521-2522`), `_wanted = parallelAccounts` (`:2512`), per-IP cap `_realIpMax = min(20, realIpMaxConcurrent||3)` (`:2504`). Launch loop `:2905-2907`; per-account crash isolation `:2899, 2644`.
   - **Concurrency levers (get this right):** on one IP the effective concurrency = `min(parallelAccounts, realIpMaxConcurrent [via _proxyCeil], _liveHwCeil)`. **Both** `parallelAccounts` and `realIpMaxConcurrent` are code levers that bound and can raise on-IP concurrency (`realIpMaxConcurrent` default 3, tunable 1..20; re-enforced by the `launchNext` per-IP gate `:2891/:2898`). With defaults, `parallelAccounts` is the tighter bound only because it is the smaller number — **not** an invariant.
   - **But raising concurrency does NOT add throughput** (posts/hour): the limit is **CPU/RAM contention** (~19s/post at 1–2 concurrent → 90–164s at 6–11). The real levers are **fewer concurrent browsers**, **more distinct accounts swapped daily**, and **proxies** — never shrinking delays or weakening the publish-confirm.
2. **FULL-BATCH-DAILY (v1.0.136) already IS "one run per day."** A **UI-only preset**: the renderer writes `cyclesPerDay = postsPerCycle = maxSlice`, `loopCampaign:false`, `completionMode:true`, `scheduleMode:'daily'` (`renderer.js:4561-4592`; `store.js:152-156`). **The engine never reads the flag** — OFF is byte-identical, double-post via this route structurally impossible.
3. **DAILY AUTO-RE-ARM (v1.0.138) already rebuilds the plan for a new day's roster — only if the post library changed** (`_dailyRearmIfNeeded` `:3970`, gate `_libraryHash` `:3976`). Re-dealing the *same* posts to the same groups on a new day is cross-day spam; the gate refuses it. It mirrors the loop-reset atomicity (null pointers + rebuild + one save) so it can never leave plan-null-with-live-pointers (the v1.0.96–1.0.113 double-post shape).
4. **The campaign-plan splits the library by a STATIC partition, and that partition IS the anti-double-post guard.** `agentLists[a.name] = cPosts.filter((_, idx) => idx % Keff === rank)` (`:3929`), `Keff = min(K, max(1, campaignMinAgents, ceil(cPosts.length/globalMaxLen)))` (`:3925`). Disjoint slices → no two accounts can post the same `(post,group)`. **Campaign-plan has NO durable per-pair ledger — the partition is the whole guard.** `shuffleCampaign` seeds a per-round shuffle of the order (`:3863`).
5. **unique/sequence DO have a durable per-pair guard:** `_inflightDelivered` (a Set, fsync'd journal, crash-fold re-seed `:1958`), used **only** for unique/sequence (`:132, :1096`) — deliberately **never** for daily-rotation/campaign-plan, which legitimately re-deliver across rounds.
6. **Comment-failure breaker, reserve/standby takeover, completion engine, moderation/held rescue, crash-fold recovery, proxy support all exist and are tested.** Do not rebuild.
7. **The publish-confirm has multiple `'published'` return paths (know all of them before touching `waitForPublish`):**
   - Dialog-count-drop path (`worker.js:1067`) additionally requires our tagged composer shell gone (`ourShellGone`) — blocks a Messenger/notification popup masquerading as our composer closing.
   - Second-probe path (`worker.js:1097`) also returns `'published'` on `sig==='gone'` (inline composer, no dialog + no enabled Post button, `:1090`) or `sig==='submitted'` (a pending/"will be reviewed" notice, `:1081`) — **neither checks `ourShellGone`.**
   - Timeout ceiling is fixed at `worker.js:1041`; `fast` mode changes only poll cadence, never the ceiling (`:1098`). Timeout paths only ever **confirm** (create-story id `:3635`, feed rescan `:3663-3688`), never re-click.

**The single most important consequence:** because the partition is the only campaign-plan guard, **any move to a shared pool where "any account can take any post" REMOVES that guard and re-introduces the double-post risk.** That is ADR-0023 Phase 5/6 and it is **evidence-gated** — it requires a durable pair-ledger (fsync'd, behind its own persisted `_batchEpoch`) proven in **shadow** first. Do not build pull-dispatch without the ledger, and build neither unless a phase below and the operator explicitly green-light it.

## 3. The target model (build everything to this)

A **BATCH** = `{ a fixed-ORDER list of posts, a set of accounts, a set of groups }`.

- **ONE RUN PER DAY.** No "many cycles inside a run." One daily run = the ordered list split across the accounts. Remove the multi-cycle concept from the operator's mental model and the UI language; the engine's internal cycle machinery may remain as an implementation detail **only** where collapsing it is riskier than keeping it (justify every such case — ledger + dashboard key off `cycle`/`round` tags).
- **STABLE ORDER.** The list stays in the **same order for the entire campaign** — the operator's control over what goes out. (Today `shuffleCampaign` reshuffles per round — freeze it to once at start.)
- **RANDOM DAILY SPLIT.** Each day the ordered list is split across that day's accounts, accounts assigned to their share **randomly each day**, while keeping the **disjoint-slice** guarantee that prevents double-posts. Today the split is a static `idx % Keff === rank` partition; the target is a **day-seeded randomized** assignment (reproducible within a day so a restart re-derives it).
- **ROW EXECUTION.** Accounts execute **in a row, up to N browsers**, next launched the instant a slot frees. (Already the pool.)
- **FAIL-AND-CONTINUE, NEVER STALL.** On failure (comment-limit / post-limit / logged-out / needs-verification): **close it and continue immediately**, keep the speed, **save what happened and the state.** A failed account never blocks the row.
- **PER-POST DASHBOARD ROW.** The dashboard shows **THE ROW**: a simple per-post list — for each post, *which account*, status (**delivered / failed / pending**), and the failure state. Simplicity is the feature.

The precise, evidence-anchored version — exactly which pieces already satisfy this and which need work — is **`docs/decisions/ADR-0024-daily-batch-target-model.md`.** Treat that spec as the contract; treat this section as its summary.

## 4. Build sequence (phases, gated, committed one at a time)

Work **long and phase by phase.** Use **subagents/workflows**: a builder agent per phase, an **adversarial reviewer** agent that tries to break the double-post guard before you accept the phase, and a **docs agent** that keeps ADR-0024 + CHANGELOG truthful. **Verify each phase before starting the next. Commit per phase** with a CHANGELOG entry (finding, fix, mitigation, test count) and a version bump. **Never ship a phase whose double-post test is red.**

Every phase follows the §5 discipline: re-read the anchors → make the smallest change satisfying acceptance → add/extend tests incl. an **N-cycles-in-one-process** run and an **adversarial double-post** assertion → **mutation-verify** the guard (revert it, confirm exactly the new test fails, restore) → full `npm test` → drive the real flow through the harness → commit.

### Phase 0 — Ground truth + the spec (no engine change)
- Read ADR-0023, ADR-0019, ADR-0022, CHANGELOG 1.0.131–1.0.138; confirm `ADR-0024`.
- Read `D:/za-post-restored/data.json` + `run-report.jsonl` (read-only) to measure the **real** topology — roster size, groups/account, clusters, library size, `speedMode`, `parallelAccounts`, `realIpMaxConcurrent`, caps. Write the measured numbers into ADR-0024 so every later phase reasons from live data, not defaults.
- **Acceptance:** ADR-0024 exists, is reviewed, every claim carries a `file:line` or a data-file measurement. Full suite green (baseline).

### Phase 1 — Per-post dashboard ROW (UI truth; no delivery-path change)
- Build `buildBatchRow` in `lib/plan.js` (a projection over `daily-progress.json`, which it already reads at `plan.js:326-345`) + `renderer/index.html`/`renderer.js`: a per-post list `{ post, assigned account, status ∈ delivered|failed|pending, failure-state }` for the current day's batch, in **frozen library order**. Source from the engine's real delivered-set/owed/outcome + `run-report.jsonl`. **Do NOT invent a parallel state store.**
- Remove multi-cycle language from the UI; speak "one daily run, split across accounts."
- **Known trap:** the dashboard has historically **lied** — a benched/idle account read as "DONE" (v1.0.131–1.0.132 fixed two surfaces; verify no third remains). A **failed** account must read failed with its reason, never done. Until the durable ledger (Phase 5), show "error today," not a durable terminal "failed."
- **Acceptance:** on the harness, a run with an injected mid-batch account failure shows that account's posts `failed` (with state) and the rest `delivered`/`pending` correctly — never a false "done." Suite green + new projection/UI tests.

### Phase 2 — Random daily split (preserve the disjoint-slice guard)
- Replace the static `idx % Keff === rank` assignment with a **per-day randomized** account→slice assignment, seeded by the **local day-key + batchId** so it is deterministic within a day (reproducible, testable) and varies day to day. **Slices must stay pairwise-disjoint and cover the library exactly once** — randomizing *which account gets which slice* must never create overlap or gaps. Reuse/extend the existing `shuffleCampaign` seeding rather than adding a second shuffle source. Freeze the post ORDER to once-at-start (do not reshuffle order per round).
- **CRITICAL SAFETY:** the re-seed must happen **only at a round/day boundary that atomically nulls the per-account pointers and rebuilds the plan** — mirror `_dailyRearmIfNeeded`'s atomicity (`orchestrator.js:3984-3991`). A **within-round** re-randomization with live pointers = double-post (a re-seed handing a delivered post to an account with overlapping groups). Reject within-round re-seeding outright.
- **Acceptance (double-post-critical):** N-cycles-in-one-process over the live topology (real cluster shape, P≈30) across multiple simulated days → **every `(post,group)` delivered exactly once per round, 0 duplicates, 0 gaps, every day**, with assignments demonstrably differing across days. **Mutation-verify:** break disjointness deliberately and confirm the double-post test catches it. **Do not ship if red.**

### Phase 3 — Consolidate "one run per day" as the real default path
- Make full-batch-daily + daily auto-re-arm the coherent, default, well-lit path; ensure the preset, the re-arm, and the dashboard row tell **one** story. **Keep the engine unaware of the preset flag** (the safety property from v1.0.136). **Do NOT delete the cycle plumbing.**
- Verify the daily re-arm gate end-to-end: same library on a new day → refuses (logs "add posts"); changed library → rebuilds for today's roster, atomically. This is the anti-cross-day-spam guard — it must not regress.
- **Acceptance:** harness proves (a) same-library next day re-delivers **nothing**; (b) new-content next day rebuilds and each account delivers its new share once, 0 dupes; (c) a swapped-in account gets a slice, a removed one is dropped; (d) the atomic save never yields plan-null-with-live-pointers. Suite green + preset resolution tests (`loopCampaign=false, completionMode=true, cyclesPerDay=postsPerCycle=maxSlice`).

### Phase 4 — Fail-and-continue hardening + state completeness
- Audit every failure class (comment-limit, post-limit, logged-out, needs-verification, transient/crash); confirm each closes the browser, continues the row immediately, and **records a durable, dashboard-visible final state** for every affected post. Close any gap where a failure leaves a post ambiguous/invisible. Reuse the comment breaker, reserve takeover, owed ledger, crash-fold — **no parallel mechanism.**
- Confirm the comment-failure breaker only suppresses **commenting** and never aborts the **post**; the post records `delivered` with a comment-lost note.
- **Acceptance:** harness injects each failure class mid-row; the row never stalls, every post ends in a definite state (delivered / failed-with-reason / pending-then-covered-by-reserve), no failure path re-posts a delivered pair. Suite green + one test per failure class.

### Phase 5 — Durable pair-ledger in SHADOW (evidence-gated; ADR-0023 Phase 5)
- **Only if** the operator wants to move toward a shared pool. Build a durable per-`(post,group)` ledger for campaign-plan — modeled on `_inflightDelivered` (fsync per delivery, reconstructed on start) — behind its **own persisted `_batchEpoch`** (NOT `_roundOffset`: two writers + disk reset would let a unique account exhausting its library purge the campaign ledger → full-library re-burst). Run in **shadow**: records and would-block, but the partition still governs delivery. Prove it agrees with the partition on the live topology before it ever governs anything.
- **Acceptance:** N-cycles + crash-injection show the shadow ledger would have blocked **zero** legitimate re-deliveries and **every** illegitimate one; the partition remains the sole live guard; an unknown/garbage epoch never widens the delivered set. Suite green. **Do not let the ledger govern delivery in this phase.**

### Phase 6 — Pull-dispatch behind `postingOrder:'batch'` (evidence-gated; ADR-0023 Phase 6)
- **Only after** Phase 5's ledger has proven itself, opt-in, one batch at a time: let any account pull any un-delivered post, with the durable ledger — promoted from shadow to authoritative — as the guard that replaces the partition. This is the one place the partition guard is removed; the ledger must be proven first, and every publish must be **ledger-write-then-publish-confirm** ordered to keep the crash window at the irreducible ~1% strand (never a double-post).
- **Acceptance:** adversarial N-cycles with aggressive mid-publish crashes across many rounds → **0 double-posts, ever.** Mutation-verify the ledger is load-bearing (disable it → the double-post test goes red). Ships default-OFF, byte-identical when off. **If the double-post test is not rock-green, this phase does not ship — and that is an acceptable ADR-0023-sanctioned outcome.**

## 5. Test discipline (non-negotiable — this is how the double-post bugs get caught)

- **N-cycles-in-ONE-process is mandatory for any delivery-path change.** Use `tests/helpers/ncycle.js` — it drives N real `_loop` cycles through **one** Orchestrator, one real store on a temp dir, real planner/pointer/owed/reserve machinery, only the worker and clock faked. **Do NOT model "the next cycle" as a new Orchestrator or a fresh `start()`** — the crash-fold reconciles durable state on every process start (`orchestrator.js:1943`), so a "new process per cycle" test hands the engine a clean slate it never gets in production and *reconstructs the exact stale-state bug away before the assertion runs.* A fully green suite has repeatedly coexisted with live recurring double-posts precisely because of this. Cycle 2+ in the same process is the only place these bugs are observable.
- **Adversarial double-post assertion on every delivery phase.** Follow `tests/orchestrator-ncycle-campaign.test.js` and `tests/orchestrator-ncycle-unique-batch.test.js`: collect every delivered `(post,group)` pair, assert `duplicatePairsWithinRound(pairs) === []`. Inject mid-post crashes, roster swaps, benched accounts, multi-day rollovers. The assertion is **two-sided**: (a) no `(post,group)` twice (the ban invariant), AND (b) no legitimately-owed pair false-skipped (starvation is the mirror failure).
- **Mutation-verify every guard.** After a guard change, revert the guard and confirm **exactly** the new test (and only it) fails; then restore. A guard whose test still passes when it's removed is not testing the guard. (v1.0.134/1.0.135 shipped tests that passed while the real code was broken because they re-implemented the logic inline — do not do that; drive the **real** code through a temp store.)
- **Round-trip through DISK, not memory.** The v1.0.133 regression shipped because a rotation-state save was copy-pasted at six sites and five dropped a field, while every test asserted the in-memory value. Assert persisted state.
- **Epoch-isolation tests (Phase 5+):** `_batchEpoch` must be a private persisted counter with exactly one writer; assert a unique/sequence recycle or a campaign reloop cannot reset it.
- Keep `npm test` fully green at every commit; run `npm run test:antispam` too. **Add tests; never delete or weaken one to make a change pass.** A passing suite is necessary but **not sufficient** (see the N-cycles rule).

## 6. Do-Not list (violations are release-blocking)

- **Do NOT** create any path that can deliver a `(post,group)` twice. If a change even *could*, flag it, mitigate, and prove it with a green adversarial test — or don't ship it.
- **Do NOT** weaken or bypass the worker's publish-confirm / post-id trust anchor (ADR-0006); understand all `'published'` return paths (§2 item 7) before touching `waitForPublish`; do not shorten timing to "go faster" (contention is the bottleneck, not delays).
- **Do NOT** give campaign-plan a durable delivered-guard that suppresses legitimate cross-round re-delivery, and do NOT use `_inflightDelivered` for anything but unique/sequence.
- **Do NOT** re-seed the daily assignment mid-round with live pointers — re-seed only at the atomic re-arm boundary (`orchestrator.js:3984-3991`).
- **Do NOT** build pull-dispatch / shared-any-account-any-post without the durable ledger proven in shadow first (Phases 5→6 order is a safety ordering, not a preference).
- **Do NOT** make the engine read `fullBatchDaily` — it is a UI preset by design (that is what makes OFF byte-identical).
- **Do NOT** re-deal the same library to the same groups on a new day (the `_libraryHash` gate at `:3976` exists to stop exactly this); do not "fix" it before Phase 5.
- **Do NOT** delete the cycle/round plumbing (ledger + dashboard key off `cycle`/`round`: `:1101`, `plan.js:333`) — "remove many-cycles" is presentation only.
- **Do NOT** delete `_campaignStandins`/`_owedStandins`/`_splitCover`/`_owed` or the exact-`gids` cover routing (`:2549-2555`) — shipped scars; retire only behind a 30-day-live gate after Phase 6.
- **Do NOT** use `_roundOffset` as the ledger epoch, or change the `batchId` fingerprint formula (`:3950`) — both cause a full-library re-burst.
- **Do NOT** point the dev app at `D:/za-post-restored/` or start real posting to develop/verify — use the harness; read live data read-only.
- **Do NOT** ship a dashboard that can show a failed or benched account as "done."
- **Do NOT** force-kill the app to "reset" during testing — an unclean kill before the fsync is itself a documented re-post route; stop via the app's Stop path.
- **Do NOT** land a large or risky refactor without stating the plan, the trade-off, and getting sign-off first. Prefer the smallest change that meets the acceptance criteria.

## 7. Cadence & verification

Work the phases in order, one commit per phase, each with: a CHANGELOG entry (finding, fix, mitigation, test count), a version bump, an ADR-0024 update if the model was refined, and the mutation-verify result recorded. For each phase report exactly: the anchors you touched, the tests you added, the mutation-verify result, the full-suite result, the CHANGELOG/version bump. Do not claim "fixed" without the green adversarial test as evidence. Anchor every current-state claim to `file:line` before acting — anchors may have drifted a few lines. Measure real topology from the live data files before assuming counts/caps/timings. Drive delivery changes through `tests/helpers/ncycle.js`. After a UI change, load the app locally (stopped/idle or the plan projection — never real posting) to confirm the row and settings reflect the engine's real state.

Treat the operator's real fleet as production the entire time. **If a phase's double-post test cannot be made green, stop and report** — not shipping is the correct, ADR-0023-sanctioned outcome, far better than a ban.

Begin with Phase 0.

─── END PASTE ───
