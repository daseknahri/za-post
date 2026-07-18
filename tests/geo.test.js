// tests/geo.test.js
// geo.detectProxyGeo aligns a PROXIED account's browser clock/locale to its proxy IP (a mismatch is a
// strong FB correlation signal). Contract: fail-SAFE — an unparseable proxy string returns {ok:false}
// with NO network (parseProxy rejects before the geo-IP call), so the sweep can skip a bad proxy. And
// CC_LOCALE must be well-formed BCP-47 for every country so a proxied account never gets a broken locale.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { detectProxyGeo, CC_LOCALE } = require('../lib/geo');

test('detectProxyGeo: unparseable input → {ok:false} with no network', async () => {
  // No-colon strings can never form host:port, so parseProxy returns null and detectProxyGeo bails BEFORE
  // any axios call — the negative path is network-free (a valid host:port would attempt the real lookup).
  for (const bad of ['garbage', '', 'nocolonnoport', 'abc']) {
    const r = await detectProxyGeo(bad);
    assert.equal(r.ok, false, `"${bad}" must fail closed`);
    assert.ok(typeof r.error === 'string' && r.error.length, 'carries an error string');
  }
});

test('CC_LOCALE: keys are ISO-3166 alpha-2, values are well-formed BCP-47 (xx-XX)', () => {
  for (const [cc, loc] of Object.entries(CC_LOCALE)) {
    assert.match(cc, /^[A-Z]{2}$/, `country code ${cc} is 2 upper-case letters`);
    assert.match(loc, /^[a-z]{2}-[A-Z]{2}$/, `locale ${loc} (for ${cc}) is well-formed`);
  }
});

test('CC_LOCALE: covers Morocco (operator region) → ar-MA', () => {
  assert.equal(CC_LOCALE.MA, 'ar-MA');
});
