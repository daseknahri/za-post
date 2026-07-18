// scripts/build-portable.js  —  `npm run pack:portable`
// Produces the SEND-READY deliverable: dist/Za-Post-Comment-Tool-<ver>-portable.zip, containing a
// "Za Post Comment Tool" folder (the runnable app + bundled Chromium) plus READ-ME-FIRST.txt.
//
// Why not `npm run pack` (NSIS)? electron-builder's NSIS/portable targets extract a winCodeSign
// cache that contains macOS symlinks; creating those on Windows needs admin / Developer Mode, and
// without it the build aborts and emits no installer. The `dir` target does NOT sign, so it never
// touches winCodeSign — it works on any Windows box. We then zip the unpacked output ourselves.
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const pkg = require(path.join(ROOT, 'package.json'));
const APP_FOLDER = pkg.build.productName; // derived from package.json (stamped by scripts/apply-brand.js) so it can't drift
const ZIP_NAME = `${pkg.build.productName.replace(/\s+/g, '-')}-${pkg.version}-portable.zip`;
const README_SRC = path.join(ROOT, 'build', 'READ-ME-FIRST.txt');

function run(cmd) { console.log('\n> ' + cmd); execSync(cmd, { cwd: ROOT, stdio: 'inherit' }); }

// electron-builder's Windows build extracts a winCodeSign 7z that contains macOS symlinks; creating
// those on Windows needs admin / Developer-Mode, and without it the extract aborts and the WHOLE
// build fails (even the `dir` target downloads winCodeSign). Pre-seed the cache WITHOUT the darwin
// folder (a Windows build never uses it) so the build works on a normal, non-admin user account.
// M4-04: don't hardcode the winCodeSign version — discover the one electron-builder will actually
// request (by scanning app-builder-lib) so a version bump can't silently break the seed. Override
// with WIN_CODESIGN_VERSION; fall back to a known-good default and warn.
function detectWinCodeSignVersion(fallback) {
  if (process.env.WIN_CODESIGN_VERSION) return process.env.WIN_CODESIGN_VERSION;
  try {
    const base = path.dirname(require.resolve('app-builder-lib/package.json'));
    const grep = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { const r = grep(p); if (r) return r; }
        else if (e.name.endsWith('.js')) { const m = fs.readFileSync(p, 'utf8').match(/winCodeSign-(\d+\.\d+\.\d+)/); if (m) return m[1]; }
      }
      return null;
    };
    const found = grep(path.join(base, 'out'));
    if (found) return found;
    console.warn('\n> ⚠️ could not detect electron-builder\'s winCodeSign version — falling back to ' + fallback + '. If the build fails on a winCodeSign extract, set WIN_CODESIGN_VERSION to the version electron-builder logs.');
  } catch (e) { console.warn('\n> ⚠️ winCodeSign version detection failed (' + e.message + ') — using ' + fallback); }
  return fallback;
}

const WIN_CODESIGN_VERSION = detectWinCodeSignVersion('2.6.0');

function ensureWinCodeSign() {
  const v = WIN_CODESIGN_VERSION;
  const cacheRoot = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'winCodeSign');
  const finalDir = path.join(cacheRoot, `winCodeSign-${v}`);
  if (fs.existsSync(path.join(finalDir, 'windows-10'))) { console.log(`\n> winCodeSign cache already seeded (${v})`); return; }
  fs.mkdirSync(cacheRoot, { recursive: true });
  const path7za = require('7zip-bin').path7za;
  const archive = path.join(cacheRoot, `winCodeSign-${v}.7z`);
  if (!fs.existsSync(archive)) {
    const url = `https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-${v}/winCodeSign-${v}.7z`;
    console.log(`\n> downloading winCodeSign-${v}.7z (one-time)`);
    execSync(`powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest -Uri '${url}' -OutFile '${archive}'"`, { stdio: 'inherit' });
  }
  fs.rmSync(finalDir, { recursive: true, force: true });
  console.log(`\n> seeding winCodeSign cache ${v} (excluding darwin symlinks)`);
  execSync(`"${path7za}" x "${archive}" "-o${finalDir}" "-x!darwin" -y`, { cwd: ROOT, stdio: 'inherit' });
}

