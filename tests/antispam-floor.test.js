// tests/antispam-floor.test.js — the HARD anti-spam floors guarantee that the fastest mode / lowest setting can
// never burst-post: the between-group gap and the post→comment gap always stay above a randomized safety floor.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { withFloor, rangeMs, ANTI_SPAM_MIN_GROUP_MS, ANTI_SPAM_MIN_COMMENT_MS } = require('../automation/worker');

test('withFloor: a 0/1s configured gap is lifted to ~the floor (randomized, never instant)', () => {
  for (let i = 0; i < 200; i++) {
    const v = withFloor(1000, ANTI_SPAM_MIN_GROUP_MS);
    assert.ok(v >= ANTI_SPAM_MIN_GROUP_MS * 0.7, `floor holds (got ${v})`); // jitter ±25% → never below ~0.75×
    assert.ok(v <= ANTI_SPAM_MIN_GROUP_MS * 1.35, `floor not wildly over (got ${v})`);
  }
});

test('withFloor: a generous configured gap passes through untouched', () => {
  const big = 200000; // 200s — well above the floor
  assert.equal(withFloor(big, ANTI_SPAM_MIN_GROUP_MS), big);
});

test('withFloor: floor is randomized (not a fixed cadence)', () => {
  const vals = new Set();
  for (let i = 0; i < 50; i++) vals.add(withFloor(0, ANTI_SPAM_MIN_COMMENT_MS));
  assert.ok(vals.size > 5, 'the floor itself jitters across calls');
});

test('super-fast config (groupDelay 0/0) still clears the group floor', () => {
  const s = { groupDelayMin: 0, groupDelayMax: 0 };
  for (let i = 0; i < 100; i++) {
    const gap = withFloor(rangeMs(s, 'groupDelayMin', 'groupDelayMax', 120, 300, 120), ANTI_SPAM_MIN_GROUP_MS);
    assert.ok(gap >= ANTI_SPAM_MIN_GROUP_MS * 0.7, `even 0/0 config can't burst (got ${gap}ms)`);
  }
});

test('comment floor ≥ group floor (instant post→link is the stronger signal)', () => {
  assert.ok(ANTI_SPAM_MIN_COMMENT_MS >= ANTI_SPAM_MIN_GROUP_MS);
});
