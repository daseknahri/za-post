// tests/spintax.test.js
// M4-01: spintax variant counting, including the nested-alternation overcount bug fix. The
// cross-check enumerates real expansions and asserts the count matches.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const spintax = require('../lib/spintax');

test('variantCount: flat templates multiply option counts', () => {
  assert.equal(spintax.variantCount('{a|b|c} {x|y}'), 6);
  assert.equal(spintax.variantCount('{Hello|Hi|Hey} {there|all}, {check out|see} our {deal|offer}!'), 24);
  assert.equal(spintax.variantCount('no spintax'), 1);
});

test('variantCount: nested alternation SUMS options (overcount bug fixed)', () => {
  assert.equal(spintax.variantCount('{a|{b|c}}'), 3);        // {a,b,c} — old code gave 4
  assert.equal(spintax.variantCount('{a|b|{c|d|e}}'), 5);    // {a,b,c,d,e}
  assert.equal(spintax.variantCount('{{a|b}|{c|d}}'), 4);    // {a,b,c,d}
  assert.equal(spintax.variantCount('{a|{b|c}{d|e}}'), 5);   // a + (b|c)(d|e) = 1 + 4
});

test('variantCount: literal braces (no pipe) are not groups', () => {
  assert.equal(spintax.variantCount('a {literal} brace'), 1);
  assert.equal(spintax.variantCount('{{a|b}}'), 2); // outer braces literal, inner is the only group
});

test('variantCount equals the number of distinct expansions (cross-check)', () => {
  for (const tpl of ['{a|b|c}', '{a|{b|c}}', '{a|b} {c|d}', '{a|{b|c}{d|e}}', 'plain text']) {
    const seen = new Set();
    for (let k = 0; k < 6000; k++) seen.add(spintax.expand(tpl));
    assert.equal(seen.size, spintax.variantCount(tpl), `distinct expansions of "${tpl}"`);
  }
});
