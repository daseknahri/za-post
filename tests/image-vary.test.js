// tests/image-vary.test.js
// imageVary.varyImage is the anti-dedup perturbation: FB dedups on image hash across accounts/groups, so
// the same source must not upload byte/hash-identical from every account. Contract: same seed →
// DETERMINISTIC output (retry-stable, no endless temp variants); output differs from source (the hash
// actually shifts); a falsy source (or missing jimp) → null so the caller uploads the original unchanged.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const imageVary = require('../lib/imageVary');
let Jimp; try { Jimp = require('jimp'); } catch {}

test('varyImage: falsy source → null (caller uploads the original)', async () => {
  assert.equal(await imageVary.varyImage(null, 's'), null);
  assert.equal(await imageVary.varyImage('', 's'), null);
});

test('available() reflects jimp presence', () => {
  assert.equal(imageVary.available(), !!Jimp);
});

test('varyImage: same seed is deterministic + output differs from source', { skip: !Jimp }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zpv-test-'));
  const src = path.join(dir, 'src.png');
  // A small solid image (PNG so encode is lossless → decoded pixels are exact). The perturbations
  // (crop + brightness + per-channel tint + sparse noise) all draw from the seeded RNG in a fixed order.
  const img = await new Promise((res, rej) => new Jimp(48, 48, 0x3366ccff, (e, i) => e ? rej(e) : res(i)));
  await img.writeAsync(src);
  const srcBytes = (await Jimp.read(src)).bitmap.data;

  const out1 = await imageVary.varyImage(src, 'seed-A');
  const out2 = await imageVary.varyImage(src, 'seed-A');
  try {
    assert.ok(out1 && out2, 'both variations produced a file');
    const px1 = (await Jimp.read(out1)).bitmap.data;
    const px2 = (await Jimp.read(out2)).bitmap.data;
    assert.equal(Buffer.compare(px1, px2), 0, 'same seed → identical decoded pixels (deterministic / retry-stable)');
    const differs = px1.length !== srcBytes.length || Buffer.compare(px1, srcBytes) !== 0;
    assert.ok(differs, 'varied output must differ from the source (the perceptual hash is shifted)');
  } finally {
    for (const o of [out1, out2]) { if (o) { try { fs.unlinkSync(o); } catch {} } }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
