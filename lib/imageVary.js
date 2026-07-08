// lib/imageVary.js
// Produce a visually near-identical COPY of an image with a DIFFERENT perceptual hash, so the
// same source image doesn't upload byte-for-byte (and hash-for-hash) to every group/account.
// Facebook dedups on image hash across groups — an identical hash arriving from many accounts
// in one window is a strong coordinated-spam signal. Best-effort: if jimp is missing or the
// image can't be processed, returns null and the caller uploads the ORIGINAL unchanged.

let Jimp; try { Jimp = require('jimp'); } catch {}
const path = require('path');
const os = require('os');
const fs = require('fs');

// Small deterministic RNG so the SAME (account, group, image) reuses the same perturbation on
// retries instead of spawning endless temp variants.
function hashInt(s) { let h = 2166136261; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function seedRng(s) { return mulberry32(hashInt(s)); }

const available = () => !!Jimp;

// Returns a path to a NEW temp image (caller must delete it), or null on any failure.
async function varyImage(srcPath, seed) {
  if (!Jimp || !srcPath) return null;
  try {
    const rng = seedRng(seed || srcPath);
    const img = await Jimp.read(srcPath);
    // SPEED: resize an oversized source DOWN before the per-pixel perturbations + encode. jimp is pure-JS, so the
    // brightness/hue/noise loops + writeAsync scale with pixel count — a 3000–5000px source made varyImage take ~12s per
    // group (blocking, right after the composer opens). Facebook re-compresses/downscales uploads to ~2048px anyway, so
    // processing at full res is wasted. Cap the longest edge at MAX_EDGE — this changes NOTHING about the hash-shift (all
    // perturbations still apply) and nothing visible (FB would downscale it regardless), it just makes the vary fast.
    const MAX_EDGE = 1600;
    if (Math.max(img.bitmap.width, img.bitmap.height) > MAX_EDGE) {
      try { if (img.bitmap.width >= img.bitmap.height) img.resize(MAX_EDGE, Jimp.AUTO); else img.resize(Jimp.AUTO, MAX_EDGE); } catch {}
    }
    const w = img.bitmap.width, h = img.bitmap.height;
    // Trim 1–3% off each edge — shifts the perceptual hash while staying visually the same.
    const cx = Math.max(1, Math.round(w * (0.01 + rng() * 0.02)));
    const cy = Math.max(1, Math.round(h * (0.01 + rng() * 0.02)));
    img.crop(cx, cy, Math.max(8, w - cx * 2), Math.max(8, h - cy * 2));
    // Tiny tone + color shifts the eye won't notice but the hash will.
    img.brightness((rng() - 0.5) * 0.06);                                   // ±3%
    // Cheap per-channel color tint — REPLACES jimp's color([{apply:'hue'}]) which did a full pure-JS RGB→HSL→RGB
    // conversion per pixel and cost ~6.5s on a 1080px image (the entire varyImage bottleneck). A small ±per-channel
    // offset over all pixels is ONE fast pass (~50ms) and shifts the color distribution + perceptual/byte hash the same
    // way a small hue rotate does — so the anti-dedup perturbation is preserved; only the catastrophic implementation goes.
    {
      const dr = Math.round((rng() - 0.5) * 12), dg = Math.round((rng() - 0.5) * 12), db = Math.round((rng() - 0.5) * 12);
      const d = img.bitmap.data, N = d.length;
      for (let i = 0; i < N; i += 4) {
        d[i]     = d[i]     < -dr ? 0 : d[i]     + dr > 255 ? 255 : d[i]     + dr;
        d[i + 1] = d[i + 1] < -dg ? 0 : d[i + 1] + dg > 255 ? 255 : d[i + 1] + dg;
        d[i + 2] = d[i + 2] < -db ? 0 : d[i + 2] + db > 255 ? 255 : d[i + 2] + db;
      }
    }
    // Sprinkle faint noise on a sparse set of pixels.
    const npx = 200 + Math.floor(rng() * 300);
    const data = img.bitmap.data, bw = img.bitmap.width, bh = img.bitmap.height;
    for (let n = 0; n < npx; n++) {
      const x = Math.floor(rng() * bw), y = Math.floor(rng() * bh);
      const d = (rng() < 0.5 ? -1 : 1) * (1 + Math.floor(rng() * 3));
      const idx = (bw * y + x) << 2;
      for (let c = 0; c < 3; c++) data[idx + c] = Math.max(0, Math.min(255, data[idx + c] + d));
    }
    let ext = 'jpg';
    try { ext = (img.getExtension() || 'jpg').replace('jpeg', 'jpg'); } catch {}
    if (img.quality) img.quality(92);
    const out = path.join(os.tmpdir(), `zpv-${Date.now()}-${process.hrtime.bigint()}-${Math.floor(rng() * 1e9)}.${ext}`); // nanosecond+monotonic → collision-proof across parallel accounts
    await img.writeAsync(out);
    return fs.existsSync(out) ? out : null;
  } catch { return null; }
}

module.exports = { varyImage, available };
