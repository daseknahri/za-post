// tests/store.test.js
// M4-01: store durability guarantees — the serialized update() mutex (no lost updates across
// concurrent read-modify-write cycles) and .bak recovery when the primary file is corrupt.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/store');

test('update() serializes concurrent mutations — no lost updates', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-conc-'));
  store.init(tmp);
  store.save({ posts: [], groups: [], accounts: [{ name: 'a', n: 0 }], settings: {}, proxies: [], useProxies: false });
  await Promise.all(Array.from({ length: 50 }, () => store.update((d) => {
    const a = d.accounts.find((x) => x.name === 'a');
    a.n = (Number(a.n) || 0) + 1; // read-modify-write across an await point
  })));
  assert.equal(store.load().accounts[0].n, 50, 'all 50 increments must land (mutex prevents lost updates)');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('load() recovers from .bak when the primary file is corrupt', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-rec-'));
  store.init(tmp);
  store.save({ posts: [], groups: [{ id: 'g1', groupId: '1', name: 'G' }], accounts: [], settings: {}, proxies: [], useProxies: false });
  store.save({ posts: [], groups: [{ id: 'g1', groupId: '1', name: 'G' }, { id: 'g2', groupId: '2', name: 'H' }], accounts: [], settings: {}, proxies: [], useProxies: false });
  // The .bak now holds the 1-group snapshot. Corrupt the primary.
  fs.writeFileSync(store.paths.DATA_FILE, '{ this is not json');
  const d = store.load();
  assert.equal(d.groups.length, 1, 'should recover the last good snapshot from .bak');
  assert.equal(store.consumeLoadIssue(), 'recovered-from-backup');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a transient READ lock on a good primary must NOT quarantine it, and update() must NOT clobber it (Windows EBUSY)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-ebusy-'));
  store.init(tmp);
  const DATA = store.paths.DATA_FILE;
  store.save({ posts: [], groups: [], accounts: [{ name: 'real', n: 7 }], settings: {}, proxies: [], useProxies: false });
  try { fs.unlinkSync(DATA + '.bak'); } catch {} // worst case: no usable .bak (fresh install that only ever load()ed)

  const realRead = fs.readFileSync;
  let lock = true;
  fs.readFileSync = function (p, ...rest) {
    if (lock && typeof p === 'string' && p === DATA) { const e = new Error('EBUSY: resource busy or locked'); e.code = 'EBUSY'; throw e; } // primary locked; .bak read still real (ENOENT)
    return realRead.call(this, p, ...rest);
  };
  try {
    await store.update((d) => { d.accounts.push({ name: 'must-not-persist' }); }); // would-be wipe: mutator runs on blank()
    assert.ok(fs.existsSync(DATA), 'primary data.json must NOT be quarantined/renamed on a transient read lock');
    assert.equal(fs.readdirSync(tmp).filter((f) => f.includes('.corrupt-')).length, 0, 'no .corrupt-* file should be created for a transient read lock');
  } finally {
    lock = false; fs.readFileSync = realRead;
  }
  const after = store.load(); // lock cleared → the real data must be intact (the skipped save preserved it)
  assert.equal(after.accounts.length, 1, 'the real accounts must survive the transient lock');
  assert.equal(after.accounts[0].name, 'real');
  assert.equal(after.accounts[0].n, 7, 'no blank/partial data was persisted over the good primary');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('update(mutator, {throwIfUnsaved:true}) THROWS E_SAVE_SKIPPED on a transient read lock (so a caller can avoid false success)', async () => {
  // The bulk importer must NOT report "imported N accounts" (and write orphan cookie jars) when the save was silently
  // skipped because data.json was transiently unreadable. With throwIfUnsaved it gets a typed error instead of a
  // silent no-op; the default (no opts) stays non-throwing (unchanged for every other caller).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-unsaved-'));
  store.init(tmp);
  const DATA = store.paths.DATA_FILE;
  store.save({ posts: [], groups: [], accounts: [{ name: 'real', n: 7 }], settings: {}, proxies: [], useProxies: false });
  try { fs.unlinkSync(DATA + '.bak'); } catch {}

  const realRead = fs.readFileSync;
  let lock = true;
  fs.readFileSync = function (p, ...rest) {
    if (lock && typeof p === 'string' && p === DATA) { const e = new Error('EBUSY: resource busy or locked'); e.code = 'EBUSY'; throw e; }
    return realRead.call(this, p, ...rest);
  };
  try {
    // (1) default (no opts): resolves WITHOUT throwing (unchanged) and does NOT clobber the primary.
    await store.update((d) => { d.accounts.push({ name: 'nope' }); });
    // (2) throwIfUnsaved: rejects with the typed code so the caller can report a retryable failure.
    let code = null;
    try { await store.update((d) => { d.accounts.push({ name: 'nope2' }); }, { throwIfUnsaved: true }); }
    catch (e) { code = e && e.code; }
    assert.equal(code, 'E_SAVE_SKIPPED', 'throwIfUnsaved must reject with code E_SAVE_SKIPPED when the save was skipped');
  } finally {
    lock = false; fs.readFileSync = realRead;
  }
  const after = store.load(); // lock cleared → the real data must be intact (neither call clobbered it)
  assert.equal(after.accounts.length, 1, 'the good primary survives both calls');
  assert.equal(after.accounts[0].name, 'real');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('update(mutator, {throwIfUnsaved:true}) SAVES normally when the primary is readable (flag is a no-op on the happy path)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-unsaved-ok-'));
  store.init(tmp);
  store.save({ posts: [], groups: [], accounts: [], settings: {}, proxies: [], useProxies: false });
  await store.update((d) => { d.accounts.push({ name: 'a1' }); }, { throwIfUnsaved: true });
  const after = store.load();
  assert.equal(after.accounts.length, 1, 'a readable primary saves as usual with the flag set');
  assert.equal(after.accounts[0].name, 'a1');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('cookies: at-rest encryption round-trips, reads legacy plaintext, and FAILS SAFE (undecryptable → [], never throws)', () => {
  const secret = require('../lib/secret');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-ck-'));
  store.init(tmp);
  const jar = [{ name: 'c_user', value: '100', domain: '.facebook.com', path: '/' }, { name: 'xs', value: 'sess', domain: '.facebook.com', path: '/' }];

  // 1) round-trip through writeCookies/readCookies (the app's actual path)
  store.writeCookies('acc1', jar);
  assert.deepEqual(store.readCookies('acc1'), jar, 'writeCookies → readCookies must return the same jar');

  // 2) on-disk envelope depends on the OS keystore. In this plain-node test env safeStorage is unavailable, so
  //    the jar is written PLAINTEXT (unchanged behavior); UNDER ELECTRON it would carry the enc:v1: marker. Assert
  //    the invariant that matches the current environment, keyed off secret.available() so it holds either way.
  const raw = fs.readFileSync(store.cookiesFile('acc1'), 'utf8');
  if (secret.available()) assert.ok(secret.isEncrypted(raw), 'with a keystore, cookies.json is encrypted at rest');
  else assert.deepEqual(JSON.parse(raw), jar, 'without a keystore, cookies.json stays plaintext JSON (dev/scripts/tests)');

  // 3) a LEGACY plaintext jar (pre-encryption install) must still read
  fs.writeFileSync(store.cookiesFile('acc2'), JSON.stringify(jar, null, 2));
  assert.deepEqual(store.readCookies('acc2'), jar, 'legacy plaintext jar reads unchanged (backward compatible)');

  // 4) THE CRITICAL FAIL-SAFE: an encrypted jar that can't be decrypted HERE (wrong OS user / a plain-node
  //    script with no safeStorage) must return [] — NOT throw, NOT ciphertext. This is what stops a script from
  //    treating ciphertext as cookies AND guarantees a decrypt failure can never crash a read.
  fs.writeFileSync(store.cookiesFile('acc3'), 'enc:v1:not-real-base64-cannot-decrypt');
  assert.deepEqual(store.readCookies('acc3'), [], 'undecryptable encrypted jar → [] (fail-safe, no throw)');

  // 5) missing jar → [] (unchanged)
  assert.deepEqual(store.readCookies('nope'), [], 'missing cookies.json → []');

  fs.rmSync(tmp, { recursive: true, force: true });
});
