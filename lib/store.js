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
  // Pacing — defaults raised to a far more human, lower-spam-risk tempo (all delays are
  // additionally jittered ±20-30% at runtime so the cadence is never metronomic).
  parallelAccounts: 2,  // accounts posting concurrently per batch (staggered, see staggerAccounts)
  postsPerGroup: 1,     // posts each account makes per group per cycle (0 = no limit; unique modes always 1)
  maxCycles: 0,         // 0 = run continuously; N = stop after N cycles
  // NOTE: the legacy single-value timing keys (waitInterval/accountDelay/groupDelay) were REMOVED — the loop
  // reads the *Min/*Max ranges below. migrateTimingRanges() still derives the ranges from an OLD data.json
  // that has only the legacy keys, so existing installs carry their tuning over.
  commentWithImage: false,
  autoDeletePosted: false,
  hideBrowser: true,    // hidden = off-screen + focus/visibility emulation (posts reliably; confirmed live)
  // NOTE: useProxies is a TOP-LEVEL data.json field (normalize() handles it), NOT a setting — do not add it here.
  enableTunnel: false,  // opt-in: start Cloudflare tunnel for remote dashboard access
  resumeOnStartup: false,  // opt-in: auto-resume an interrupted run after shutdown/crash
  launchOnStartup: false,  // register the app as a Windows login item
  loopCampaign: false,     // unique modes: false = complete after each post once; true = recycle + rotate forever
  // ---- anti-spam hardening (all on by default; tune in Settings) -----------------------
  commentDelayMin: 60,     // seconds: lower bound of the random wait between a post and its first comment
  commentDelayMax: 180,    // seconds: upper bound (the post→link pattern is a top spam trigger; 6s was bot-like)
  dailyCap: 0,             // max group-posts PER ACCOUNT per day (0 = no cap; e.g. 5-10 for young accounts)
  enableWarmup: false,     // opt-in: new accounts browse/scroll the feed before their first post
  warmupRuns: 5,           // an account is "new" (warmed up before posting) for its first N successful runs
  varyContent: true,       // expand {a|b|c} spintax in captions/comments so each post differs
  varyImages: true,        // perturb image bytes per post so the perceptual hash differs across groups
  randomizeLinks: true,    // append a unique tracking param to links in the first comment
  staggerAccounts: true,   // spread account start times within a batch instead of all-at-once
  rateLimitCooldownHours: 4, // base cool-down before a rate-limited account is tried again (doubles per strike)
  reserveAccounts: 0,      // 0 = off (set e.g. 3 in Settings). Keep this many healthy accounts OUT of posting each cycle — held in reserve to (a) place orphaned link-comments on posts whose own account got blocked, and (b) take over a cooled-down account's slot. Always leaves ≥1 account posting.
  // ---- humanization / unpredictable cadence (every gap is a RANDOM value in [min,max], never a
  // constant — a fixed cadence is a top spam signal). The min/max RANGES below supersede the legacy
  // single-value keys above; normalize() migrates an old data.json (single key -> ±20% range).
  waitIntervalMin: 90,  waitIntervalMax: 180,   // minutes between cycles (range)
  accountDelayMin: 1,   accountDelayMax: 4,      // minutes between account starts (range)
  groupDelayMin: 120,   groupDelayMax: 300,      // seconds between groups within an account (range; floor 120s)
  pageScrollDwellSecMin: 3,  pageScrollDwellSecMax: 15,  // human "reading the feed" browse before composing
  commentDwellSecMin: 1,     commentDwellSecMax: 4,      // pause on the post before typing the comment
  prePublishDwellSecMin: 3,  prePublishDwellSecMax: 8,   // "re-read before posting" pause
  composerOpenInitialDelayMs: 1500,  // first-attempt settle before scanning for the composer trigger
  humanizeMaster: true,  // master switch for jitter/stagger/dwell (the post->comment window stays random regardless)
  timingVariance: { interact: 0.4, settle: 0.35, pause: 0.3, wait: 0.25 }, // ± jitter fraction per delay class
  speedMode: 'normal', // 'fast' | 'normal' | 'slow' — last one-click pacing preset applied in Settings
  moderationEnabled: false, // MOD: opt-in — let a designated moderator account approve held posts so post+comment go live
  // ---- scheduling ---------------------------------------------------------------------
  scheduleMode: 'continuous', // 'continuous' = cycle every waitInterval; 'daily' = ONE cycle per day at dailyPostTime
  dailyPostTime: '09:00',     // local HH:MM the daily run fires (only used when scheduleMode==='daily')
  // ---- completion engine --------------------------------------------------------------
  completionMode: false,      // finite campaigns: keep self-healing (swap/retry/rescue/approve) until EVERY post
                              // is published AND every comment placed / held post approved, THEN auto-stop + report.
  // ---- held-post re-post rescue -------------------------------------------------------
  repostEnabled: false,       // opt-in: when a post stays HELD in "Spam potentiel" (moderator couldn't approve it),
                              // a healthy reserve account re-posts the content to that group so it goes live 100%.
  repostGraceSec: 180,        // wait this long after a hold is marked un-approvable before a reserve re-posts
                              // (lets FB's own auto-release win first; a live-feed check then prevents duplicates).
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

