# DEVELOPMENT.md — Engineering Handbook

This is the one document a new engineer reads before touching za-post. It describes **how we actually work** — the change loop, the tests, the packaging, and the rules that keep us from bricking a client or double-posting to Facebook. Read it end to end, then keep it open beside you for your first few changes.

za-post is an Electron + Puppeteer Facebook group auto-poster. It drives real accounts against real groups. A bug here does not throw a stack trace in a sandbox — it double-posts to a live group, gets an account flagged, or parks a paying client on a License screen. We work slowly and adversarially on purpose.

---

## 0. Two rules before anything else

1. **Work only in the DEV CLONE at `C:\zpost\za-post`** (its userData folder is `za-post-restored`). **Never touch the owner's installed production copy at `C:\Za-Post-App`.** Updating the installed copy is the owner's call, not ours. If you find yourself pointing tooling at `C:\Za-Post-App`, stop.
2. **Never weaken the double-post / double-comment traps.** These are sacred invariants (see [§8](#8-sacred-invariants) and `INVARIANTS.md`). A change that touches them requires an adversarial multi-agent verify before it ships — no exceptions.

Everything below is the machinery that enforces those two rules.

---

## 1. The Change Loop

Every change — a one-line fix included — goes through the same loop. Do not skip steps because a fix "looks trivial"; the trivial-looking fixes are the ones that reintroduce double-posts.

1. **Adversarial audit.** Before changing anything, hunt for the gap. What failure path lets this bug happen? What *else* is on that path? Find the failure modes first; then you know what "fixed" has to mean.
2. **Implement the smallest correct fix.** Smallest *correct*, not smallest. Don't refactor on the side. Don't add scope. The narrower the diff, the easier step 3 is.
3. **Adversarially verify — refute + reproduce.**
   - If the change touches a **sacred invariant** (the double-post / double-comment traps, crash/rotation safety), run a **multi-agent Workflow verify**: one agent tries to *refute* the fix (construct an input that still double-posts), another tries to *reproduce* the original bug against the patched code. It ships only if both fail to break it.
   - If the change is **contained** (no sacred invariant in the blast radius), **code-inspection verification** is enough — read the surrounding code and the call sites and argue why it's correct.
4. **Run the tests.** `npm test` (270 tests) **and** `npm run test:antispam`. Both green. See [§2](#2-testing).
5. **Bump the version** in `package.json`. A hardening batch is a SemVer **patch** bump on the `1.0.x` line (currently **1.0.56** → 1.0.57). See [§4](#4-versioning).
6. **Write a CHANGELOG entry** in plain language: *what changed* and, more importantly, *why it mattered*. Keep-a-Changelog style. See [§4](#4-versioning).
7. **Package:** `ENFORCE_LICENSE=1 npm run pack:portable` → produces `dist/<product>-<ver>-portable.zip`. See [§3](#3-packaging).
8. **Smoke-test the packaged zip** under an **isolated `--user-data-dir`** so it can never touch dev userData. See [§3](#3-packaging).
9. **Verify enforcement is wired.** Confirm `<extracted>\resources\enforce-license.flag` exists directly (it's a sibling of `app.asar`, not inside it); reserve `npx asar extract` for confirming the license wiring inside `app.asar`. See [§3](#3-packaging).
10. **Update the assistant memory files** so the next session starts from current reality.
11. **Ship ONLY the newest zip.** Delete older zips — they are superseded and buggy, and a client installing an old one is a support incident.

If you can't complete a step, you are not done. A half-finished loop is a regression waiting to ship.

---

## 2. Testing

We do not merge on a hunch. A reliability fix is not "done" until it is *specifically* re-verified for the exactly-once guarantees.

**Primary suite**
```
npm test
```
Runs `node --test "tests/**/*.test.js"` — 270 tests. All must pass.

**Anti-spam suite**
```
npm run test:antispam
```
Runs `scripts/test-antispam.js` — the pacing/humanization/anti-detection checks. Must pass.

**What every reliability fix is re-verified against**

Independently of the suites, when you touch anything on the posting/commenting path, re-verify by hand that the change is safe for:

- **double-post** — the same post never goes out twice,
- **double-comment** — the same comment never lands twice,
- **lost-comment** — a comment that should land is never silently dropped,
- **deadlock** — the pool never wedges.

Crash / rotation tests — **including the crash-mid-pool case** — must pass **unchanged**. If a crash test needed editing to go green, you changed behavior, not just fixed a bug; go back to step 1.

**Which verification tier applies**

- **Sacred-invariant change** → adversarial multi-agent verify (refute + reproduce). Contained code inspection is *not* sufficient here.
- **Contained fix** → code-inspection verification.

**Before shipping** → the packaged-zip smoke test under an isolated `--user-data-dir` (see [§3](#3-packaging)) is itself part of the test gate, not an afterthought.

---

## 3. Packaging

**Build command**
```
ENFORCE_LICENSE=1 npm run pack:portable
```
This runs `scripts/build-portable.js`, which produces `dist/<product>-<ver>-portable.zip` from electron-builder's unsigned `dir` target, self-zipped with 7-Zip.

**`ENFORCE_LICENSE=1` — what it does and why it's one codebase**

- With `ENFORCE_LICENSE=1`, the build stamps `resources/enforce-license.flag` — the **per-seat marker** that turns on license enforcement. This is what a client build gets.
- **Omit** the flag for an unlimited owner/dev build. Same source, different build-time env — **no source divergence, ever.** We do not maintain a "licensed" and "unlicensed" fork.

**The license-server prerequisite — the top way to brick a client**

> The license server **MUST be live before you ship an enforced build.** A fresh install has no cached license; if it can't reach the server, it **parks on the License screen** and the client is stuck. Confirm the server is up *before* handing over a zip.

Also: **do NOT probe or contact the license-server infrastructure** yourself as part of dev work.

**Smoke-test the packaged zip — isolated userData, always**

Launch the built zip with an explicit isolated `--user-data-dir` so it can never read or write the dev `za-post-restored` userData:
```
"<extracted>\Za Post Comment Tool.exe" --user-data-dir="C:\zpost\_smoketest-userdata"
```
Verify it launches, reaches its normal first screen, and (for an enforced build with the server live) accepts a license — then throw the throwaway userData away.

**Verify enforcement is wired**

The **enforce marker** is written to `resources/enforce-license.flag` — a **sibling of `app.asar`**, not inside it (`main.js` reads `path.join(process.resourcesPath, 'enforce-license.flag')`). So confirming enforcement needs no asar extract at all — just check the flag exists directly:
```
dir "<extracted>\resources\enforce-license.flag"
```
If the flag isn't there, the build is not actually enforcing — do not ship it as a client build. Reserve `npx asar extract` for confirming the **license wiring inside `app.asar`**:
```
npx asar extract "<extracted>\resources\app.asar" C:\zpost\_asar-check
```

**Client data & upgrades**

Client data lives in a **separate userData folder** (`%APPDATA%\za-post-restored`). A folder-replace upgrade therefore carries the client's data over untouched — that separation is deliberate; don't collapse it.

**Ship discipline**

Ship **only the newest zip**. Delete older ones — they're superseded and buggy, and shipping the wrong one is the classic client incident.

---

## 4. Versioning & CHANGELOG

- **SemVer.** Hardening batches are **patch** bumps on the **`1.0.x`** line. Current version: **1.0.56**.
- Every batch **bumps `package.json`** *and* **adds a matching `CHANGELOG.md` entry**.
- CHANGELOG entries are **plain language, Keep-a-Changelog style**: *what changed* and *why it mattered*. Write for the person debugging a client six months from now, not for the compiler. "Fixed a race where a crash between publish-click and confirm could re-post — the retry now only fires on a pre-Enter 'failed' state" beats "hardened publish path".

---

## 5. Git conventions

- **Conventional Commits:** `type(scope): summary` — e.g. `fix(gaps): retry only on pre-Enter failed`, `feat: campaign plan mode`. Reference audit ranks where relevant.
- **Branch off the default branch** before committing when asked to commit.
- **Commit and push ONLY when the owner explicitly asks.** Do not commit proactively.
- **Do not skip hooks or bypass signing** (`--no-verify`, `--no-gpg-sign`, etc.) unless explicitly requested. If a hook fails, fix the cause.

---

## 6. Environment rules

- Develop and test in the **DEV CLONE at `C:\zpost\za-post`** (userData `za-post-restored`). **Never** test against the owner's installed production copy at **`C:\Za-Post-App`** — updating that is the owner's call.
- **Robustness > security** whenever the two compete. This is a deliberate stance — see **ADR-0017**. Don't "harden" in a way that makes a big end-to-end run less reliable.
- The owner runs a **real Moroccan residential IP with no proxies**. Anti-detection is **identity = profile** with a **RAM-capped concurrency pool** — not proxy rotation. Design with that reality.
- Set FB accounts to **English**. Arabic detection is only a fallback path.
- **Do NOT probe or contact the license-server infrastructure.**
- **Smoke-test packaged builds under an isolated `--user-data-dir`** so they never touch dev userData.

---

## 7. Where the knowledge lives

Two engineering references are authoritative and should be read alongside this handbook:

- **`INVARIANTS.md`** — the anti-regression contract at the repo root: the enumerated list of guarantees the code must never break (the double-post / double-comment traps and friends, see [§8](#8-sacred-invariants)). If you're changing posting/commenting/pool code, read it *first* and record any new invariant you're relying on rather than leaving it implicit.
- **`docs/decisions/`** — the **ADR log** (Architecture Decision Records). Each ADR captures *why* a decision was made and what it traded off (e.g. **ADR-0017** robustness > security; **ADR-0001/0005** the identity=profile anti-detect strategy; **ADR-0004** licensing; **ADR-0006** the comment post-ID trust anchor; **ADR-0011** moderator approval).

**Adding a new ADR**

1. Copy the numbering convention: `docs/decisions/ADR-XXXX-short-title.md`, next sequential number.
2. Use the standard skeleton: **Context** (the forces at play) → **Decision** (what we chose) → **Consequences** (what it costs us, what it buys us) → **Status** (Proposed / Accepted / Superseded-by).
3. Write it when you make a decision a future engineer would otherwise second-guess or silently reverse — especially any decision that touches a sacred invariant or the robustness-vs-security trade. Reference the ADR number in your commit and CHANGELOG.

---

## 8. Sacred invariants

These are the guarantees that, if broken, cause real-world harm. **A change touching any of them requires the adversarial multi-agent verify from [§1](#1-the-change-loop) step 3 — code inspection alone is not enough.**

Never weaken the double-post / double-comment traps:

- `markDelivered` / `alreadyDelivered`
- `_cycleDelivered`
- `publishClicked`
- `waitForPublish`
- **retry-only-on-pre-Enter-`'failed'`** (a retry must never fire once Enter has been pressed — that's the whole point)

Crash and rotation safety (including **crash-mid-pool**) is part of this set: those tests must pass **unchanged**, not be "adjusted" to go green.

If a fix seems to require touching one of these, that is the signal to slow down, run the full adversarial loop, and record an ADR if the behavior's contract is changing.

---

## 9. Documentation Map

The repo has accumulated a lot of docs across the build-out. Here's what each one *is*, whether to trust it, and what to do with it. Categories: **reference**, **architecture**, **operator-guide**, **setup-guide**, **spec**, **audit**, **plan-roadmap**, **status-snapshot**.

### Front-door & reference

| Doc | Category | Status | What to do with it |
|---|---|---|---|
| `README.md` | reference | aging | **Refresh.** Keep as the front-door entry point. Correct the stale "License is a permissive local stub / no validation server" note — licensing **is** implemented (see `ENV.md` / ADR-0004). De-emphasize the King/Base restoration-era migration framing. |
| `DOCS.md` | reference | aging | **Refresh.** Still the best single "how it works" reference. Bump version 1.0.0 → 1.0.12, correct the licensing section, and add the Standby / Daily-Rotation / Campaign-Plan / moderation features it omits (all covered in OPERATOR-GUIDE). |
| `ENV.md` | reference | **current** | **Keep authoritative.** Newest, internally consistent reference for env vars, build config, and the license-tier table. The README / DOCS / CODEBASE_MAP licensing sections should be reconciled *against this*. |
| `CODEBASE_MAP.md` | architecture | stale | **Refresh.** Authoritative for module-level orientation but a 2026-06-20 snapshot. Update the licensing sections (`get-license-info` is no longer a permissive stub) and reconcile its §8 risk table against `AUDIT.md` / the invariant set — or explicitly stamp it point-in-time. |

### Operator-facing

| Doc | Category | Status | What to do with it |
|---|---|---|---|
| `OPERATOR-GUIDE.md` | operator-guide | **current** | **Keep authoritative.** The canonical operator-facing doc; reflects the newest feature set (Standby, Daily Rotation, Campaign Plan, moderation, Turbo, Completion mode). **Supersedes OPERATIONS.md.** |
| `OPERATIONS.md` | operator-guide | stale | **Merge into OPERATOR-GUIDE.** A strict subset framed around the retired King/Base workspace. Fold its still-unique bits (prep-accounts / sync-memberships workflow, scripts reference, launch commands) into OPERATOR-GUIDE.md (or a DEV doc), then archive. |
| `BIG-TEST-RUNBOOK.md` | operator-guide | aging | **Refresh.** One of the few genuinely operator-authoritative runbooks. Strip the hard-coded 24-posters / 5-IPs / 8-posts example into generic form, drop the stale "Moderator approval is currently OFF", and confirm against v1.0.12. |
| `SETUP-PROXIES-MODERATOR.md` | setup-guide | **current** | **Keep authoritative.** Operator how-to for proxies (one per account, fail-closed) and the moderator admin account. Optionally cross-link to `iproyal-proxy-guide` for the buying step. |
| `SETUP-RDP.md` | operator-guide | **current** | **Keep authoritative.** Self-contained, version-independent fix for the RDP-disconnect vs off-screen-Chromium gotcha (tscon keepalive). Authoritative for its niche. |
| `docs/iproyal-proxy-guide.md` | setup-guide | **current** | **Keep authoritative.** Vendor-specific buy-and-fill companion (which iProyal product, how to format the proxy string). Minor acceptable overlap with SETUP-PROXIES-MODERATOR at a different altitude. |
| `docs/ROLLOUT-400.md` | operator-guide | aging | **Refresh.** The 400-account deployment runbook, still authoritative on process (license-first, import, proxy = parallelism). Update the stale v1.0.2/1.0.3 references; re-verify the pack command and license-server host against current `lib/license.js`. |

### Audit & roadmap

| Doc | Category | Status | What to do with it |
|---|---|---|---|
| `AUDIT.md` | audit | aging | **Keep authoritative.** The robustness / exactly-once / concurrency test-plan reference. Annotate which P1 items already landed in 1.0.12 so open vs closed is clear. |
| `COMPLETION_PLAN.md` | plan-roadmap | aging | **Keep authoritative.** The "what's left to ship" roadmap. Add a status column marking landed milestones (licensing M1-05/06, ENV.md M4-08, HTTPS / health / bearer / encryption) so a new engineer doesn't redo finished work. |
| `docs/PERSONA-ROADMAP.md` | plan-roadmap | **current** | **Keep authoritative.** Dated 2026-07-01 forward-looking strategy memo — the authoritative WHY behind the anti-detect / proxy strategy (ADR-0001/0005) and future persona direction. Correctly reads as a memo. |
| `docs/ship-hardening.md` | plan-roadmap | stale | **Refresh.** Reconcile the `DEFAULT_SERVER` story (it lists the raw IP + Coolify env URL) with the license host now in `lib/license.js:21` — env-overridable with an HTTPS fallback: `process.env.LICENSE_SERVER_URL \|\| 'https://lisence.ibnbatoutaweb.com'` (the domain is literally spelled `lisence`), not a fixed constant. Mark which hardening layers actually shipped vs remain optional. |
| `docs/never-stop-and-batch-content.md` | plan-roadmap | aging | **Mark-historical (split).** The pacing / never-stop sections are shipped (historical). Verify the unbuilt "batch = groups + agents + content" feature is still unbuilt (grep `data.json` for `batches`); if so, keep that section as the live batch design record. |

### Specs (design records — mostly implemented)

| Doc | Category | Status | What to do with it |
|---|---|---|---|
| `CORE_ENHANCEMENT_SPEC.md` | spec | historical | **Mark-historical.** Pre-implementation build plan for posting / proxy / orchestration hardening (shipped by 1.0.12). Banner: "Historical — implemented; see CODEBASE_MAP.md for current state." |
| `COMMENT_TARGETING_SPEC.md` | spec | historical | **Keep as authoritative historical record.** The fuller, later comment-targeting design (post-ID trust anchor, ADR-0006). Absorb COMMENT_ROBUSTNESS_SPEC; add an "implemented" banner. Still useful for the exact log lines to grep. |
| `COMMENT_ROBUSTNESS_SPEC.md` | spec | historical | **Merge into COMMENT_TARGETING_SPEC.** The earlier caption-match iteration, superseded by the post-ID-anchor spec. Fold into one historical "comment-targeting evolution" note and archive. |
| `HUMANIZE_TIMING_SPEC.md` | spec | historical | **Mark-historical.** Pre-implementation timing plan (shipped). The min/max settings-schema table is the one piece with lasting value — extract it into a live settings reference if wanted. |
| `MODERATOR_APPROVAL_SPEC.md` | spec | historical | **Mark-historical.** Pre-implementation design for the moderator feature (shipped, ADR-0011). Keep as the engineer "why"; point operators to SETUP-PROXIES-MODERATOR.md. |
| `RELIABILITY_HIDE_SPEC.md` | spec | historical | **Mark-historical.** Pre-implementation hide-mode + publish-reliability build note (shipped). The "Dropped as risky" section and the hidden-while-in-use test procedure retain some value. |

### Status snapshot

| Doc | Category | Status | What to do with it |
|---|---|---|---|
| `HANDOFF.md` | status-snapshot | historical | **Mark-historical.** A first-person 2026-06-19..20 session log referencing dead workspace paths and v1.0.0. Banner it as a point-in-time record of *why* hidden-mode / anti-spam decisions were made — **not** current status. |

**Rule of thumb when the docs disagree:** `ENV.md` wins on env/build/licensing, `OPERATOR-GUIDE.md` wins on operator workflow, `CODEBASE_MAP.md` wins on module layout (once refreshed), `INVARIANTS.md` + `docs/decisions/` win on *why*. This handbook wins on *how we work*.

---

## 10. Quick reference

```bash
# Tests (both must pass before packaging)
npm test                              # node --test "tests/**/*.test.js" — 270 tests
npm run test:antispam                 # scripts/test-antispam.js

# Package an enforced client build
ENFORCE_LICENSE=1 npm run pack:portable   # -> dist/<product>-<ver>-portable.zip
#   (omit ENFORCE_LICENSE=1 for an unlimited owner/dev build)

# Verify the enforce marker made it into the bundle (sibling of app.asar, not inside it)
dir "<extracted>\resources\enforce-license.flag"
# Confirm the license WIRING inside app.asar (not the flag)
npx asar extract "<extracted>\resources\app.asar" C:\zpost\_asar-check

# Smoke-test the zip WITHOUT touching dev userData
"<extracted>\Za Post Comment Tool.exe" --user-data-dir="C:\zpost\_smoketest-userdata"
```

- **Dev clone:** `C:\zpost\za-post` (userData `za-post-restored`) — work here.
- **Production copy:** `C:\Za-Post-App` — **never touch.**
- **Current version:** 1.0.56 (patch-bump the 1.0.x line for hardening batches).
- **License server must be live before shipping an enforced build.**
- **Ship only the newest zip; delete the rest.**
