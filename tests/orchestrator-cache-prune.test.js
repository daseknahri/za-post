'use strict';
// B2 guardrail: _pruneProfileCaches must delete ONLY ephemeral Chrome cache dirs and NEVER touch
// cookies/identity — a regression here would silently log out all accounts on a long run.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

function seedProfile(store, acct) {
  const prof = store.profileDir(acct);
  const mk = (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); };
  // ephemeral caches (must be pruned)
  mk(path.join(prof, 'Cache', 'data_0'));
  mk(path.join(prof, 'Default', 'Code Cache', 'js', 'x'));
  mk(path.join(prof, 'Default', 'GPUCache', 'x'));
  mk(path.join(prof, 'Default', 'ShaderCache', 'x'));
  mk(path.join(prof, 'Default', 'Crashpad', 'report'));
  // identity/login (must survive)
  mk(path.join(prof, 'Default', 'Network', 'Cookies'));
  mk(path.join(prof, 'Default', 'Local Storage', 'leveldb', 'x'));
  mk(path.join(prof, 'Default', 'IndexedDB', 'x'));
  mk(path.join(prof, 'Default', 'Service Worker', 'CacheStorage', 'x'));
  mk(path.join(prof, 'Default', 'Preferences'));
  mk(path.join(store.accountDir(acct), 'cookies.json')); // the DURABLE login (lives outside chrome-profile)
  return prof;
}

test('B2 _pruneProfileCaches: deletes caches, preserves all cookies/identity', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-prune-'));
  try {
    const store = require('../lib/store');
    store.init(tmp);
    const acct = 'guardtest';
    const prof = seedProfile(store, acct);
    const { Orchestrator } = require('../automation/orchestrator');
    const orch = new Orchestrator();
    orch.log = () => {};
    orch._pruneProfileCaches(() => ({ accounts: [{ name: acct, isModerator: false }] }));

    // caches gone
    assert.ok(!fs.existsSync(path.join(prof, 'Cache')), 'Cache should be deleted');
    assert.ok(!fs.existsSync(path.join(prof, 'Default', 'Code Cache')), 'Code Cache should be deleted');
    assert.ok(!fs.existsSync(path.join(prof, 'Default', 'GPUCache')), 'GPUCache should be deleted');
    assert.ok(!fs.existsSync(path.join(prof, 'Default', 'ShaderCache')), 'ShaderCache should be deleted');
    assert.ok(!fs.existsSync(path.join(prof, 'Default', 'Crashpad')), 'Crashpad should be deleted');
    // identity survives
    assert.ok(fs.existsSync(path.join(prof, 'Default', 'Network', 'Cookies')), 'Cookies must survive');
    assert.ok(fs.existsSync(path.join(prof, 'Default', 'Local Storage', 'leveldb', 'x')), 'Local Storage must survive');
    assert.ok(fs.existsSync(path.join(prof, 'Default', 'IndexedDB')), 'IndexedDB must survive');
    assert.ok(fs.existsSync(path.join(prof, 'Default', 'Service Worker', 'CacheStorage')), 'Service Worker CacheStorage must survive');
    assert.ok(fs.existsSync(path.join(prof, 'Default', 'Preferences')), 'Preferences must survive');
    assert.ok(fs.existsSync(path.join(store.accountDir(acct), 'cookies.json')), 'durable cookies.json must survive');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('B2 _pruneProfileCaches: never prunes the moderator account', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-mod-'));
  try {
    const store = require('../lib/store');
    store.init(tmp);
    const mod = 'modacct';
    const prof = store.profileDir(mod);
    fs.mkdirSync(path.join(prof, 'Cache'), { recursive: true });
    fs.writeFileSync(path.join(prof, 'Cache', 'data_0'), 'x');
    const { Orchestrator } = require('../automation/orchestrator');
    const orch = new Orchestrator();
    orch.log = () => {};
    orch._pruneProfileCaches(() => ({ accounts: [{ name: mod, isModerator: true }] }));
    assert.ok(fs.existsSync(path.join(prof, 'Cache')), "moderator's cache must NOT be pruned (its background approval browser may be open)");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
