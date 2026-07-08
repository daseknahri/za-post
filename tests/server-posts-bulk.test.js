// tests/server-posts-bulk.test.js
// The remote POST /api/posts/bulk endpoint: token-gated bulk insert from an external server. Verifies the
// X-Access-Token gate, that it accepts both { posts:[…] } and a raw array body, the replace flag is passed
// through, and a non-array body is a 400. Uses the real express app (server.js) with a stubbed addPostsBulk
// hook, driven over HTTP via global fetch.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const remote = require('../server');

test('POST /api/posts/bulk: token gate + array / {posts} / raw-array bodies + validation', async () => {
  const port = 38217;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-srv-'));
  const captured = [];
  await remote.startServer(port, {
    apiToken: 'secret-token',
    uploadDir: path.join(tmp, 'uploads'),
    imagesDir: path.join(tmp, 'images'),
    getData: () => ({ posts: [] }),
    addPostsBulk: async (posts, opts) => {
      captured.push({ posts, opts });
      const added = posts.filter((p) => (p.caption || '').trim()).length;
      return { added, skipped: posts.length - added };
    },
  });
  const base = `http://127.0.0.1:${port}`;
  const TOK = { 'Content-Type': 'application/json', 'X-Access-Token': 'secret-token' };

  // 1) no token → 401
  let r = await fetch(`${base}/api/posts/bulk`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts: [{ caption: 'x' }] }) });
  assert.equal(r.status, 401, 'missing token → 401');

  // 2) { posts:[…] } with token: one valid, one blank caption (skipped); replace passed through
  r = await fetch(`${base}/api/posts/bulk`, { method: 'POST', headers: TOK, body: JSON.stringify({ replace: true, posts: [{ caption: 'Post A', comment: 'c', imageUrl: 'http://img/a.jpg' }, { caption: '  ' }] }) });
  let j = await r.json();
  assert.equal(r.status, 200);
  assert.deepEqual({ success: j.success, added: j.added, skipped: j.skipped, replaced: j.replaced }, { success: true, added: 1, skipped: 1, replaced: true });
  assert.equal(captured[0].posts.length, 2, 'hook received both posts');
  assert.equal(captured[0].opts.replace, true, 'replace flag forwarded to the hook');

  // 3) raw JSON array body also accepted (replace defaults false)
  r = await fetch(`${base}/api/posts/bulk`, { method: 'POST', headers: TOK, body: JSON.stringify([{ caption: 'B' }, { caption: 'C' }]) });
  j = await r.json();
  assert.equal(j.success, true); assert.equal(j.added, 2); assert.equal(j.replaced, false);

  // 4) non-array → 400
  r = await fetch(`${base}/api/posts/bulk`, { method: 'POST', headers: TOK, body: JSON.stringify({ posts: 'nope' }) });
  assert.equal(r.status, 400, 'non-array posts → 400');

  remote.stopServer();
  fs.rmSync(tmp, { recursive: true, force: true });
});
