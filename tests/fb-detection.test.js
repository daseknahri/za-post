// tests/fb-detection.test.js
// M1-03 / M1-04: Facebook state detection is the #1 cause of silent overnight failure. These pin
// the shared phrase/label matchers (the single source of truth the worker's in-page detectors use)
// across locales — and, just as important, the NEGATIVE cases: a transient error must not look like
// a block, and "Post to your story" must not look like the submit button.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const w = require('../automation/worker');

test('rate-limit: matches block walls across locales', () => {
  assert.ok(w.isRateLimitText("You're Temporarily Blocked"));
  assert.ok(w.isRateLimitText('You’re doing this too often'.replace('’', "'")));
  assert.ok(w.isRateLimitText('We limit how often you can post'));
  assert.ok(w.isRateLimitText('Action bloquée temporairement'));           // FR (accents)
  assert.ok(w.isRateLimitText('Estás bloqueado temporalmente'));           // ES
  assert.ok(w.isRateLimitText('Du machst das zu oft'));                    // DE
});

test('rate-limit: does NOT match generic transient errors (must not abort the account)', () => {
  assert.equal(w.isRateLimitText('Something went wrong. Please try again later.'), false);
  assert.equal(w.isRateLimitText('Network error, please try again'), false);
  assert.equal(w.isRateLimitText(''), false);
});

test('checkpoint: matches by text, by URL, and ignores normal group pages', () => {
  assert.ok(w.isCheckpointText('Please confirm that you are a real person', ''));
  assert.ok(w.isCheckpointText('Confirma tu identidad para continuar', ''));     // ES
  assert.ok(w.isCheckpointText('', 'https://www.facebook.com/checkpoint/12345/'));// URL cue
  assert.ok(w.isCheckpointText('', 'https://m.facebook.com/challenge/?next=x'));  // URL cue
  assert.equal(w.isCheckpointText('Write something...', 'https://www.facebook.com/groups/123'), false);
});

test('pending: matches approval phrasing but not unrelated "pending" UI', () => {
  assert.ok(w.isPendingText('Your post is pending approval'));
  assert.ok(w.isPendingText('This post will be reviewed by an admin'));
  assert.ok(w.isPendingText('En attente d’approbation'.replace('’', "'")));       // FR
  assert.equal(w.isPendingText('You have 3 pending friend requests'), false);     // false-positive guard
  assert.equal(w.isPendingText('Posted to the group'), false);
});

test('post button: full-label match across locales, not substring', () => {
  assert.ok(w.isPostButtonLabel('Post'));
  assert.ok(w.isPostButtonLabel('  POST  '));      // trims + lowercases
  assert.ok(w.isPostButtonLabel('Publier'));       // FR
  assert.ok(w.isPostButtonLabel('Veröffentlichen'));// DE (accents stripped)
  assert.ok(w.isPostButtonLabel('Pubblica'));      // IT
  assert.equal(w.isPostButtonLabel('Post to your story'), false, 'must not grab a longer label');
  assert.equal(w.isPostButtonLabel('Post anonymously'), false);
  assert.equal(w.isPostButtonLabel(''), false);
});

test('classifyGroupError: block is never retried, transient is, the rest skip (E-P1)', () => {
  assert.equal(w.classifyGroupError('Rate-limited by Facebook'), 'block');
  assert.equal(w.classifyGroupError('identity verification required'), 'block');
  assert.equal(w.classifyGroupError('action blocked'), 'block');
  assert.equal(w.classifyGroupError('Navigation timeout of 30000 ms exceeded'), 'transient');
  assert.equal(w.classifyGroupError('Protocol error (Runtime.callFunctionOn): Target closed'), 'transient');
  assert.equal(w.classifyGroupError('net::ERR_CONNECTION_RESET'), 'transient');
  assert.equal(w.classifyGroupError('post button not found'), 'permanent');
  assert.equal(w.classifyGroupError(''), 'permanent');
});

test('comment box: matches localized aria hints, not unrelated boxes', () => {
  assert.ok(w.isCommentBoxLabel('Write a comment…'));
  assert.ok(w.isCommentBoxLabel('Commentaire'));   // FR
  assert.ok(w.isCommentBoxLabel('Kommentar schreiben')); // DE
  assert.ok(w.isCommentBoxLabel('Escribe un comentario')); // ES
  assert.equal(w.isCommentBoxLabel('Search'), false);
  assert.equal(w.isCommentBoxLabel("What's on your mind?"), false);
});