(async () => {
  if (!fs.existsSync(README_SRC)) throw new Error('missing build/READ-ME-FIRST.txt');

  // 1) refresh the bundled Chromium into ./chrome-bin (extraResources -> resources/chrome)
  run('node scripts/bundle-chromium.js');

  // 1.5) make electron-builder's winCodeSign cache usable without admin/Developer-Mode
  ensureWinCodeSign();

  // 2) build the unpacked app: `dir` target = no installer, no signing.
  // BYTENODE=1 → ship V8 BYTECODE instead of readable JS for the main-process modules (anti-theft). We compile
  // each module to .jsc UNDER ELECTRON (matching V8 ABI), then transiently swap each .js for a 2-line stub that
  // loads its .jsc, build, and ALWAYS restore the source in `finally` (so the dev clone / source tree is never
  // left modified, even on error). Off by default → the normal build is byte-for-byte unchanged.
  const builder = require('electron-builder');
  const BYTENODE = process.env.BYTENODE === '1';
  const swaps = []; const jscFiles = [];
  try {
    if (BYTENODE) {
      console.log('\n> BYTENODE: compiling main-process modules to V8 bytecode (under Electron)…');
      const electronPath = require('electron');
      execSync(`"${electronPath}" scripts/compile-jsc.js`, { cwd: ROOT, stdio: 'inherit' });
      const TARGETS = ['main.js', 'server.js', 'lib/store.js', 'lib/plan.js', 'lib/license.js', 'lib/secret.js', 'lib/chromium.js', 'lib/spintax.js', 'lib/imageVary.js', 'lib/proxy.js', 'automation/orchestrator.js', 'automation/worker.js'];
      for (const rel of TARGETS) {
        const jsPath = path.join(ROOT, rel);
        const jscPath = jsPath.replace(/\.js$/, '.jsc');
        if (!fs.existsSync(jscPath)) throw new Error(`bytenode: ${rel}.jsc was not produced (compile failed)`);
        jscFiles.push(jscPath);
        const base = path.basename(jsPath, '.js');
        // main.js is the entry → just bootstrap bytenode + run its .jsc. Other modules re-export their .jsc.
        // The stub keeps the SAME module path, so every existing require() resolves to it (no require rewrites).
        const stub = rel === 'main.js'
          ? `require('bytenode');\nrequire('./${base}.jsc');\n`
          : `require('bytenode');\nmodule.exports = require('./${base}.jsc');\n`;
        swaps.push({ file: jsPath, backup: fs.readFileSync(jsPath, 'utf8') });
        fs.writeFileSync(jsPath, stub, 'utf8');
      }
      console.log(`> BYTENODE: ${TARGETS.length} modules → bytecode + stub loaders`);
    }
    console.log('\n> electron-builder (dir target)');
    await builder.build({ targets: builder.Platform.WINDOWS.createTarget('dir') });
  } finally {
    // ALWAYS restore the original source + remove the transient .jsc (even if the build threw).
    for (const s of swaps) { try { fs.writeFileSync(s.file, s.backup, 'utf8'); } catch (e) { console.error(`!! RESTORE FAILED: ${s.file} — restore it from git!`, e.message); } }
    for (const j of jscFiles) { try { fs.rmSync(j, { force: true }); } catch {} }
    if (BYTENODE && swaps.length) console.log('> BYTENODE: source .js restored, transient .jsc cleaned');
  }

  const unpacked = path.join(DIST, 'win-unpacked');
  const chromeExe = path.join(unpacked, 'resources', 'chrome', 'chrome.exe');
  if (!fs.existsSync(chromeExe)) throw new Error('build incomplete: resources/chrome/chrome.exe missing in win-unpacked');
  const appExe = path.join(unpacked, `${APP_FOLDER}.exe`);
  if (!fs.existsSync(appExe)) throw new Error(`build incomplete: "${APP_FOLDER}.exe" missing in win-unpacked`);

  // CLIENT license enforcement (opt-in): drop the marker main.js checks (process.resourcesPath/enforce-license.flag)
  // into resources/ so this packaged build REQUIRES per-seat activation. Omit ENFORCE_LICENSE to ship an unlimited build.
  if (process.env.ENFORCE_LICENSE === '1') {
    fs.writeFileSync(path.join(unpacked, 'resources', 'enforce-license.flag'), 'client build — per-seat license enforced\r\n');
    console.log('\n> ENFORCE_LICENSE=1 → wrote resources/enforce-license.flag (this build REQUIRES activation with a per-seat key)');
  } else {
    console.log('\n> (unlimited build — set ENFORCE_LICENSE=1 to require a per-seat key)');
  }

  // 3) stage:  <staging>/Za Post Comment Tool/   +   <staging>/READ-ME-FIRST.txt
  const staging = path.join(DIST, '_portable-staging');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.renameSync(unpacked, path.join(staging, APP_FOLDER));
  fs.copyFileSync(README_SRC, path.join(staging, 'READ-ME-FIRST.txt'));
  fs.copyFileSync(README_SRC, path.join(DIST, 'READ-ME-FIRST.txt')); // handy reference next to the zip

  // start.bat launcher (sits next to the .exe): sets the remote-API token + enables the tunnel for that
  // launch, so the recipient never has to touch Windows env vars — just double-click start.bat. The token is
  // baked from ZAPOST_API_TOKEN at BUILD time (kept OUT of the repo); without it, a clearly-marked placeholder.
  const apiToken = process.env.ZAPOST_API_TOKEN || 'PASTE-YOUR-TOKEN-HERE';
  const enableTunnel = process.env.ENABLE_TUNNEL || '1';
  const bat = [
    '@echo off',
    'setlocal',
    'REM ── Launches Za Post (remote API token + tunnel set for THIS launch) AND auto-relaunches it after a CRASH. ──',
    'REM No admin / scheduled task needed — just double-click this. A clean quit or Stop does NOT relaunch.',
    'REM Keep this window open while the app runs (it is the watchdog). Use the token as your X-Access-Token header.',
    `set "ZAPOST_API_TOKEN=${apiToken}"`,
    `set "ENABLE_TUNNEL=${enableTunnel}"`,
    'set "ZAPOST_WATCHDOG=1"',
    'set /a _fails=0',
    ':launch',
    `start /wait "" "%~dp0${APP_FOLDER}.exe"`,
    'REM The run that just exited reached healthy uptime (the app wrote .healthy) -> reset the crash streak so isolated crashes days apart never accumulate to the cap; then consume the marker.',
    'if exist "%~dp0.healthy" set /a _fails=0',
    'if exist "%~dp0.healthy" del /q "%~dp0.healthy" >nul 2>&1',
    'REM run-active.flag next to the exe = a run was ACTIVE when the process died (a CRASH) -> relaunch. No flag = a clean quit / Stop / completed run -> exit.',
    'if not exist "%~dp0run-active.flag" goto done',
    'set /a _fails+=1',
    'if %_fails% geq 5 (',
    '  echo [start.bat] The app crashed 5 times in a row - not relaunching. Check the app, then run start.bat again.',
    '  goto done',
    ')',
    'echo [start.bat] The app exited while a run was active - crash - relaunching in 30s, attempt %_fails% of 5...',
    'timeout /t 30 /nobreak >nul',
    'goto launch',
    ':done',
    'endlocal',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(staging, APP_FOLDER, 'start.bat'), bat, 'utf8');
  console.log(`\n> wrote ${APP_FOLDER}/start.bat (token ${apiToken === 'PASTE-YOUR-TOKEN-HERE' ? 'PLACEHOLDER — set ZAPOST_API_TOKEN before building' : 'baked from ZAPOST_API_TOKEN'}, ENABLE_TUNNEL=${enableTunnel})`);

  // 4) zip the staging CONTENTS via 7-Zip — STANDARD forward-slash zip entries (the .NET Framework
  // 4.x ZipFile API writes backslash separators that some extractors mishandle). cwd = staging so
  // the "Za Post Comment Tool/" folder + readme land at the zip ROOT.
  const zipPath = path.join(DIST, ZIP_NAME);
  fs.rmSync(zipPath, { force: true });
  const path7za = require('7zip-bin').path7za;
  console.log('\n> 7-Zip: packing portable archive');
  execSync(`"${path7za}" a -tzip -mx=5 "${zipPath}" "*"`, { cwd: staging, stdio: 'inherit' });

  if (!fs.existsSync(zipPath)) throw new Error('zip was not created');
  const mb = Math.round(fs.statSync(zipPath).size / 1e6);
  // Keep ONLY the latest portable zip (operator's rule: "we just need one"). Prune every OTHER *-portable.zip in
  // dist/ now that THIS build succeeded (done after the new zip exists so a failed build never deletes the last good one).
  try {
    for (const f of fs.readdirSync(DIST)) {
      if (/-portable\.zip$/i.test(f) && f !== ZIP_NAME) { fs.rmSync(path.join(DIST, f), { force: true }); console.log(`> pruned old build: dist/${f}`); }
    }
  } catch (e) { console.warn('> (could not prune old zips:', e.message + ')'); }
  console.log(`\n✅ Portable build ready: dist/${ZIP_NAME}  (${mb} MB)`);
  console.log(`   Zip root: "${APP_FOLDER}/" (app + bundled Chromium) + READ-ME-FIRST.txt`);
  console.log('   Send this single .zip — the recipient extracts it and runs the .exe inside.');
})().catch((e) => { console.error('\n❌ build-portable failed:', e.message); process.exit(1); });
