// lib/store.js
// Single JSON-file data store + filesystem layout for the app.
// Layout (all under Electron userData):
//   <userData>/data.json                      -> { posts, groups, accounts, settings, proxies, useProxies }
//   <userData>/accounts/<name>/chrome-profile -> per-account Chromium user-data dir (Puppeteer)
//   <userData>/accounts/<name>/cookies.json   -> imported / saved cookies
//   <userData>/storage/images/                -> decoded post & comment images

const path = require('path');
const fs = require('fs');

let USER_DATA = null;          // set once via init()
let DATA_FILE = null;
let ACCOUNTS_DIR = null;
let IMAGES_DIR = null;

const DEFAULT_SETTINGS = {
  parallelAccounts: 3,
  waitInterval: 60,     // minutes between full posting cycles
  accountDelay: 1,      // minutes between parallel batches
  postsPerGroup: 1,     // posts each account makes per group per cycle (0 = no limit; unique modes always 1)
  groupDelay: 60,       // seconds between groups within one account
  maxCycles: 0,         // 0 = run continuously; N = stop after N cycles
  commentWithImage: false,
  autoDeletePosted: false,
  useProxies: false,
  enableTunnel: false,  // opt-in: start Cloudflare tunnel for remote dashboard access
  resumeOnStartup: true,   // auto-resume an interrupted run after shutdown/crash
  launchOnStartup: false,  // register the app as a Windows login item
  loopCampaign: false,     // unique modes: false = complete after each post once; true = recycle + rotate forever
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function init(userDataPath) {
  USER_DATA = userDataPath;
  DATA_FILE = path.join(USER_DATA, 'data.json');
  ACCOUNTS_DIR = ensureDir(path.join(USER_DATA, 'accounts'));
  IMAGES_DIR = ensureDir(path.join(USER_DATA, 'storage', 'images'));
  // Seed an empty data file on first run.
  if (!fs.existsSync(DATA_FILE)) save(blank());
  return { DATA_FILE, ACCOUNTS_DIR, IMAGES_DIR };
}

function blank() {
  return { posts: [], groups: [], accounts: [], settings: { ...DEFAULT_SETTINGS }, proxies: [], useProxies: false };
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      posts: Array.isArray(raw.posts) ? raw.posts : [],
      groups: Array.isArray(raw.groups) ? raw.groups : [],
      accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
      proxies: Array.isArray(raw.proxies) ? raw.proxies : [],
      useProxies: !!raw.useProxies,
    };
  } catch {
    return blank();
  }
}

function save(data) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE); // atomic-ish write to avoid corruption
  return data;
}

// ---- per-account paths -------------------------------------------------
function accountDir(name) {
  return ensureDir(path.join(ACCOUNTS_DIR, sanitizeName(name)));
}
function profileDir(name) {
  return ensureDir(path.join(accountDir(name), 'chrome-profile'));
}
function cookiesFile(name) {
  return path.join(accountDir(name), 'cookies.json');
}
function sanitizeName(name) {
  return String(name).replace(/[^A-Za-z0-9_-]/g, '_');
}

// Stop Chromium from reopening the previous session's tabs (it does this when the last
// run exited uncleanly — e.g. the browser was killed). Without this, each launch piles
// up dozens of restored tabs and bogs the machine down.
function sanitizeProfile(name) {
  const def = path.join(profileDir(name), 'Default');
  // Delete the session snapshots so there is nothing to restore.
  for (const f of ['Current Session', 'Current Tabs', 'Last Session', 'Last Tabs']) {
    try { fs.rmSync(path.join(def, f), { force: true }); } catch {}
  }
  // Mark a clean exit + set startup to a single New Tab Page (not "continue where you left off").
  const prefs = path.join(def, 'Preferences');
  try {
    if (fs.existsSync(prefs)) {
      const p = JSON.parse(fs.readFileSync(prefs, 'utf8'));
      p.profile = p.profile || {}; p.profile.exit_type = 'Normal'; p.profile.exited_cleanly = true;
      p.session = p.session || {}; p.session.restore_on_startup = 5; delete p.session.startup_urls;
      fs.writeFileSync(prefs, JSON.stringify(p));
    }
  } catch {}
}

function readCookies(name) {
  try { return JSON.parse(fs.readFileSync(cookiesFile(name), 'utf8')); } catch { return []; }
}
// A4: atomic write (tmp + rename) so a crash mid-write can't corrupt cookies.json.
function writeCookies(name, cookies) {
  const dest = cookiesFile(name);
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cookies, null, 2));
  fs.renameSync(tmp, dest);
}

// ---- image helpers -----------------------------------------------------
// Decode a {data:<base64>, ext:<png|jpg|...>} object to a file on disk; return path.
function saveBase64Image(img, prefix = 'post') {
  if (!img || !img.data) return null;
  const ext = (img.ext || 'jpg').replace(/[^a-z0-9]/gi, '') || 'jpg';
  const file = path.join(IMAGES_DIR, `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.${ext}`);
  fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
  return file;
}

// ---- rotation state (per-account "next post index" for sequence/unique modes) ----
// Mirrors the original app's .pcu-state.json. Survives restarts.
function stateFile() { return path.join(USER_DATA, 'pcu-state.json'); }
function loadRotation() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) || {}; } catch { return {}; }
}
function saveRotation(obj) {
  try {
    const tmp = stateFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj || {}, null, 2));
    fs.renameSync(tmp, stateFile()); // atomic-ish — a crash mid-write won't corrupt rotation
  } catch {}
}

module.exports = {
  init, load, save, blank, DEFAULT_SETTINGS,
  accountDir, profileDir, cookiesFile, sanitizeName, readCookies, writeCookies,
  saveBase64Image, loadRotation, saveRotation, sanitizeProfile,
  get paths() { return { USER_DATA, DATA_FILE, ACCOUNTS_DIR, IMAGES_DIR }; },
};
