// tests/vps-crypto.test.js
// M3-05: the license key store must be encrypted at rest, with integrity (a tampered or wrong-key
// file fails closed rather than silently loading garbage). Covers vps-server/crypto + keystore.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const kc = require('../vps-server/crypto');

test('crypto: encrypt → decrypt round-trips and hides plaintext', () => {
  const obj = { 'AAAA-BBBB': { hwid: null, tier: 'pro', revoked: false } };
  const blob = kc.encrypt(obj, 'secret-pass');
  assert.equal(kc.isEncrypted(blob), true);
  assert.ok(!JSON.stringify(blob).includes('pro'), 'ciphertext must not contain plaintext fields');
  assert.deepEqual(kc.decrypt(blob, 'secret-pass'), obj);
});

test('crypto: a wrong passphrase fails (GCM auth)', () => {
  const blob = kc.encrypt({ a: 1 }, 'right');
  assert.throws(() => kc.decrypt(blob, 'wrong'));
});

test('crypto: tampered ciphertext fails (integrity)', () => {
  const blob = kc.encrypt({ a: 1 }, 'k');
  const tampered = { ...blob, ct: Buffer.from('00'.repeat(16), 'hex').toString('base64') };
  assert.throws(() => kc.decrypt(tampered, 'k'));
});

test('keystore: encrypted save → load round-trips, ciphertext on disk', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-ks-'));
  process.env.KEYS_PATH = path.join(tmp, 'keys.json');
  process.env.KEYS_ENCRYPTION_KEY = 'unit-test-secret';
  const ks = require('../vps-server/keystore'); // lazy env reads → safe to require after setting env
  ks.save({ 'AAAA-BBBB': { tier: 'pro', revoked: false } });
  const onDisk = fs.readFileSync(process.env.KEYS_PATH, 'utf8');
  assert.ok(onDisk.includes('__enc__'), 'keys.json should be encrypted on disk');
  assert.ok(!onDisk.includes('pro'), 'plaintext tier must not be on disk');
  assert.deepEqual(ks.load(), { 'AAAA-BBBB': { tier: 'pro', revoked: false } });
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.KEYS_PATH; delete process.env.KEYS_ENCRYPTION_KEY;
});
