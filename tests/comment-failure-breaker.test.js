// tests/comment-failure-breaker.test.js
// THE COMMENT-SIDE BREAKER — the guard the comment path never had.
//
// OPERATOR-REPORTED: an account kept POSTING while its comments never landed. Only an explicitly DETECTED wall
// (blocked_comment / blocked_account — FB's red text) ever rested an account. Every other comment failure — 'failed'
// (no comment box), 'error', 'timeout', 'notfound' (submitted but never visible = silently dropped / shadow-suppressed)
// — just returned, and the account moved to its next group and posted again. So a comment-suppressed account burned its
// whole daily cap manufacturing posts with NO link-comment.
//
// Why that is the worst outcome for this product: the link IS the payload. A link-less post has ZERO value while still
// consuming the daily cap, adding shared-IP ban exposure, and queueing orphan-comment rescue work. Posting more is
// strictly negative EV — so stop the account.
//
// Mirrors mixedPushbackDecision (the posting twin) exactly: same threshold, same transient/block split.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { commentFailureDecision, mixedPushbackDecision } = require('../automation/worker');

test('below the threshold → no decision (an isolated hiccup must never stop an account)', () => {
  for (const n of [0, 1, 2]) {
    assert.equal(commentFailureDecision(n, false), null, `${n} consecutive failures is not a pattern`);
    assert.equal(commentFailureDecision(n, true), null);
  }
});

test('3 in a row with a comment landed earlier this run → TRANSIENT (stop this cycle, no rest)', () => {
  assert.equal(commentFailureDecision(3, true), 'transient', 'it CAN comment (it did), so this reads as an FB hiccup — stop posting link-less, but do not burn a rest');
  assert.equal(commentFailureDecision(9, true), 'transient');
});

test('3 in a row with NOTHING landed this run → BLOCK (FB is suppressing → rest on the comment ladder)', () => {
  assert.equal(commentFailureDecision(3, false), 'block', 'never landed a comment + 3 failures ⇒ suppressed; every further post would go live WITHOUT its link');
  assert.equal(commentFailureDecision(99, false), 'block');
});

test('the streak RESETS on a landed comment (only a SUSTAINED inability trips it)', () => {
  // The caller resets consecCommentFails to 0 on _commentLanded; simulate that contract.
  let streak = 0;
  const onResult = (landed) => { if (landed) streak = 0; else streak++; return commentFailureDecision(streak, false); };
  assert.equal(onResult(false), null);   // 1
  assert.equal(onResult(false), null);   // 2
  assert.equal(onResult(true), null);    // landed → reset
  assert.equal(onResult(false), null);   // 1 again — must NOT fire at the old count
  assert.equal(onResult(false), null);   // 2
  assert.equal(onResult(false), 'block'); // 3 in a row → fires
});

test('it is the exact twin of the posting breaker (same threshold + split — no divergent semantics)', () => {
  for (const n of [0, 1, 2, 3, 7]) {
    for (const today of [true, false]) {
      assert.equal(commentFailureDecision(n, today), mixedPushbackDecision(n, today), `n=${n} today=${today}: the two breakers must agree`);
    }
  }
});

test('a custom threshold is honored, and junk input never fires', () => {
  assert.equal(commentFailureDecision(2, false, 2), 'block', 'threshold is tunable');
  assert.equal(commentFailureDecision(1, false, 2), null);
  for (const junk of [undefined, null, NaN, 'x', -5]) {
    assert.equal(commentFailureDecision(junk, false), null, `junk ${JSON.stringify(junk)} must never trip the breaker`);
  }
});

// ===============================================================================================================
// THE PREDICATE SPLIT — v1.0.118 reused _commentLanded and made the breaker BLIND to the very class it exists for.
//
// _commentLanded answers "was Enter PRESSED?" (it drives rescue routing, where re-queuing a maybe-placed comment is a
// DOUBLE-COMMENT = the ban axis), so it deliberately counts 'unconfirmed' and 'not_visible' as landed. Correct there.
// The breaker asks a DIFFERENT question: "did a comment actually become VISIBLE?" addFirstComment returns 'not_visible'
// when the box emptied but a re-scan PROVED our text is not under the post — the shadow-suppression signature. As a
// "success" it reset the streak AND latched commentedToday=true forever, so the breaker could never fire again.
// ===============================================================================================================
const { commentOutcomeClass } = require('../automation/worker');

