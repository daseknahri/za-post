// tests/license.test.js
// M1-06 / M1-05: the licensing decision core. Per-seat tiers + a 7-day offline grace period.
// Pinned behavior:
//   - server reachable: revoked → invalid, expired → invalid, valid → tier limits enforced
//   - server unreachable: customer keys valid ONLY within the grace window (then fail-closed);
//     a wrong/absent cache fails closed. (The owner key path needs the secret key, so it's covered
//     by the negative isOwnerKey check plus the customer fail-closed case.)
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const lic = require('../lib/license');

const NOW = Date.UTC(2026, 5, 20, 12, 0, 0);
const DAY = 86400000;
const CUST = 'AAAA-BBBB-CCCC-DDDD'; // not the owner key

test('isOwnerKey is false for arbitrary keys', () => {
  assert.equal(lic.isOwnerKey(CUST), false);
  assert.equal(lic.isOwnerKey(''), false);
});

test('decideFromResponse: revoked → invalid (server-reachable revocation is enforced)', () => {
  const r = lic.decideFromResponse({ revoked: true }, CUST, NOW);
  assert.equal(r.valid, false);
  assert.equal(r.revoked, true);
});

test('decideFromResponse: expired → invalid', () => {
  const r = lic.decideFromResponse({ valid: true, expires: NOW - DAY }, CUST, NOW);
  assert.equal(r.valid, false);
  assert.equal(r.expired, true);
});

test('decideFromResponse: valid maps tier → limits, server overrides win', () => {
  const std = lic.decideFromResponse({ valid: true, tier: 'standard' }, CUST, NOW);
  assert.equal(std.valid, true);
  assert.deepEqual(std.limits, lic.TIERS.standard);

  const pro = lic.decideFromResponse({ valid: true, tier: 'pro' }, CUST, NOW);
  assert.deepEqual(pro.limits, lic.TIERS.pro);

  const override = lic.decideFromResponse({ valid: true, tier: 'standard', maxAccounts: 5, maxGroups: 7 }, CUST, NOW);
  assert.deepEqual(override.limits, { maxAccounts: 5, maxGroups: 7 });
});

test('decideOffline: customer with NO cache fails closed', () => {
  const r = lic.decideOffline(CUST, null, NOW);
  assert.equal(r.valid, false);
});

test('decideOffline: customer WITHIN the grace window stays valid (cached limits)', () => {
  const cache = { key: CUST, lastValidated: NOW - 2 * DAY, tier: 'pro', limits: lic.TIERS.pro, expires: 0 };
  const r = lic.decideOffline(CUST, cache, NOW);
  assert.equal(r.valid, true);
  assert.equal(r.grace, true);
  assert.deepEqual(r.limits, lic.TIERS.pro);
});

test('decideOffline: customer PAST the grace window fails closed', () => {
  const cache = { key: CUST, lastValidated: NOW - 8 * DAY, tier: 'pro', limits: lic.TIERS.pro, expires: 0 };
  const r = lic.decideOffline(CUST, cache, NOW);
  assert.equal(r.valid, false);
});

test('decideOffline: an expired cached license fails closed even within grace', () => {
  const cache = { key: CUST, lastValidated: NOW - DAY, expires: NOW - DAY, tier: 'pro', limits: lic.TIERS.pro };
  const r = lic.decideOffline(CUST, cache, NOW);
  assert.equal(r.valid, false);
  assert.equal(r.expired, true);
});

test('decideOffline: a cache for a DIFFERENT key fails closed', () => {
  const cache = { key: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ', lastValidated: NOW - DAY, tier: 'pro', limits: lic.TIERS.pro };
  const r = lic.decideOffline(CUST, cache, NOW);
  assert.equal(r.valid, false);
});

test('limitsFor: unknown tier → unlimited; known tier → its limits', () => {
  assert.deepEqual(lic.limitsFor('pro'), lic.TIERS.pro);
  assert.deepEqual(lic.limitsFor('nonexistent'), lic.UNLIMITED);
});
