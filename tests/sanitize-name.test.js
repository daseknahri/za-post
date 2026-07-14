// tests/sanitize-name.test.js
// store.sanitizeName maps every profile-dir / cookie-file / account-dir path segment. It MUST map all
// non-[A-Za-z0-9_-] chars to '_' (path-isolation between accounts). This also DOCUMENTS the known
// collision (a/b, a_b, a b … all → the same dir) so any future change to profile-dir derivation is a
// deliberate, tested decision rather than a silent cross-account session-bleed regression.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const store = require('../lib/store');

test('sanitizeName: reserved / space / unicode / separator chars → underscore; safe chars kept', () => {
  assert.equal(store.sanitizeName('hello'), 'hello');       // safe chars untouched
  assert.equal(store.sanitizeName('a-b_c9'), 'a-b_c9');     // hyphen, underscore, digits kept
  assert.equal(store.sanitizeName('a b'), 'a_b');           // space
  assert.equal(store.sanitizeName('a/b'), 'a_b');           // POSIX separator (isolation-critical)
  assert.equal(store.sanitizeName('a\\b'), 'a_b');          // Windows separator
  assert.equal(store.sanitizeName('a.b'), 'a_b');           // dot (no path traversal)
  assert.equal(store.sanitizeName('a:b*?"<>|'), 'a_b______'); // Windows-reserved chars
  assert.equal(store.sanitizeName('café'), 'caf_');         // accented → underscore
  assert.equal(store.sanitizeName('日本'), '__');            // multibyte → per-char underscore
  assert.equal(store.sanitizeName(''), '');                 // empty stays empty
  assert.equal(store.sanitizeName(123), '123');             // coerces to string
});

test('sanitizeName: DOCUMENTED collision — distinct names can map to the same dir', () => {
  // These DISTINCT account names all sanitize to 'a_b'. If two accounts collide here they SHARE a
  // profile/cookie dir (cross-account session bleed). Pinned so a future disambiguation change is deliberate.
  const mapped = ['a/b', 'a_b', 'a b', 'a.b', 'a\\b'].map((n) => store.sanitizeName(n));
  assert.deepEqual(new Set(mapped), new Set(['a_b']), 'all collide to a_b — isolation depends on distinct sanitized names');
});
