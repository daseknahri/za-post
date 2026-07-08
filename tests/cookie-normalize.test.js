// tests/cookie-normalize.test.js
// Locks the cookie-normalizer fix: the silent-logout bug was SameSite=None cookies injected WITHOUT secure:true, which
// Chrome's setCookie rejects → the caller's one-by-one fallback drops them (e.g. `xs`) → half-seeded jar → logout.
// The invariant that prevents this: any normalized cookie with SameSite=None MUST carry secure:true. These tests also
// prove a realistic FB set round-trips with nothing dropped, now that both copies are one source (store.normalizeCookie).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeCookie } = require('../lib/store');

// The exact constraint Puppeteer/Chrome setCookie enforces — if this holds, the cookie is accepted (not dropped).
function assertSetCookieValid(o, label) {
  assert.ok(o.name, `${label}: has a name`);
  assert.ok('value' in o, `${label}: has a value`);
  assert.ok(o.domain && o.path, `${label}: has domain + path`);
  if (o.sameSite !== undefined) assert.ok(['Strict', 'Lax', 'None'].includes(o.sameSite), `${label}: sameSite is a valid enum`);
  if (o.sameSite === 'None') assert.equal(o.secure, true, `${label}: SameSite=None MUST carry secure:true or setCookie drops it`);
}

test('normalizeCookie: a realistic FB cookie set round-trips to setCookie-valid shapes, nothing dropped', () => {
  const fb = [
    { name: 'c_user', value: '100012345', domain: '.facebook.com', path: '/', secure: true, httpOnly: false, sameSite: 'None', expires: 1900000000 },
    { name: 'xs', value: '42%3Aabcd%3A2%3A1700000000', domain: '.facebook.com', path: '/', secure: true, httpOnly: true, sameSite: 'None', expires: 1900000000 },
    { name: 'datr', value: 'AbC-dEfGhIj', domain: '.facebook.com', path: '/', secure: true, httpOnly: true, sameSite: 'None', expires: 1990000000 },
    { name: 'sb', value: 'Xy_Z12', domain: '.facebook.com', path: '/', secure: true, httpOnly: true, sameSite: 'None' }, // session-ish, no expires
    { name: 'fr', value: '0aBcDeF', domain: '.facebook.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires: 1900000000 },
  ];
  const out = fb.map(normalizeCookie);
  assert.equal(out.length, fb.length, 'no cookie dropped');
  out.forEach((o, i) => assertSetCookieValid(o, fb[i].name));
  assert.equal(out.find((o) => o.name === 'fr').sameSite, 'Lax', 'Lax preserved verbatim');
  assert.equal(out.find((o) => o.name === 'xs').secure, true, 'xs keeps secure');
});

test('normalizeCookie: SameSite=None WITHOUT secure gets secure forced true (the fix — this cookie used to be dropped)', () => {
  const o = normalizeCookie({ name: 'xs', value: 'abc', domain: '.facebook.com', path: '/', sameSite: 'None' }); // NO secure field
  assert.equal(o.sameSite, 'None');
  assert.equal(o.secure, true, 'secure forced → setCookie accepts it instead of rejecting + dropping it');
  assertSetCookieValid(o, 'xs-no-secure');
});

test('normalizeCookie: unknown/missing sameSite → None+secure (valid); Strict/Lax preserved', () => {
  assert.equal(normalizeCookie({ name: 'x', value: '1' }).secure, true, 'missing sameSite → None → secure forced (valid)');
  assert.equal(normalizeCookie({ name: 'x', value: '1', sameSite: 'weird' }).secure, true, 'unknown sameSite → None → secure forced');
  assert.equal(normalizeCookie({ name: 'x', value: '1', sameSite: 'Strict' }).sameSite, 'Strict');
  assert.equal(normalizeCookie({ name: 'x', value: '1', sameSite: 'Lax' }).sameSite, 'Lax');
});

test('normalizeCookie: a throwing input falls back to a safe placeholder and never throws', () => {
  const o = normalizeCookie(null);
  assert.ok(o && o.name && o.domain && o.path, 'returns a safe placeholder shape');
});

test('normalizeCookie: defaults domain + path + coerces value, does not invent httpOnly/secure when absent (non-None)', () => {
  const o = normalizeCookie({ name: 'presence', value: null, sameSite: 'Lax' });
  assert.equal(o.domain, '.facebook.com');
  assert.equal(o.path, '/');
  assert.equal(o.value, '', 'null value coerced to empty string');
  assert.equal(o.sameSite, 'Lax');
  assert.equal('secure' in o, false, 'no secure invented for a non-None cookie that had none');
});
