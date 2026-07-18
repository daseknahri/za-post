# ADR-0024: The simplified daily-batch posting model

- **Status:** Proposed (target model). Supersedes the *operator-facing framing* of ADR-0019 (frozen round) and ADR-0023 (batch/pool phases) without contradicting their engine invariants. Extends ADR-0023's evidence-gated Phases 5–6.
- **Date:** 2026-07-18
- **App version at authoring:** v1.0.138, branch `enhancements`
- **Next ADR number after this:** 0025 (update `docs/decisions/README.md`)

Every current-state claim in this ADR is anchored to `file:line` verified against the live tree. The next session must re-read the cited block before changing it — line numbers may drift by a few. The single sacred invariant threaded through everything:

> **No `(post, group)` pair may be published twice per campaign round, and the publish-confirm must never be weakened.** All accounts post through one shared exit IP (the operator's home line; proxies are optional and partial). A repeated `(post, group)` reads as spam and gets the account/IP banned. A double-post destroys both of the only two things the operator values — posts and speed.

---

## 1. Context — the operator vision

The operator runs this Electron app on their own machine, posting to Facebook groups with their own real, bannable accounts. Over a long refinement session they converged on one simplified mental model, replacing the app's older "many cycles inside a run" framing:

> A **BATCH** = `{ a fixed-ORDER list of posts, a set of accounts, a set of groups }`. **ONE RUN PER DAY.** Each day the post list — kept in the **same order the entire campaign** — is **split across the accounts**, with accounts assigned to their share **randomly each day**. Accounts execute **in a row**, up to N available browsers, one after another. If an account **fails** (comment-limit / post-limit / logged-out / needs-verification): **close it and continue immediately** — never stall, keep the speed; **save what happened + the state** so the final state of every post is known. "We only care about posts and speed." The dashboard shows **THE ROW**: a simple per-post list — which account, delivered/failed/pending, state. **Remove the "many cycles inside a run" concept** — one daily run = the list split on the accounts.

The key realization for this ADR: **most of that engine already exists.** The concurrent pool is already the row of N browsers with fail-and-continue; FULL-BATCH-DAILY (v1.0.136) is already one-run-per-day; DAILY AUTO-RE-ARM (v1.0.138) already re-deals for a new day's roster. What is genuinely missing is (a) a **flat per-post dashboard row**, (b) a **per-day randomized** account→slice assignment, and — only if the operator wants a true any-account-any-post pull pool — (c) a **durable per-`(post,group)` ledger**, which is the keystone that everything dangerous funnels through.

---

## 2. Decision

Build the whole product to the daily-batch model. Each behavior below is tagged **[EXISTS]** (already true — cite anchor), **[PRESET]** (settings composition over existing paths), or **[BUILD]** (new work), with a **SAFETY** line stating its relation to the no-double-post invariant.

### 2.1 The batch object

A batch = `{ ordered post list, set of accounts, set of groups }`. In the current code a batch is not a stored object — it is an **emergent cluster** computed each round:

- A **cluster** = poster accounts sharing an identical signature `sig(a) = sort(assignedGroups).join('|') + '::' + (postSetId||'')` — `orchestrator.js:3867`. That is exactly `{accounts, groups, post-set}`. **[EXISTS]**
- The batch's **ordered post list** = the library filtered to the cluster's post-set and the first account's postFilter (`_postsForCluster`, `orchestrator.js:3874`), in persisted `posts[]` array order (the library order the operator sees). **[EXISTS]**
- **Multiple batches already work**: distinct group-sets → distinct clusters; distinct `postSetId` tags → distinct clusters drawing different content (`orchestrator.js:3870-3876`, `plan.js:213`). **[EXISTS]**

**Target change [BUILD, small]:** Formalize the batch order as **decided once at campaign start** and frozen into the persisted plan (`campaignPlan` already persists `agentLists` + `libraryHash` at `orchestrator.js:3950`), so "same order the entire campaign" holds even across rounds. Today `shuffleCampaign` reshuffles the library **every** round (`orchestrator.js:3863`, `seededShuffle(posts, roundOffset+1)`) — a genuine tension with "same order forever." Under the target, the shuffle decides the order **once** (round 0), not per-round.

- **SAFETY:** Order is presentational + assignment-input only; it never touches per-`(post,group)` delivery. Freezing order cannot cause a double-post. **Neutral.**

### 2.2 The daily split — random per-day account assignment

**Current mechanism (the partition) [EXISTS]:** within a cluster of `K` agents, agent `j` owns posts where `idx % Keff === rank`, `rank = (j − shift) mod K`, `shift = roundOffset mod K` (`orchestrator.js:3926-3929`). This is a **disjoint round-robin deal**: every post index maps to exactly one rank → exactly one agent. Coverage + disjointness are arithmetic (proven over live topology: P=30 → 30/30 covered, 0 dupes; ADR-0023 §Phase 1). `Keff = min(K, max(1, campaignMinAgents, ceil(cPosts.length / globalMaxLen)))` (`orchestrator.js:3925`) benches surplus agents to pace volume. A non-multiple `P` is handled by the deal itself — the first `P mod Keff` ranks get `ceil(P/Keff)` posts, the rest `floor`; no remainder dropped.

**Gap vs vision:** the partition is a **fixed** round-robin — same roster + same posts → same account gets the same slice every round. The operator wants a **fresh random** account→share assignment each day. Today only two levers rotate assignment, both at the reloop/re-arm boundary, both a rotation not a fresh random: `roundOffset` (the `shift`) and `shuffleCampaign` (the library order).

**Target spec [BUILD]:**
1. **Keep the partition as the assignment unit.** Do NOT move the default path to a shared pull-pool. The disjoint partition is the *only* thing standing in for the absent durable per-`(post,group)` ledger.
2. **Randomize by day-seeding the permutation of ownership.** Derive `perm = seededShuffle([0..K-1], hash(dayKey, batchId))` and assign `rank = perm.indexOf(j)`. This gives a fresh, **reproducible-within-the-day**, re-randomized-across-days mapping — exactly the vision — while preserving disjointness. Reproducible-within-a-day is **required** so a mid-day restart re-derives the identical assignment (no re-post).
3. **Split across ALL accounts when wanted:** "split across the accounts" implies `Keff = K` (nobody benched) = `campaignMinAgents = K`. The daily-batch preset should default `campaignMinAgents` to cluster size. Measured cost (ADR-0023): `Keff=K` compresses an 8-day spread to ~5 days ≈ **+58% daily volume** into those groups — the operator's explicit trade ("posts and speed"); surface it in the batch-volume preview (`renderer.js:4536-4548`).

- **SAFETY (critical):** The daily random *permutation of ownership* is safe **only because the partition stays disjoint** (each post still has exactly one owner per day). The trap: a **re-seed that changes ownership mid-round while pointers persist.** If day N gave post P to account A (A delivered P to its groups) and a same-round re-seed hands P to account B with overlapping groups, B re-delivers `(P, sharedGroup)` = double-post, **unguarded** (campaign-plan has no `_inflightDelivered`; `orchestrator.js:1009-1014`). **Guard: the re-seed must occur only at a round/day boundary that also nulls the per-account pointers and rebuilds the plan atomically** — the exact atomicity `_dailyRearmIfNeeded` already enforces (`orchestrator.js:3984-3991`, "never leave a plan-null-with-live-pointers state"). A within-round re-randomization is **rejected outright.**

### 2.3 Row execution — up to N browsers

**This is already the concurrent pool [EXISTS].** Concurrency cap = `_livePoolTarget() = min(_wanted, _proxyCeil, _liveHwCeil())` (`orchestrator.js:2521-2522`), where `_wanted = parallelAccounts` (`:2512`) and `_proxyCeil` folds in the per-IP cap `_realIpMax = min(20, realIpMaxConcurrent||3)` (`:2504-2505`). The launch loop tops up to target on every freed slot — `while (inFlight.size < _livePoolTarget() && queue.length) launchNext(); await Promise.race([...inFlight])` (`orchestrator.js:2905-2907`) — the next account starts the *instant* a slot frees. This IS "a row of up to N browsers, one after another."

- **Concurrency levers (corrected):** on one shared IP the effective concurrency = `min(parallelAccounts [:2512], realIpMaxConcurrent [:2504→_proxyCeil :2505], _liveHwCeil [:2521])`. **Both `parallelAccounts` and `realIpMaxConcurrent` are code levers** that bound and can raise on-IP concurrency (`realIpMaxConcurrent` default 3, tunable 1..20, also re-enforced by the `launchNext` per-IP gate at `:2891/:2898`). With defaults `parallelAccounts` is the tighter bound only because it is the smaller number — this is **not** a code invariant that `parallelAccounts` always binds.
- **Throughput is contention-bound, not lever-bound (corrected):** raising concurrency on one IP does **not** add throughput (posts/hour) — measured ~19s/post at 1–2 concurrent degrading to 90–164s at 6–11 concurrent (8–10 Chrome renderers on a 4-core laptop). State this as a **CPU/RAM contention limit**, not "no lever exists." The real throughput lever is the operator **swapping in more distinct accounts daily** and/or proxies, not more concurrency.

- **SAFETY:** Fail-and-continue is safe (crash isolation returns a failed result, no delivery; `orchestrator.js:2644-2645, 2899`). Neutral.

### 2.4 Fail-and-continue, never stall

Each account runs under `_runAccount(...).catch(...)` returning a synthetic failed result (`orchestrator.js:2644-2645`); a rejection is swallowed per-account, the `.finally` frees the IP slot, the pool keeps draining (`:2899-2903`). One account failing can never stall the row. **[EXISTS].**

Failure taxonomy → action (`DROP_FLAGS` at `orchestrator.js:41`):

| Operator failure | Engine flag | Action (close + continue row) | Status |
|---|---|---|---|
| logged-out | `needs_login` | close, rest ~3h, reserve covers exact groups (`:1657/:1663`), row continues | **[EXISTS]** |
| needs-verification | `needs_verification` | close, rest ~6h, checkpoint state (`:1222/:1657`), row continues | **[EXISTS]** |
| post-limit | `rate_limited` | close, cool-down, auto-retry next cycle (`:1608/:2595`), reserve covers, row continues | **[EXISTS]** |
| comment-limit | comment breaker | breaker trips per-account; **posting continues**, comments suppressed | **[EXISTS, verify]** |

- **comment-limit [BUILD-verify]:** confirm the comment-failure breaker (`tests/comment-failure-breaker.test.js`, modified on this branch) only suppresses commenting and does not abort the **post**. Keep/add a test asserting a comment-limit trip still delivers the post and records the post `delivered` with a comment-lost note.

**Re-assignment rule (the safety line).** Two existing re-assignment paths, not equivalent in safety:
- **Full-drop cover (safe, [EXISTS]):** if account A dropped before delivering post P to any group, `coverDrop` hands A's exact slice to a covering reserve R routed to **A's exact groups via `gids`** (`orchestrator.js:2549-2555`). No overlap → no double-post. (This is the exact scar the v1.0.127 `gids` fix repaired.)
- **Partial-delivery owed cover (bounded, [EXISTS]):** if A delivered P to *some* groups then failed, the un-reached groups are recorded OWED (`_cycleOwed`/`_owed`, `:2696-2716`) and a reserve finishes **only the un-reached groups**; the worker's per-cell `alreadyDelivered` skip (`:1096`) covers unique/sequence, and owed-group scoping + the same-run `_cycleDelivered` set cover campaign-plan.

- **TARGET RULE:** re-assigning an undelivered post to another account within the same day is permitted **only** when the recipient is routed to a group-set that is a subset of the failed account's un-delivered groups, carried explicitly via `gids`. Any re-assignment that could send `(P, group)` to an account whose groups were already served this round is **FORBIDDEN** without the durable ledger (§2.7 / Phase 5–6).
- **DEFAULT:** an undelivered share of a cleanly-benched account is covered **this run** by a reserve on the same groups (safe, existing); if no reserve is free it is **left for the next day's re-split** (`_dailyRearmIfNeeded`), never sprayed onto an arbitrary account.

- **SAFETY:** Fail-and-continue itself is safe; the reserve takeover is the danger surface, guarded by exact-`gids` routing and owed-group scoping. **Preserve both verbatim.**

### 2.5 State persistence + the dashboard ROW

**The per-post record already exists durably [EXISTS]** in two stores:
1. **`run-report.jsonl`/`.csv`** — append-one-row-per-delivery audit, tagged `round`+`cycle` (`store.js:850`; `orchestrator.js:1101`). Immutable "what happened."
2. **`daily-progress.json`** — the dashboard rollup; `recordProgress` keys each cell by `` `${account}|${postId}|${groupId}` `` with `{account, postId, caption, groupId, group, status: done|held|error, comment, ts, round, cycle}` (`store.js:923-927`). Survives rotation + restart.

**Live per-account state [EXISTS]:** `_setAcctState(name, state, {posted, action})` maintains `_acctLive` (`orchestrator.js:499-502`), emitting `running/done/rate_limited/needs_login/checkpoint/error/cooldown/idle/off/capped`.

**Gap vs "THE ROW":** the current dashboard is **cycle-indexed** (`plan.js:295-388`, keys like `r{round}c{cycle}`) and **account-centric** in the live view (`renderLiveOps`, `renderer.js:920`). The operator wants **one flat per-post list** in library order.

**Target spec [BUILD]:** Add a `buildBatchRow(input)` read-model to `lib/plan.js` emitting, per batch (cluster), an array in **frozen library order**:
```
row[i] = { postNum, postId, caption,
           assignedAccount,   // inverse of campaignPlan.agentLists — no new state
           group(s),
           status: delivered | failed(reason) | pending | held,
           reason, ts }
```
- `status` per `(post,group)` maps from `daily-progress.json` (`done→delivered`, `held→pending-approval`, `error→failed`), `reason` from the account's final drop state/`attnFlag`.
- Same order every day (§2.1). **Pure projection of data that already exists** — no new persistence, no engine change.

- **SAFETY:** Read-only view. **Zero delivery impact.** Do NOT invent a new per-day ledger — the row is a projection of `daily-progress.json`; a parallel store would duplicate the truth and risk divergence.

**Known trap:** the dashboard has historically *lied* — a benched/idle account read as "DONE" (v1.0.131–1.0.132 fixed two surfaces). A failed account must read **failed with its reason**, never done. Verify no third surface remains.

### 2.6 One run per day

**Already a preset [PRESET, EXISTS].** `fullBatchDaily` (v1.0.136) sets `cyclesPerDay = postsPerCycle = maxSlice`, `loopCampaign = false`, `completionMode = true`, `scheduleMode = 'daily'` (`renderer.js:4561-4592`; `store.js:152-156`). `maxSlice = ceil(pool/K)` per cluster, clamped 1..50 (`renderer.js:4510-4532`; `store.campaignMaxSlice` `store.js:582-610`). **The engine never reads the flag** (`renderer.js:4586`) — OFF is byte-identical, and a double-post via this route is structurally impossible. Internally "one run" is still `maxSlice` cycles fired back-to-back (`orchestrator.js:2149-2151`); the multi-cycle machinery is **hidden and maxed out**, not removed — the right call (never rewrite the crown jewel for a model relabel).

**Daily continuity [EXISTS].** `_dailyRearmIfNeeded` rebuilds the plan for the new day's roster on the next Start, **only if `libraryHash` changed** (`orchestrator.js:3970-3994`, gate at `:3976`) — else it refuses (re-delivering the same posts to the same groups on one IP = cross-day spam, no durable pair-guard). This is the "one run per day, new accounts each day" loop.

**Target spec [BUILD, UI-only]:** When the preset is ON, **hide** `cyclesPerDay`, `postsPerCycle`, `loopCampaign`, `completionMode`, and all "cycle" language (partly done at `renderer.js:4536-4540`); swap the cycle-indexed panel for the flat batch-row view (§2.5). Rename operator-facing "cycle" → nothing; the operator sees only "today's run" + the per-post row. Default the preset ON for the batch model with `campaignMinAgents = K`.

- **SAFETY:** Preset + UI only; the engine never reads the flag, so toggling cannot change delivery. The `campaignMinAgents = K` default raises daily **volume** (§2.2) — a surfaced trade, not a double-post risk (the partition stays disjoint at any `Keff`, `:3929`).

### 2.7 The publish-confirm guard (must never weaken) — precise statement (corrected)

`waitForPublish` (`worker.js:1039`) returns `'published'` via **more than one** path; understand all of them before touching it:
- **Dialog-count-drop path (`worker.js:1067`):** `if (dialogCount >= 0 && dialogCountBefore > 0 && dialogCount < dialogCountBefore && ourShellGone) return 'published';` — this path **additionally requires our tagged composer shell to be gone** (GAP#2 guard: blocks a Messenger/notification popup from masquerading as our composer closing).
- **Second-probe path (`worker.js:1097`):** `'published'` is **also** returned when the second probe yields `sig==='gone'` (inline/non-dialog composer: no dialog + no enabled Post button, `worker.js:1090`) **or** `sig==='submitted'` (a pending/"will be reviewed" notice on an alert/status/dialog surface, `worker.js:1081`). **Neither of these two checks `ourShellGone`** — do not assume every `'published'` return is gated on the shell.
- **Timeout ceiling is fixed** at `worker.js:1041`; `fast` mode changes only the poll cadence, **never** the ceiling (`worker.js:1098`).

Confirmation before `markDelivered` (fired at publish, e.g. `worker.js:3625, 3766`) is what makes a post idempotent. Timeout paths only ever **confirm** a landing (create-story network id `:3635`, read-only feed rescan `:3663-3688`) — **never a re-click**. **SAFETY: sacred.** A false `'published'` marks a never-sent post delivered (lost); a false `'timeout'` re-posts a delivered pair (duplicate).

### 2.8 Safety ledger (per behavior)

| # | Target behavior | Type | Preserves invariant? | Needs durable ledger? |
|---|---|---|---|---|
| 1 | Freeze batch post-ORDER once at start | BUILD | Yes — order is assignment input only | No |
| 2 | Daily RANDOM ownership via day-seeded permutation of the disjoint partition | BUILD | Yes — **iff** re-seed only at a boundary that atomically nulls pointers + rebuilds (mirror `:3984-3991`). Mid-round re-seed with live pointers = DOUBLE-POST | No (partition is the guard); a mid-round re-seed WOULD need it → **forbid instead** |
| 3a | Fail-and-continue (crash isolation) | EXISTS | Yes — failed account delivers nothing (`:2644`) | No |
| 3b | Full-drop reserve cover (exact `gids`) | EXISTS | Yes — R targets dropped account's own groups (`:2549-2555`) | No |
| 3c | Partial-delivery owed cover (un-reached groups only) | EXISTS | Yes — scoped to owed gids + `_cycleDelivered`/`alreadyDelivered` (`:2696-2716, :1096`) | No, for the same-run case |
| 3d | Re-assign undelivered post to an ARBITRARY free account over overlapping groups | FORBID | **NO** — unguarded double-post (`:1009-1014`) | **YES — blocked until Phase 5→6** |
| 4 | Flat per-post dashboard row | BUILD | Yes — read-only projection of `daily-progress.json` | No |
| 5 | full-batch-daily preset + UI simplification | PRESET | Yes — engine never reads the flag (`renderer.js:4586`) | No |
| 6 | `campaignMinAgents = K` (split across ALL accounts) | PRESET | Yes for double-post (disjoint at any `Keff`); raises daily VOLUME ~+58% | No |

---

## 3. Current-vs-target delta (summary)

| # | Target | Status | Anchor | What remains |
|---|---|---|---|---|
| T1 | Row, up to N browsers, next-on-free-slot | **DONE** | `orchestrator.js:2888, 2905-2907` | Nothing |
| T2 | Failed account closed, row continues | **DONE** | `:2899, 2903, 2644` | Nothing structural |
| T3 | ONE run/day (remove many-cycles) | **DONE as preset** | v1.0.136; internally still cycles (`:2149-2151`) | Relabel/UI only; do not rip out cycle plumbing |
| T4 | Ordered list split across accounts | **DONE** | `:3898/3929` disjoint partition = the guard | Nothing for the split |
| T5 | Same order entire campaign | **PARTIAL** | `shuffleCampaign` reshuffles per round (`:3863`) | Freeze order once (§2.1) |
| T6 | Accounts assigned randomly each day | **PARTIAL** | rotation via `roundOffset++` (`:3984`), gated on library change (`:3976`) | Day-seeded permutation (§2.2); true unchanged-library daily re-deal needs the ledger |
| T7 | Failed account's share continues immediately | **PARTIAL** | pool continues; share does not migrate to a live account under the static partition | True same-day reassign = pull model → needs ledger |
| T8 | Per-`(post,group)` durable final state | **PARTIAL** | `daily-progress.json` records done/held; `_inflightDelivered` guards unique/sequence only (`:1009`) | Durable campaign-plan pair-ledger = keystone |
| T9 | Flat per-post dashboard row | **PARTIAL** | data in `plan.js:301-388` but cycle-indexed | Flat projection (§2.5) |
| T10 | Posts + speed (throughput) | **CONTENTION-BOUND** | `_livePoolTarget` min (`:2521-2522`); 19s→164s/post under load | No code lever adds throughput on one IP; swap accounts daily |

**One-line delta:** the *execution engine* (row, N browsers, fail-and-continue, one-run/day) **already exists.** Genuinely missing: (a) the durable per-`(post,group)` ledger (T8), the single prerequisite that unlocks (b) true same-day fail-and-reassign (T7) and (c) daily random reassignment of an *unchanged* library (T6-full), plus (d) the cheap flat dashboard row (T9). Everything dangerous funnels through the ledger.

---

## 4. The sequenced build plan (dependency-ordered; each phase ships alone)

```
Phase A (dashboard row)        ──┐  independent, no engine risk
Phase B (one-run/day relabel)  ──┤  independent
                                 ├─► Phase D (ledger SHADOW) ─► Phase E (ledger AUTHORITATIVE)
Phase C (daily re-arm, exists) ──┘                                   │
                                              Phase F (fail-and-REASSIGN, same-day) ◄─┘
                                                        │
                                                        ▼
                                              Phase G (daily random reassign, UNCHANGED library)
```

### Phase A — Flat per-post dashboard "row" (T9)
- **Deliver:** `buildBatchRow` in `lib/plan.js` (projection over the same ledger it already reads at `plan.js:326-345`) + `renderer/index.html`/`renderer.js`. One row per post: account, alias, delivered/failed/pending, per-group state, in frozen order.
- **Risk:** LOW (read-only). Trap: don't imply a state the ledger can't prove — until Phase D, show "error today," not a durable terminal "failed."
- **Acceptance/test:** `lib/plan` unit tests over a synthetic `daily-progress.json` → one row per post, correct per-group status; a run with an **injected mid-batch account failure** shows that account's posts `failed` (with state) and the rest `delivered`/`pending` — never a false "done."

### Phase B — Make one-run/day the stated model (T3, cosmetic)
- **Deliver:** promote the preset to the primary UI path; remove "N cycles per run" language from operator surfaces. **Do NOT delete the cycle plumbing** — ledger + dashboard key off `cycle`/`round` (`orchestrator.js:1101`, `plan.js:333`). Naming + defaults only.
- **Risk:** LOW. **Acceptance/test:** settings/preset tests assert the preset still resolves to `loopCampaign=false, completionMode=true, cyclesPerDay=postsPerCycle=maxSlice`.

### Phase C — (already shipped) library-change-gated daily reassignment (T6 partial)
- **No work.** `_dailyRearmIfNeeded` (v1.0.138) exists; its `same-library` gate (`:3976`) is a **safety feature**, not a bug. Do not re-implement, do not "fix" before Phase E.

### Phase D — Durable pair-ledger in SHADOW (keystone, step 1)
- **Deliver:** a durable, fsync'd ledger of every `(post,group)` delivery under a **private persisted `_batchEpoch`** (NOT `_roundOffset`). Runs in **shadow** — records and would-flag, but the static partition stays authoritative. Zero behavior change.
- **Why shadow first:** prove the ledger's "already delivered" exactly matches what the partition actually delivered, over real multi-day runs, before anything trusts it. A green suite has coexisted with live double-posts (ADR-0023 §Testing-note) — validate against **live** deliveries.
- **Risk:** MEDIUM (new persistent state + fsync; disk-full interaction with `_evalDiskHalt` at `:2904`). Mitigated by shadow.
- **Acceptance/test:** N-cycles-in-ONE-process harness (`tests/helpers/ncycle.js`) → shadow-ledger delivered set == partition's actual deliveries; epoch survives a simulated crash-fold; an unknown/garbage epoch never widens the delivered set.

### Phase E — Ledger becomes AUTHORITATIVE for skip (keystone, step 2)
- **Deliver:** the delivery path consults the durable ledger as a per-pair skip guard (like `_inflightDelivered`, extended to campaign-plan). Partition still deals slices; the ledger is now a second, durable guard surviving crash + reassignment.
- **Risk:** HIGH — first change that can *cause or prevent* a double-post. Gate behind Phase D's shadow evidence. **The sacred-invariant phase.**
- **Acceptance/test:** adversarial double-post harness — inject mid-slice crash, reassigned slice, same-day restart, roster swap → assert **no `(post,group)` delivered twice** AND a legitimately-owed pair is still delivered exactly once (no false-skip starvation).

### Phase F — Fail-and-REASSIGN, same day (T7)
- **Deliver:** when an account fails mid-share, its **undelivered** pairs (per the authoritative ledger) re-queue onto live accounts immediately. Now safe because the ledger, not the partition, guarantees each pair goes once.
- **Risk:** HIGH (the pull model). Only after E. Opt-in behind `postingOrder:'batch'`, one batch at a time. Publish must be **ledger-write-then-publish-confirm** ordered to keep the crash window at the irreducible ~1% strand (never a double-post).
- **Acceptance/test:** kill A after it delivered k of m pairs → exactly the remaining m−k migrate, the k done are **never re-posted**, the run reports A's failure + final per-pair state.

### Phase G — Daily random reassignment of an UNCHANGED library (T6 full)
- **Deliver:** lift the `same-library` gate (`:3976`) **only when** the authoritative ledger proves the prior batch's pairs are all recorded, minting a **new `_batchEpoch`** so a fresh day's reshuffle is a legitimately new generation.
- **Risk:** MEDIUM-HIGH (re-arms the cross-day-spam path the gate blocks). Only post-E. Requires explicit operator opt-in — re-posting the *same content* to the *same groups* is itself the spam the gate names; the ledger prevents *accidental* double-post, not the *deliberate* re-delivery the operator may not want.
- **Acceptance/test:** two consecutive days, unchanged library, opt-in ON → new epoch, fresh full delivery, no intra-epoch double-post; opt-in OFF → `same-library` behavior preserved.

---

## 5. Consequences

**Positive.** The operator model is achievable **today almost entirely via a preset + a read-model + one seeding change**, with **zero rewrite of the delivery core** and **no new double-post surface**, provided the daily re-randomization is bound to the existing atomic re-arm boundary. Phases A–C are cheap, reversible, low-risk and can ship immediately. The keystone ledger is built shadow-first so it can never regress delivery before it is proven.

**Negative / accepted.** The one thing the vision cannot have without Phases 5–6 (D→E→F→G) is a true "any account picks up any leftover post" pull-pool — that is exactly the line ADR-0023 draws, and it is correctly the last, most expensive, evidence-gated work. Throughput does not improve from any code change on one IP (contention limit); the operator's lever is more distinct accounts/proxies. The `campaignMinAgents = K` default raises daily volume ~+58% into each group — an explicit, surfaced trade.

**If Phase E/F/G's double-post test cannot be made green, not shipping is the correct, ADR-0023-sanctioned outcome.** A ban costs far more than an unshipped pull-pool.

---

## 6. Alternatives considered

- **Big-bang move to a shared pull-pool as the opening move (any account posts any leftover post).** Rejected — this is precisely the line ADR-0023 draws and ADR-0021 already tried in spirit: removing the disjoint partition removes the only campaign-plan double-post guard. It is deferred to the last, evidence-gated phases (D→E→F→G), built shadow-first.
- **Reuse `_roundOffset` as the ledger epoch.** Rejected — two writers plus a disk reset would let a unique account exhausting its library purge the campaign ledger, causing a full-library re-burst. Use a private persisted `_batchEpoch`.
- **A new per-day state store for the dashboard row.** Rejected — the row is a pure projection of the existing `daily-progress.json`; a parallel store would duplicate the truth and risk divergence (and the dashboard has a history of *lying*, v1.0.131–1.0.132).
- **Within-round re-randomization of ownership.** Rejected outright — re-seeding while per-account pointers are live can hand a delivered post to an account with overlapping groups = unguarded double-post. Re-seed only at the atomic re-arm boundary.
- **Ripping out the internal cycle/round plumbing to "really" make one-run-per-day.** Rejected — the ledger and dashboard key off `cycle`/`round`; the multi-cycle machinery is hidden and maxed by the preset, not removed. "Remove many-cycles" is presentation only.

---

## 7. Do-Not-Break list

- **Never** let two accounts deliver the same `(post,group)` on the shared IP. Any phase that removes the static partition (T7/pull) must have the authoritative ledger (Phase E) live first.
- **Never** weaken the publish-confirm / post-id trust anchor (ADR-0006). Understand all `'published'` return paths (§2.7) before touching `waitForPublish`. Don't shorten timing for speed (contention is the bottleneck).
- **Do not** give campaign-plan a durable delivered-guard that suppresses legitimate cross-round re-delivery; keep `_inflightDelivered` for unique/sequence only (`orchestrator.js:1009`).
- **Do not** re-seed the daily assignment mid-round with live pointers — re-seed only at the atomic re-arm boundary (`:3984-3991`).
- **Do not** delete the cycle/round plumbing (ledger + dashboard key off it: `:1101`, `plan.js:333`) — "remove many-cycles" is presentation only.
- **Do not** remove the `same-library` re-arm gate (`:3976`) before Phase E — it is the cross-day-spam guard.
- **Do not** make the engine read `fullBatchDaily` — it is a UI preset by design (that is what makes OFF byte-identical).
- **Do not** delete `_campaignStandins`/`_owedStandins`/`_splitCover`/`_owed`, or the exact-`gids` cover routing (`:2549-2555`) — shipped scars, retire only behind a 30-day-live gate after Phase F subsumes them.
- **Do not** use `_roundOffset` as the ledger epoch (two writers + disk reset → a unique account exhausting its library would purge the campaign ledger → full-library re-burst). Use a private persisted `_batchEpoch`.
- **Do not** change the `batchId` fingerprint formula (`:3950`) — it is durable and compared across versions; a change mismatches every persisted plan forever.
- **Keep** the two duplicated partition implementations (`orchestrator._computeCampaignPlan` `:3860` and `plan.computeCampaignAgentLists` `plan.js:211`) in sync — the dashboard silently lies if they drift.

## 8. References

- ADR-0023 (batch/pool — floor the spread; the direction this continues; Phases 1–4 shipped, 5–6 evidence-gated).
- ADR-0019 (campaign plan frozen within a round), ADR-0022 (owed-ledger coherence), ADR-0009 (run-to-completion engine), ADR-0006 (post-id trust anchor), ADR-0021 (rejected owed-ledger-for-unique/sequence — the double-post scar).
- CHANGELOG entries v1.0.131–v1.0.138 (dashboard truth, posts-per-day, full-batch-daily, parallel-accounts control, speed audit, daily auto-re-arm).
- Engine anchors throughout: `automation/orchestrator.js`, `automation/worker.js`, `lib/store.js`, `lib/plan.js`, `renderer/renderer.js`.
- The paste-ready hand-off for a fresh build session: `docs/BUILD-PROMPT-end-to-end.md`.
