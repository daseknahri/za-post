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