test('not_visible is a LOSS — it is the shadow-suppression signature, not a success', () => {
  assert.equal(commentOutcomeClass('not_visible'), 'lost',
    'the re-scan PROVED our comment is not under the post: no value was produced. v1.0.118 counted this as landed, which reset the streak and blinded the breaker to exactly the case it was written for.');
});

test('only a VERIFIED-visible comment counts as landed', () => {
  for (const c of ['posted', 'already_present', 'blocked_account_landed', 'blocked_comment_landed']) {
    assert.equal(commentOutcomeClass(c), 'landed', `${c} produced a real, visible comment`);
  }
});

test('every silent failure mode is a LOSS (these are what let the account keep posting link-less)', () => {
  for (const c of ['failed', 'error', 'timeout', 'skipped', 'unplaced', 'blocked_comment', 'blocked_account', 'blocked_login', 'blocked_checkpoint']) {
    assert.equal(commentOutcomeClass(c), 'lost', `${c} produced no visible comment`);
  }
});

test('unconfirmed + none are UNKNOWN — neither increment nor reset', () => {
  assert.equal(commentOutcomeClass('unconfirmed'), 'unknown',
    'instant/max mode skips the confirm re-scan by design, so nearly every outcome is unconfirmed: counting it as a LOSS would rest every account instantly; counting it as a WIN would blind the breaker (the v1.0.118 bug).');
  assert.equal(commentOutcomeClass('none'), 'unknown', 'no comment was wanted — never an attempt');
});

test('losses accumulate ACROSS unknowns (the instant-mode case still trips)', () => {
  let streak = 0;
  const feed = (c) => { const k = commentOutcomeClass(c); if (k === 'landed') streak = 0; else if (k === 'lost') streak++; return commentFailureDecision(streak, false); };
  assert.equal(feed('not_visible'), null);   // 1
  assert.equal(feed('unconfirmed'), null);   // unknown → must NOT reset
  assert.equal(feed('not_visible'), null);   // 2
  assert.equal(feed('unconfirmed'), null);   // unknown
  assert.equal(feed('not_visible'), 'block'); // 3 → trips despite the unknowns between
});

test('a genuinely landed comment still resets the streak (an isolated hiccup never rests an account)', () => {
  let streak = 0;
  const feed = (c) => { const k = commentOutcomeClass(c); if (k === 'landed') streak = 0; else if (k === 'lost') streak++; return commentFailureDecision(streak, false); };
  feed('not_visible'); feed('failed');
  assert.equal(feed('posted'), null, 'a verified comment clears the streak');
  assert.equal(feed('failed'), null, 'and the count restarts from 1, not 3');
});

test('an unknown outcome NEVER latches the transient signal (which downgraded later real streaks to no-rest)', () => {
  // v1.0.118: 'not_visible' set anyCommentLanded=true (write-once), so a LATER genuine 3x streak returned 'transient'
  // (stop, no rest) instead of 'block' (rest). Only a real landing may arm it.
  let armed = false;
  for (const c of ['not_visible', 'unconfirmed', 'failed', 'timeout']) {
    if (commentOutcomeClass(c) === 'landed') armed = true;
  }
  assert.equal(armed, false, 'no unverified/lost outcome may arm the transient signal');
  assert.equal(commentFailureDecision(3, armed), 'block', 'so a suppressed account is RESTED, not merely paused');
});

// ===============================================================================================================
// PERSISTED COMMENT HEALTH — observed LIVE, not theorised.
//
// A 2-group account (e2) posted 2 posts per cycle, BOTH live without their link ("1 same-caption post in the feed and
// can't confirm which is OURS"), queued them for rescue, and the rescue could not cover them ("no free healthy in-group
// account"). It then did it again the next cycle, forever: 211s of work per cycle for ZERO value, full daily-cap burn,
// full shared-IP ban exposure.
//
// The in-worker breaker could never stop it: consecCommentFails is a run-local reset every cycle, so an account with
// FEWER GROUPS THAN THE THRESHOLD can never reach 3 within one cycle. The streak must persist ACROSS cycles.
// ===============================================================================================================

