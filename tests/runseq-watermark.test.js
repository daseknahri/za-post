// tests/runseq-watermark.test.js
// [#6/#7] THE R5 CLEAN-COMMIT WATERMARK (icommit / _inflightSeq).
//
// #6 — v1.0.115 made the journal sequence run-local and returned it as res.runSeq, but the POOL rebuilds `res`
// field-by-field from the _runAccount result. runSeq was not in that rebuild, so res.runSeq was ALWAYS undefined and
// icommit was committed as `undefined`. watermark() coerces with `|| 0`, so EVERY journal line stayed a survivor (q > 0)
// forever: the clean commit was never recorded and a crash-fold would re-apply already-committed deliveries.
//
// #7 — once runSeq actually flows, the plain-replace commit becomes dangerous: _splitCover runs N stand-ins against the
// SAME forAgent, sharing ONE icommit field. A LOW-seq sibling returning last would REGRESS the watermark, resurrecting a
// high-seq sibling's committed lines as survivors → the fold re-applies them → re-post. Both commits are now monotonic.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// The exact shape the pool commits (mirrors the two call sites).
const commitIcommit = (prevIcommit, runSeq) => Math.max(prevIcommit || 0, Number(runSeq) || 0);
// The survivor test the crash-fold applies.
const survives = (q, icommit) => (Number(q) || 0) > (icommit || 0);

test('[#6] a committed watermark actually supersedes this run\'s lines (undefined runSeq made every line survive forever)', () => {
  const runSeq = 7;
  const icommit = commitIcommit(0, runSeq);
  assert.equal(icommit, 7, 'the run\'s seq must reach the pointer record');
  assert.equal(survives(7, icommit), false, 'this run\'s own line (q=7) is superseded → the fold is a no-op for it');
  assert.equal(survives(8, icommit), true, 'a LATER uncommitted line (q=8) still survives → a hard kill is still recovered');
  // The v1.0.115 bug: res.runSeq undefined → icommit undefined → watermark()'s `|| 0` → everything survives.
  const broken = Math.max(0, Number(undefined) || 0);
  assert.equal(survives(7, broken), true, 'PROOF the old shape was broken: with a dropped runSeq the committed line still "survives" → the fold re-applies a delivery that already happened');
});

test('[#7] icommit is MONOTONIC — a late LOW-seq split-cover sibling cannot regress the watermark', () => {
  // R1 (seq 5) and R2 (seq 6) split-cover the SAME forAgent; R2 returns first, R1 last.
  let icommit = 0;
  icommit = commitIcommit(icommit, 6);   // R2 commits
  assert.equal(icommit, 6);
  icommit = commitIcommit(icommit, 5);   // R1 returns LAST with the lower seq
  assert.equal(icommit, 6, 'a plain replace would drop it to 5, resurrecting R2\'s committed q=6 line as a survivor → the fold re-applies R2\'s delivery → re-post');
  assert.equal(survives(6, icommit), false, 'R2\'s delivery stays superseded regardless of return order');
});

test('[#7] a missing runSeq (the supervisor catch path) is a NO-OP, never a zeroing', () => {
  assert.equal(commitIcommit(9, undefined), 9, 'a crashed run with no runSeq must not erase a good watermark');
  assert.equal(commitIcommit(9, null), 9);
  assert.equal(commitIcommit(9, NaN), 9);
  assert.equal(commitIcommit(0, undefined), 0, 'and it does not invent one');
});
