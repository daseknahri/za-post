// tests/write-atomic.test.js
// store.writeFileAtomic is THE write primitive behind data.json / cookies / moderation-state /
// pending-comments / Preferences. Contract: tmp → looped write → fsync → atomic rename, so a reader
// never observes a torn / 0-byte / partially-written file; content round-trips exactly (incl. large
// payloads that exercise the short-write loop); no .tmp residue; a fresh write fully replaces prior bytes.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/store');

test('writeFileAtomic: content round-trips exactly + no .tmp left behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-atom-'));
  const dest = path.join(dir, 'x.json');
  const content = JSON.stringify({ a: 1, s: 'héllo — 日本', arr: [1, 2, 3] });
  store.writeFileAtomic(dest, content);
  assert.equal(fs.readFileSync(dest, 'utf8'), content, 'content read back exactly');
  assert.equal(fs.existsSync(dest + '.tmp'), false, 'the .tmp was renamed away (no residue)');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeFileAtomic: a fresh write fully replaces prior content (no leftover trailing bytes)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-atom2-'));
  const dest = path.join(dir, 'x.json');
  store.writeFileAtomic(dest, 'a-longer-original-payload-aaaaaaaaaaaaaaaaaaaaaaaa');
  store.writeFileAtomic(dest, 'short'); // shorter than the original
  assert.equal(fs.readFileSync(dest, 'utf8'), 'short', 'shorter new content replaces the longer old (rename, not in-place truncate)');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeFileAtomic: large payload round-trips (exercises the short-write loop)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-atom3-'));
  const dest = path.join(dir, 'big.json');
  const big = 'x'.repeat(2 * 1024 * 1024); // 2 MB — large enough that a short write could occur without the loop
  store.writeFileAtomic(dest, big);
  const read = fs.readFileSync(dest, 'utf8');
  assert.equal(read.length, big.length, 'full length written (no short-write truncation)');
  assert.equal(read, big, 'content matches byte-for-byte');
  fs.rmSync(dir, { recursive: true, force: true });
});
