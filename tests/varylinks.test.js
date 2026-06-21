// tests/varylinks.test.js
// varyLinks must make a link UNIQUE per group (so Facebook doesn't dedupe it) WITHOUT changing where
// the link goes. The old version appended `?s=<hash>`, which is WordPress's SEARCH parameter — it
// turned a recipe URL into a search page, so the comment's link preview showed a different article.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const w = require('../automation/worker');

const firstUrl = (s) => new URL(s.match(/https?:\/\/[^\s]+/)[0]);

test('varyLinks: preserves the exact article URL (origin + path) and adds only utm_content', () => {
  const out = w.varyLinks('Try this https://recipes.panrecipe.com/boil-the-peel-of-a-radish today', 'acct|gid');
  const u = firstUrl(out);
  assert.equal(u.origin + u.pathname, 'https://recipes.panrecipe.com/boil-the-peel-of-a-radish', 'destination must be unchanged');
  assert.ok(u.searchParams.has('utm_content'), 'adds the uniqueness param');
  assert.equal(u.searchParams.has('s'), false, 'must NOT add the WordPress search param ?s=');
  assert.equal(u.searchParams.has('ref'), false);
});

test('varyLinks: never overwrites the user\'s own query params or fragment', () => {
  const u = firstUrl(w.varyLinks('https://site.com/article?s=real-slug&id=42#section', 'seed'));
  assert.equal(u.searchParams.get('s'), 'real-slug', 'user\'s own s= is preserved, not hijacked');
  assert.equal(u.searchParams.get('id'), '42');
  assert.ok(u.searchParams.has('utm_content'));
  assert.equal(u.hash, '#section', 'fragment preserved');
});

test('varyLinks: produces distinct URLs per group seed (FB dedupe avoidance) but same destination', () => {
  const a = firstUrl(w.varyLinks('https://x.com/recipe', 'acct|groupA'));
  const b = firstUrl(w.varyLinks('https://x.com/recipe', 'acct|groupB'));
  assert.notEqual(a.searchParams.get('utm_content'), b.searchParams.get('utm_content'));
  assert.equal(a.origin + a.pathname, b.origin + b.pathname);
});

test('varyLinks: re-varying a previously-varied link replaces our tag, not duplicates it', () => {
  const once = w.varyLinks('https://x.com/p', 's1');
  const twice = w.varyLinks(once, 's2');
  const u = firstUrl(twice);
  assert.equal(u.searchParams.getAll('utm_content').length, 1, 'exactly one utm_content');
});
