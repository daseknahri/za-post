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
  hideBrowser: true,    // run automation Chromium hidden (headless). false = visible window for debugging
  useProxies: false,
  enableTunnel: false,  // opt-in: start Cloudflare tunnel for remote dashboard access
  resumeOnStartup: false,  // opt-in: auto-resume an interrupted run after shutdown/crash
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

function stripBom(s) { return String(s).replace(/^\uFEFF/, ''); }

function normalize(raw) {
  return {
    posts: Array.isArray(raw.posts) ? raw.posts : [],
    groups: Array.isArray(raw.groups) ? raw.groups : [],
    accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
    settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
    proxies: Array.isArray(raw.proxies) ? raw.proxies : [],
    useProxies: !!raw.useProxies,
  };
}

// Durable write: temp file -> write -> fsync (flush bytes to disk) -> rename. The fsync
// is what the old code lacked: without it, a crash/power-loss after rename could leave a
// 0-byte file (exactly the corruption this app already suffered). Throws on ENOSPC so the
// caller learns the write failed instead of silently truncating.
function writeFileAtomic(dest, content) {
  const tmp = dest + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, dest);
}

let lastLoadIssue = null; // 'recovered-from-backup' | 'corrupt-no-backup' \u2014 surfaced once to the UI

function load() {
  try {
    return normalize(JSON.parse(stripBom(fs.readFileSync(DATA_FILE, 'utf8'))));
  } catch (e) {
    // data.json is missing, empty, partial, or corrupt. A missing file on first run is
    // normal (no backup yet) \u2014 just return blank. Otherwise try to recover from .bak so a
    // half-written file (disk-full) can't silently wipe the user's accounts/posts.
    let existed = false;
    try { existed = fs.existsSync(DATA_FILE) && fs.statSync(DATA_FILE).size > 0; } catch {}
    try {
      const bak = normalize(JSON.parse(stripBom(fs.readFileSync(DATA_FILE + '.bak', 'utf8'))));
      // Quarantine the bad primary so the next save() can't copy it over the good .bak.
      if (existed) { try { fs.renameSync(DATA_FILE, DATA_FILE + '.corrupt-' + Date.now()); } catch {} }
      try { writeFileAtomic(DATA_FILE, JSON.stringify(bak, null, 2)); } catch {}
      lastLoadIssue = 'recovered-from-backup';
      return bak;
    } catch {
      // No usable backup. Preserve the unreadable primary instead of blanking-then-saving
      // over it, so it stays recoverable by hand.
      if (existed) { try { fs.renameSync(DATA_FILE, DATA_FILE + '.corrupt-' + Date.now()); } catch {} lastLoadIssue = 'corrupt-no-backup'; }
      return blank();
    }
  }
}

function save(data) {
  const json = JSON.stringify(data, null, 2);
  // Snapshot the current good file as .bak BEFORE overwriting so any bad write stays
  // recoverable. load() has already quarantined a corrupt primary, so what we copy here
  // is the last value we successfully wrote.
  try { if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, DATA_FILE + '.bak'); } catch {}
  writeFileAtomic(DATA_FILE, json);
  return data;
}

// Serialize every read-modify-write cycle. The orchestrator loop, IPC handlers, and the
// remote HTTP server all mutate data.json from the same process but across await points;
// without this, two overlapping load->mutate->save cycles drop one of the changes
// (lost-update). Route all mutations through update() and they apply one at a time.
let _writeChain = Promise.resolve();
function update(mutator) {
  const run = async () => {
    const data = load();
    const result = await mutator(data);
    save(data);
    return result;
  };
  const next = _writeChain.then(run, run); // run regardless of a prior update's outcome
  _writeChain = next.then(() => {}, () => {}); // never let a rejection wedge the chain
  return next;
}

// Read-and-clear the last load problem so the UI can warn the operator exactly once.
function consumeLoadIssue() { const v = lastLoadIssue; lastLoadIssue = null; return v; }

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
// A4: durable atomic write (tmp + fsync + rename) so a crash mid-write can't corrupt cookies.json.
function writeCookies(name, cookies) {
  writeFileAtomic(cookiesFile(name), JSON.stringify(cookies, null, 2));
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
  try { writeFileAtomic(stateFile(), JSON.stringify(obj || {}, null, 2)); } catch {}
}

// ---- run report (per-post audit trail) ---------------------------------
// Append-only JSONL + a parallel CSV for spreadsheets. One row per (account, group, post)
// outcome so an operator can audit exactly what landed across a 120-post campaign.
function reportDir() { return ensureDir(path.join(USER_DATA, 'logs')); }
function reportFile() { return path.join(reportDir(), 'run-report.jsonl'); }
function reportCsvFile() { return path.join(reportDir(), 'run-report.csv'); }
function appendReport(record) {
  try {
    fs.appendFileSync(reportFile(), JSON.stringify(record) + '\n');
    const csv = reportCsvFile();
    if (!fs.existsSync(csv)) fs.appendFileSync(csv, 'timestamp,account,group,groupId,postId,result,comment,detail\n');
    const esc = (v) => { const s = String(v == null ? '' : v).replace(/"/g, '""'); return /[",\n]/.test(s) ? `"${s}"` : s; };
    fs.appendFileSync(csv, [record.ts, record.account, record.group, record.groupId, record.postId, record.result, record.comment, record.detail].map(esc).join(',') + '\n');
  } catch {}
}
function loadReport(limit = 0) {
  try {
    const lines = fs.readFileSync(reportFile(), 'utf8').split(/\r?\n/).filter(Boolean);
    const slice = limit > 0 ? lines.slice(-limit) : lines;
    return slice.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

module.exports = {
  init, load, save, update, blank, DEFAULT_SETTINGS, consumeLoadIssue,
  accountDir, profileDir, cookiesFile, sanitizeName, readCookies, writeCookies,
  saveBase64Image, loadRotation, saveRotation, sanitizeProfile,
  appendReport, loadReport, reportFile, reportCsvFile,
  get paths() { return { USER_DATA, DATA_FILE, ACCOUNTS_DIR, IMAGES_DIR }; },
};
