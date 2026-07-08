// tests/retry.test.js
// M1-01: the upload/download reliability primitive. A failed upload must NEVER resolve as
// success — that is exactly what let the worker publish image-less posts. These tests pin the
// retry/timeout/backoff contract that the worker's image-upload and downloadImage paths rely on.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { retryAsync } = require('../automation/worker');

test('retryAsync: succeeds on the first attempt', async () => {
  let calls = 0;
  const r = await retryAsync(() => { calls++; return Promise.resolve('ok'); }, { attempts: 3, baseDelayMs: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.result, 'ok');
  assert.equal(calls, 1, 'should not retry after success');
});

test('retryAsync: retries a flaky op and eventually succeeds', async () => {
  let calls = 0;
  const r = await retryAsync(() => {
    calls++;
    return calls < 3 ? Promise.reject(new Error('flaky')) : Promise.resolve('done');
  }, { attempts: 3, baseDelayMs: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.result, 'done');
  assert.equal(calls, 3, 'should retry until success');
});

test('retryAsync: reports failure (ok:false) after exhausting attempts', async () => {
  let calls = 0;
  const r = await retryAsync(() => { calls++; return Promise.reject(new Error('always fails')); }, { attempts: 3, baseDelayMs: 1 });
  assert.equal(r.ok, false, 'a never-succeeding op must report failure, not silent success');
  assert.equal(calls, 3, 'should try exactly `attempts` times');
  assert.match(r.error.message, /always fails/);
});

test('retryAsync: a hanging op times out per attempt and ultimately fails', async () => {
  let calls = 0;
  const r = await retryAsync(() => { calls++; return new Promise(() => {}); /* never resolves */ }, {
    attempts: 2, timeoutMs: 30, baseDelayMs: 1, label: 'image upload',
  });
  assert.equal(r.ok, false, 'a stalled upload must fail (so the worker skips the group, not publishes image-less)');
  assert.equal(calls, 2);
  assert.match(r.error.message, /image upload timeout/);
});

test('retryAsync: onAttempt fires once per failed attempt', async () => {
  const seen = [];
  await retryAsync(() => Promise.reject(new Error('nope')), {
    attempts: 3, baseDelayMs: 1, onAttempt: (a, n) => seen.push(`${a}/${n}`),
  });
  assert.deepEqual(seen, ['1/3', '2/3', '3/3']);
});

test('retryAsync: exposes the upload-or-skip decision the worker relies on', async () => {
  // Mirrors automation/worker.js: `const up = await retryAsync(upload, ...); if (!up.ok) skipGroup()`.
  const upload = () => new Promise((_, rej) => setTimeout(() => rej(new Error('CDP stall')), 5));
  const up = await retryAsync(upload, { attempts: 2, timeoutMs: 50, baseDelayMs: 1 });
  const wouldPublishImageless = up.ok === false ? false : true; // worker publishes ONLY when up.ok
  assert.equal(wouldPublishImageless, false, 'worker must not reach publish when the upload failed');
});
