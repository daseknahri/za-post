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
