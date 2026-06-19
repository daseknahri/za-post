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

(async () => {
  if (!fs.existsSync(README_SRC)) throw new Error('missing build/READ-ME-FIRST.txt');

  // 1) refresh the bundled Chromium into ./chrome-bin (extraResources -> resources/chrome)
  run('node scripts/bundle-chromium.js');

  // 2) build the unpacked app: `dir` target = no installer, no signing, no winCodeSign
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

  // 4) zip the staging CONTENTS (folder + readme become the zip root) via .NET — fast, standard
  const zipPath = path.join(DIST, ZIP_NAME);
  fs.rmSync(zipPath, { force: true });
  const ps1 = path.join(DIST, '_zip.ps1');
  fs.writeFileSync(ps1,
    "Add-Type -AssemblyName System.IO.Compression.FileSystem\n" +
    `[System.IO.Compression.ZipFile]::CreateFromDirectory('${staging}', '${zipPath}', 'Optimal', $false)\n`);
  run(`powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1}"`);
  fs.rmSync(ps1, { force: true });

  if (!fs.existsSync(zipPath)) throw new Error('zip was not created');
  const mb = Math.round(fs.statSync(zipPath).size / 1e6);
  console.log(`\n✅ Portable build ready: dist/${ZIP_NAME}  (${mb} MB)`);
  console.log(`   Zip root: "${APP_FOLDER}/" (app + bundled Chromium) + READ-ME-FIRST.txt`);
  console.log('   Send this single .zip — the recipient extracts it and runs the .exe inside.');
})().catch((e) => { console.error('\n❌ build-portable failed:', e.message); process.exit(1); });
