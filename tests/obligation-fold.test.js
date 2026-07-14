// tests/obligation-fold.test.js
// Locks the crash-durability OBLIGATION FOLD (Orchestrator._foldObligationJournal). Held-post + orphan/deferred link-
// comment obligations are journaled at CREATION (store.appendObligation), so a hard-kill before the account-return
// persist no longer loses them: the next Start folds the survivors into moderation.json / comments.json — deduped
// EXACTLY as the return-persist does (recovered once, never doubled) — then clears the journal so a resolved-and-removed
// card can't be re-folded as a phantom. Comments always rescue (Phase-3 is idempotent); held needs an opt-in consumer.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('_foldObligationJournal: recovers journaled held + comments, deduped, then clears (no phantom on re-fold)', async () => {
  const store = require('../lib/store');
  const { Orchestrator } = require('../automation/orchestrator');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-obl-'));
  store.init(tmp);

  // Simulate a CRASHED run: obligations on disk, but moderation/comments empty (the account-return persist never ran).
  store.appendObligation({ k: 'held', postId: 'p1', gid: 'g1', posterAccount: 'a', captionSnip: 'hello', source: 'pending_at_publish' });
  store.appendObligation({ k: 'held', postId: 'p1', gid: 'g1', posterAccount: 'a', captionSnip: 'hello', source: 'comment_notfound' }); // DUP (same post,group,account) → collapses
  store.appendObligation({ k: 'held', postId: 'p2', gid: 'g2', posterAccount: 'b', captionSnip: 'world' });
  store.appendObligation({ k: 'comment', postId: 'p3', gid: 'g3', posterAccount: 'a', captionSnip: 'link', comment: 'mylink', reason: 'emerging_block' });
  store.appendObligation({ k: 'comment', postId: 'p3', gid: 'g3', posterAccount: 'a', captionSnip: 'link', comment: 'mylink' }); // DUP (same postId) → collapses
  store.appendObligation({ k: 'comment', postId: 'p4', gid: 'g4', posterAccount: 'b', captionSnip: 'link2', comment: 'link2' });

  const o = Object.create(Orchestrator.prototype);
  o.log = () => {};
  const data = { settings: { moderationEnabled: true } }; // held consumers on

  await o._foldObligationJournal(data);

  const held = store.loadModeration().held;
  assert.equal(held.length, 2, 'two DISTINCT held cards recovered (the p1/g1/a dup collapsed)');
  assert.ok(held.every((h) => h.status === 'held'), 'folded held records are status=held');
  assert.deepEqual(held.map((h) => h.postId).sort(), ['p1', 'p2']);

  const pending = store.loadComments().pending;
  assert.equal(pending.length, 2, 'two DISTINCT pending comments recovered (the p3 dup collapsed)');
  assert.deepEqual(pending.map((c) => c.postId).sort(), ['p3', 'p4']);

  // The journal is CLEARED after folding → a second Start folds nothing (no phantom re-add).
  assert.deepEqual(store.loadObligations(), [], 'obligation journal cleared after fold');
  await o._foldObligationJournal(data);
  assert.equal(store.loadModeration().held.length, 2, 're-fold is a no-op (journal empty)');
  assert.equal(store.loadComments().pending.length, 2, 're-fold is a no-op for comments');

  // Idempotency across a REPEAT crash: the same obligation re-journaled + re-folded must NOT double (dedup vs persisted).
  store.appendObligation({ k: 'held', postId: 'p1', gid: 'g1', posterAccount: 'a', captionSnip: 'hello' });
  store.appendObligation({ k: 'comment', postId: 'p3', gid: 'g3', posterAccount: 'a', captionSnip: 'link' });
  await o._foldObligationJournal(data);
  assert.equal(store.loadModeration().held.length, 2, 'a re-journaled held dup does not double (deduped vs the already-persisted card)');
  assert.equal(store.loadComments().pending.length, 2, 'a re-journaled comment dup does not double');

  // Moderation OFF → held obligations are NOT folded (no consumer), but comments still rescue.
  store.saveModeration({ held: [] }); store.saveComments({ pending: [] });
  store.appendObligation({ k: 'held', postId: 'p5', gid: 'g5', posterAccount: 'a' });
  store.appendObligation({ k: 'comment', postId: 'p6', gid: 'g6', posterAccount: 'a', comment: 'x' });
  await o._foldObligationJournal({ settings: { moderationEnabled: false } });
  assert.equal(store.loadModeration().held.length, 0, 'held NOT folded when all consumers (moderation/repost/completion) are off');
  assert.equal(store.loadComments().pending.length, 1, 'comments still fold (they always rescue — a live post is never left without its link)');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('compactObligations: per-account compaction drops only that account\'s entries (the clean-return path)', () => {
  const store = require('../lib/store');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-oblc-'));
  store.init(tmp);
  store.appendObligation({ k: 'held', postId: 'p1', gid: 'g1', posterAccount: 'a' });
  store.appendObligation({ k: 'comment', postId: 'p2', gid: 'g2', posterAccount: 'a' });
  store.appendObligation({ k: 'held', postId: 'p3', gid: 'g3', posterAccount: 'b' });
  // Account 'a' returns cleanly (its obligations now durable in moderation/comments) → compact out ONLY a's entries.
  store.compactObligations((e) => (e && e.posterAccount) !== 'a');
  const left = store.loadObligations();
  assert.equal(left.length, 1, "only account b's obligation remains after a's clean-return compaction");
  assert.equal(left[0].posterAccount, 'b');
  store.compactObligations(() => false); // clear-all (fold/Start-Fresh)
  assert.deepEqual(store.loadObligations(), [], 'clear-all empties the journal');
  fs.rmSync(tmp, { recursive: true, force: true });
});
