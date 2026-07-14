// tests/repost-author-match.test.js
// R6 AUTHOR-MATCHING (repost.js isContentLive) — the Phase-4 re-post liveness check must recognize EITHER of OUR
// live copies (the ORIGINAL poster's AND, after a crash re-armed a re-post, the RESERVE reposter's) so it never
// re-posts a duplicate, while NEVER counting a stranger's same-caption post as ours. The DOM navigation isn't unit-
// testable, but the two pure pieces are: authorsList (which isContentLive uses directly, Node-side, to build the
// author set fed into the in-browser scan) and isOurAuthor (the per-article predicate the in-browser feed scan +
// permalink gate replicate). This locks the R6 semantics against regression.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { authorsList, isOurAuthor } = require('../automation/repost');

// ── authorsList: normalize + 60-slice + drop-empties, from a single value OR an array ────────────────────────────
test('authorsList: normalizes (diacritics, case, whitespace) and drops empties', () => {
  assert.deepEqual(authorsList(['Zakaria  El  Ámïn', '', null, undefined]), ['zakaria el amin'], 'diacritics stripped, collapsed whitespace, lowercased; falsy entries removed');
  assert.deepEqual(authorsList('Simo'), ['simo'], 'a single (non-array) value is wrapped');
  assert.deepEqual(authorsList([]), [], 'empty in → empty out');
  assert.deepEqual(authorsList(null), [], 'null → [] (no throw)');
});

test('authorsList: keeps BOTH the original poster and the reserve reposter (the R6 pair)', () => {
  assert.deepEqual(authorsList(['Original Name', 'Reserve Name']), ['original name', 'reserve name'], 'both authors survive so isContentLive matches either');
});

test('authorsList: 60-slices to MATCH authorOf (a >60-char display name still author-matches)', () => {
  const long = 'x'.repeat(70);
  const got = authorsList([long]);
  assert.equal(got[0].length, 60, 'expected author sliced to 60 — authorOf slices the on-page author to 60, so an un-sliced expected name would never match (a false hold)');
  assert.ok(isOurAuthor(got, 'x'.repeat(60)), 'the 60-char on-page author matches the 60-sliced expected author');
});

// ── isOurAuthor: the per-article predicate ───────────────────────────────────────────────────────────────────────
test('isOurAuthor: an UNREADABLE article author is treated as possibly-ours (never risk a duplicate)', () => {
  assert.equal(isOurAuthor(['original', 'reserve'], ''), true, "empty/unreadable author → true (conservative — don't re-post over a maybe-ours post)");
});

test('isOurAuthor: a readable author is ours iff it is one of OUR authors', () => {
  const authors = ['original', 'reserve'];
  assert.equal(isOurAuthor(authors, 'original'), true, 'the ORIGINAL poster is ours');
  assert.equal(isOurAuthor(authors, 'reserve'), true, 'the RESERVE reposter is ours (the R6 fix — its own live copy is recognized)');
  assert.equal(isOurAuthor(authors, 'a stranger'), false, "a STRANGER's same-caption post is NOT ours (never suppressed on a stranger)");
});

test('isOurAuthor: with only the original author, the reserve copy is NOT matched (pre-R6 behavior when no reserve armed)', () => {
  assert.equal(isOurAuthor(['original'], 'reserve'), false, 'single-author set does not match the reserve — R6 value comes from PASSING both authors');
});

// ── The R6 scenario end-to-end (pure): a re-armed re-post recognizes the reserve; a stranger is refused ──────────
test('R6 scenario: a crash-re-armed re-post finds the RESERVE own live copy (no duplicate) and refuses a stranger', () => {
  // dispatch builds expectedAuthors = [rec.fbDisplayName, rec.repostedByDisplay].filter(Boolean)
  const authors = authorsList(['Original Poster', 'Reserve Poster']);
  // The reserve's own live copy is in the feed (original permalink was 'absent' → fell through to the author-aware scan)
  assert.equal(isOurAuthor(authors, 'reserve poster'), true, 'reserve live copy recognized → isContentLive live → NO duplicate re-post');
  // A stranger who posted the identical caption is NOT us
  assert.equal(isOurAuthor(authors, 'someone else'), false, 'stranger refused → not counted live → the (cap-1-bounded) re-post is still allowed, never suppressed on a stranger');
  // Before the reserve name is ever captured (repostedByDisplay ''), only the original remains
  assert.deepEqual(authorsList(['Original Poster', '']), ['original poster'], 'a never-warmed reserve (empty display) degrades to original-author-only — the documented residual');
});
