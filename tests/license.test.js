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
const fs = require('fs');
const os = require('os');
const path = require('path');
const lic = require('../lib/license');

const NOW = Date.UTC(2026, 5, 20, 12, 0, 0);
const DAY = 86400000;
const CUST = 'AAAA-BBBB-CCCC-DDDD'; // not the owner key

test('isOwnerKey is false for arbitrary keys', () => {
  assert.equal(lic.isOwnerKey(CUST), false);
  assert.equal(lic.isOwnerKey(''), false);
});

test('owner key stays valid even when the server says invalid (never hwid-locked / "active on another device")', () => {
  const OWNER = 'C2F7-4414-7C06-8227'; // the baked owner key
  assert.equal(lic.isOwnerKey(OWNER), true);
  const r = lic.decideFromResponse({ valid: false, message: 'License is already active on another device' }, OWNER, NOW);
  assert.equal(r.valid, true);
  assert.equal(r.tier, 'owner');
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

test('decideFromResponse: valid customer → UNLIMITED limits (pure per-seat; tier + server overrides do not cap)', () => {
  const std = lic.decideFromResponse({ valid: true, tier: 'standard' }, CUST, NOW);
  assert.equal(std.valid, true);
  assert.deepEqual(std.limits, lic.UNLIMITED);
  assert.equal(std.tier, 'standard'); // tier NAME still tracked for display

  const pro = lic.decideFromResponse({ valid: true, tier: 'pro' }, CUST, NOW);
  assert.deepEqual(pro.limits, lic.UNLIMITED);

  // server-sent explicit caps are IGNORED — the per-seat model never limits account/group count
  const override = lic.decideFromResponse({ valid: true, tier: 'standard', maxAccounts: 5, maxGroups: 7 }, CUST, NOW);
  assert.deepEqual(override.limits, lic.UNLIMITED);
});

test('decideOffline: customer with NO cache fails closed', () => {
  const r = lic.decideOffline(CUST, null, NOW);
  assert.equal(r.valid, false);
});

test('decideOffline: customer WITHIN the grace window stays valid (unlimited, even from an old capped cache)', () => {
  const cache = { key: CUST, lastValidated: NOW - 2 * DAY, tier: 'pro', limits: { maxAccounts: 100, maxGroups: 500 }, expires: 0 };
  const r = lic.decideOffline(CUST, cache, NOW);
  assert.equal(r.valid, true);
  assert.equal(r.grace, true);
  assert.deepEqual(r.limits, lic.UNLIMITED); // limits are always unlimited now — a stale capped cache can't re-impose a limit
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

test('decideOffline: device-lock — a mismatched/deleted cached hwid fails closed when the real hwid is injected', () => {
  const within = { key: CUST, lastValidated: NOW - 2 * DAY, tier: 'pro', expires: 0 };
  // opt-out (no currentHwid arg) preserves the pure callers/tests → still grants grace
  assert.equal(lic.decideOffline(CUST, { ...within, hwid: 'AAA' }, NOW).valid, true, 'no hwid arg → device-lock opt-out → grace');
  // injected hwid MATCHES the cached one → valid
  assert.equal(lic.decideOffline(CUST, { ...within, hwid: 'MACHINE-1' }, NOW, undefined, 'MACHINE-1').valid, true, 'same machine → valid');
  // injected hwid does NOT match → bound to another machine → fail closed
  const mismatch = lic.decideOffline(CUST, { ...within, hwid: 'MACHINE-1' }, NOW, undefined, 'MACHINE-2');
  assert.equal(mismatch.valid, false, 'different machine → invalid');
  assert.match(mismatch.message, /different machine/i);
  // cached hwid DELETED to dodge the lock → still fails closed when a real hwid is present
  assert.equal(lic.decideOffline(CUST, { ...within, hwid: undefined }, NOW, undefined, 'MACHINE-2').valid, false, 'tampered (deleted hwid) → invalid');
});

test('limitsFor: every tier → unlimited (pure per-seat)', () => {
  assert.deepEqual(lic.limitsFor('pro'), lic.UNLIMITED);
  assert.deepEqual(lic.limitsFor('standard'), lic.UNLIMITED);
  assert.deepEqual(lic.limitsFor('nonexistent'), lic.UNLIMITED);
});

test('decideOffline: a BACKWARD clock correction (now < lastValidated) stays valid within grace', () => {
  // lastValidated stamped while the local clock ran ~1 day AHEAD; NTP/CMOS then corrects backward → now < lastValidated.
  const cache = { key: CUST, lastValidated: NOW + DAY, tier: 'pro', expires: 0 }; // age = -DAY (negative)
  const r = lic.decideOffline(CUST, cache, NOW);
  assert.equal(r.valid, true, 'a backward clock jump must NOT read as "grace expired" and lock out a genuine offline client');
  assert.equal(r.grace, true);
});

test('checkCached: a transient lock on an EXISTING license.json → unreadable (NOT a hard-invalid that stops a campaign)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-lic-'));
  const lf = path.join(tmp, 'license.json');
  fs.writeFileSync(lf, JSON.stringify({ key: CUST, hwid: 'x', lastValidated: NOW, tier: 'standard', limits: lic.UNLIMITED, expires: 0 }));
  const realRead = fs.readFileSync;
  fs.readFileSync = function (p, ...rest) { if (typeof p === 'string' && p === lf) { const e = new Error('EBUSY: locked'); e.code = 'EBUSY'; throw e; } return realRead.call(this, p, ...rest); };
  try {
    const r = await lic.checkCached(tmp, 'http://127.0.0.1:1'); // server irrelevant — the unreadable case short-circuits before validate()
    assert.equal(r.valid, false, 'unreadable is NOT "valid" → no enforcement bypass for a planted unreadable file');
    assert.equal(r.unreadable, true, 'flagged so the ~6h re-validator does NOT tear down a running campaign on an I/O blip');
  } finally { fs.readFileSync = realRead; fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('checkCached: a genuinely ABSENT license.json (ENOENT) → invalid, NOT unreadable (a non-payer still fails closed)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-lic2-'));
  try {
    const r = await lic.checkCached(tmp, 'http://127.0.0.1:1');
    assert.equal(r.valid, false);
    assert.ok(!r.unreadable, 'an absent file is "not activated", not "temporarily unreadable" — no free pass');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