test('[live] a 2-group account accumulates comment losses ACROSS cycles and trips at 3', () => {
  // Mirrors _recordAccountOutcome's contract: any landed comment clears; losses accumulate.
  let acc = { commentFails: 0 };
  const cycle = (lost, landed) => {
    if (landed) acc.commentFails = 0;
    else if (lost > 0) acc.commentFails = (acc.commentFails || 0) + lost;
    return (acc.commentFails || 0) >= 3;
  };
  assert.equal(cycle(2, false), false, 'cycle 1: 2 groups → 2 losses. The in-run breaker (threshold 3) can NEVER fire here — this is the bug');
  assert.equal(cycle(2, false), true, 'cycle 2: 4 total → trips. Without persistence it would post link-less forever');
});

test('[live] any landed comment clears the persisted streak (an isolated hiccup must not rest an account)', () => {
  let acc = { commentFails: 2 };
  const cycle = (lost, landed) => {
    if (landed) acc.commentFails = 0;
    else if (lost > 0) acc.commentFails = (acc.commentFails || 0) + lost;
    return (acc.commentFails || 0) >= 3;
  };
  assert.equal(cycle(1, true), false, 'a cycle that landed a comment clears it, even though it also lost one');
  assert.equal(acc.commentFails, 0);
  assert.equal(cycle(2, false), false, 'and the count restarts from scratch, not from the old 2');
});

test('[live] a healthy account is never touched by the persisted counter', () => {
  let acc = { commentFails: 0 };
  for (let i = 0; i < 10; i++) { if (true) acc.commentFails = 0; } // every cycle lands a comment
  assert.equal(acc.commentFails, 0, 'an account whose comments land never accumulates');
});

// ── REAL _recordAccountOutcome across cycles — the tests above SIMULATE the accumulator inline, so they passed while
// the real code wiped the rest. These drive the actual orchestrator + store and would have caught the collision:
// the comment breaker set rateLimitedUntil at :1587, then the "recovered → clear" branch at :1650 (a commentless
// account still satisfies posted>0 && !flag) wiped it in the SAME store.update — leaving the account posting
// commentless forever. Proven at runtime (8 cycles of lost comments → 0 surviving rests) before the fix.
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/store');
const { Orchestrator } = require('../automation/orchestrator');

// Drive N cycles of an account (with `groups` groups) through the REAL _recordAccountOutcome, skipping a cooling cycle
// exactly as the live pre-launch gate does. Each posting cycle loses `lossesPerCycle` comments (a realistic all-fail
// cycle is lossesPerCycle === groups). Returns {cyclesPosted, rested} — how many cycles posted before it actually rested.
async function runCommentCycles(perCycle, n, groups = 2) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cbrk-'));
  try {
    store.init(tmp);
    const assignedGroups = Array.from({ length: groups }, (_, i) => 'g' + (i + 1));
    store.save({ posts: [], groups: [], accounts: [{ name: 'x', assignedGroups, enabled: true, status: 'logged_in', daily: {} }], settings: {}, proxies: [] });
    const o = new Orchestrator(() => {}, {});
    let cyclesPosted = 0, everRested = false;
    for (let c = 0; c < n; c++) {
      const cur = store.load().accounts.find((a) => a.name === 'x');
      if ((Number(cur.rateLimitedUntil) || 0) > Date.now()) continue; // cooling → the pool skips it (no browser, no post)
      await o._recordAccountOutcome('x', { posted: 1, pendingApproval: 0, errors: 0, flag: null, postedIds: [], dealtIds: [], ...perCycle }, { rateLimitCooldownHours: 4 });
      cyclesPosted++;
      if ((Number(store.load().accounts.find((a) => a.name === 'x').rateLimitedUntil) || 0) > Date.now()) everRested = true;
    }
    return { cyclesPosted, rested: everRested };
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
}

