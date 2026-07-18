# Never-stop posting & the "batch = groups + agents + content" model

> Design notes + roadmap. Captures the operator's idea (2026-06-24), what the app already does, what
> was shipped now, and what is a multi-phase feature for future discussion.

---

## 0. The goal (operator's words)

1. **The random interval is the solution — plan it well, including the super-fast method.**
2. **Posting should never stop.** When an agent finishes its posts:
   - if the posts are **not** updated → re-post them, but each account takes a **different** post than the previous round;
   - if the posts **were** updated (e.g. next day) → run with the **new** content;
   - if the operator changes the wizard → it applies on the next round, with the new data.
3. **Proposed cleaner architecture:** group agents **by groups** across the whole app, and tie a **selected set of posts (content)** to that group/agent set — a **batch**. Every agent inside a batch "owns" the batch's full content. Assign posts to a batch from the Posts section (a UI), so every cycle is perfect.

---

## 1. Random interval / pacing — STATUS: ✅ planned, now hardened

### How pacing works
Every human-facing wait is a fresh random draw from a `[min, max]` band (`rangeMs` → `rand`), never a constant — so the cadence is never metronomic (a fixed gap is itself a bot signal). The key gaps:

| Gap | Default | Randomized? | Fast/turbo mode |
|---|---|---|---|
| Between posts to different groups (`groupDelay`) | 120–300 s | yes | **kept** (not skipped) |
| Post → link-comment (`commentDelay`) | 60–180 s + ±12% jitter | yes | **kept** (the most hardened gap) |
| Between cycles (`waitInterval`) | 90–180 min | yes | kept |
| Account stagger (`accountDelay`) | 1–4 min × slot | yes | kept |
| Cosmetic dwells (scroll/pre-publish/comment read) + typing speed | small | yes | **collapse to 0** in fast mode |

**Fast/turbo only removes the cosmetic dwells and typing speed — it does NOT remove the anti-spam gaps.** That part was already correct.

### The hole that was fixed (this change)
`rangeMs`'s safety floor drops to **1 s** when the operator *explicitly* sets the min/max keys ("let deliberately-fast values take effect"). So a misconfig (`groupDelay 0/0`) or a `fast` pace (0.5×) on small values could produce ~1 s gaps — a burst-post spam signal.

**Shipped:** a **hard, randomized anti-spam floor** that the fastest mode / lowest setting / `fast` pace can never undercut (`withFloor` in `automation/worker.js`):
- **≥ ~20 s between posts to different groups** (`ANTI_SPAM_MIN_GROUP_MS`)
- **≥ ~30 s post → link-comment** (`ANTI_SPAM_MIN_COMMENT_MS`)

Both are jittered (never a fixed value); operator settings only ever make the gap *longer*. Tested in `tests/antispam-floor.test.js` (incl. the 0/0-config case). **Result: "super fast" is now safe by construction.**

> Note: `speedMode='turbo'` already left `groupDelay`/`commentDelay` untouched (it has no pace multiplier) — conservative, kept as-is.

---

## 2. Never-stop — STATUS: ✅ already true for the right modes

What happens when an agent finishes its posts, per mode:

| Mode | Finishes? | On finish |
|---|---|---|
| **Campaign Plan + Loop ON** | never | bumps `roundOffset` → **reshuffles which account posts which** → resets pointers → recomputes the plan from `this._data.posts` (**picks up edited content**) → **waits to the next day** → continues. **This is exactly the operator's idea #2.** |
| **Daily Rotation** | never | wraps the library (`nextIdx = (i+1) % P`), 1 post/account/day, holds to next local midnight |
| **Sequence/Unique + Loop ON** | never | clears the dealt-set, bumps `roundOffset` (each account gets a shifted post next round) |
| **Post to All** | never | re-posts everything every cycle |
| Sequence/Unique + Loop OFF | stops after one pass | by design (completion report) |

**The library re-reads every cycle** (`getData()` at the top of `_loop`), so **edited posts and changed wizard settings take effect on the next round** automatically. Adding/removing/reordering posts changes the campaign partition's `batchId` change-hash, but the reshuffle is **deferred to the next round boundary** — recomputing the partition mid-round would wipe every agent's delivered pointer and re-post the whole library to the shared IP (a re-burst). A mid-round edit is held and applied cleanly at the next round (or on Stop→edit→Start); see [ADR-0019](decisions/ADR-0019-campaign-plan-frozen-within-round.md).

### So the operator's "never stop, rotate posts" goal is **already met** by **Campaign Plan + Loop** (the mode the wizard sets). No code change needed for that.

