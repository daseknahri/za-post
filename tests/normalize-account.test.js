// tests/normalize-account.test.js
// store.normalize() runs every account through normalizeAccount — the DI-3/DI-4 data-integrity coercions that stop a
// hand-edited / torn / partially-migrated data.json from breaking the daily-cap + cool-down math:
//   • a NaN/string/negative daily.count must not disable or skew the cap;
//   • a malformed daily.date must not freeze the cap on a stale day;
//   • a CORRUPT far-future cooldown (rateLimitedUntil / nextAttnRetry) must NOT block an account forever;
//   • strike counters (rlStrikes + the v1.0.53 attnStrikes) must floor to a non-negative integer.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const store = require('../lib/store');
const norm1 = (acct) => store.normalize({ accounts: [acct], settings: {} }).accounts[0];

test('daily.count: string→number, negative→0, NaN→0; malformed date reset', () => {
  assert.deepEqual(norm1({ name: 'a', daily: { date: '2026-07-12', count: '7' } }).daily, { date: '2026-07-12', count: 7 });
  assert.deepEqual(norm1({ name: 'a', daily: { date: 'garbage', count: -5 } }).daily, { date: '', count: 0 });
  assert.deepEqual(norm1({ name: 'a', daily: { date: '2026-07-12', count: NaN } }).daily, { date: '2026-07-12', count: 0 }); // NaN would otherwise disable the cap
});

test('rateLimitedUntil / nextAttnRetry: corrupt far-future → 0 (never block an account forever); expired → 0; sane kept', () => {
  const farFuture = Date.now() + 10 * 365 * 24 * 3600 * 1000; // 10 years out = corrupt
  assert.equal(norm1({ name: 'a', rateLimitedUntil: farFuture }).rateLimitedUntil, 0, 'far-future cooldown cleared');
  assert.equal(norm1({ name: 'a', nextAttnRetry: farFuture }).nextAttnRetry, 0, 'far-future attn-rest cleared');
  assert.equal(norm1({ name: 'a', rateLimitedUntil: Date.now() - 3600 * 1000 }).rateLimitedUntil, 0, 'expired cooldown cleared');
  const soon = Date.now() + 3600 * 1000; // a valid ~1h cooldown
  assert.equal(norm1({ name: 'a', rateLimitedUntil: soon }).rateLimitedUntil, soon, 'a sane near-future cooldown is kept intact');
});

test('rlStrikes / attnStrikes: floored to a non-negative integer', () => {
  assert.equal(norm1({ name: 'a', rlStrikes: -3 }).rlStrikes, 0);
  assert.equal(norm1({ name: 'a', rlStrikes: 2.9 }).rlStrikes, 2);
  assert.equal(norm1({ name: 'a', attnStrikes: '4' }).attnStrikes, 4); // v1.0.53 field
  assert.equal(norm1({ name: 'a', attnStrikes: NaN }).attnStrikes, 0);
});
