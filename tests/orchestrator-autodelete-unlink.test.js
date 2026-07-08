// tests/orchestrator-autodelete-unlink.test.js
// Auto-delete image cleanup (this-session fix): when a post is auto-deleted, its LOCAL image files are unlinked —
// but ONLY files UNDER the app's images dir. imagePaths can come from the remote bulk API or a hand-edited data.json,
// so an outside / traversal / URL / sibling-prefix path must NEVER be removed. Guards the containment check + the
// "orphans every posted image → unbounded disk growth" regression.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Orchestrator } = require('../automation/orchestrator');

test('_unlinkDeletedImages: removes ONLY files under the images dir (path containment)', () => {
  const orch = new Orchestrator(() => {}, {});
  const imagesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-imgdir-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zpost-outside-'));
  const siblingEvil = imagesDir + '-evil'; fs.mkdirSync(siblingEvil, { recursive: true }); // shares the imagesDir prefix

  const inDir = path.join(imagesDir, 'img1.jpg'); fs.writeFileSync(inDir, 'x');
  const inSub = path.join(imagesDir, 'sub', 'img2.jpg'); fs.mkdirSync(path.dirname(inSub), { recursive: true }); fs.writeFileSync(inSub, 'x');
  const outside = path.join(outsideDir, 'secret.jpg'); fs.writeFileSync(outside, 'y');
  const traversal = path.join(imagesDir, '..', path.basename(outsideDir), 'secret.jpg'); // resolves to `outside`
  const evil = path.join(siblingEvil, 'z.jpg'); fs.writeFileSync(evil, 'z');

  orch._unlinkDeletedImages([inDir, inSub, outside, traversal, evil, 'https://cdn/x.jpg', null, undefined], imagesDir);

  assert.equal(fs.existsSync(inDir), false, 'an in-dir image IS unlinked');
  assert.equal(fs.existsSync(inSub), false, 'a nested in-dir image IS unlinked');
  assert.equal(fs.existsSync(outside), true, 'an outside-dir file is NEVER unlinked (direct + traversal both rejected)');
  assert.equal(fs.existsSync(evil), true, 'a SIBLING dir that merely prefix-matches the images dir is NOT unlinked');

  // Degenerate inputs must be safe no-ops (never throw)
  assert.doesNotThrow(() => orch._unlinkDeletedImages([], imagesDir));
  assert.doesNotThrow(() => orch._unlinkDeletedImages(null, imagesDir));
  assert.doesNotThrow(() => orch._unlinkDeletedImages([inDir], '')); // no dir → guard skips, nothing removed

  fs.rmSync(imagesDir, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
  fs.rmSync(siblingEvil, { recursive: true, force: true });
});