### Two known caveats (documented, not blocking)
1. **Sequence/Unique + Loop ON without a Daily schedule** re-deals within the inter-cycle wait (~90–180 s), not "1 round per day." Campaign Plan does not have this issue (it paces to the next day). *Fix if ever needed:* after the `_dealt.clear()` + `roundOffset++`, set `this._lastDailyRunDate = this._localDayKey()` when `scheduleMode !== 'daily'` (mirrors what Campaign Plan already does). **Or simply use `scheduleMode = daily`.**
2. **Campaign Plan with an in-place content edit** (caption/image changed but the post **id** unchanged): the new content **is** delivered on the next slot (the library re-reads each cycle), but the partition doesn't reshuffle (the `batchId` only hashes ids). To force a reshuffle, add/remove/reorder a post — which takes effect at the **next round boundary**, not mid-round (see the reshuffle note above and [ADR-0019](decisions/ADR-0019-campaign-plan-frozen-within-round.md)).

---

## 3. Proposed architecture — "batch = groups + agents + content"

### The idea
A first-class, **persistent batch** that bundles:
- a set of **groups**,
- a set of **agents** (accounts), and
- a **selected subset of posts** (its own content).

Each batch posts only **its own content** to **its own groups** via **its own agents**, and every agent in the batch shares that batch's full content. You'd assign posts to a batch from the **Posts section**, and the wizard would configure batches.

Example: **Batch "Recipes"** (recipe groups + recipe accounts + 12 recipe posts) and **Batch "Health"** (health groups + health accounts + 8 health posts) run side by side, each with its own content — instead of today's single global post library shared by everyone.

### Why it's valuable
Today **all posts are a global library** applied to every agent (only narrowed by the blunt `postFilter` = with/without-comments). There is **no way to say "these 10 posts belong to group-set A and these 8 to group-set B."** The batch model makes content-per-group-set first-class, which is the natural mental model for running multiple campaigns at once.

### Current reality (why it's not trivial)
- **No persistent batch entity.** "Batch" today means (a) the wizard's *transient* grouping while it's open, and (b) the engine's *per-cycle computed* cluster. Neither survives in `data.json`; the wizard re-derives batches from each account's `assignedGroups` every time it opens (and that reconstruction is fragile — fails past 8 clusters or if an account moved).
- **No post→batch scoping.** `_postsForAccount` always starts from the whole `data.posts`.
- **Rotation state is global** (`perAccountRotation`, the shared dealt-set) — a batch would want its own rotation namespace so batches don't interfere.

### Proposed data model
```jsonc
// data.json root gains:  { ..., "batches": [...] }
{
  "id": "batch-uuid",
  "name": "Recipes",
  "groupIds":  ["group-..."],   // authoritative (no more reconstructing from accounts)
  "agentNames": ["account-..."]
}
// each post gains one optional field:
{ "...": "...", "batchId": "batch-uuid" | null }   // null/absent = global library (back-compat)
```

### Engine change (surgical — one function)
At the top of `_postsForAccount`, before the `postFilter` step, scope the library to the account's batch:
```js
const acctBatch = data.batches && data.batches.find(b => b.agentNames.includes(account.name));
const scoped = acctBatch
  ? data.posts.filter(p => p.batchId === acctBatch.id)   // batch agents see only batch posts
  : data.posts.filter(p => !p.batchId);                  // global agents see only unscoped posts
const filtered = scoped.filter(p => matchesFilter(p, account.postFilter || 'all'));
```
Everything downstream (daily-rotation, campaign-plan, unique/sequence, dealt-set, pointers, the `batchId` change-hash) is unchanged because it all reads the `filtered` array produced here. With `batches: []`, behaviour is **identical to today** (every post `batchId=null`).

**Key invariant:** an account in a batch whose batch has **no posts** must return `[]` (like an account with no groups) — it must NOT fall through to the global library, or content leaks across batches.

### Is this doable in ONE pass, perfectly? **No.**
The data-model change cascades into three subsystems with separate correctness invariants — the **engine selector**, the **wizard** (which today reverse-engineers state instead of reading a canonical source), and the **Posts UI**. Trying to land all of it atomically is how subtle leakage/regression bugs happen.

### Phased plan
- **Phase 1 — Data model (store.js only).** Add `batches: []` to `blank()`/`normalize()`; accept optional `post.batchId`. One-time migration: derive initial batches from existing campaign clusters. Zero engine/UI change → all current tests still pass (batches unused).
- **Phase 2 — Engine scoping (`_postsForAccount` only).** The gate above + unit tests: batch agent sees only batch posts; non-batch agent sees only `batchId=null` posts; empty batch → `[]`; `batches=[]` → unchanged.
- **➡ Smallest correct increment = Phase 1 + Phase 2** (with all posts left `batchId=null`). This is the atomic unit that makes the feature coherent and low-risk: the data model without the gate is decoration; the gate without the model has nothing to scope.
- **Phase 3 — Posts UI.** Batch picker in Add/Edit Post, batch badge on cards, a "Batch A (12) · Global (5)" filter chip.
- **Phase 4 — Wizard.** Read/write `data.batches` directly (retire the fragile reconstruction); scope the plan preview to the batch's posts. Apply still writes `assignedGroups` for engine back-compat.

