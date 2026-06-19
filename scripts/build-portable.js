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
const APP_FOLDER = 'Za Post Comment Tool';
const ZIP_NAME = `Za-Post-Comment-Tool-${pkg.version}-portable.zip`;
const README_SRC = path.join(ROOT, 'build', 'READ-ME-FIRST.txt');

function run(cmd) { console.log('\n> ' + cmd); execSync(cmd, { cwd: ROOT, stdio: 'inherit' }); }

// electron-builder's Windows build extracts a winCodeSign 7z that contains macOS symlinks; creating
// those on Windows needs admin / Developer-Mode, and without it the extract aborts and the WHOLE
// build fails (even the `dir` target downloads winCodeSign). Pre-seed the cache WITHOUT the darwin
// folder (a Windows build never uses it) so the build works on a normal, non-admin user account.
function ensureWinCodeSign() {
  const cacheRoot = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'winCodeSign');
  const finalDir = path.join(cacheRoot, 'winCodeSign-2.6.0');
  if (fs.existsSync(path.join(finalDir, 'windows-10'))) { console.log('\n> winCodeSign cache already seeded'); return; }
  fs.mkdirSync(cacheRoot, { recursive: true });
  const path7za = require('7zip-bin').path7za;
  const archive = path.join(cacheRoot, 'winCodeSign-2.6.0.7z');
  if (!fs.existsSync(archive)) {
    const url = 'https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z';
    console.log('\n> downloading winCodeSign-2.6.0.7z (one-time)');
    execSync(`powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest -Uri '${url}' -OutFile '${archive}'"`, { stdio: 'inherit' });
  }
  fs.rmSync(finalDir, { recursive: true, force: true });
  console.log('\n> seeding winCodeSign cache (excluding darwin symlinks)');
  execSync(`"${path7za}" x "${archive}" "-o${finalDir}" "-x!darwin" -y`, { cwd: ROOT, stdio: 'inherit' });
}

(async () => {
  if (!fs.existsSync(README_SRC)) throw new Error('missing build/READ-ME-FIRST.txt');

  // 1) refresh the bundled Chromium into ./chrome-bin (extraResources -> resources/chrome)
  run('node scripts/bundle-chromium.js');

  // 1.5) make electron-builder's winCodeSign cache usable without admin/Developer-Mode
  ensureWinCodeSign();

  // 2) build the unpacked app: `dir` target = no installer, no signing
  console.log('\n> electron-builder (dir target)');
  const builder = require('electron-builder');
  await builder.build({ targets: builder.Platform.WINDOWS.createTarget('dir') });

  const unpacked = path.join(DIST, 'win-unpacked');
  const chromeExe = path.join(unpacked, 'resources', 'chrome', 'chrome.exe');
  if (!fs.existsSync(chromeExe)) throw new Error('build incomplete: resources/chrome/chrome.exe missing in win-unpacked');
  const appExe = path.join(unpacked, `${APP_FOLDER}.exe`);
  if (!fs.existsSync(appExe)) throw new Error(`build incomplete: "${APP_FOLDER}.exe" missing in win-unpacked`);

  // 3) stage:  <staging>/Za Post Comment Tool/   +   <staging>/READ-ME-FIRST.txt
  const staging = path.join(DIST, '_portable-staging');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.renameSync(unpacked, path.join(staging, APP_FOLDER));
  fs.copyFileSync(README_SRC, path.join(staging, 'READ-ME-FIRST.txt'));
  fs.copyFileSync(README_SRC, path.join(DIST, 'READ-ME-FIRST.txt')); // handy reference next to the zip

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
  console.log(`\n✅ Portable build ready: dist/${ZIP_NAME}  (${mb} MB)`);
  console.log(`   Zip root: "${APP_FOLDER}/" (app + bundled Chromium) + READ-ME-FIRST.txt`);
  console.log('   Send this single .zip — the recipient extracts it and runs the .exe inside.');
})().catch((e) => { console.error('\n❌ build-portable failed:', e.message); process.exit(1); });