// Coerce the numeric/bookkeeping fields the engine does math on, so a hand-edited or
// partially-migrated data.json can't propagate strings/NaN into the daily-cap and cool-down
// logic (a NaN cap comparison silently disables the cap). Only touches fields that exist.
function normalizeAccount(a) {
  if (!a || typeof a !== 'object') return a;
  const out = { ...a };
  if (out.daily && typeof out.daily === 'object') {
    // DI-3: a negative/NaN/string count must not disable or skew the daily cap, and a malformed date
    // must not freeze the cap on a stale day. Floor the count at 0; reset a non-YYYY-MM-DD date.
    const cnt = Math.max(0, Math.floor(Number(out.daily.count) || 0));
    const date = /^\d{4}-\d{2}-\d{2}$/.test(out.daily.date) ? out.daily.date : '';
    out.daily = { date, count: cnt };
  }
  if (out.rlStrikes !== undefined) out.rlStrikes = Math.max(0, Math.floor(Number(out.rlStrikes) || 0));
  if (out.rateLimitedUntil !== undefined) {
    // DI-4: keep a cool-down timestamp ONLY if it's a sane future time. A corrupt far-future value
    // would block the account forever; a past value is already expired → reset both to 0 (not blocked).
    const v = Number(out.rateLimitedUntil) || 0;
    const now = Date.now(), yearMs = 365 * 24 * 60 * 60 * 1000;
    out.rateLimitedUntil = (v > now && v < now + yearMs) ? v : 0;
  }
  // MOD-1: moderator role + the FB display name used to author-match held posts in the queue.
  // Both default safely for an old data.json (absent → false / ''). fbDisplayName empty = "cannot
  // match" (the approval is fail-closed), so a missing name never widens what gets approved.
  if ('isModerator' in out) out.isModerator = !!out.isModerator;
  if ('fbDisplayName' in out) out.fbDisplayName = typeof out.fbDisplayName === 'string' ? out.fbDisplayName.trim() : '';
  // STANDBY (backup) account: never posts in normal cycles; only activates in its assigned groups when a
  // working account there drops, a post stays held, or a comment needs placing. Default off (a normal poster).
  if ('standby' in out) out.standby = !!out.standby;
  return out;
}

// Migrate a pre-overhaul data.json: if a legacy single-value timing key was customized but the new
// min/max range isn't present, derive the range (±20%) so the user's tuning carries over. The legacy
// key is kept (back-compat / rollback). New installs already have the range defaults.
function migrateTimingRanges(rawS) {
  const s = { ...(rawS || {}) };
  for (const [legacy, lo, hi] of [['waitInterval', 'waitIntervalMin', 'waitIntervalMax'], ['accountDelay', 'accountDelayMin', 'accountDelayMax'], ['groupDelay', 'groupDelayMin', 'groupDelayMax']]) {
    if (s[legacy] != null && s[lo] == null && s[hi] == null) {
      const v = Number(s[legacy]);
      if (Number.isFinite(v) && v > 0) { s[lo] = Math.floor(v * 0.8); s[hi] = Math.ceil(v * 1.2); }
    }
  }
  return s;
}