test('[live·real] a comment-dead account ACTUALLY rests — the breaker survives the recovered-clear (the bug)', async () => {
  // Every cycle: posts fine, comment LOST. Before the fix rateLimitedUntil was set at :1587 then wiped at :1650 in the
  // same write, so the account posted commentless forever. Now the rest survives and the pool skips it.
  const r = await runCommentCycles({ commentLost: 1, commentLanded: false }, 8, 2);
  assert.ok(r.rested, 'the account MUST actually rest once its comments stop landing — otherwise it posts commentless forever');
});

test('[live·real] group-aware threshold: a 2-group account rests after ONE fully-failed cycle (2 commentless, not 4)', async () => {
  // The operator's fleet is 2-group accounts. A realistic all-fail cycle loses BOTH comments → commentFails hits the
  // group-aware threshold (2) in ONE cycle, halving the pre-rest exposure vs the old flat 3 (which needed 2 cycles).
  const r = await runCommentCycles({ commentLost: 2, commentLanded: false }, 8, 2);
  assert.ok(r.rested, 'a 2-group account whose comments all fail must rest');
  assert.equal(r.cyclesPosted, 1, 'it rests after ONE fully-failed cycle — 2 commentless posts, not 4');
});

test('[live·real] group-aware threshold: a wide (3-group) account keeps the original confidence (threshold 3)', async () => {
  // Cap at 3: a wide account still needs 3 losses, so a single dropped comment among many never rests it.
  const r1 = await runCommentCycles({ commentLost: 3, commentLanded: false }, 8, 3);
  assert.equal(r1.cyclesPosted, 1, 'a 3-group all-fail cycle (3 losses) rests after one cycle');
  const r2 = await runCommentCycles({ commentLost: 1, commentLanded: false }, 2, 5); // 1 loss/cycle × 2 cycles = 2 losses
  assert.ok(!r2.rested, 'a 5-group account with only 2 accumulated losses stays UNDER threshold 3 — an isolated drop never rests a wide account');
});

test('[live·real] an UNCONFIRMED comment (max-mode, unknown) never rests a healthy account (no false positive)', async () => {
  // In speedMode=max the confirm re-scan is skipped, so most comments are 'unconfirmed' → commentLost:0, commentLanded:false
  // (neither a win nor a loss). Such an account is posting fine and MUST NOT be rested, or max mode would bench the fleet.
  const r = await runCommentCycles({ commentLost: 0, commentLanded: false }, 10, 2);
  assert.ok(!r.rested, 'an unconfirmed (unknown) comment outcome must never accumulate a rest');
  assert.equal(r.cyclesPosted, 10, 'the account keeps working every cycle (nothing is actually failing)');
});

test('[live·real] comments recovering clears the rest — a healthy account is not stuck resting', async () => {
  // Rest the account (2 lost cycles → trips), then feed a landed comment: rlStrikes/rateLimitedUntil must clear so a
  // recovered account rejoins rather than ratcheting forever.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cbrk-'));
  try {
    store.init(tmp);
    store.save({ posts: [], groups: [], accounts: [{ name: 'x', assignedGroups: ['g1', 'g2'], enabled: true, status: 'logged_in', daily: {} }], settings: {}, proxies: [] });
    const o = new Orchestrator(() => {}, {});
    const rec = (r) => o._recordAccountOutcome('x', { posted: 1, pendingApproval: 0, errors: 0, flag: null, postedIds: [], dealtIds: [], ...r }, { rateLimitCooldownHours: 4 });
    await rec({ commentLost: 1, commentLanded: false });
    await rec({ commentLost: 1, commentLanded: false });
    await rec({ commentLost: 1, commentLanded: false }); // trips → rested
    // force the cooldown into the past to simulate its expiry, then a clean (comments-landing) cycle
    await store.update((d) => { const a = d.accounts.find((x) => x.name === 'x'); if (a) a.rateLimitedUntil = Date.now() - 1000; });
    await rec({ commentLost: 0, commentLanded: true });
    const acc = store.load().accounts.find((a) => a.name === 'x');
    assert.equal(Number(acc.rateLimitedUntil) || 0, 0, 'a landed comment after the rest expires clears the cooldown');
    assert.equal(Number(acc.rlStrikes) || 0, 0, 'and clears the strike ladder — the account is fully recovered');
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
});
