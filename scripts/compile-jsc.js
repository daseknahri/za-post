// scripts/compile-jsc.js — compile the MAIN-PROCESS modules to V8 bytecode (.jsc) so the shipped app contains
// bytecode, not readable JS. MUST run UNDER ELECTRON (electron.exe scripts/compile-jsc.js) so the bytecode
// matches the bundled Electron's V8 ABI — a .jsc compiled under plain Node would fail to load in the app.
//
// It only COMPILES (creates X.jsc next to X.js). The build script (build-portable.js, BYTENODE=1) does the
// swap-to-stub + restore around the package step. Renderer/preload are NOT compiled (they load via <script>/
// the preload sandbox, not require()).
'use strict';
const bytenode = require('bytenode');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// Main-process modules that are require()'d (safe to bytecode). Excludes preload.js, license-preload.js,
// renderer/renderer.js (renderer side) and node_modules.
const DEFAULT_TARGETS = [
  'main.js', 'server.js',
  'lib/store.js', 'lib/plan.js', 'lib/license.js', 'lib/secret.js', 'lib/chromium.js', 'lib/spintax.js', 'lib/imageVary.js', 'lib/proxy.js',
  'automation/orchestrator.js', 'automation/worker.js',
];

// Optional CLI args = a specific subset (used by the smoke test). Otherwise compile the full set.
const argv = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const targets = argv.length ? argv : DEFAULT_TARGETS;

(async () => {
  try {
    for (const rel of targets) {
      const src = path.join(ROOT, rel);
      const out = src.replace(/\.js$/, '.jsc');
      await bytenode.compileFile({ filename: src, output: out, compileAsModule: true });
      console.log('compiled', rel, '->', path.basename(out));
    }
    console.log('JSC_OK ' + targets.length);
    process.exit(0);
  } catch (e) {
    console.error('JSC_FAIL', (e && e.message) || e);
    process.exit(1);
  }
})();