function normalize(raw) {
  return {
    posts: Array.isArray(raw.posts) ? raw.posts : [],
    groups: Array.isArray(raw.groups) ? raw.groups : [],
    accounts: (Array.isArray(raw.accounts) ? raw.accounts : []).map(normalizeAccount),
    settings: { ...DEFAULT_SETTINGS, ...migrateTimingRanges(raw.settings) },
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

// Keep only the newest 3 data.json.corrupt-* files so repeated corruption can't fill the disk.
function pruneCorrupt() {
  try {
    const dir = path.dirname(DATA_FILE);
    const base = path.basename(DATA_FILE) + '.corrupt-';
    const olds = fs.readdirSync(dir).filter((f) => f.startsWith(base)).sort();
    for (const f of olds.slice(0, -3)) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
  } catch {}
}

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
      if (existed) { try { fs.renameSync(DATA_FILE, DATA_FILE + '.corrupt-' + Date.now()); } catch {} pruneCorrupt(); }
      try { writeFileAtomic(DATA_FILE, JSON.stringify(bak, null, 2)); } catch {}
      lastLoadIssue = 'recovered-from-backup';
      return bak;
    } catch {
      // No usable backup. Preserve the unreadable primary instead of blanking-then-saving
      // over it, so it stays recoverable by hand.
      if (existed) { try { fs.renameSync(DATA_FILE, DATA_FILE + '.corrupt-' + Date.now()); } catch {} pruneCorrupt(); lastLoadIssue = 'corrupt-no-backup'; }
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
    try {
      const data = load();
      const result = await mutator(data);
      save(data);
      return result;
    } catch (e) {
      // Surface the failure instead of swallowing it: a mutator throw or a disk-full save would
      // otherwise leave the UI and the on-disk data diverged with no trace. Log here so even
      // fire-and-forget callers leave a breadcrumb, then re-throw so awaiting callers learn the
      // write failed and can react.
      try { console.error('[store.update] mutation/write failed:', (e && e.message) || e); } catch {}
      throw e;
    }
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
function sanitizeProfile(name, hidden = false) {
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
      // Pin the window placement to THIS launch's intent. Chrome otherwise restores the last
      // run's rectangle: a hidden run saves off-screen (-32000) bounds, so a later interactive
      // LOGIN would open invisibly; a visible login saves on-screen bounds, so the next hidden
      // run flashes on-screen. Force off-screen when hidden; otherwise clear it so Chrome opens
      // on-screen at its default (logins MUST be visible).
      p.browser = p.browser || {};
      if (hidden) {
        const prev = p.browser.window_placement || {};
        p.browser.window_placement = {
          left: -32000, top: -32000, right: -30720, bottom: -31100, maximized: false,
          work_area_left: prev.work_area_left || 0, work_area_top: prev.work_area_top || 0,
          work_area_right: prev.work_area_right || 1366, work_area_bottom: prev.work_area_bottom || 768,
        };
      } else {
        delete p.browser.window_placement;
      }
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

// UTC calendar-day key (YYYY-MM-DD) for per-account daily-cap bookkeeping. UTC — NOT local —
// so a DST shift or a clock that syncs/drifts within the same day can't change the key and
// wrongly reset an account's daily count, which would let it post past its cap and risk a block.
function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
// Has the daily-cap window advanced to a genuinely LATER day than `daily` last recorded?
// Monotonic: only a FORWARD move rolls the window over. A clock moved BACKWARD (key <= stored)
// keeps the existing count rather than resetting it — so the cap can never be cleared by
// rewinding the clock. (Lexicographic compare on YYYY-MM-DD is chronological.)
function dailyRolledOver(daily, key = todayKey()) {
  if (!daily || !daily.date) return true;
  return key > daily.date;
}
// Group-posts an account has used in the CURRENT cap window (0 once the window rolls over).
function dailyUsed(daily, key = todayKey()) {
  if (dailyRolledOver(daily, key)) return 0;
  return Number(daily.count) || 0;
}

// Clamp/validate numeric settings so out-of-range or reversed values from the UI / HTTP API /
// hand-edited data.json can't produce negative sleeps, a Min>Max delay window, or silently disable
// a cap. Only touches keys present in the patch. (M2-07)
function clampSettings(s) {
  const n = (v, def, min, max) => { let x = Number(v); if (!Number.isFinite(x)) x = def; return Math.min(max, Math.max(min, Math.round(x * 1000) / 1000)); };
  const out = { ...(s || {}) };
  if ('parallelAccounts' in out) out.parallelAccounts = n(out.parallelAccounts, 2, 1, 20);
  if ('waitInterval' in out)     out.waitInterval     = n(out.waitInterval, 120, 0, 1440);
  if ('accountDelay' in out)     out.accountDelay     = n(out.accountDelay, 2, 0, 1440);
  if ('groupDelay' in out)       out.groupDelay       = n(out.groupDelay, 180, 0, 3600);
  if ('postsPerGroup' in out)    out.postsPerGroup    = n(out.postsPerGroup, 1, 0, 100000);
  if ('maxCycles' in out)        out.maxCycles        = n(out.maxCycles, 0, 0, 100000);
  if ('commentDelayMin' in out)  out.commentDelayMin  = n(out.commentDelayMin, 60, 0, 86400);
  if ('commentDelayMax' in out)  out.commentDelayMax  = n(out.commentDelayMax, 180, 0, 86400);
  if ('dailyCap' in out)         out.dailyCap         = n(out.dailyCap, 0, 0, 100000);
  if ('warmupRuns' in out)       out.warmupRuns       = n(out.warmupRuns, 5, 0, 1000);
  if ('rateLimitCooldownHours' in out) out.rateLimitCooldownHours = n(out.rateLimitCooldownHours, 4, 0, 168);
  if ('reserveAccounts' in out) out.reserveAccounts = Math.round(n(out.reserveAccounts, 0, 0, 100));
  // Humanization ranges (supersede the legacy single keys).
  if ('waitIntervalMin' in out) out.waitIntervalMin = n(out.waitIntervalMin, 90, 0, 1440);
  if ('waitIntervalMax' in out) out.waitIntervalMax = n(out.waitIntervalMax, 180, 0, 1440);
  if ('accountDelayMin' in out) out.accountDelayMin = n(out.accountDelayMin, 1, 0, 1440);
  if ('accountDelayMax' in out) out.accountDelayMax = n(out.accountDelayMax, 4, 0, 1440);
  if ('groupDelayMin' in out)   out.groupDelayMin   = n(out.groupDelayMin, 120, 0, 3600);
  if ('groupDelayMax' in out)   out.groupDelayMax   = n(out.groupDelayMax, 300, 0, 3600);
  if ('pageScrollDwellSecMin' in out) out.pageScrollDwellSecMin = n(out.pageScrollDwellSecMin, 3, 0, 600);
  if ('pageScrollDwellSecMax' in out) out.pageScrollDwellSecMax = n(out.pageScrollDwellSecMax, 15, 0, 600);
  if ('commentDwellSecMin' in out) out.commentDwellSecMin = n(out.commentDwellSecMin, 1, 0, 300);
  if ('commentDwellSecMax' in out) out.commentDwellSecMax = n(out.commentDwellSecMax, 4, 0, 300);
  if ('prePublishDwellSecMin' in out) out.prePublishDwellSecMin = n(out.prePublishDwellSecMin, 3, 0, 60);
  if ('prePublishDwellSecMax' in out) out.prePublishDwellSecMax = n(out.prePublishDwellSecMax, 8, 0, 60);
  if ('composerOpenInitialDelayMs' in out) out.composerOpenInitialDelayMs = n(out.composerOpenInitialDelayMs, 1500, 800, 3000);
  if ('humanizeMaster' in out) out.humanizeMaster = !!out.humanizeMaster;
  if ('speedMode' in out) out.speedMode = ['turbo', 'fast', 'normal', 'slow'].includes(out.speedMode) ? out.speedMode : 'normal';
  if ('moderationEnabled' in out) out.moderationEnabled = !!out.moderationEnabled;
  if ('scheduleMode' in out) out.scheduleMode = (out.scheduleMode === 'daily') ? 'daily' : 'continuous';
  if ('dailyPostTime' in out) out.dailyPostTime = /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(out.dailyPostTime || '')) ? out.dailyPostTime : '09:00';
  if ('completionMode' in out) out.completionMode = !!out.completionMode;
  if ('repostEnabled' in out) out.repostEnabled = !!out.repostEnabled;
  if ('repostGraceSec' in out) out.repostGraceSec = n(out.repostGraceSec, 180, 0, 86400);
  if (out.timingVariance && typeof out.timingVariance === 'object') {
    const def = { interact: 0.4, settle: 0.35, pause: 0.3, wait: 0.25 };
    const tv = {}; for (const k of Object.keys(def)) tv[k] = n(out.timingVariance[k], def[k], 0, 0.6);
    out.timingVariance = tv;
  }
  // Keep every min/max pair coherent — if both bounds are present and reversed, swap them.
  for (const [lo, hi] of [['commentDelayMin', 'commentDelayMax'], ['waitIntervalMin', 'waitIntervalMax'], ['accountDelayMin', 'accountDelayMax'], ['groupDelayMin', 'groupDelayMax'], ['pageScrollDwellSecMin', 'pageScrollDwellSecMax'], ['commentDwellSecMin', 'commentDwellSecMax'], ['prePublishDwellSecMin', 'prePublishDwellSecMax']]) {
    if (lo in out && hi in out && Number(out[lo]) > Number(out[hi])) { const t = out[lo]; out[lo] = out[hi]; out[hi] = t; }
  }
  return out;
}

// M2-02: should a status write be IGNORED to preserve a high-priority attention flag? A concurrent
// headless status check (or any lower-priority writer) must not clear a rate-limit/checkpoint/
// verification/disabled flag the run just set. rate_limited is protected only while still active
// (rateLimitedUntil in the future); once it expires a clearing write is allowed through.
function preserveAttentionStatus(curStatus, curRateLimitedUntil, newStatus, now = Date.now()) {
  const PROTECTED = new Set(['rate_limited', 'checkpoint', 'needs_verification', 'account_disabled']);
  const CLEARING = new Set(['logged_in', 'checking', 'not_logged_in', 'error']);
  if (!PROTECTED.has(curStatus) || curStatus === newStatus) return false;
  if (!CLEARING.has(newStatus)) return false; // an equal/higher attention status may overwrite
  if (curStatus === 'rate_limited' && !((Number(curRateLimitedUntil) || 0) > now)) return false; // expired → allow clear
  return true;
}

// ---- rotation state (per-account "next post index" for sequence/unique modes) ----
// Mirrors the original app's .pcu-state.json. Survives restarts.
function stateFile() { return path.join(USER_DATA, 'pcu-state.json'); }
function loadRotation() {
  try { return JSON.parse(stripBom(fs.readFileSync(stateFile(), 'utf8'))) || {}; }
  catch {
    // Corrupt/partial primary — recover from the .bak so a bad write can't silently empty the dealt
    // set and make a unique campaign re-post the whole library on the next resume.
    try { return JSON.parse(stripBom(fs.readFileSync(stateFile() + '.bak', 'utf8'))) || {}; } catch { return {}; }
  }
}
// Returns true on success, false on failure so the caller can warn the operator (a silently-dropped
// rotation write risks re-posting already-published content on resume). Snapshots a .bak first.
function saveRotation(obj) {
  try {
    try { if (fs.existsSync(stateFile())) fs.copyFileSync(stateFile(), stateFile() + '.bak'); } catch {}
    writeFileAtomic(stateFile(), JSON.stringify(obj || {}, null, 2));
    return true;
  } catch { return false; }
}

// ---- moderation state (held posts awaiting moderator approval) ----------------------------------
// MOD: one record per post FB held in the group "Spam potentiel"/pending queue. The single source of
// truth across the post→approve→comment phases; survives restart. Mirrors the rotation state.
function moderationFile() { return path.join(USER_DATA, 'moderation-state.json'); }
function loadModeration() {
  try { const o = JSON.parse(stripBom(fs.readFileSync(moderationFile(), 'utf8'))); return o && Array.isArray(o.held) ? o : { held: [] }; }
  catch {
    try { const o = JSON.parse(stripBom(fs.readFileSync(moderationFile() + '.bak', 'utf8'))); return o && Array.isArray(o.held) ? o : { held: [] }; } catch { return { held: [] }; }
  }
}
function saveModeration(obj) {
  try {
    const safe = obj && Array.isArray(obj.held) ? obj : { held: [] };
    try { if (fs.existsSync(moderationFile())) fs.copyFileSync(moderationFile(), moderationFile() + '.bak'); } catch {}
    writeFileAtomic(moderationFile(), JSON.stringify(safe, null, 2));
    return true;
  } catch { return false; }
}

// ---- orphaned-comment queue (posts that went live but whose first comment couldn't be placed) -------
// One record per post that published successfully but failed to get its link-comment (rate-limit, block,
// or the post couldn't be found). A healthy account that is a member of the group later places the
// comment so a post is NEVER left without its link. Survives restart; mirrors the moderation state.
function commentsFile() { return path.join(USER_DATA, 'pending-comments.json'); }
function loadComments() {
  try { const o = JSON.parse(stripBom(fs.readFileSync(commentsFile(), 'utf8'))); return o && Array.isArray(o.pending) ? o : { pending: [] }; }
  catch {
    try { const o = JSON.parse(stripBom(fs.readFileSync(commentsFile() + '.bak', 'utf8'))); return o && Array.isArray(o.pending) ? o : { pending: [] }; } catch { return { pending: [] }; }
  }
}
function saveComments(obj) {
  try {
    const safe = obj && Array.isArray(obj.pending) ? obj : { pending: [] };
    try { if (fs.existsSync(commentsFile())) fs.copyFileSync(commentsFile(), commentsFile() + '.bak'); } catch {}
    writeFileAtomic(commentsFile(), JSON.stringify(safe, null, 2));
    return true;
  } catch { return false; }
}

// ---- run report (per-post audit trail) ---------------------------------
// Append-only JSONL + a parallel CSV for spreadsheets. One row per (account, group, post)
// outcome so an operator can audit exactly what landed across a 120-post campaign.
function reportDir() { return ensureDir(path.join(USER_DATA, 'logs')); }
function reportFile() { return path.join(reportDir(), 'run-report.jsonl'); }
function reportCsvFile() { return path.join(reportDir(), 'run-report.csv'); }
// Returns true on success, false on failure so the caller can warn the operator that the audit
// trail (run-report.jsonl/.csv) may be incomplete — a silently-dropped row makes the report lie
// about what actually posted.
function appendReport(record) {
  try {
    // Rotate at 5 MB so the append-only report can't grow unbounded over months of daily use.
    try {
      if (fs.existsSync(reportFile()) && fs.statSync(reportFile()).size > 5 * 1024 * 1024) {
        fs.renameSync(reportFile(), reportFile() + '.1');
        if (fs.existsSync(reportCsvFile())) fs.renameSync(reportCsvFile(), reportCsvFile() + '.1');
      }
    } catch {}
    fs.appendFileSync(reportFile(), JSON.stringify(record) + '\n');
    const csv = reportCsvFile();
    if (!fs.existsSync(csv)) fs.appendFileSync(csv, 'timestamp,account,group,groupId,postId,caption,result,comment,detail\n');
    const esc = (v) => { const s = String(v == null ? '' : v).replace(/"/g, '""'); return /[",\n]/.test(s) ? `"${s}"` : s; };
    fs.appendFileSync(csv, [record.ts, record.account, record.group, record.groupId, record.postId, record.caption, record.result, record.comment, record.detail].map(esc).join(',') + '\n');
    return true;
  } catch (e) {
    try { console.error('[store.appendReport] failed to write audit row:', (e && e.message) || e); } catch {}
    return false;
  }
}
function loadReport(limit = 0) {
  try {
    const lines = fs.readFileSync(reportFile(), 'utf8').split(/\r?\n/).filter(Boolean);
    const slice = limit > 0 ? lines.slice(-limit) : lines;
    return slice.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

module.exports = {
  init, load, save, update, normalize, blank, DEFAULT_SETTINGS, consumeLoadIssue,
  accountDir, profileDir, cookiesFile, sanitizeName, readCookies, writeCookies,
  saveBase64Image, loadRotation, saveRotation, loadModeration, saveModeration, loadComments, saveComments, sanitizeProfile, todayKey, dailyRolledOver, dailyUsed,
  clampSettings, preserveAttentionStatus,
  appendReport, loadReport, reportFile, reportCsvFile,
  get paths() { return { USER_DATA, DATA_FILE, ACCOUNTS_DIR, IMAGES_DIR }; },
};
