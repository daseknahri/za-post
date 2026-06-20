// tests/secret.test.js
// M3-01: at-rest credential encryption via Electron safeStorage. In the node:test process there is
// no Electron main-process safeStorage, so encryption is UNAVAILABLE — these pin the graceful
// fallback (no data loss, legacy plaintext stays readable, ciphertext is never typed back). The real
// DPAPI round-trip is exercised in the Electron app itself.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const secret = require('../lib/secret');

test('available() is false outside the Electron main process', () => {
  assert.equal(secret.available(), false);
});

test('encrypt is a no-op when encryption is unavailable (never loses data)', () => {
  assert.equal(secret.encrypt('hunter2'), 'hunter2');
  assert.equal(secret.encrypt(''), '');
  assert.equal(secret.encrypt(null), null);
});

test('decrypt passes through legacy plaintext', () => {
  assert.equal(secret.decrypt('plain@example.com'), 'plain@example.com');
  assert.equal(secret.decrypt(''), '');
});

test('an encrypted marker without safeStorage decrypts to empty (never returns ciphertext)', () => {
  const fake = 'enc:v1:AAAABBBBCCCC';
  assert.equal(secret.isEncrypted(fake), true);
  assert.equal(secret.decrypt(fake), '');
});

test('isEncrypted only matches the marker', () => {
  assert.equal(secret.isEncrypted('plain'), false);
  assert.equal(secret.isEncrypted('enc:v1:x'), true);
});