### Different agents per batch — what actually happens

This is the **cleanest** case (disjoint agents, disjoint groups, disjoint content) and the easiest to reason about: each batch becomes a **self-contained campaign running in parallel**.

- **Content stays inside the batch.** A Batch-A agent's `_postsForAccount` only ever sees `batchId === A`, so it posts A's content to A's groups. A Batch-B agent only sees B. They never touch each other's posts. ✅
- **Within a batch, the work still divides** the same way it does today: Campaign Plan clusters A's agents and splits **A's posts** among them (interleave, 1/agent/day); B's agents split **B's posts**. *(Implementation note: this requires `_computeCampaignPlan` to partition each cluster over its batch's posts, not the global library — so Phase 2 touches `_computeCampaignPlan` too, not only `_postsForAccount`. Slightly more than "one function," but still self-contained.)*
- **They run together every cycle.** The orchestrator runs all active agents each cycle, so both batches post in the same run.

**What is SHARED globally (not per-batch) today — decide if that's acceptable, or future per-batch work:**

| Resource | Today | Effect with different agents per batch |
|---|---|---|
| **Schedule / daily time** | one global `dailyPostTime` + scheduleMode | **both batches fire at the same time.** Per-batch times (A at 09:00, B at 20:00) would be a follow-up feature. |
| **Concurrency** (`parallelAccounts`) | one global pool | all agents from **all** batches compete for the same N parallel slots (e.g. 10 in A + 20 in B share the budget). |
| **Reserves** (`reserveAccounts`) | one global pool, group-agnostic takeover | ⚠️ **the real gotcha:** a reserve must cover a dropped agent **in the same batch** (it needs that batch's groups *and* content). Global reserves would need batch-awareness, or reserves should be **assigned to a batch**. Without this, a reserve could take over a Batch-A slot but have B's groups/none → it can't deliver A's content. **This is the main thing to design before shipping batches.** |
| **Proxies / moderation / daily cap** | global | shared across batches (usually fine). |

**Empty / mis-set batch:** an agent whose batch has **no posts** goes idle (returns `[]`) — it does **not** fall back to the global library (the key no-leak invariant). So if you create Batch B's agents but forget to assign posts to Batch B, those agents simply do nothing until you give the batch content.

**Mixing batched + non-batched agents:** an agent in **no** batch posts only the **global** (`batchId=null`) posts. So you can run "Batch A" + "Batch B" + a set of agents on the shared global library, all at once.

**vs. today (no batches):** you can *already* point different agents at different **groups** (they form separate clusters), but every cluster posts the **same global library**. The batch feature is exactly what gives each agent-set its **own content** — that's the whole win.

### Open questions for discussion
- Can a post belong to **multiple** batches (`batchIds[]`) or exactly one (`batchId`)? (One is simpler and matches the mental model; many is more flexible.)
- Should rotation state be namespaced **per batch** so editing one batch's posts doesn't reset another batch's pointers? (Recommended once batches exist — today any post edit resets *all* campaign pointers.)
- Can an agent belong to more than one batch? (Recommend: no — one agent ↔ one batch, mirroring one agent ↔ one cluster.)
- **Reserves per batch?** A reserve must inherit the dropped agent's batch (groups + content) to cover it. Recommend assigning reserves to a batch (or making takeover batch-aware). This is the main correctness item once batches have distinct agents.
- **Per-batch schedule / concurrency?** Should each batch have its own daily time and parallel budget, or stay global? (Global is simpler for v1; per-batch is a clear future enhancement.)

---

## 4. Recommendation / what to do

1. **Now (done):** the anti-spam **safety floor** so any speed (incl. super-fast) is safe; tests added.
2. **Now (no code):** for "agents never stop," use **Campaign Plan + Loop ON** (the wizard already sets this) — it reshuffles each round, paces to one post/account/day, and picks up edited content automatically. For Sequence/Unique looping, also set **Daily schedule**.
3. **Next (when ready):** implement the batch-content feature as **Phase 1 + Phase 2** first (the atomic, low-risk core), then the UI/wizard. This delivers "every cycle goes perfect, each batch owns its own content" without a risky big-bang change.
