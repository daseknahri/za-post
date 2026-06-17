// lib/chromium.js
// Single source of truth for the Chromium executable Puppeteer should launch.
//  - Packaged Electron app: the browser is shipped as an extraResource at
//    <resources>/chrome/chrome.exe (see package.json build.extraResources and
//    scripts/bundle-chromium.js). This is what makes the app work on a machine
//    with no Puppeteer cache / no dev tools.
//  - Dev or standalone node scripts: fall back to Puppeteer's downloaded cache.
const path = require('path');
const fs = require('fs');

function chromiumPath() {
  // Packaged Electron: use the bundled browser so no Puppeteer cache is needed.
  try {
    const electron = require('electron');
    const app = electron && electron.app;
    if (app && app.isPackaged) {
      const exe = path.join(process.resourcesPath, 'chrome', 'chrome.exe');
      if (fs.existsSync(exe)) return exe;
    }
  } catch {}
  // Dev / standalone: let Puppeteer resolve its own downloaded Chromium.
  try { return require('puppeteer').executablePath(); } catch {}
  return undefined;
}

module.exports = { chromiumPath };
