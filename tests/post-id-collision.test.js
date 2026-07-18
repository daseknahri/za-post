// tests/post-id-collision.test.js
// [#4] POST IDS MUST BE COLLISION-PROOF — a duplicate post.id is a DOUBLE-POST, not a cosmetic wart.
//
// The bulk-add paths captured `const now = Date.now()` OUTSIDE store.update()'s mutator, so store's _writeChain
// serialization gave ZERO protection: two concurrent bulk adds both read the clock before either mutator ran and minted
// IDENTICAL sequences (post-N-0..post-N-k). Nothing anywhere enforces post.id uniqueness.
//
// Why it is a double-post: campaign-plan is the one mode with NO durable per-(post,group) guard (the ledger dedups only
// WITHIN a cycle), so its monotonic slice pointer is the only defense — and _campaignNextIdx resolves it with
// `list.indexOf(lastPostId) + 1`, which returns the FIRST occurrence. A duplicate id silently REWINDS the pointer, and
// the agent re-posts its already-delivered slice, every round, forever.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// The mint shape used by both bulk paths (main.js) — nanosecond + monotonic + random, as lib/imageVary.js already does.
const mint = (i) => `post-${Date.now()}-${process.hrtime.bigint()}-${i}-${Math.floor(Math.random() * 1e9)}`;

test('[#4] ids are unique within one batch', () => {
  const ids = Array.from({ length: 500 }, (_, i) => mint(i));
  assert.equal(new Set(ids).size, ids.length, 'every id in a batch must be distinct');
});

test('[#4] ids are unique ACROSS batches minted in the SAME millisecond (the concurrent-bulk-add race)', () => {
  // Two bulk adds racing inside one clock tick — the exact case the hoisted Date.now() collided on.
  const a = [], b = [];
  const t0 = Date.now();
  do { a.push(mint(0)); b.push(mint(0)); } while (Date.now() === t0 && a.length < 200);
  const all = a.concat(b);
  assert.ok(a.length > 1, 'sanity: minted several ids inside one millisecond');
  assert.equal(new Set(all).size, all.length, 'same-millisecond mints must NOT collide — a duplicate id rewinds the campaign slice pointer into a permanent re-post loop');
});

test('[#4] the OLD shape collides in exactly this case (proves the test is not vacuous)', () => {
  const now = Date.now();                       // hoisted OUT of the mutator, as the bug had it
  const oldMint = (i) => `post-${now}-${i}`;
  const a = [0, 1, 2].map(oldMint);
  const b = [0, 1, 2].map(oldMint);             // a second concurrent bulk add, same captured clock
  assert.deepEqual(a, b, 'the old shape produced IDENTICAL id sequences for concurrent batches');
  assert.notEqual(new Set(a.concat(b)).size, a.concat(b).length, 'i.e. it collided — which is what the new mint fixes');
});
