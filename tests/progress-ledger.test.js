// tests/progress-ledger.test.js — the durable per-day "done" ledger (store.recordProgress / loadProgress) that
// feeds the dashboard plan. Verifies status mapping, per-(account,post,group) dedupe, and day bucketing.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/store');

function freshStore() { const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-prog-')); store.init(tmp); return tmp; }
const rec = (over) => ({ ts: '2026-06-23T10:00:00.000Z', account: 'A', postId: 'p1', caption: 'cap', groupId: 'g1', group: 'Alpha', result: 'posted', comment: 'ok', detail: '', ...over });

test('recordProgress: a posted row lands as done and counts once', () => {
  freshStore();
  store.recordProgress(rec());
  const led = store.loadProgress();
  const day = led.days[Object.keys(led.days)[0]];
  assert.equal(day.posted, 1);
  assert.equal(Object.keys(day.items).length, 1);
  assert.equal(day.items['A|p1|g1'].status, 'done');
});

test('recordProgress: re-reporting the same cell updates, does not double-count', () => {
  freshStore();
  store.recordProgress(rec({ result: 'error' }));   // first: error
  store.recordProgress(rec({ result: 'posted' }));  // later: posted (same account/post/group)
  const led = store.loadProgress();
  const day = led.days[Object.keys(led.days)[0]];
  assert.equal(day.errors, 0, 'the earlier error count was decremented');
  assert.equal(day.posted, 1, 'now counted as posted, not doubled');
  assert.equal(Object.keys(day.items).length, 1);
});

test('recordProgress: pending → held; skips summary/blank rows', () => {
  freshStore();
  store.recordProgress(rec({ result: 'pending' }));
  store.recordProgress({ account: '(run summary)', result: 'summary:done' }); // ignored
  store.recordProgress(rec({ postId: null }));   // ignored (no post)
  store.recordProgress(rec({ result: 'skipped' })); // ignored (not a delivery)
  const led = store.loadProgress();
  const day = led.days[Object.keys(led.days)[0]];
  assert.equal(day.held, 1);
  assert.equal(day.posted, 0);
  assert.equal(Object.keys(day.items).length, 1, 'only the pending row is recorded');
});

test('clearProgress: wipes the ledger (used by Start over)', () => {
  freshStore();
  store.recordProgress(rec());
  assert.ok(Object.keys(store.loadProgress().days).length > 0, 'has data');
  store.clearProgress();
  assert.deepEqual(store.loadProgress().days, {}, 'ledger emptied');
});

test('recordProgress: different groups of the same post are separate cells', () => {
  freshStore();
  store.recordProgress(rec({ groupId: 'g1' }));
  store.recordProgress(rec({ groupId: 'g2' }));
  const led = store.loadProgress();
  const day = led.days[Object.keys(led.days)[0]];
  assert.equal(day.posted, 2);
  assert.deepEqual(Object.keys(day.items).sort(), ['A|p1|g1', 'A|p1|g2']);
});
