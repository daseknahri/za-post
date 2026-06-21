# za-post — End-to-end robustness audit & test plan

> From a 41-agent end-to-end audit (10 subsystems × find-gaps + adversarial-verify P0/P1 + synthesis). 88 gaps (0 P0, 30 P1, 58 P2), 81 test scenarios. Recon only — nothing was modified.

## 0. Verdict
The operation is solid and production-credible today: the exactly-once spine (rotation deal-state + `publishClicked` guard + comment `submitted` flag), atomic file writes with `.bak` recovery, dynamic account pool, watchdog with sleep-resume, and pervasive timeout-capped CDP calls are all already in place and well-tested. The few things that most move it toward flawless are (1) closing the two **concurrency holes** where parallel accounts write `pcu-state.json` and the audit trail without serialization — the only real exactly-once / truth-of-record risks — and (2) eliminating **silent failure paths** (cookie-write, image-download, decryption, comment-confirmation) that succeed-or-skip without telling the operator why. Most remaining items are diagnostic polish and humanization variance, not correctness.

## 1. Robustness backlog (prioritized) — top items
| ID | Dim | Gap | Proposed addition | Eff | Double-post-safe |
|----|-----|-----|-------------------|-----|------------------|
| **DI-1** | data | Parallel accounts write `pcu-state.json` unserialized → lost-update can re-deal a published post | `store.updateRotation(mutator)` on a `_rotationChain`; `_persistDealt` async + awaited | M | Yes |
| **DI-2** | data | Parallel `appendReport` (JSONL+CSV) can interleave → corrupt audit | Route audit writes through `store.appendToReport` on a `_writeChain` | M | Yes |
| **ORCH-1** | orch | Crash between claim and dealt-persist re-deals a post to a 2nd account | Volatile `claims.json` + restart reconcile vs `run-report.jsonl` | M | Yes |
| **BOOT-1** | boot | Auto-resume doesn't validate rotation durability → empty dealt-set re-posts everything | Cross-check before resume; warn on empty/stale deal-set | M | Yes |
| **LOGIN-1** | login | `writeCookies` throw in `credentialLogin` swallowed → next run logged-out | Return `cookie_write_failed` → status error + relogin msg | S | n/a |
| **LOGIN-2** | login | `decrypt()` returns '' on unavailable encryption → silent `needs_login` | Return `{value,unavailable}`; actionable message | M | n/a |
| **OBS-1** | obs | Image download fails silently | `downloadImage` returns `{ok,reason,details}`; log url+postId+reason | S | n/a |
| **OBS-3** | obs | Comment failure reason not persisted to audit | `addFirstComment` returns `{outcome,reason}`; carry into report detail | S | Yes |
| **POST-1** | post | No liveness cap on `waitForPublish` polls → dead CDP hangs 90s | `withTimeout` each evaluate; return 'timeout' after 3 consecutive | M | Yes |
| **POST-2** | post | Caption present-but-hidden, checks time out → unverified publish | Pre-publish read-only re-read; empty → skip group | M | Yes |
| **RES-1** | res | Browser disconnect mid-comment burns a retry on a dead browser | `isConnected()` checks → 'failed' (pre-submit) / 'unconfirmed' (post) | S | Yes |
| **VER-1** | verify | Short-caption posts skip comment even with verified `expectedPostId` | Gate `(<12 && !permalink) && !expectedPostId`; id-only scanFeed | S | Yes |
| **VER-3** | verify | Feed-fallback uses first box even if not our post | Verify article id == expectedPostId before `boxes[0]` | M | Yes |
| **VER-4** | verify | Reply-to-user auto-focus → false `posted` | Require comment-count increment, not just box-emptied | M | Yes |
| **PROX-1/2** | proxy | Cooldown proxy re-picked; mid-run proxy errors never reported to health | Cooldown-aware selection + classify/report nav errors | M | n/a |
| **DI-3/4** | data | Corrupt `daily.count`/`rateLimitedUntil` silently disables a safety gate | Validate in `normalizeAccount` (floor/range-check) | S | n/a |

Full P2 set (HUMAN-1..4, BOOT-2..6, LOGIN-3..5, RES-2..7, VER-2/5/6, PROX-3/4, DI-5/6, STALL-1, OBS-2/4/5, POST-3) is in the workflow output — diagnostic/humanization polish.

