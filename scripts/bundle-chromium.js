// scripts/bundle-chromium.js
// Copies Puppeteer's downloaded Chromium into ./chrome-bin so electron-builder can
// ship it as an extraResource (-> resources/chrome). Version-proof: the source dir
// is resolved from puppeteer.executablePath(), not hardcoded. Run by `npm run pack`.
const fs = require('fs');
const path = require('path');

const exe = require('puppeteer').executablePath(); // .../chrome/<ver>/chrome-win64/chrome.exe
if (!exe || !fs.existsSync(exe)) {
  console.error('[bundle-chromium] Chromium not found at:', exe);
  console.error('[bundle-chromium] Run `npx puppeteer browsers install chrome` first.');
  process.exit(1);
}
const srcDir = path.dirname(exe);                       // the chrome-win64 folder
const destDir = path.join(__dirname, '..', 'chrome-bin');

fs.rmSync(destDir, { recursive: true, force: true });
fs.cpSync(srcDir, destDir, { recursive: true });
const mb = Math.round(fs.statSync(path.join(destDir, 'chrome.exe')).size / 1e6);
console.log(`[bundle-chromium] Copied Chromium (chrome.exe ${mb}MB) ->`, destDir);
