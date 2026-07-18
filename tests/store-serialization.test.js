// tests/store-serialization.test.js
// store.updateComments / updateModeration are the serialized read-modify-write chains that rescue
// idempotency + held-record integrity depend on. The parallel posting pool has many account closures
// appending pending/held records across await points; without serialization a second save clobbers the
// first's appends → a silently lost held post (never approved) or orphaned comment (never rescued).
// Also pins blank()'s fresh-settings contract (no shared DEFAULT_SETTINGS ref across data objects).
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/store');

test('updateComments: concurrent appends all land (serialized, no lost update) + returns {ok,result}', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-com-'));
  store.init(tmp);
  const N = 40;
  const results = await Promise.all(Array.from({ length: N }, (_, i) => store.updateComments((cs) => {
    cs.pending = cs.pending || [];
    cs.pending.push({ gid: 'g', postId: 'p' + i, status: 'pending' }); // read-modify-write across the chain
    return cs.pending.length;
  })));
  const cs = store.loadComments();
  assert.equal((cs.pending || []).length, N, 'all N concurrent appends survived (chain serialized, no clobber)');
  assert.ok(results.every((r) => r && r.ok === true), 'each call returns {ok:true, result}');
  assert.deepEqual(new Set(cs.pending.map((c) => c.postId)), new Set(Array.from({ length: N }, (_, i) => 'p' + i)),
    'no append clobbered another');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('updateModeration: concurrent held-record appends all land', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-mod-'));
  store.init(tmp);
  const N = 30;
  await Promise.all(Array.from({ length: N }, (_, i) => store.updateModeration((ms) => {
    ms.held = ms.held || [];
    ms.held.push({ gid: 'g', postId: 'h' + i, status: 'held' });
  })));
  const ms = store.loadModeration();
  assert.equal((ms.held || []).length, N, 'all N concurrent held appends survived');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('blank(): settings is a fresh copy of DEFAULT_SETTINGS (no shared mutable ref)', () => {
  const a = store.blank(), b = store.blank();
  assert.notEqual(a.settings, b.settings, 'each blank() gets its own settings object');
  a.settings.__probe = 1;
  assert.equal(b.settings.__probe, undefined, 'mutating one blank must not leak into another (or DEFAULT_SETTINGS)');
  assert.equal(store.DEFAULT_SETTINGS.__probe, undefined, 'DEFAULT_SETTINGS itself is not mutated');
  assert.deepEqual(
    { posts: a.posts, groups: a.groups, accounts: a.accounts, proxies: a.proxies, useProxies: a.useProxies },
    { posts: [], groups: [], accounts: [], proxies: [], useProxies: false });
});
