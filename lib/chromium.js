// lib/chromium.js
// Single source of truth for the Chromium executable Puppeteer launches.
//
// DEFAULT = the BUNDLED Chrome shipped with the app (resources/chrome/chrome.exe). This is the version
// Puppeteer is built/calibrated for, and it's exactly what the proven-working build used. We tried using the
// operator's REAL system Chrome — but that auto-updates AHEAD of Puppeteer's matched version (e.g. real
// Chrome 149 vs Puppeteer's 148), and the version/CDP mismatch made Facebook's fresh-login throw an endless
// captcha. The matched bundled Chrome logs in cleanly. So system Chrome is OPT-IN only (ZA_USE_SYSTEM_CHROME=1).
const path = require('path');
const fs = require('fs');

// Locate a REAL, regular Chrome/Edge install (opt-in only — see note above).
function findSystemBrowser() {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const lad = process.env['LOCALAPPDATA'] || '';
  const candidates = [
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    lad && path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch {} }
  return null;
}

function bundledOrCachePath() {
  // Packaged Electron: the bundled, version-matched browser (works with no Puppeteer cache).
  try {
    const electron = require('electron');
    const app = electron && electron.app;
    if (app && app.isPackaged) {
      const exe = path.join(process.resourcesPath, 'chrome', 'chrome.exe');
      // Packaged: ONLY the bundled browser. If it's missing (AV quarantine / partial extract), return undefined —
      // NEVER fall through to the puppeteer cache, which resolves to the BUILD machine's path (nonexistent on the
      // client) and makes every launch spawn-fail with a misleading ENOENT.
      return fs.existsSync(exe) ? exe : undefined;
    }
  } catch {}
  // Dev / standalone only: Puppeteer's own downloaded (matched) Chromium.
  try { return require('puppeteer').executablePath(); } catch {}
  return undefined;
}

function chromiumPath() {
  // OPT-IN only: real system Chrome (newer than Puppeteer → caused FB login captchas; not the default).
  if (process.env.ZA_USE_SYSTEM_CHROME === '1') {
    const sys = findSystemBrowser();
    if (sys) return sys;
  }
  // DEFAULT: the bundled, version-matched Chrome (what the proven-working build used).
  return bundledOrCachePath();
}

module.exports = { chromiumPath, findSystemBrowser };
