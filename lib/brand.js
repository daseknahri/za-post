// lib/brand.js — single source of truth for all per-brand identity (app name, app id, remote port, autostart
// task name, window title, icon, accent). Read ONCE at startup from brand.json at the project/asar root.
//
// WHITE-LABEL: every field FALLS BACK to the original "Za Post" defaults, so if brand.json is missing or partial
// the app behaves EXACTLY as before — the refactor is therefore safe for the existing/shipped build. To spin up a
// differently-branded copy that runs side-by-side on the same machine, run `node scripts/apply-brand.js <name>`
// (it copies brands/<name>.json here, stamps the build-time keys into package.json, and stamps the renderer
// <title>), then build. The two copies then differ in: userData folder (app name), Windows app id, exe/product
// name, desktop shortcut, autostart task, and remote API port — so neither can touch the other's data or processes.
'use strict';
const fs = require('fs');
const path = require('path');

let _b = null;
function brand() {
  if (_b) return _b;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'brand.json'), 'utf8')) || {}; } catch { raw = {}; }
  _b = {
    name:          raw.name          || 'za-post-restored',      // app.getName() → %APPDATA%\<name> (ALL on-disk state)
    appId:         raw.appId         || 'com.zapost.commenttool', // Windows AppUserModelID + electron-builder appId
    productName:   raw.productName   || 'Za Post Comment Tool',   // exe filename + install dir + desktop shortcut
    windowTitle:   raw.windowTitle   || raw.productName || 'Za Post Comment Tool',
    shortName:     raw.shortName     || 'Za Post Comment',
    icon:          raw.icon          || 'assets/icon.ico',
    remotePort:    Number(raw.remotePort) || 3000,               // remote API port (two copies must differ)
    apiTokenEnv:   raw.apiTokenEnv   || 'ZAPOST_API_TOKEN',      // env var that supplies the fixed API token
    autostartTask: raw.autostartTask || 'za-post-autostart',     // Windows Task Scheduler daily-start task name
    accentColor:   raw.accentColor   || '#6366f1',
  };
  return _b;
}

module.exports = { brand };