## 2. Recommended implementation order
- **Wave 1 — concurrency & exactly-once (highest care):** DI-1, DI-2, then ORCH-1, then BOOT-1. Keep global `dealt` semantics, `_persistDealt` async **awaited**, preserve "halt run on write failure."
- **Wave 2 — silent-failure elimination (low risk):** LOGIN-1/2, OBS-1/3, RES-5, LOGIN-3/4, BOOT-2/4/5/6, DI-3/4.
- **Wave 3 — resilience & proxy health:** BOOT-3, RES-1/2/4/6, PROX-1+2, RES-3/7, PROX-3/4, DI-5/6.
- **Wave 4 — posting/verify hardening:** POST-1/2/3, VER-1/2/3/4/5/6.
- **Wave 5 — observability UI & humanization:** OBS-2/4/5, HUMAN-1/2/3/4.
- Extra-care (near the exactly-once / comment-submitted boundary): DI-1, ORCH-1, BOOT-1, POST-2, RES-1, VER-1/2/3/4 — gate each behind §4 regression checks.

## 3. Test plan
### 3a. Automated (npm test) gaps to add
store.test.js: concurrent updateRotation (10 merges, no lost id), concurrent appendToReport (10 parseable lines, CSV==JSONL), daily.count/-rateLimitedUntil validation, corrupt cookies.json, orphan-profile prune. orchestrator.test.js: ORCH-1 crash-before-publish re-deals to exactly one + single audit row, BOOT-1 corrupt-state resume blocked, STALL-1 multi-cause, RES-4 groupRetries reset. proxy.test.js: PROX-1 cooldown skip, PROX-2 407/tunnel report. secret.test.js: LOGIN-2 unavailable shape. New worker-*.test.js: LOGIN-1 cookie-write-fail, POST-1 evaluate-hang cap, POST-2 empty-caption skip, RES-1/OBS-3 disconnect outcome+reason, VER-1 short-caption id path. fb-detection.test.js: VER-6 broadened comment-box labels. main-boot.test.js: BOOT-3 run-active ordering, BOOT-6 setAccountStatus await.

### 3b. Manual smoke checklist (ordered — "check all")
1. Boot clean (no corruption warning). 2. Second instance exits (single-instance). 3. Boot with corrupt data.json → recovered-from-backup. 4. Speed preset save (group delay ≥120s floor). 5. Add account → logged_in. 6. Bad proxy string → actionable hint, flagged. 7. Small run (1 acct, 2 groups) → `Confirmed LIVE` + `Comment: posted and verified`. 8. Verify post+comment in FB. 9. Per-group summary at run end. 10. Hidden mode → no window, posts land, non-metronomic re-park. 11. Hidden + machine in use → unaffected, no focus-steal. 12. Visible mode → on-screen, posts land. 13. Stop mid-run → graceful drain + dealt persisted. 14. Resume → no dupes.

### 3c. Adversarial / failure-injection
Kill network mid-post → account held + resume. Kill network 45s after Post → ≤45s timeout + read-only rescan, no re-click. Kill browser mid-comment → pre-submit 'failed'/post-submit 'unconfirmed', no retry on dead browser. Expired cookies mid-loop → fast 'failed' + needs_login. Decryption unavailable → one clear log, error not silent. Cookie write ENOSPC → cookie_write_failed (not success). Bad/dead proxy → reportProxy(false) + cooldown + others unaffected. 404/non-image/SSRF image URL → specific reason, group skipped pre-Post. Moderated group → pending distinguished from not-visible, no re-comment. Another user posts identical caption during wait → id-mismatch refusal → skipped. Post deleted during wait → permalink 404 → feed fallback, no wrong-post. Slow connection → adaptive composer timeout + jittered retries + rescue. Reply-auto-focus after Enter → count must increment, no false posted. Laptop sleep mid-run → watchdog extends (no kill). Crash after one account persists dealt → no dupes on restart.

## 4. Invariants to protect (regression checks)
1. Exactly-once posting (`dealt` + `publishClicked`): DI-1 concurrent-merge test + `_persistDealt` rejection sets `_stop` + crash-restart no-dupes.
2. `publishClicked` set once, never reset: POST unit test asserts `clickPostButton` called once on timeout+failed-rescue; grep guard no path clears it.
3. Comment `submitted` → post-Enter non-retryable: worker-comment test asserts post-submit errors never return 'failed'; no type/Enter/click after submitted.
4. Audit truth-of-record parseable: concurrent-append test (JSONL==CSV); ORCH-1 falls back to "don't re-deal" if audit unreadable.
5. Headful + both hide modes (off-screen, no SwiftShader, GPU on): smoke 10–12 + launch assertion `headless===false` + occlusion/GPU flags unchanged.
6. Load-time normalization never disables a safety gate: store tests preserve valid future cooldown / valid daily.count while resetting absurd values.
