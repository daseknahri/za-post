// main.js
// Electron main process for "Za Post Comment Tool" (restored, clean source).
// Implements the full IPC contract the recovered renderer expects, persists data
// via lib/store, runs automation via automation/orchestrator + worker, exposes a
// remote dashboard via server.js, and uses a permissive LOCAL license (no server).

const { app, BrowserWindow, ipcMain, dialog, shell, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

// ---- persistent log file (assigned in whenReady, guarded until then) --------
let LOG_DIR = null;
let LOG_FILE = null;
let _logWrites = 0;

// Rotate automation.log past 5MB. Called at boot AND periodically here, so a long CONTINUOUS run (the
// intended mode — maxCycles defaults to 0) can't grow the log unbounded until the disk fills (which
// would then make the atomic data.json / cookies writes fail).
function rotateLogIfBig() {
  try {
    if (!LOG_FILE || !LOG_DIR) return;
    if (fs.statSync(LOG_FILE).size <= 5 * 1024 * 1024) return;
    try { fs.renameSync(path.join(LOG_DIR, 'automation.log.1'), path.join(LOG_DIR, 'automation.log.2')); } catch {}
    fs.renameSync(LOG_FILE, path.join(LOG_DIR, 'automation.log.1'));
  } catch {}
}

function appendLogFile(line) {
  try {
    if (!LOG_FILE) return;
    if ((++_logWrites % 200) === 0) rotateLogIfBig(); // bound the log within a single long run, not only at boot
    fs.appendFile(LOG_FILE, '[' + new Date().toISOString() + '] ' + String(line) + '\n', { encoding: 'utf8' }, () => {});
  } catch {}
}

// A packaged CLIENT build enforces per-seat licensing when it ships with the enforce-license.flag marker
// (written into resources/ by scripts/build-portable.js when ENFORCE_LICENSE=1). The dev/source build has no
// marker → unlimited owner mode. (The OWNER key still activates offline/unlimited even when this is on.)
function _enforceLicenseMarker() { try { return app.isPackaged && fs.existsSync(path.join(process.resourcesPath, 'enforce-license.flag')); } catch { return false; } }

// FIRST-RUN DATA CONTINUITY (client in-place upgrade). This build's userData is %APPDATA%\za-post-restored. If a
// client's PRIOR build wrote to a DIFFERENT userData (an older product name — e.g. "ossama-post" or "Za Post Comment
// Tool"), a fresh install here would boot into a BLANK data.json and ORPHAN their accounts / encrypted FB-session
// cookies / groups / posts / settings. This one-shot, marker-guarded seed byte-copies that data across BEFORE
// store.init — but ONLY when THIS dir has no real data yet, so an existing install is NEVER touched (a pure no-op).
// Same machine + same OS user → the DPAPI (safeStorage enc:v1) cookie envelope decrypts verbatim, so jars are copied as-is.
function migrateLegacyUserDataOnce(destRoot) {
  try {
    const marker = path.join(destRoot, '.migrated-v1');
    if (fs.existsSync(marker)) return;
    const dataCount = (p) => { try { const d = JSON.parse(fs.readFileSync(p, 'utf8')); return (d.accounts || []).length + (d.groups || []).length + (d.posts || []).length; } catch { return -1; } };
    const destData = path.join(destRoot, 'data.json');
    try { fs.mkdirSync(destRoot, { recursive: true }); } catch {}
    // Guard: NEVER migrate over an install that has been USED before. A data.json only exists once store.init has run at
    // least once — so if it's present, this dir is the operator's real install (has data) OR a deliberately-emptied one;
    // either way, respect it (don't seed stale legacy data over it). A truly FRESH install has NO data.json yet (this
    // migration runs BEFORE store.init), which is the only case we seed. (dataCount is still used to pick the legacy SOURCE.)
    if (fs.existsSync(destData)) { try { fs.writeFileSync(marker, new Date().toISOString()); } catch {} return; }
    const appData = process.env.APPDATA || path.dirname(destRoot);
    const LEGACY = ['ossama-post', 'Za Post Comment Tool']; // prior names of THIS SAME app (identical data model) → safe straight copy
    let srcRoot = null, srcMtime = -1;
    for (const nm of LEGACY) {
      const dv = path.join(appData, nm, 'data.json');
      const n = fs.existsSync(dv) ? dataCount(dv) : -1;
      if (n > 0) { const m = fs.statSync(dv).mtimeMs; if (m > srcMtime) { srcMtime = m; srcRoot = path.join(appData, nm); } }
    }
    if (!srcRoot) { try { fs.writeFileSync(marker, 'no-legacy'); } catch {} return; }
    console.log('[migrate] seeding fresh userData from prior build: ' + srcRoot);
    fs.copyFileSync(path.join(srcRoot, 'data.json'), destData);
    const srcAcc = path.join(srcRoot, 'accounts');
    if (fs.existsSync(srcAcc)) {
      const destAcc = path.join(destRoot, 'accounts'); fs.mkdirSync(destAcc, { recursive: true });
      for (const nm of fs.readdirSync(srcAcc)) {
        try { const sJar = path.join(srcAcc, nm, 'cookies.json'); if (fs.existsSync(sJar)) { fs.mkdirSync(path.join(destAcc, nm), { recursive: true }); fs.copyFileSync(sJar, path.join(destAcc, nm, 'cookies.json')); } } catch {}
      }
    }
    const srcImg = path.join(srcRoot, 'storage', 'images');
    if (fs.existsSync(srcImg)) {
      const destImg = path.join(destRoot, 'storage', 'images'); fs.mkdirSync(destImg, { recursive: true });
      for (const f of fs.readdirSync(srcImg)) { try { fs.copyFileSync(path.join(srcImg, f), path.join(destImg, f)); } catch {} }
    }
    for (const f of ['license.json', 'license-config.json']) { try { const s = path.join(srcRoot, f); if (fs.existsSync(s)) fs.copyFileSync(s, path.join(destRoot, f)); } catch {} }
    try { fs.writeFileSync(marker, new Date().toISOString()); } catch {}
    console.log('[migrate] legacy data seeded OK');
  } catch (e) { try { console.error('[migrate] non-fatal:', e && e.message); } catch {} }
}

// Portable build has no installer — so on first launch we drop a desktop shortcut to the
// app (the exe carries its own icon). A marker file means we never recreate a shortcut the
// user deliberately deleted. Packaged + Windows only; best-effort.
function ensureDesktopShortcut() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  try {
    const marker = path.join(app.getPath('userData'), '.desktop-shortcut-done');
    if (fs.existsSync(marker)) return;
    const lnk = path.join(app.getPath('desktop'), 'Za Post Comment Tool.lnk');
    const ok = shell.writeShortcutLink(lnk, 'create', {
      target: process.execPath,
      cwd: path.dirname(process.execPath),
      description: 'Za Post Comment Tool — Facebook posting automation',
      icon: process.execPath,
      iconIndex: 0,
    });
    try { fs.writeFileSync(marker, new Date().toISOString()); } catch {}
    appendLogFile(ok ? 'Created desktop shortcut' : 'Desktop shortcut create returned false');
  } catch (e) { try { appendLogFile('Desktop shortcut failed: ' + e.message); } catch {} }
}

// Orphaned-Chromium sweep. A crashed or force-killed run can leave headless
// chrome.exe processes alive, each holding a lock on its per-account profile dir
// (so the NEXT run for that account fails to launch). We match ONLY chrome.exe
// whose command line points at one of OUR profile dirs (userData/accounts/...),
// so the user's real Chrome is never touched. Run this at STARTUP only — at that
// point no login/automation browser of ours is open yet, so every match is stale.
// Windows-only; best-effort (resolves with the count killed).
function killOrphanChromium() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(0);
    const base = store.paths.ACCOUNTS_DIR;
    if (!base) return resolve(0);
    const psBase = base.replace(/'/g, "''"); // escape single quotes for the PS string literal
    const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${psBase}*' } | Select-Object -ExpandProperty ProcessId`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15000 }, (_err, stdout) => {
      const pids = String(stdout || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
      if (!pids.length) return resolve(0);
      let pending = pids.length, killed = 0;
      for (const pid of pids) {
        execFile('taskkill', ['/F', '/T', '/PID', pid], { windowsHide: true, timeout: 10000 }, (e) => {
          if (!e) killed++;
          if (--pending === 0) resolve(killed);
        });
      }
    });
  });
}

// Multi-profile support: `electron . --profile=base` runs an isolated instance
// (separate userData) so the two account sets (King + base) coexist, mirroring the
// two original apps. Default profile keeps the package name (the King set).
const PROFILE = (process.argv.find((a) => a.startsWith('--profile=')) || '').split('=')[1] || process.env.ZA_PROFILE;
if (PROFILE) app.setName('za-post-restored-' + PROFILE);
// Required for Windows toast notifications (captcha/login alerts) to show with our identity —
// without it, an unpackaged/portable run's notifications are silently dropped or mislabeled.
try { app.setAppUserModelId('com.zapost.commenttool'); } catch {}

// Single-instance lock — scoped per profile (app.setName above changes userData, so each
// profile gets its own lock and can coexist with the default instance).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
app.on('second-instance', () => {
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
});

// Remote-access tunnel: in the packaged app the cloudflared binary is unpacked from the
// asar (asarUnpack) — point the cloudflared package at that path (it reads CLOUDFLARED_BIN).
if (app.isPackaged) {
  process.env.CLOUDFLARED_BIN = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'cloudflared', 'bin', 'cloudflared.exe');
}

const store = require('./lib/store');
const remote = require('./server');
const { Orchestrator } = require('./automation/orchestrator');
const license = require('./lib/license');
const secret = require('./lib/secret');
const { chromiumPath } = require('./lib/chromium');
const { launchStealth, applyProxyGeo, viewportFor } = require('./lib/browser'); // manual login/browse browser uses the SAME hardened launch + geo as posting
const { startBridge, mapChromeCookie } = require('./lib/chrome-bridge'); // localhost receiver for the "Import from Chrome" companion extension
let proxyChain = null; try { proxyChain = require('proxy-chain'); } catch {} // authenticated-proxy tunnel (Chrome can't auth SOCKS5 directly)

// Puppeteer (stealth) — used for interactive login + status checks.
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

process.on('uncaughtException', (e) => {
  console.error('[FATAL] uncaughtException:', e);
  appendLogFile('[FATAL] uncaughtException: ' + (e && e.stack || e));
  if (mainWindow && !mainWindow.isDestroyed()) emit('automation-log', '❌ [FATAL] ' + (e && e.message || e));
});
process.on('unhandledRejection', (e) => {
  console.error('[FATAL] unhandledRejection:', e);
  appendLogFile('[FATAL] unhandledRejection: ' + (e && e.stack || e));
  if (mainWindow && !mainWindow.isDestroyed()) emit('automation-log', '❌ [FATAL] ' + (e && e.message || e));
});

const REMOTE_PORT = 3000;
const BRIDGE_PORT = 47913; // localhost-only receiver for the Chrome-import companion extension (never exposed over the tunnel)
let BRIDGE_TOKEN = '';       // stable per-install token, persisted in userData + baked into the generated extension
let BRIDGE_TOKEN_STABLE = true; // false if the token couldn't be persisted → it changes each launch → an already-loaded extension goes stale (401s)
// Per-launch secret that gates the remote API whenever the public tunnel is enabled.
const REMOTE_TOKEN = require('crypto').randomBytes(16).toString('hex');
// RUN_STATE_FILE is assigned in whenReady (after app paths are available).
// Declared here so setRunActive / isRunActive are accessible throughout the file.
let RUN_STATE_FILE = null;

/** Persist active=true/false atomically so a hard kill leaves the flag intact. */
let _psbId = null;
function setRunActive(active) {
  // Durable write (temp → fsync → rename) so a hard kill can't leave a torn run-state file
  // that would silently suppress crash-resume.
  try {
    const tmp = RUN_STATE_FILE + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, JSON.stringify({ active: !!active, ts: Date.now() })); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(tmp, RUN_STATE_FILE);
  } catch {}
  // RDP/unattended: while a run is active, block system + display sleep. The hidden off-screen Chromium
  // windows stop painting if the display sleeps, so this keeps automation reliable on a laptop left running
  // (and 'prevent-display-sleep' also prevents system suspend). Released the moment the run stops.
  try {
    if (active) { if (_psbId == null || !powerSaveBlocker.isStarted(_psbId)) { _psbId = powerSaveBlocker.start('prevent-display-sleep'); appendLogFile && appendLogFile('powerSaveBlocker ON (display/system sleep blocked while running)'); } }
    else if (_psbId != null) { try { if (powerSaveBlocker.isStarted(_psbId)) powerSaveBlocker.stop(_psbId); } catch {} _psbId = null; }
  } catch {}
}
/** Returns true if the previous session left active=true (interrupted / shutdown). */
function isRunActive() {
  try { return !!JSON.parse(fs.readFileSync(RUN_STATE_FILE, 'utf8')).active; } catch { return false; }
}

let mainWindow = null;
let licenseWindow = null;
let revokedWindow = null;
let tunnelUrl = '';
let tunnelActive = false; // remote-access tunnel currently running?

// Start/stop the Cloudflare remote-access tunnel live (no app restart needed).
async function applyTunnelState(enabled) {
  if (enabled && !tunnelActive) {
    tunnelActive = true;
    emit('automation-log', '🌐 Starting remote-access tunnel...');
    try { remote.startTunnel(REMOTE_PORT, (u) => { tunnelUrl = u ? `${u}/?token=${REMOTE_TOKEN}` : u; send('remote-url-update', tunnelUrl); if (u) emit('automation-log', `🔐 Remote dashboard ready — open it from the app (the access-token URL is kept OUT of the logs). Base: ${u}`); }); }
    catch (e) { tunnelActive = false; emit('automation-log', '🌐 Tunnel failed: ' + e.message); }
  } else if (!enabled && tunnelActive) {
    tunnelActive = false; tunnelUrl = '';
    try { remote.stopTunnel(); } catch {}
    send('remote-url-update', '');
    emit('automation-log', '🌐 Remote-access tunnel stopped');
  }
}
let orchestrator = null;
let userPauseActions = 0; // bumped on every USER pause/resume so suspend/resume can detect user intent
const loginBrowsers = new Map(); // accountName -> { browser, interval }

// ---- helpers -----------------------------------------------------------
function getData() { return store.load(); }
function send(channel, payload) { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload); }
function emit(channel, payload) {
  send(channel, payload);
  if (channel === 'automation-log') {
    const line = typeof payload === 'string' ? payload : JSON.stringify(payload);
    remote.addLog(line);
    appendLogFile(line);
  }
  // ANY terminal state clears the run-active flag — completed, finished, AND stopped
  // (including internal stops like maxCycles / no-posts / all-logged-out). Otherwise the
  // flag stays set and the next launch auto-resumes a run that already ended, forever.
  if (channel === 'automation-stopped') {
    setRunActive(false);
  }
  if (channel === 'account-attention') {
    notifyAccountAttention(payload);
  }
}
// Native desktop toast when an account needs YOU (captcha/verification or a re-login). Deduped so a
// still-flagged account across cycles can't spam you.
const _attentionNotified = new Map();
function notifyAccountAttention(payload) {
  try {
    const name = (payload && payload.name) || 'An account';
    const flag = (payload && payload.flag) || '';
    const last = _attentionNotified.get(name) || 0;
    if (Date.now() - last < 10 * 60 * 1000) return; // at most one toast / 10 min per account
    _attentionNotified.set(name, Date.now());
    const { Notification } = require('electron');
    if (!Notification.isSupported()) return;
    const MSG = {
      needs_verification: { title: 'Za Post — verification needed', body: `${name}: Facebook wants a human/identity check (captcha). Open this account, complete it, then Start again.` },
      needs_login: { title: 'Za Post — login needed', body: `${name}: session expired. Open this account and log in, then Start again.` },
      account_disabled: { title: 'Za Post — account disabled', body: `${name}: Facebook disabled/restricted this account. Check it on Facebook — it can't post.` },
      likely_blocked: { title: 'Za Post — account not posting', body: `${name}: posted nothing across its groups (likely blocked/restricted). Check this account on Facebook.` },
    };
    const m = MSG[flag] || { title: 'Za Post — account needs attention', body: `${name}: needs attention — check it on Facebook.` };
    const n = new Notification(m);
    n.on('click', () => { try { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } catch {} });
    n.show();
  } catch {}
}
const ok = (extra = {}) => ({ success: true, ...extra });
const fail = (error) => ({ success: false, error: String(error && error.message ? error.message : error) });

// Copy a multer temp upload into the permanent images dir (temp files get flushed by
// the OS, but the worker reads these paths later, possibly after a reboot).
function persistTemp(tempPath, prefix) {
  try {
    if (!tempPath || !fs.existsSync(tempPath)) return null;
    const ext = path.extname(tempPath) || '.jpg';
    const dest = path.join(store.paths.IMAGES_DIR, `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}${ext}`);
    fs.copyFileSync(tempPath, dest);
    try { fs.unlinkSync(tempPath); } catch {}
    return dest;
  } catch { return tempPath; }
}

// Used by the remote dashboard (server.js hooks). Serialized via store.update so HTTP
// writes can't clobber the orchestrator's concurrent post/auto-delete writes.
function addPostFromRemote(fields) {
  const imgPath = persistTemp(fields.imagePath, 'post');
  const commentImagePath = persistTemp(fields.commentImagePath, 'comment');
  return store.update((data) => {
    data.posts.push({
      id: 'post-' + Date.now(), caption: fields.caption || '', comment: fields.comment || '',
      imagePaths: imgPath ? [imgPath] : [], imageUrl: fields.imageUrl || '',
      commentImagePath: commentImagePath || null, commentImageUrl: fields.commentImageUrl || '',
    });
  }).then(() => send('data-updated')).catch(() => {});
}
function deletePostByIndex(index) {
  return store.update((data) => {
    if (index >= 0 && index < data.posts.length) data.posts.splice(index, 1);
  }).then(() => send('data-updated')).catch(() => {});
}
// Bulk-insert posts pushed from the client's external server (POST /api/posts/bulk). Mirrors the add-posts-bulk IPC
// handler (trim caption, skip blanks) and honors replace=true (clear the library first). Returns { added, skipped } so
// the API reports the REAL count — the server.js default stub returned {added:0} and silently dropped every post. A
// write failure REJECTS (no swallow) so server.js answers HTTP 500 instead of a false 200.
function addPostsBulkFromRemote(posts, opts) {
  if (!Array.isArray(posts)) return Promise.resolve({ added: 0, skipped: 0 });
  const replace = !!(opts && opts.replace);
  const now = Date.now();
  let added = 0, skipped = 0;
  return store.update((data) => {
    if (replace) data.posts = [];
    for (let i = 0; i < posts.length; i++) {
      const p = posts[i] || {};
      const caption = (p.caption || '').trim();
      if (!caption) { skipped++; continue; }
      data.posts.push({ id: `post-${now}-${i}`, caption, comment: p.comment || '', imagePaths: [], imageUrl: p.imageUrl || '', commentImagePath: null, commentImageUrl: p.commentImageUrl || '' });
      added++;
    }
  }).then(() => { send('data-updated'); return { added, skipped }; });
}

// Companion-extension import: create/update the account for a Facebook session pushed from Chrome. Keyed by c_user
// (the FB numeric id) so re-sending the SAME account updates it in place — never a duplicate. Writes the FULL cookie
// jar (incl. datr) so the app's own Chromium runs the account with the same device identity + session (no re-login).
// Keep only the account's joined groups that MATCH a CONFIGURED group (tiny + actionable: "in 5 of your 20 targets"),
// not the raw ~1000 groups the account belongs to — storing all of those × 400 accounts would bloat data.json (rewritten
// on every update). Returns a capped, deduped id list.
function matchConfiguredGroups(data, joinedIds) {
  if (!Array.isArray(joinedIds) || !joinedIds.length) return [];
  const cfg = new Set((data.groups || []).map((g) => String(g.groupId || g.id)));
  return [...new Set(joinedIds.map(String).filter((id) => cfg.has(id)))].slice(0, 40); // small: it lives inline in data.json; the badge only reads .length
}

async function importFromChromeBridge(payload) {
  // License gate: the bridge listens before the UI license gate, so an enforced build that isn't ACTIVATED (or is
  // expired/revoked) must not ingest accounts/cookies either. On the owner/dev build (not enforced) this is a no-op.
  if (_licenseState && _licenseState.enforced && !_licenseState.valid) return { skipped: true, reason: 'license not active — activate the app first' };
  const cookiesIn = Array.isArray(payload && payload.cookies) ? payload.cookies : [];
  const jar = cookiesIn.map(mapChromeCookie).filter(Boolean);
  const cUser = String((payload && payload.c_user) || (jar.find((c) => c.name === 'c_user') || {}).value || '').trim();
  // LIVE-AGENT telemetry — the helper reports the real session state (session sync / health beacon / group sync).
  const health = (payload && payload.health && typeof payload.health === 'object' && payload.health.state)
    ? { state: String(payload.health.state).slice(0, 20), at: Date.now() } : null;
  const groups = Array.isArray(payload && payload.groups) ? [...new Set(payload.groups.map((g) => String(g)).filter(Boolean))].slice(0, 1000) : null;
  // HEALTH-ONLY BEACON (a logged-out/checkpointed profile, or any send with no cookie jar): update the matched
  // account's live status WITHOUT creating anything and WITHOUT touching its stored jar (keep the last good session
  // for recovery). Matched strictly by c_user — never guesses an account.
  if (cUser && ((payload && payload.beacon) || !jar.length)) {
    // Cheap pre-check: never run a full store.update (load + full-file save) for a beacon that matches NO account.
    const exists = (getData().accounts || []).some((a) => a.chromeCUser && String(a.chromeCUser) === cUser);
    if (!exists) return { beacon: true, matched: false };
    let hitName = null;
    // NO throwIfUnsaved — a telemetry heartbeat has no false-success risk; a transient data.json lock just skips this
    // update and the next real session/health change re-sends. (throwIfUnsaved would 500 + red-badge the whole fleet on
    // a harmless Defender/OneDrive blip.)
    await store.update((data) => {
      const acc = (data.accounts || []).find((a) => a.chromeCUser && String(a.chromeCUser) === cUser);
      if (acc) { hitName = acc.name; if (health) acc.chromeHealth = health; acc.chromeSeen = Date.now(); if (groups) acc.chromeGroups = matchConfiguredGroups(data, groups); }
    });
    if (hitName) send('data-updated');
    return { beacon: true, name: hitName, state: health && health.state, matched: !!hitName };
  }
  if (!cUser || !jar.length) return { skipped: true, reason: 'no logged-in Facebook session (missing c_user)' };
  const label = String((payload && payload.label) || '').trim();
  const desired = store.sanitizeName(label || ('fb_' + cUser));
  const hasDatr = jar.some((c) => c.name === 'datr');
  // xs is Facebook's actual SESSION cookie. Without it (or with it empty) the account is LOGGED OUT even though c_user
  // is present (common after a soft-logout / expiry / password change). Surface it — the siblings (import-cookies) warn
  // the same way — so the operator knows which of 86 imports arrived dead instead of finding out on the first run.
  const hasXs = jar.some((c) => c.name === 'xs' && String(c.value) !== '');
  // Optional credentials the operator typed in the helper popup — encrypted at rest (DPAPI/safeStorage), used only as
  // the Tier-3 auto re-login fallback if this account's imported session ever dies. Never sent anywhere else.
  const email = String((payload && payload.email) || '').trim();
  const password = (payload && payload.password != null && String(payload.password) !== '') ? String(payload.password) : '';
  const encEmail = email ? secret.encrypt(email) : null;
  const encPass = password ? secret.encrypt(password) : null;
  let name = desired, created = false;
  await store.update((data) => {
    data.accounts = data.accounts || [];
    // 1) Same FB account by its c_user → update in place (rename-safe). 2) Else adopt a name match ONLY if that account
    // is NOT bound to a DIFFERENT c_user — otherwise a mislabel ('bb 24' vs 'bb.24' both sanitize to 'bb_24') would
    // HIJACK an unrelated account: rebind its chromeCUser + OVERWRITE its cookie jar/creds with the wrong session,
    // silently destroying one account. Never overwrite a different identity.
    let acc = data.accounts.find((a) => a.chromeCUser && String(a.chromeCUser) === cUser)
      || data.accounts.find((a) => (!a.chromeCUser || String(a.chromeCUser) === cUser) && store.sanitizeName(a.name).toLowerCase() === desired.toLowerCase());
    if (acc) { name = acc.name; acc.chromeCUser = cUser; if (label && !acc.alias) acc.alias = label; if (encEmail) acc.email = encEmail; if (encPass) acc.password = encPass; if (acc.status === 'not_logged_in') acc.lastMessage = ''; if (health) acc.chromeHealth = health; acc.chromeSeen = Date.now(); if (groups) acc.chromeGroups = matchConfiguredGroups(data, groups); }
    else {
      // NO overLimit('accounts') gate here (deliberately, unlike the sibling creators): the owner's licensing is
      // PER-SEAT with NO account cap (every tier maxAccounts:Infinity), so the check would enforce nothing — its only
      // real effect was to REFUSE every bridge import on an enforced build that isn't ACTIVATED yet (overLimit fails
      // closed on valid:false), which would silently make the operator redo all ~86 profiles after activating. Posting
      // stays license-gated regardless. If a finite account tier is ever introduced, gate ALL creation paths together.
      // Disambiguate a name collision with a DIFFERENT identity so we create a NEW account instead of overwriting one.
      let finalName = desired;
      if (data.accounts.some((a) => store.sanitizeName(a.name).toLowerCase() === finalName.toLowerCase())) finalName = store.sanitizeName(desired + '_' + cUser);
      const na = { name: finalName, alias: label || '', status: 'not_logged_in', lastMessage: '', assignedGroups: [], postFilter: 'all', postingOrder: 'post-centric-unique', enabled: true, isModerator: false, chromeCUser: cUser };
      if (encEmail) na.email = encEmail; if (encPass) na.password = encPass;
      na.chromeSeen = Date.now(); if (health) na.chromeHealth = health; if (groups) na.chromeGroups = matchConfiguredGroups(data, groups);
      data.accounts.push(na); name = finalName; created = true;
    }
  }, { throwIfUnsaved: true }).catch((e) => {
    // A transient data.json lock during a live-agent re-sync must degrade quietly (retry next change), not 500 the
    // extension. The onboarding CREATE still can't falsely succeed — we return a retry marker instead of writing a jar.
    if (e && e.code === 'E_SAVE_SKIPPED') { name = null; return; }
    throw e;
  });
  if (name === null) return { skipped: true, reason: 'data.json busy — will retry' };
  // ONLY write the jar for a LIVE session (xs present). A soft-logout (c_user present but xs gone) must NOT overwrite
  // the last-good stored jar — that jar is the recovery session; the account's health is still updated to logged_out.
  if (hasXs) store.writeCookies(name, jar); // encrypted at rest (safeStorage/DPAPI), same as every other jar
  send('data-updated');
  const warning = !hasXs ? 'Missing the "xs" session cookie — this account will arrive LOGGED OUT. Open the profile logged in to Facebook and re-send (or add its login below).' : (!hasDatr ? 'Missing the "datr" device cookie — Facebook may treat this as a new device (more checkpoints).' : '');
  try { appendLogFile(`Chrome import: ${created ? 'created' : 'updated'} "${name}" (c_user ${cUser}, ${jar.length} cookies${hasXs ? '' : ', NO xs ⚠️'}${hasDatr ? ', datr ✓' : ', NO datr ⚠️'}${(encEmail || encPass) ? ', +creds' : ''})`); } catch {}
  return { name, cUser, created, cookies: jar.length, hasDatr, hasXs, hasCreds: !!(encEmail || encPass), warning };
}

// Generate the companion extension into userData with THIS install's port+token baked in, ready to "Load unpacked".
function generateChromeImportExtension() {
  const srcDir = path.join(__dirname, 'chrome-bridge');
  const outDir = path.join(app.getPath('userData'), 'chrome-import-extension');
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of ['manifest.json', 'background.js', 'popup.html', 'popup.js']) {
    let txt = fs.readFileSync(path.join(srcDir, f), 'utf8');
    txt = txt.split('__PORT__').join(String(BRIDGE_PORT)).split('__TOKEN__').join(BRIDGE_TOKEN);
    fs.writeFileSync(path.join(outDir, f), txt);
  }
  return outDir;
}

// Read the user's installed-Chrome profile labels (BB24, AA32…) from Local State — names only, never cookies. Windows.
function readChromeProfileLabels() {
  try {
    const base = path.join(app.getPath('appData'), '..', 'Local', 'Google', 'Chrome', 'User Data');
    const ls = JSON.parse(fs.readFileSync(path.join(base, 'Local State'), 'utf8'));
    const cache = (ls.profile && ls.profile.info_cache) || {};
    return Object.entries(cache).map(([dir, v]) => ({ dir, name: (v && v.name) || dir })).sort((a, b) => a.dir.localeCompare(b.dir, undefined, { numeric: true }));
  } catch { return []; }
}

function showLicenseWindow() {
  if (licenseWindow) { licenseWindow.focus(); return; }
  licenseWindow = new BrowserWindow({ width: 440, height: 400, resizable: false, title: 'License', icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'), webPreferences: { preload: path.join(__dirname, 'license-preload.js'), contextIsolation: true, nodeIntegration: false } });
  licenseWindow.removeMenu();
  licenseWindow.loadFile(path.join(__dirname, 'license-window.html'));
  licenseWindow.on('closed', () => { licenseWindow = null; });
}
function showRevokedWindow() {
  if (revokedWindow) { revokedWindow.focus(); return; }
  revokedWindow = new BrowserWindow({ width: 440, height: 400, resizable: false, title: 'License', webPreferences: { preload: path.join(__dirname, 'license-preload.js'), contextIsolation: true, nodeIntegration: false } });
  revokedWindow.removeMenu();
  revokedWindow.loadFile(path.join(__dirname, 'revoked.html'));
  revokedWindow.on('closed', () => { revokedWindow = null; });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 800, minWidth: 1024, minHeight: 700,
    title: 'Za Post Comment Tool',
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.on('did-finish-load', () => console.log('[BOOT] renderer loaded OK'));
  mainWindow.webContents.on('render-process-gone', (_e, d) => console.error('[BOOT] renderer gone:', d.reason));
  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(async () => {
  // If we LOST the single-instance lock, do NOTHING and let app.quit() proceed. Otherwise this
  // second instance would run killOrphanChromium() (which kills the FIRST instance's live run/login
  // browsers — they all live under ACCOUNTS_DIR), start a colliding server, and maybe auto-resume.
  if (!gotLock) return;
  migrateLegacyUserDataOnce(app.getPath('userData')); // one-shot: seed a fresh install from a prior build's userData (pure no-op if this dir already has data)
  store.init(app.getPath('userData'));
  clearInterruptedLoginStates(); // triggers the first load() — surfaces any recovery below

  // If data.json was corrupt at startup, tell the operator clearly (data integrity matters
  // for a real campaign). store.load() already recovered from backup / quarantined the bad file.
  const dataIssue = store.consumeLoadIssue();
  if (dataIssue) {
    const detail = dataIssue === 'recovered-from-backup'
      ? 'data.json was unreadable and was automatically restored from the backup (data.json.bak). Changes since the last successful save may be lost. The corrupt file was preserved as data.corrupt-*.json.'
      : 'data.json was unreadable and no backup existed, so the app started with empty data. The unreadable file was preserved as data.corrupt-*.json for manual recovery.';
    appendLogFile('DATA WARNING: ' + detail);
    try { dialog.showMessageBox({ type: 'warning', title: 'Za Post — data recovery', message: 'Saved data was recovered after corruption', detail, buttons: ['OK'] }); } catch {}
  }

  // Kill any Chromium left orphaned by a previous crash/force-kill so its locked
  // profile dir doesn't block this session's launches. Best-effort, non-blocking.
  killOrphanChromium().then((n) => { if (n) emit('automation-log', `🧹 cleaned up ${n} orphaned browser process(es) from a previous run`); }).catch(() => {}); // emit() already writes to the log file

  // ---- run-state file (shutdown/crash resilience) ---------------------------
  RUN_STATE_FILE = path.join(app.getPath('userData'), 'run-state.json');

  // ---- Windows login-item (opt-in launchOnStartup) -------------------------
  try { app.setLoginItemSettings({ openAtLogin: !!(store.load().settings.launchOnStartup) }); } catch {}

  // ---- log file setup & startup rotation ------------------------------------
  LOG_DIR = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(LOG_DIR, { recursive: true });
  LOG_FILE = path.join(LOG_DIR, 'automation.log');
  rotateLogIfBig();
  appendLogFile('--- session start ---');
  // ---------------------------------------------------------------------------

  ensureDesktopShortcut(); // first-run: drop a desktop icon (portable build has no installer)

  orchestrator = new Orchestrator(emit, { isLoginOpen: (name) => loginBrowsers.has(name) });

  // Survive laptop sleep: a suspend drops every Chromium CDP connection, so HOLD the run on
  // suspend and continue on wake. We only auto-resume a pause WE triggered (not a user pause).
  let pausedBySystem = false;
  let systemPauseToken = -1; // snapshot of userPauseActions when WE auto-paused
  try {
    const { powerMonitor } = require('electron');
    powerMonitor.on('suspend', () => { try { if (orchestrator && orchestrator.isRunning() && !orchestrator.isPaused()) { orchestrator.pause(); pausedBySystem = true; systemPauseToken = userPauseActions; appendLogFile('System suspend — auto-paused the run'); } } catch {} });
    // Auto-resume ONLY if we paused AND the user issued no pause/resume since — otherwise the user
    // deliberately paused after the system pause, and waking must NOT silently un-pause their run.
    powerMonitor.on('resume', () => {
      try {
        if (pausedBySystem && orchestrator && orchestrator.isPaused()) {
          if (userPauseActions === systemPauseToken) { orchestrator.resume(); appendLogFile('System resume — auto-resumed the run'); }
          else appendLogFile('System resume — left paused (you paused it manually)');
        }
        pausedBySystem = false;
      } catch {}
    });
  } catch {}

  // Chrome-import bridge: a localhost-only receiver for the companion extension (see lib/chrome-bridge.js). Uses a
  // STABLE per-install token (persisted) so the generated extension keeps working across app restarts. Best-effort.
  try {
    const btFile = path.join(app.getPath('userData'), 'chrome-bridge-token.txt');
    try { BRIDGE_TOKEN = fs.readFileSync(btFile, 'utf8').trim(); } catch {}
    if (!BRIDGE_TOKEN) {
      BRIDGE_TOKEN = require('crypto').randomBytes(24).toString('hex');
      // Verify the token actually PERSISTED (read it back). If it didn't, the next launch generates a DIFFERENT token
      // and the extension the operator already loaded goes stale → every import silently 401s. Flag it so the Import
      // panel can warn "regenerate the helper" instead of leaving the operator confused.
      try { fs.writeFileSync(btFile, BRIDGE_TOKEN); BRIDGE_TOKEN_STABLE = (fs.readFileSync(btFile, 'utf8').trim() === BRIDGE_TOKEN); } catch { BRIDGE_TOKEN_STABLE = false; }
      if (!BRIDGE_TOKEN_STABLE) { try { appendLogFile('⚠️ Chrome import: the bridge token could NOT be saved — it will change on the next app restart, so an already-loaded helper extension will stop working (401). Re-generate + re-load the helper after each restart until this is fixed (check data-folder permissions / antivirus).'); } catch {} }
    }
    startBridge({ port: BRIDGE_PORT, token: BRIDGE_TOKEN, onImport: importFromChromeBridge, log: (m) => { try { appendLogFile(m); } catch {} } });
  } catch (e) { try { appendLogFile('Chrome import bridge failed to start: ' + ((e && e.message) || e)); } catch {} }

  // Remote control server + tunnel (best effort). Hooks delegate all mutations
  // back here so the data store stays the single source of truth.
  await remote.startServer(REMOTE_PORT, {
    getData,
    getStatus: () => orchestrator.isRunning(),
    onStart: async () => { if (_licenseState && _licenseState.enforced && !_licenseState.valid) return { success: false, error: 'License not active — activate the app before posting.' }; const r = await orchestrator.start(getData); if (r && r.success !== false) setRunActive(true); return r; }, // license gate: the remote server runs before the UI gate, so enforce here too (an enforced+invalid build must not post via the API)
    onStop: () => { orchestrator.stop(); setRunActive(false); },
    addPost: (fields) => addPostFromRemote(fields),
    addPostsBulk: (posts, o) => addPostsBulkFromRemote(posts, o), // POST /api/posts/bulk — WAS unwired (server.js stub silently dropped every remotely-pushed post)
    deletePost: (index) => deletePostByIndex(index),
    // Set the inter-cycle interval. The engine reads the waitIntervalMin/Max RANGE (the single waitInterval key
    // was removed), so a fixed interval = min=max=minutes. Returns the promise so the caller can await the write.
    setInterval: (minutes) => store.update((d) => { const m = clampSettings({ waitIntervalMin: minutes, waitIntervalMax: minutes }); d.settings.waitIntervalMin = m.waitIntervalMin; d.settings.waitIntervalMax = m.waitIntervalMax; }).then(() => send('data-updated')),
    toggleAccount: (name, enabled) => store.update((d) => { const a = (d.accounts || []).find((x) => x.name === name); if (a) a.enabled = enabled === undefined ? a.enabled === false : !!enabled; }).then(() => send('data-updated')),
    loginAccount: (name) => { if (_licenseState && _licenseState.enforced && !_licenseState.valid) return { success: false, error: 'License not active — activate the app first.' }; return openLoginBrowser(name); }, // gate like onStart: openLoginBrowser drives real auto-login automation, so an enforced+invalid build must not run it via the remote API
    closeLogin: (name) => closeLoginBrowser(name),
    getTunnelUrl: () => tunnelUrl || '',
    getProxyHealth: () => orchestrator.getProxyHealth(), // E-X4: /api/proxies/health
    apiToken: REMOTE_TOKEN, // gate /api/* when reached over the public tunnel
    uploadDir: path.join(app.getPath('userData'), 'uploads'),
    imagesDir: store.paths.IMAGES_DIR,
  }).catch((e) => { try { appendLogFile('Remote API failed to start (best-effort) — continuing to launch the app: ' + ((e && e.message) || e)); } catch {} }); // a server-init throw must NOT skip the license gate + createWindow()
  // Cloudflare tunnel is OPT-IN: its spawned binary can destabilize the app on some
  // systems, so it's off by default. Enable with ENABLE_TUNNEL=1 (or settings.enableTunnel).
  const wantTunnel = process.env.ENABLE_TUNNEL || (getData().settings && getData().settings.enableTunnel);
  applyTunnelState(!!wantTunnel);

  // License gate — OPT-IN. Enforced when: the ENABLE_LICENSE env is set, the operator turned it on in settings, OR
  // this is a packaged CLIENT build carrying the enforce-license.flag marker (ENFORCE_LICENSE=1 at build time). The
  // dev/source build has no marker → unlimited owner mode, boot identical to before. The OWNER key still activates
  // offline/unlimited even when enforcement is on, so an owner-built package is never locked out.
  const LICENSE_ON = !!(process.env.ENABLE_LICENSE || (store.load().settings && store.load().settings.licenseEnabled) || _enforceLicenseMarker());
  if (!LICENSE_ON) {
    setLicenseState({ valid: true, tier: 'owner', limits: license.UNLIMITED }, false); // owner/dev: unlimited
    createWindow();
  } else {
    const r = await checkCachedResilient();
    if (r && r.unreadable) {
      // license.json EXISTS but stayed locked through the launch retries (antivirus/OneDrive scanning the userData
      // folder at startup is common on Windows). Do NOT brick a likely-already-activated customer — and, worse, block
      // crash-resume/--autostart with mainWindow=null — on a harmless I/O blip. Open the app PROVISIONALLY and confirm
      // with a fast re-check that locks within ~2 min if the file turns out genuinely invalid (a bounded bypass window,
      // acceptable per robustness-over-security since the asar is already unpackable).
      setLicenseState({ valid: true, tier: 'standard', limits: license.UNLIMITED }, true);
      createWindow();
      try { appendLogFile('⚠️ License file was temporarily unreadable at launch (antivirus/sync likely scanning the data folder) — starting normally and re-verifying shortly.'); } catch {}
      scheduleLicenseRecheck(120000);
    } else {
      setLicenseState(r, true); // enforce the validated tier's limits from here on
      if (r.valid) createWindow();
      else if (r.revoked) showRevokedWindow();
      else showLicenseWindow();
    }
    // Periodic re-validation — ONLY when enforcement is on (no-op in owner/dev mode). Re-checks every ~6h so a
    // server-side revoke or an expiry takes effect WITHOUT a restart: refresh the tier limits, and if the
    // license has gone invalid, stop any running automation and surface the re-validation window.
    const REVAL_MS = 6 * 60 * 60 * 1000;
    const revalTimer = setInterval(async () => {
      try {
        const rr = await license.checkCached(app.getPath('userData'), licenseServerUrl());
        // TRANSIENT lock (Defender/OneDrive/indexer, or our own writeCache tmp→rename that fires on every successful
        // validation while store.update writes the same folder during a run) → the sentinel means "retry", NOT
        // "invalid". NEVER overwrite a currently-valid state or tear down a running overnight campaign on an I/O blip;
        // keep last-known-good and re-check next cycle (the file is present, just momentarily locked).
        if (rr && rr.unreadable) return;
        setLicenseState(rr, true);
        try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('license-updated'); } catch {}
        if (!rr.valid) {
          let stopped = false;
          try { if (orchestrator.isRunning()) { orchestrator.stop(); setRunActive(false); stopped = true; } } catch {}
          emit('automation-log', stopped ? '🔒 License is no longer valid — automation stopped. Re-validate to continue.' : '🔒 License is no longer valid — re-validate to run.');
          try { if (rr.revoked) showRevokedWindow(); else showLicenseWindow(); } catch {}
        }
      } catch {}
    }, REVAL_MS);
    app.on('before-quit', () => { try { clearInterval(revalTimer); } catch {} });
  }

  // ---- Auto-resume after shutdown / crash ------------------------------------
  // Capture whether the previous session left the run-active flag set.
  const wasInterrupted = isRunActive();
  // Only resume if there is actually work left — a stale run-active flag (e.g. a crash just after the
  // campaign completed) must not resurrect a finished run.
  const _rd = store.load();
  const _hasWork = (_rd.posts || []).length > 0 && (_rd.accounts || []).some((a) => a.enabled !== false && !a.isModerator && (a.assignedGroups || []).length > 0);
  if (wasInterrupted && !_hasWork) { try { setRunActive(false); } catch {} }
  if (wasInterrupted && _hasWork && _rd.settings.resumeOnStartup === true && mainWindow) {
    let resumeFired = false; // guard: fire exactly once
    mainWindow.webContents.once('did-finish-load', () => {
      if (resumeFired || orchestrator.isRunning()) return;
      resumeFired = true;
      emit('automation-log', '🔁 Previous run was interrupted (shutdown/crash) — resuming the campaign...');
      // orchestrator.start re-reads data.json + loads rotation, continuing from persisted state.
      // Note: the in-flight post at shutdown may be re-attempted (acceptable; rotation/auto-delete
      // prevent broad duplication).
      orchestrator.start(getData);
      setRunActive(true);
    });
    // Fallback: if the renderer never finishes loading (GPU/OOM renderer crash on a headless RDP box, corrupt
    // index.html, slow disk), did-finish-load never fires and the unattended run would be SILENTLY missed. Arm a
    // timer to resume anyway — orchestrator.start re-reads data.json and does not need the renderer. resumeFired
    // guarantees it still fires exactly once.
    setTimeout(() => {
      if (resumeFired || orchestrator.isRunning()) return;
      resumeFired = true;
      emit('automation-log', '🔁 Previous run interrupted — resuming (renderer load timed out)...');
      orchestrator.start(getData);
      setRunActive(true);
    }, 20000);
  }
  // DAILY AUTO-START boot hook: when the Windows scheduled task launches the app WITH --autostart at dailyPostTime (armed
  // by the "auto-start daily" toggle), run TODAY's cycle now. runNow is REQUIRED: the task fires at the schedule time but
  // boot latency makes "now" just-past dailyPostTime, so the plain daily gate would treat today as done and wait for
  // tomorrow — missing today. Guards: only on the flagged launch, only when NOT resuming an interrupted run (that path
  // owns it), only in daily mode with the toggle on + work present, and only if not already running. A manual launch (no
  // flag) never auto-posts; a task launch while the app is already open quits on the single-instance lock (no double-post).
  if (process.argv.includes('--autostart') && !wasInterrupted && _hasWork && _rd.settings && _rd.settings.autoStartDaily === true && _rd.settings.scheduleMode === 'daily' && mainWindow && !orchestrator.isRunning()) {
    let autoFired = false;
    const _fireAuto = () => { if (autoFired || orchestrator.isRunning()) return; autoFired = true; emit('automation-log', '⏰ Daily auto-start (scheduled task) — running today\'s campaign now...'); orchestrator.start(getData, { runNow: true }); setRunActive(true); };
    mainWindow.webContents.once('did-finish-load', _fireAuto);
    setTimeout(_fireAuto, 20000); // renderer-independent fallback (matches the resume path)
  }
  // ---------------------------------------------------------------------------

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch((e) => {
  // Last-resort: any UNTRAPPED throw during startup (userData not writable, a lib init failure) must NOT leave a
  // headless zombie — a live process with no window that only Task Manager can kill. Surface it + still try to show
  // a window so the operator can see + report the error.
  try { appendLogFile('FATAL startup error: ' + ((e && e.stack) || e)); } catch {}
  try { dialog.showErrorBox('Za Post — startup problem', 'The app hit an error while starting:\n\n' + String((e && e.message) || e) + '\n\nCheck that the app folder and your user-data folder are writable (antivirus / OneDrive / a full disk can lock them), then relaunch.'); } catch {}
  try { if (!mainWindow || mainWindow.isDestroyed()) createWindow(); } catch { try { app.quit(); } catch {} }
});

app.on('window-all-closed', () => {
  if (orchestrator) orchestrator.stop();
  // A clean window-all-closed is a deliberate user quit — durably clear run-active (synchronous
  // fsync+rename) so the next launch won't auto-resume a run the user intentionally closed. A
  // crash/hard-kill leaves the flag set, which is the legitimate crash-resume case.
  try { setRunActive(false); } catch {}
  for (const [, entry] of loginBrowsers) { try { entry.browser.close(); } catch {} }
  remote.stopServer();
  if (process.platform !== 'darwin') app.quit();
});

// =======================================================================
// IPC: DATA
// =======================================================================
ipcMain.handle('get-data', () => getData());
ipcMain.handle('save-data', async (_e, data) => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fail('Invalid data');
  if (!Array.isArray(data.posts) || !Array.isArray(data.groups) || !Array.isArray(data.accounts)) return fail('Invalid data');
  try {
    // Route through update() (the serialized write-chain) so a renderer save can't lost-update against a
    // concurrent orchestrator write, and through normalize() so every save coerces accounts/settings the
    // same way load() does (e.g. account.standby/isModerator booleans, settings defaults).
    await store.update((d) => {
      const n = store.normalize(data);
      // CRITICAL: the renderer's snapshot of the RUNTIME account fields is STALE. Take those from the live
      // disk copy (`d`) instead of overwriting them — otherwise a settings/standby/proxy edit would reset a
      // live rate-limit COOLDOWN or the daily POST COUNT, which actively deepens Facebook bans. Renderer-owned
      // STRUCTURAL fields (alias, assignedGroups, postFilter, postingOrder, enabled, standby, proxy,
      // isModerator, fbDisplayName, email, password) are kept from the renderer; runtime fields below are not.
      // chrome* are written CONTINUOUSLY by the Chrome-import bridge (session/health/group sync) independent of the
      // renderer, so a stale renderer save must NOT roll them back — treat them as runtime/bridge-owned like the rest.
      const RUNTIME = ['status', 'lastMessage', 'daily', 'rateLimitedUntil', 'rlStrikes', 'nextAttnRetry', 'fbUserId', 'fbName', 'lastChecked', 'chromeCUser', 'chromeHealth', 'chromeSeen', 'chromeGroups'];
      const live = new Map((d.accounts || []).map((a) => [a.name, a]));
      for (const a of n.accounts) { const cur = live.get(a.name); if (cur) for (const k of RUNTIME) { if (cur[k] === undefined) delete a[k]; else a[k] = cur[k]; } }
      // NEVER drop an account that exists on disk but is missing from the renderer's (possibly stale) snapshot — the
      // Chrome bridge can CREATE accounts concurrently while the UI is open, and a full-data save built on a pre-create
      // snapshot would silently erase them (orphaning their profile dir + cookie jar). Deletion goes ONLY through the
      // dedicated delete handlers, so union any disk-only account back in.
      const payloadNames = new Set(n.accounts.map((a) => a.name));
      for (const a of (d.accounts || [])) { if (!payloadNames.has(a.name)) n.accounts.push(a); }
      // POSTS: the renderer NEVER edits posts through this full-blob save (all post CRUD is via the dedicated
      // add/edit/delete/assign-post-set handlers), so a stale snapshot must NOT rewrite them — replaying it would drop
      // posts the remote API (POST /api/posts/bulk, including replace=true) pushed concurrently. Keep the live disk posts.
      // GROUPS: the renderer DOES edit groups here (rename + moderatedBy), so write the payload groups — but UNION back
      // any disk-only group (added concurrently via add-group[s]) by id, exactly like accounts, so a stale save can't drop one.
      const payloadGroupIds = new Set(n.groups.map((g) => String(g.id)));
      for (const g of (d.groups || [])) { if (!payloadGroupIds.has(String(g.id))) n.groups.push(g); }
      d.groups = n.groups; d.accounts = n.accounts;
      d.settings = n.settings; d.proxies = n.proxies; d.useProxies = n.useProxies;
    }, { throwIfUnsaved: true }); // a transient data.json lock must NOT report false success then silently drop the operator's structural edit (assignedGroups/alias/credentials have no other writer) — surface E_SAVE_SKIPPED so the renderer says "not saved, retry"
    return ok();
  } catch (e) { return fail(e); }
});

// =======================================================================
// IPC: POSTS
// =======================================================================
ipcMain.handle('add-post', async (_e, post) => {
  try {
    const imagePaths = [];
    for (const img of post.images || []) { const p = store.saveBase64Image(img, 'post'); if (p) imagePaths.push(p); }
    let commentImagePath = null;
    if (post.commentImage) commentImagePath = store.saveBase64Image(post.commentImage, 'comment');
    await store.update((data) => {
      data.posts.push({
        id: 'post-' + Date.now(),
        caption: post.caption || '',
        comment: post.comment || '',
        imagePaths,
        imageUrl: post.imageUrl || '',
        commentImagePath,
        commentImageUrl: post.commentImageUrl || '',
      });
    });
    send('data-updated');
    return ok();
  } catch (e) { return fail(e); }
});

// =======================================================================
// IPC: BULK IMPORT
// =======================================================================
ipcMain.handle('add-posts-bulk', async (_e, posts) => {
  try {
    if (!Array.isArray(posts)) return fail('Expected an array of posts');
    let added = 0, skipped = 0;
    const now = Date.now();
    await store.update((data) => {
      for (let i = 0; i < posts.length; i++) {
        const p = posts[i];
        const caption = (p.caption || '').trim();
        if (!caption) { skipped++; continue; }
        data.posts.push({
          id: `post-${now}-${i}`,
          caption,
          comment: p.comment || '',
          imagePaths: [],
          imageUrl: p.imageUrl || '',
          commentImagePath: null,
          commentImageUrl: p.commentImageUrl || '',
        });
        added++;
      }
    });
    send('data-updated');
    return ok({ added, skipped });
  } catch (e) { return fail(e); }
});

ipcMain.handle('add-groups-bulk', async (_e, items) => {
  try {
    if (!Array.isArray(items)) return fail('Expected an array of group URLs/IDs');
    let added = 0, skipped = 0, limited = 0;
    const now = Date.now();
    await store.update((data) => {
      const existingIds = new Set(data.groups.map((g) => g.groupId));
      for (let i = 0; i < items.length; i++) {
        const groupId = extractGroupId(String(items[i] || ''));
        if (!groupId || existingIds.has(groupId)) { skipped++; continue; }
        // M1-05: stop adding once the license group limit is reached (count the rest as "limited").
        if (overLimit('groups', data.groups.length)) { limited++; continue; }
        existingIds.add(groupId);
        data.groups.push({ id: `group-${now}-${i}`, groupId, name: `Group ${data.groups.length + 1}` });
        added++;
      }
    });
    send('data-updated');
    return ok({ added, skipped, limited, message: limited ? `${limited} group(s) not added — your ${_licenseState.tier} plan limit of ${_licenseState.limits.maxGroups} groups was reached.` : undefined });
  } catch (e) { return fail(e); }
});

ipcMain.handle('delete-post', async (_e, postId) => {
  try {
    await store.update((data) => { data.posts = data.posts.filter((p) => p.id !== postId); });
    send('data-updated'); return ok();
  } catch (e) { return fail(e); }
});

// BULK post ops — the Posts-tab multi-select buttons. These channels are bridged in preload + called by the
// renderer but had NO handler (the invoke rejected → the button silently no-op'd). bulk-assign-post-set is how
// the operator TAGS posts to a post-set from the Posts tab; without it, set-restricted accounts post NOTHING.
ipcMain.handle('delete-posts', async (_e, ids) => {
  try {
    const set = new Set((ids || []).map(String));
    const removed = await store.update((data) => { const before = data.posts.length; data.posts = data.posts.filter((p) => !set.has(String(p.id))); return before - data.posts.length; });
    send('data-updated'); return ok({ removed });
  } catch (e) { return fail(e); }
});
ipcMain.handle('bulk-assign-post-set', async (_e, postIds, setId) => {
  try {
    const set = new Set((postIds || []).map(String));
    const assigned = await store.update((data) => {
      const valid = new Set(((data.settings && data.settings.postSets) || []).map((s) => s.id));
      const sid = (setId && valid.has(String(setId))) ? String(setId) : null; // '' or an unknown id → null = default (whole library); never leaves a dangling ref that would silently post nothing
      let c = 0; for (const p of data.posts) if (set.has(String(p.id))) { p.postSetId = sid; c++; }
      return c;
    });
    send('data-updated'); return ok({ assigned });
  } catch (e) { return fail(e); }
});
ipcMain.handle('delete-post-set', async (_e, setId) => {
  try {
    const sid = String(setId || '');
    await store.update((data) => {
      if (data.settings && Array.isArray(data.settings.postSets)) data.settings.postSets = data.settings.postSets.filter((s) => s.id !== sid);
      for (const p of data.posts) if (p.postSetId === sid) p.postSetId = null; // posts revert to default (all)
      for (const a of data.accounts) if (a.postSetId === sid) a.postSetId = null; // accounts revert to the whole library (no dangling set → no silent no-post)
    });
    send('data-updated'); return ok({ ok: true });
  } catch (e) { return fail(e); }
});

ipcMain.handle('edit-post', async (_e, postId, updates) => {
  try {
    const found = await store.update((data) => {
      const p = data.posts.find((x) => x.id === postId);
      if (!p) return false;
      if (updates.caption !== undefined) p.caption = updates.caption;
      if (updates.comment !== undefined) p.comment = updates.comment;
      // Remote image URLs are simple strings downloaded at post time — editable here (uploaded local images
      // aren't, to avoid re-encoding; delete + re-add for those).
      if (updates.imageUrl !== undefined) p.imageUrl = updates.imageUrl;
      if (updates.commentImageUrl !== undefined) p.commentImageUrl = updates.commentImageUrl;
      return true;
    });
    if (!found) return fail('Post not found');
    send('data-updated'); return ok();
  } catch (e) { return fail(e); }
});

// =======================================================================
// IPC: GROUPS
// =======================================================================
ipcMain.handle('add-group', async (_e, group) => {
  try {
    const groupId = extractGroupId(group.groupId);
    if (!groupId) return fail('Invalid group ID / URL');
    const res = await store.update((data) => {
      const over = overLimit('groups', data.groups.length); if (over) return over; // M1-05 backend enforcement
      data.groups.push({ id: 'group-' + Date.now(), groupId, name: group.name || `Group ${data.groups.length + 1}` });
      return null;
    });
    if (res) return res; // over-limit fail object
    send('data-updated'); return ok();
  } catch (e) { return fail(e); }
});

ipcMain.handle('delete-group', async (_e, groupId) => {
  try {
    await store.update((data) => {
      data.groups = data.groups.filter((g) => g.id !== groupId && g.groupId !== groupId);
      // Prune the deleted group from every account's assignedGroups so the worker never
      // wastes a cycle on a group that no longer exists.
      const valid = new Set(data.groups.map((g) => g.id));
      for (const a of data.accounts) a.assignedGroups = (a.assignedGroups || []).filter((id) => valid.has(id));
    });
    send('data-updated'); return ok();
  } catch (e) { return fail(e); }
});

// BULK group delete — the Groups-tab multi-select "Delete selected" button (bridged + called, but had no handler).
ipcMain.handle('delete-groups', async (_e, ids) => {
  try {
    const set = new Set((ids || []).map(String));
    const removed = await store.update((data) => {
      const before = data.groups.length;
      data.groups = data.groups.filter((g) => !set.has(String(g.id)) && !set.has(String(g.groupId)));
      const valid = new Set(data.groups.map((g) => g.id));
      for (const a of data.accounts) a.assignedGroups = (a.assignedGroups || []).filter((id) => valid.has(id)); // prune dangling refs
      return before - data.groups.length;
    });
    send('data-updated'); return ok({ removed });
  } catch (e) { return fail(e); }
});

// Open a URL in the OS default browser — the "👥 open group page" button (held-post moderation recovery) + any
// external link. Bridged via the gated invoke('open-external', url) but had no handler → the link silently failed.
ipcMain.handle('open-external', async (_e, url) => {
  try {
    const u = String(url || '');
    if (!/^https?:\/\//i.test(u)) return fail('Only http/https URLs are allowed'); // no file:/// or other schemes from the renderer
    await shell.openExternal(u);
    return ok();
  } catch (e) { return fail(e); }
});

function extractGroupId(input) {
  if (!input) return '';
  const s = String(input).trim();
  const m = s.match(/groups\/([0-9A-Za-z._-]+)/);
  return m ? m[1] : s.replace(/[^0-9A-Za-z._-]/g, '');
}

// =======================================================================
// IPC: ACCOUNTS
// =======================================================================
ipcMain.handle('create-account', async (_e, accountName, alias, opts) => {
  try {
    if (!accountName) return fail('Account name required');
    // A moderator is born flagged + disabled-as-poster so it can NEVER be selected into the posting pool,
    // even in the brief window before the renderer would set the flag (no race; no one-frame-as-poster).
    const isMod = !!(opts && opts.isModerator);
    const res = await store.update((data) => {
      if (data.accounts.some((a) => a.name === accountName)) return fail('Account already exists');
      // Licensing: moderators are FREE — only posting accounts count against the per-seat limit. So skip the
      // check for moderators, and for posters count posters only (a designated moderator must not eat a seat).
      if (!isMod) { const over = overLimit('accounts', data.accounts.filter((a) => !a.isModerator).length); if (over) return over; }
      data.accounts.push({
        name: accountName, alias: alias || '', status: 'not_logged_in', lastMessage: '',
        assignedGroups: [], postFilter: 'all', postingOrder: 'post-centric-unique',
        enabled: !isMod, isModerator: isMod,
      });
      return null;
    });
    if (res) return res; // 'already exists' / over-limit fail object
    store.profileDir(accountName); // create profile dir
    send('data-updated'); return ok();
  } catch (e) { return fail(e); }
});

// BULK account import — the #1 lever for a large-fleet client deployment (400 accounts would otherwise be ~800
// manual clicks). Accepts an array of { name, alias?, proxy?, email?, password?, cookies? }; optional opts.cookiesDir
// points at a folder of <account>.json cookie exports matched by name. Mirrors add-groups-bulk (ONE store.update
// creating every record) + create-account (record shape + profile dir) + set-account-credentials (encrypt creds at
// rest) + import-cookies (jar filter). CRITICAL: does NOT run a per-account checkStatus — 400 browser launches would
// be catastrophic; accounts land 'not_logged_in' and the first posting run's 3-tier auth verifies + seeds them.
ipcMain.handle('add-accounts-bulk', async (_e, accounts, opts) => {
  try {
    if (!Array.isArray(accounts)) return fail('Expected an array of accounts');
    const cookiesDir = (opts && opts.cookiesDir) ? String(opts.cookiesDir) : null;
    let added = 0, skipped = 0, limited = 0, withProxy = 0, withCreds = 0, cookiesLoaded = 0, cookiesMissing = 0, cookiesNoDatr = 0, cookiesWriteFailed = 0;
    const provision = []; // {name, cookies|null} — file I/O AFTER the transaction (writeCookies / profileDir hit disk)
    // throwIfUnsaved: if data.json was transiently unreadable on load (Windows AV/sync/indexer lock), store.update
    // SKIPS the save. Without this flag the handler would push accounts into a discarded in-memory copy, write orphan
    // cookie jars, and report full success while data.json kept ZERO of them (the operator's whole paste lost). The
    // typed throw routes to the catch below → fail(...) → the renderer keeps the paste so the operator can retry.
    await store.update((data) => {
      // Dedup on the SANITIZED on-disk key (what profileDir/cookiesFile derive), NOT the raw display name — else two
      // distinct pasted names that sanitize/case-fold to the SAME folder would silently OVERWRITE the first account's
      // Chrome profile + cookies.json (a real, hard-to-notice data-loss risk on a 400-account paste).
      const existing = new Set((data.accounts || []).map((a) => store.sanitizeName(a.name).toLowerCase()));
      for (const raw of accounts) {
        const name = String((raw && raw.name) || '').trim();
        if (!name) { skipped++; continue; }               // no name → can't create a profile dir → skip
        const key = store.sanitizeName(name).toLowerCase();
        if (!key || existing.has(key)) { skipped++; continue; } // duplicate on the on-disk identity (existing OR earlier in this batch) → skip
        if (overLimit('accounts', (data.accounts || []).filter((a) => !a.isModerator).length)) { limited++; continue; }
        existing.add(key);
        const acct = {
          name, alias: String((raw && raw.alias) || '').trim(), status: 'not_logged_in', lastMessage: '',
          assignedGroups: [], postFilter: 'all', postingOrder: 'post-centric-unique', enabled: true, isModerator: false,
        };
        const proxy = String((raw && raw.proxy) || '').trim(); if (proxy) { acct.proxy = proxy; withProxy++; }
        const email = String((raw && raw.email) || '').trim();
        const password = (raw && raw.password != null && String(raw.password) !== '') ? String(raw.password) : '';
        if (email) acct.email = secret.encrypt(email);
        if (password) acct.password = secret.encrypt(password);
        if (email || password) withCreds++;
        data.accounts.push(acct);
        provision.push({ name, cookies: (raw && Array.isArray(raw.cookies)) ? raw.cookies : null });
        added++;
      }
    }, { throwIfUnsaved: true });
    // Create profile dirs + seed cookies OUTSIDE the store transaction. Inline cookies win; else <name>.json in the folder.
    for (const p of provision) {
      try { store.profileDir(p.name); } catch {}
      let jar = p.cookies;
      if (!jar && cookiesDir) {
        try {
          // Use ONLY the SANITIZED filename + a resolved-path containment check — never join a raw pasted name into a
          // filesystem path (a name like "..\\..\\x" would otherwise read a file OUTSIDE the chosen cookies folder).
          const safeName = store.sanitizeName(p.name);
          const candFile = path.join(cookiesDir, safeName + '.json');
          const resolvedDir = path.resolve(cookiesDir) + path.sep;
          let file = null;
          try { if (safeName && path.resolve(candFile).startsWith(resolvedDir) && fs.existsSync(candFile)) file = candFile; } catch {}
          if (file) { let a = JSON.parse(fs.readFileSync(file, 'utf8')); if (a && !Array.isArray(a) && Array.isArray(a.cookies)) a = a.cookies; if (Array.isArray(a)) jar = a; }
        } catch {}
      }
      if (Array.isArray(jar)) {
        const clean = jar.filter((c) => c && typeof c === 'object' && c.name && String(c.name).trim() && c.value != null && String(c.value) !== '');
        if (clean.length) {
          try { store.writeCookies(p.name, clean); cookiesLoaded++; } catch { cookiesWriteFailed++; } // a swallowed writeCookies (ENOSPC / locked .tmp) would strand the account with NO session, invisible in the summary → surface it so the operator can re-import
          // datr = Facebook's DEVICE cookie. A jar with c_user+xs but NO datr logs in but looks like a BRAND-NEW device
          // → far more checkpoints (a top cause of "imported but arrives logged-out / needs re-verify"). Flag thin exports
          // so the operator can re-export the FULL cookie set (incl. datr) before running them.
          const names = new Set(clean.map((c) => String(c.name)));
          if (!names.has('datr')) cookiesNoDatr++;
        } else cookiesMissing++;
      } else if (cookiesDir) cookiesMissing++;
    }
    send('data-updated');
    return ok({ added, skipped, limited, withProxy, withCreds, cookiesLoaded, cookiesMissing, cookiesNoDatr, cookiesWriteFailed });
  } catch (e) { return fail(e); }
});

// Generate the companion extension for THIS install and reveal where to load it. Returns the folder path + how many
// accounts already came in via the bridge, plus the installed-Chrome profile labels (BB24…) for reference.
ipcMain.handle('setup-chrome-import', async () => {
  try {
    const dir = generateChromeImportExtension();
    const data = getData();
    const imported = (data.accounts || []).filter((a) => a.chromeCUser).length;
    return ok({ extensionDir: dir, port: BRIDGE_PORT, imported, tokenStable: BRIDGE_TOKEN_STABLE, profiles: readChromeProfileLabels() });
  } catch (e) { return fail(e); }
});
// Open the generated extension folder in the OS file manager (so the user can drag it into chrome://extensions).
ipcMain.handle('open-chrome-import-folder', async () => {
  try { const dir = path.join(app.getPath('userData'), 'chrome-import-extension'); if (!fs.existsSync(dir)) generateChromeImportExtension(); await shell.openPath(dir); return ok({ dir }); } catch (e) { return fail(e); }
});
// Lightweight status poll for the Import-from-Chrome panel (how many accounts carry a Chrome session).
ipcMain.handle('chrome-import-info', async () => {
  try {
    const data = getData();
    const accts = (data.accounts || []).filter((a) => a.chromeCUser);
    const now = Date.now();
    const health = { healthy: 0, checkpoint: 0, logged_out: 0, unknown: 0 };
    let seenRecently = 0;
    for (const a of accts) {
      // Only count a state as current if beaconed within 24h; a stale reading (Chrome closed) counts as 'unknown', not
      // a false 'healthy', so the summary never gives an outdated all-clear.
      const fresh = a.chromeSeen && (now - a.chromeSeen) < 24 * 3600 * 1000;
      const st = fresh ? ((a.chromeHealth && a.chromeHealth.state) || 'unknown') : 'unknown';
      health[st] = (health[st] || 0) + 1;
      if (fresh) seenRecently++;
    }
    return ok({ imported: accts.length, health, seenRecently, port: BRIDGE_PORT, ready: !!BRIDGE_TOKEN, tokenStable: BRIDGE_TOKEN_STABLE });
  } catch (e) { return fail(e); }
});

// Auto-assign each Chrome-imported account to the target groups the live agent CONFIRMED it's a member of (acc.chromeGroups
// = the intersection of its joined groups with your configured groups). SAFE: mode 'add' only UNIONS (never removes) so a
// best-effort miss can't drop a real group; 'replace' sets exactly the confirmed set. Accounts with no reported groups are
// skipped. This is the "one call to speed the setup" — no per-account manual group picking.
ipcMain.handle('assign-chrome-groups', async (_e, payload) => {
  try {
    const mode = (payload && payload.mode === 'replace') ? 'replace' : 'add';
    const names = (payload && Array.isArray(payload.names) && payload.names.length) ? new Set(payload.names) : null;
    let updated = 0, totalMemberships = 0, skippedNoData = 0;
    await store.update((data) => {
      // Map a reported FB group id (or an internal id) → the app's internal group.id.
      const byId = new Map();
      for (const g of (data.groups || [])) { byId.set(String(g.groupId), g.id); byId.set(String(g.id), g.id); }
      for (const a of (data.accounts || [])) {
        if (a.isModerator) continue;
        if (names && !names.has(a.name)) continue;
        if (!Array.isArray(a.chromeGroups) || !a.chromeGroups.length) { if (a.chromeCUser) skippedNoData++; continue; }
        const confirmed = [...new Set(a.chromeGroups.map((cg) => byId.get(String(cg))).filter(Boolean))];
        if (!confirmed.length) continue;
        const prev = new Set((a.assignedGroups || []).map(String));
        a.assignedGroups = (mode === 'replace') ? confirmed : [...new Set([...(a.assignedGroups || []).map(String), ...confirmed])];
        const changed = mode === 'replace' ? true : a.assignedGroups.some((x) => !prev.has(String(x)));
        if (changed) { updated++; totalMemberships += confirmed.length; }
      }
    });
    send('data-updated');
    return ok({ updated, totalMemberships, skippedNoData });
  } catch (e) { return fail(e); }
});

// Folder picker for the bulk-account cookies (a directory of <account>.json cookie exports).
ipcMain.handle('pick-cookies-folder', async () => {
  try {
    const r = await dialog.showOpenDialog({ title: 'Select the folder with <account>.json cookie files', properties: ['openDirectory'] });
    if (!r || r.canceled || !r.filePaths || !r.filePaths.length) return ok({ canceled: true });
    return ok({ dir: r.filePaths[0] });
  } catch (e) { return fail(e); }
});

// Apply ONE action to MANY accounts atomically (single store.update). action: enable|disable|standby|primary|
// postingOrder|postFilter|proxy|assignGroups|delete. Moderators are never touched. Used by the Accounts-tab bulk-action bar.
ipcMain.handle('batch-account-action', async (_e, payload) => {
  try {
    const { names, action, value } = payload || {};
    if (!Array.isArray(names) || !names.length || !action) return fail('No accounts or action given');
    if (action === 'delete') {
      if (orchestrator && orchestrator.isRunning()) return fail('Stop automation before deleting accounts');
      for (const n of names) if (loginBrowsers.has(n)) return fail(`Close the login browser for "${n}" first`);
    }
    const set = new Set(names);
    let count = 0;
    const deleted = []; // ONLY the accounts actually removed (excludes moderators) — so we never wipe a moderator's profile dir
    await store.update((data) => {
      if (action === 'delete') {
        data.accounts = (data.accounts || []).filter((a) => { if (set.has(a.name) && !a.isModerator) { count++; deleted.push(a.name); return false; } return true; });
        return;
      }
      for (const a of data.accounts || []) {
        if (!set.has(a.name) || a.isModerator) continue;
        if (action === 'enable') a.enabled = true;
        else if (action === 'disable') a.enabled = false;
        else if (action === 'standby') a.standby = true;
        else if (action === 'primary') a.standby = false;
        else if (action === 'postingOrder') a.postingOrder = String(value || 'post-centric');
        else if (action === 'postFilter') a.postFilter = String(value || 'all');
        else if (action === 'proxy') a.proxy = String(value || '').trim();
        else if (action === 'assignGroups') { const gids = ((value && value.groupIds) || []).map(String); a.assignedGroups = (value && value.mode === 'replace') ? gids : [...new Set([...(a.assignedGroups || []).map(String), ...gids])]; } // 'replace' = set exactly the checked groups; 'add' = union with current. IDs stringified to match store normalization.
        else continue;
        count++;
      }
    });
    if (action === 'delete') { for (const n of deleted) { try { fs.rmSync(store.accountDir(n), { recursive: true, force: true }); } catch {} } }
    send('data-updated');
    return ok({ count });
  } catch (e) { return fail(e); }
});

// Enable/disable an account for automation (disabled accounts are skipped by the orchestrator).
ipcMain.handle('toggle-account', async (_e, accountName, enabled) => {
  try {
    const res = await store.update((data) => {
      const a = data.accounts.find((x) => x.name === accountName);
      if (!a) return { _notfound: true };
      a.enabled = enabled === undefined ? a.enabled === false : !!enabled;
      return { enabled: a.enabled };
    });
    if (res && res._notfound) return fail('Account not found');
    send('data-updated'); return ok(res);
  } catch (e) { return fail(e); }
});

ipcMain.handle('delete-account', async (_e, accountName) => {
  try {
    if (orchestrator && orchestrator.isRunning()) return fail('Stop automation before deleting an account');
    if (loginBrowsers.has(accountName)) return fail('Close the login browser for this account first');
    await store.update((data) => { data.accounts = data.accounts.filter((a) => a.name !== accountName); });
    try { fs.rmSync(store.accountDir(accountName), { recursive: true, force: true }); } catch {}
    send('data-updated'); return ok();
  } catch (e) { return fail(e); }
});

ipcMain.handle('set-account-credentials', async (_e, accountName, email, password) => {
  try {
    const res = await store.update((data) => {
      const a = data.accounts.find((x) => x.name === accountName);
      if (!a) return { _notfound: true };
      // M3-01: encrypt credentials at rest (Electron safeStorage / DPAPI). Falls back to plaintext only
      // where OS encryption is unavailable (dev). decrypt() in the worker is transparent.
      a.email = secret.encrypt(email || '');
      // KEEP the existing password when the form left it blank (null/undefined) — re-encrypting '' on every
      // email/alias edit would silently WIPE a saved password. Only overwrite when a value is actually given.
      if (password != null) a.password = secret.encrypt(password);
      return {};
    });
    if (res && res._notfound) return fail('Account not found');
    send('data-updated');
    return ok();
  } catch (e) { return fail(e); }
});

// Decrypted email + whether a password is set, for the edit-account form (local renderer only —
// never returns the password itself). M3-01: credentials are encrypted at rest.
ipcMain.handle('get-account-credentials', (_e, accountName) => {
  const a = getData().accounts.find((x) => x.name === accountName);
  if (!a) return fail('Account not found');
  return ok({ email: secret.decrypt(a.email || ''), hasPassword: !!a.password });
});

ipcMain.handle('rename-account', async (_e, oldName, newName) => {
  try {
    if (orchestrator && orchestrator.isRunning()) return fail('Stop automation before renaming an account');
    if (loginBrowsers.has(oldName)) return fail('Close the login browser for this account first');
    const res = await store.update((data) => {
      const a = data.accounts.find((x) => x.name === oldName);
      if (!a) return { err: 'Account not found' };
      if (data.accounts.some((x) => x.name === newName)) return { err: 'Name already in use' };
      try {
        const from = store.accountDir(oldName), to = path.join(store.paths.ACCOUNTS_DIR, store.sanitizeName(newName));
        if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to);
      } catch (e) { return { err: (e && e.message) || 'rename failed' }; }
      a.name = newName;
      return {};
    });
    if (res && res.err) return fail(res.err);
    send('data-updated'); return ok();
  } catch (e) { return fail(e); }
});

ipcMain.handle('import-cookies', async (_e, accountName, cookies) => {
  try {
    // A3: tolerate JSON string or array; accept common export shapes; filter junk entries
    // instead of rejecting the whole import; log how many were imported.
    let raw;
    if (typeof cookies === 'string') {
      try { raw = JSON.parse(cookies); } catch { return fail('Cookies must be a JSON array'); }
    } else {
      raw = cookies;
    }
    if (!Array.isArray(raw)) return fail('Cookies must be an array');
    // Some exporters wrap in { cookies: [...] } or { cookie: [...] }
    if (!raw.length && raw.cookies) raw = raw.cookies;
    // M3-06: require a non-empty name AND a non-empty value (an empty value is a dead cookie that
    // silently breaks the session) instead of just "has a value key".
    const arr = raw.filter((c) => c && typeof c === 'object' && c.name && String(c.name).trim() && c.value != null && String(c.value) !== '');
    const skipped = raw.length - arr.length;
    if (!arr.length) return fail('No valid cookies found (each entry needs a non-empty name + value)');
    // Facebook needs c_user (account id) + xs (session) to be logged in. Warn if the import lacks
    // them — a top cause of "imported but still logged out".
    const names = new Set(arr.map((c) => String(c.name)));
    const missing = ['c_user', 'xs'].filter((k) => !names.has(k));
    store.writeCookies(accountName, arr);
    console.log(`[import-cookies] ${accountName}: imported ${arr.length}, skipped ${skipped} junk entr${skipped === 1 ? 'y' : 'ies'}${missing.length ? `, MISSING critical cookie(s): ${missing.join(', ')}` : ''}`);
    setAccountStatus(accountName, 'checking', 'Verifying…');
    send('data-updated');
    const status = await checkStatus(accountName);
    setAccountStatus(accountName, status.status, status.message, status);
    const warning = missing.length ? `Imported, but missing ${missing.join(' & ')} — Facebook will treat this account as logged out. Re-export cookies while logged in.`
      : (!names.has('datr') ? `Imported, but missing "datr" (Facebook's device cookie) — the account logs in but looks like a NEW device, which means more checkpoints. Re-export the FULL cookie set (including datr).` : undefined);
    return ok({ status: status.status, message: status.message, imported: arr.length, skipped, warning });
  } catch (e) { return fail(e); }
});

ipcMain.handle('check-account-status', async (_e, accountName) => {
  setAccountStatus(accountName, 'checking', 'Verifying…');
  send('data-updated');
  const res = await checkStatus(accountName);
  setAccountStatus(accountName, res.status, res.message, res);
  return res;
});

ipcMain.handle('login-account', async (_e, accountName) => {
  try { await openLoginBrowser(accountName); return ok(); }
  catch (e) { return fail(e); }
});

ipcMain.handle('close-login-browser', (_e, accountName) => {
  closeLoginBrowser(accountName); return ok();
});

// Launch a headless browser with the account's cookies/profile and see if FB
// considers it logged in. Primary auth gate is the c_user cookie; DOM probe is
// used only for picker/checkpoint detection.
async function checkStatus(accountName) {
  let browser;
  try {
    store.sanitizeProfile(accountName, false); // headless probe; clear any off-screen bounds so a later login is visible
    browser = await puppeteer.launch({
      headless: true, userDataDir: store.profileDir(accountName),
      executablePath: chromiumPath(),
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
    });
    const allPages = await browser.pages();
    for (let i = 1; i < allPages.length; i++) { try { await allPages[i].close(); } catch {} }
    const page = allPages[0] || (await browser.newPage());
    const cookies = store.readCookies(accountName);
    // A2: resilient injection — try batch first, fall back to one-by-one so one bad
    // cookie can't prevent ALL cookies from being set.
    if (cookies.length) {
      const normalized = cookies.map(normalizeCookie);
      try {
        await page.setCookie(...normalized);
      } catch {
        for (const ck of normalized) { try { await page.setCookie(ck); } catch {} }
      }
    }
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Fix #2: real render wait instead of fixed 3s
    await page.waitForSelector('[role="navigation"], [data-pagelet="FeedUnit_0"], [aria-label="Your profile"]', { timeout: 12000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));

    if (/login|checkpoint/.test(page.url())) return { status: 'not_logged_in', message: 'Redirected to login/checkpoint' };

    // Fix #1: gate on c_user cookie as PRIMARY auth check
    const pageCookies = await page.cookies();
    const cUser = pageCookies.find((c) => c.name === 'c_user' && c.value);
    if (!cUser) return { status: 'not_logged_in', message: 'No c_user cookie — not authenticated' };

    // Still detect picker/checkpoint even when c_user present (stale session edge case)
    const probe = await page.evaluate(() => {
      const t = (document.body.innerText || '');
      const picker = /continue as|use another profile|log into facebook/i.test(t)
        || !!Array.from(document.querySelectorAll('a,div[role="button"],button')).find((e) => /^continue$|continue as|use another profile/i.test((e.textContent || '').trim()));
      const checkpoint = /checkpoint/.test(location.href);
      return { picker, checkpoint };
    });
    if (probe.checkpoint) return { status: 'not_logged_in', message: 'Session expired — checkpoint' };
    if (probe.picker) return { status: 'not_logged_in', message: 'Session expired — re-login required (account picker shown)' };

    // Fix #3: capture FB display name
    const fbUserId = cUser.value;
    const fbName = await page.evaluate(() => {
      const e = document.querySelector('[aria-label="Your profile"]');
      return e ? (e.textContent || '').trim().slice(0, 40) : '';
    }).catch(() => '');
    return { status: 'logged_in', message: `Active — c_user=${fbUserId}${fbName ? ' (' + fbName + ')' : ''}`, fbUserId, fbName };
  } catch (e) {
    return { status: 'error', message: e.message };
  } finally { if (browser) await browser.close().catch(() => {}); }
}

// Fix #3: accept full result object to persist fbUserId, fbName, lastChecked.
// Backward-compatible: extra arg is optional.
function setAccountStatus(name, status, message, result) {
  // Serialized via store.update so account-status writes (which fire constantly during a
  // run) can't clobber the orchestrator's concurrent post/auto-delete writes.
  store.update((data) => {
    const a = data.accounts.find((x) => x.name === name);
    if (!a) return;
    // M2-02: a concurrent check-account-status must not downgrade a still-active rate-limit /
    // checkpoint / verification / disabled flag the run just set (a headless cookie probe reads
    // "logged_in" even for an account that's blocked from POSTING). Keep the flag; still refresh
    // the identity fields below.
    if (!store.preserveAttentionStatus(a.status, a.rateLimitedUntil, status)) {
      a.status = status; a.lastMessage = message || '';
    }
    if (result && result.fbUserId) a.fbUserId = result.fbUserId;
    if (result && result.fbName !== undefined) a.fbName = result.fbName;
    if (result && result.status === 'logged_in') a.lastChecked = Date.now();
    // Opportunistically prune any assignedGroups that no longer exist in data.groups.
    const valid = new Set(data.groups.map((g) => g.id));
    a.assignedGroups = (a.assignedGroups || []).filter((id) => valid.has(id));
    // (data-updated is emitted only after a SUCCESSFUL write below — never on a failed write,
    // so the UI can't show a status the disk never persisted.)
  }).then(() => send('data-updated')).catch((e) => { try { console.error('[setAccountStatus] persist failed for', name, '-', (e && e.message) || e); } catch {} });
}

function clearInterruptedLoginStates() {
  const data = getData();
  let changed = false;
  for (const account of data.accounts || []) {
    if (account.status !== 'logging_in') continue;
    const cUser = store.readCookies(account.name).find((c) => c.name === 'c_user' && c.value);
    if (cUser) {
      account.status = 'logged_in';
      account.lastMessage = `Active - c_user=${cUser.value}`;
      account.fbUserId = cUser.value;
      account.lastChecked = Date.now();
    } else {
      account.status = 'not_logged_in';
      account.lastMessage = 'Login window was interrupted - check status or log in again';
    }
    changed = true;
  }
  if (changed) store.save(data);
}

// Open a VISIBLE browser for manual login; persist cookies while open; notify on close.
async function openLoginBrowser(accountName, opts = {}) {
  // opts.mode: 'login' (default — open FB /login for MANUAL sign-in), 'browse' (open the FB feed so the operator can
  // re-join a group / fix a held post AS this account), or 'autologin' (open /login + human-like credentialLogin fill;
  // on captcha/2FA/failure the visible window just stays open to finish manually). All modes share the SAME battle-
  // tested loginBrowsers map + cookie-save-on-close + status-verify, so session handling is identical + safe.
  // Fix #6: already open guard
  if (loginBrowsers.has(accountName)) {
    // A window is already open for this account (one profile/session at a time). If the operator asked for a specific
    // group, navigate the EXISTING window there + bring it to front (so "open a group" still works); else just surface it.
    try {
      const _ent = loginBrowsers.get(accountName);
      const _p = _ent && _ent.browser && (await _ent.browser.pages())[0];
      if (_p) { if (opts.mode === 'browse' && opts.gotoUrl) await _p.goto(String(opts.gotoUrl), { waitUntil: 'domcontentloaded' }).catch(() => {}); await _p.bringToFront().catch(() => {}); }
    } catch {}
    emit('automation-log', `🔐 [${accountName}] browser already open — ${(opts.mode === 'browse' && opts.gotoUrl) ? 'navigated it to the group' : 'brought it to front'}`);
    return;
  }

  // Fix #4: block login if automation is using this profile
  if (orchestrator && orchestrator.isRunning()) {
    emit('automation-log', `🔐 [${accountName}] cannot open login — automation is using this profile; stop automation first`);
    return;
  }

  emit('automation-log', `🔐 [${accountName}] opening login browser...`);

  store.sanitizeProfile(accountName, false); // wipe saved tabs + clear off-screen bounds so the login window is VISIBLE
  // Route this browser through the ACCOUNT'S OWN PROXY + apply its geo, exactly like the posting browser. Otherwise a
  // (say) US account browsed from the host's real FOREIGN IP is precisely what triggers Google/FB "unusual location"
  // robot-captcha + checkpoints. launchStealth also drops --enable-automation + adds the WebRTC IP-leak guard (BASE_ARGS).
  const _d = getData();
  const _acct = (_d.accounts || []).find((a) => a.name === accountName) || { name: accountName };
  const _useProxies = !!_d.useProxies, _proxies = _d.proxies || [];
  let _proxyArg = '', _anonLocal = null, _proxyAuth = null;
  try {
    const { parseProxy } = require('./automation/worker');
    let pstr = (_acct.proxy && String(_acct.proxy).trim()) || '';
    if (!pstr && _useProxies && _proxies.length) { let h = 0; for (let i = 0; i < accountName.length; i++) h = (h * 31 + accountName.charCodeAt(i)) >>> 0; pstr = _proxies[h % _proxies.length]; } // same stable pool pick as the worker
    if (pstr) {
      const pp = parseProxy(pstr);
      if (pp) {
        if (pp.username && proxyChain) { _anonLocal = await proxyChain.anonymizeProxy(pp.upstream).catch(() => null); if (_anonLocal) _proxyArg = `--proxy-server=${_anonLocal}`; else { _proxyArg = `--proxy-server=${pp.server}`; _proxyAuth = pp; } }
        else { _proxyArg = `--proxy-server=${pp.server}`; if (pp.username) _proxyAuth = pp; }
      }
    }
  } catch (e) { emit('automation-log', `🔐 [${accountName}] proxy setup skipped: ${(e && e.message) || e}`); }
  emit('automation-log', _proxyArg ? `🔐 [${accountName}] browser routed through the account's proxy (same IP as posting — avoids an "unusual location" captcha)` : `🔐 [${accountName}] no proxy for this account — browser uses the real host IP`);
  const _vp = viewportFor(accountName);
  // F1: free the proxy-chain tunnel if the LAUNCH (or page setup) throws — otherwise it is ONLY freed in the disconnected
  // handler, which isn't registered until after a successful launch, so a failed launch (locked profile / Chrome start
  // failure / bad --proxy-server) on a PROXIED account leaks a port + child process on every retry.
  let browser, page;
  try {
    browser = await launchStealth({
      headless: false, userDataDir: store.profileDir(accountName),
      defaultViewport: null, // a real visible window — the viewport tracks the actual window size
      // F4: NO --no-sandbox — match the POSTING browser exactly (BASE_ARGS omits it on purpose; running with it is an
      // automation-correlated tell, and the whole point of this proxied browse is to look identical to when it posts).
      args: [`--window-size=${_vp.width},${_vp.height}`, ...(_proxyArg ? [_proxyArg] : [])],
    });
    const pages = await browser.pages();
    for (let i = 1; i < pages.length; i++) { try { await pages[i].close(); } catch {} } // keep exactly one tab
    page = pages[0] || (await browser.newPage());
    if (_proxyAuth && _proxyAuth.username) { try { await page.authenticate({ username: _proxyAuth.username, password: _proxyAuth.password || '' }); } catch {} } // HTTP-proxy auth when not proxy-chain-wrapped
    // F3: only override tz/locale when a proxy is ACTUALLY active. If a configured proxy failed to parse, _proxyArg is ''
    // and the browser is on the REAL host IP — faking a proxy-region clock there is the incoherent context we want to AVOID.
    if (_proxyArg) { try { await applyProxyGeo(page, _acct, _d.settings || {}, _useProxies, _proxies, (m) => emit('automation-log', `🔐 [${accountName}] ${m}`)); } catch {} }
  } catch (e) {
    if (_anonLocal && proxyChain) { try { await Promise.race([proxyChain.closeAnonymizedProxy(_anonLocal, true).catch(() => {}), new Promise((r) => setTimeout(r, 8000))]); } catch {} } // free the tunnel a failed launch would otherwise leak
    throw e;
  }

  // Auto-capture the email/phone + password the user types during manual login. FB's login
  // box accepts a phone number too, so this works either way. Only SAVED on a successful
  // login (in the disconnected handler) so the credential-login fallback can reuse it.
  const captured = { id: '', pass: '' };
  try {
    await page.exposeFunction('__zaCaptureCreds', (id, pass) => { if (id) captured.id = String(id); if (pass) captured.pass = String(pass); });
    await page.evaluateOnNewDocument(() => {
      const grab = () => {
        const em = document.querySelector('input[name="email"], #email');
        const pw = document.querySelector('input[name="pass"], #pass');
        if (em && pw && em.value && pw.value && window.__zaCaptureCreds) { try { window.__zaCaptureCreds(em.value, pw.value); } catch (e) {} }
      };
      document.addEventListener('submit', grab, true);
      document.addEventListener('click', (e) => { try { if (e.target.closest('button[name="login"], [data-testid="royal_login_button"], button[type="submit"]')) grab(); } catch (er) {} }, true);
      document.addEventListener('keydown', (e) => { if (e.key === 'Enter') grab(); }, true);
    });
  } catch {}

  // opts.gotoUrl (built + sanitized in the handler) lets 'browse' land on a specific FB group so the operator can confirm
  // membership / re-join AS this account, through its proxy. Gated on mode==='browse' so it can never redirect login/autologin.
  const _navUrl = (opts.mode === 'browse' && opts.gotoUrl) ? String(opts.gotoUrl) : (opts.mode === 'browse' ? 'https://www.facebook.com/' : 'https://www.facebook.com/login');
  await page.goto(_navUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  emit('automation-log', `🔐 [${accountName}] navigated to ${page.url()} — ${opts.mode === 'browse' ? 'browse as this account (re-join a group / fix a held post), then close when done' : 'waiting for you to log in'}`);
  // AUTO-LOGIN mode (the Check button on a logged-out account WITH stored creds): fill the FB form human-like via the
  // worker's credentialLogin. On a captcha/2FA or ANY failure it just leaves the visible window open to finish by hand
  // (same end-state as manual login) — it never throws out of here.
  if (opts.mode === 'autologin') {
    try {
      const acc = getData().accounts.find((a) => a.name === accountName);
      const em = secret.decrypt((acc && acc.email) || ''); const pw = secret.decrypt((acc && acc.password) || '');
      if (em && pw) {
        const { credentialLogin } = require('./automation/worker');
        emit('automation-log', `🤖 [${accountName}] attempting human-like auto-login…`);
        await credentialLogin(page, em, pw, (m) => emit('automation-log', `🔐 [${accountName}] ${m}`), accountName)
          .catch((e) => emit('automation-log', `🔐 [${accountName}] auto-login could not complete (${(e && e.message) || e}) — finish in the open window`));
      } else {
        emit('automation-log', `🔐 [${accountName}] no stored credentials — log in manually in the open window`);
      }
    } catch (e) { emit('automation-log', `🔐 [${accountName}] auto-login error: ${(e && e.message) || e}`); }
  }

  // Fix #7: set logging_in intermediate status
  setAccountStatus(accountName, 'logging_in', 'Login window open — waiting for manual login');

  send('login-browser-opened', accountName);

  let sessionDetectedLogged = false; // Fix #6: emit c_user detection only once

  // A LIVE session = both c_user AND xs present. writeCookies is a FULL overwrite, so persisting a login-wall /
  // soft-logout jar (missing c_user/xs) would DESTROY the account's last-good recovery jar → next run's Tier-2 cookie
  // recovery fails and the account is stranded needs_login with no auto-recovery. Only ever persist a live jar here.
  const _liveJar = (jar) => Array.isArray(jar) && jar.some((c) => c.name === 'c_user' && c.value) && jar.some((c) => c.name === 'xs' && c.value);

  // Flush cookies on page close — but ONLY if the session is live (see above).
  page.on('close', async () => {
    try { const jar = await page.cookies(); if (_liveJar(jar)) store.writeCookies(accountName, jar); } catch {}
  });

  const interval = setInterval(async () => {
    try {
      const pageCookies = await page.cookies();
      if (_liveJar(pageCookies)) store.writeCookies(accountName, pageCookies); // never overwrite the good jar with a logged-out one
      // Fix #6: emit once when c_user first appears
      if (!sessionDetectedLogged) {
        const cUser = pageCookies.find((c) => c.name === 'c_user' && c.value);
        if (cUser) {
          sessionDetectedLogged = true;
          emit('automation-log', `🔑 [${accountName}] session detected (c_user=${cUser.value}) — keep going / you can close when done`);
        }
      }
    } catch {}
  }, 5000);
  loginBrowsers.set(accountName, { browser, interval });

  browser.on('disconnected', async () => {
    // B6: wrap entire handler so a checkStatus failure can't crash the main process
    // or leave the account stuck on 'logging_in'.
    try {
      clearInterval(interval);
      loginBrowsers.delete(accountName);
      if (_anonLocal && proxyChain) { try { await Promise.race([proxyChain.closeAnonymizedProxy(_anonLocal, true).catch(() => {}), new Promise((r) => setTimeout(r, 8000))]); } catch {} } // free the local proxy tunnel (bounded)
      emit('automation-log', `🔐 [${accountName}] login window closed — verifying session...`);
      send('login-browser-closed', accountName);
      const res = await checkStatus(accountName);
      setAccountStatus(accountName, res.status, res.message, res);
      if (res.status === 'logged_in') {
        // Auto-capture: persist the credentials the user typed so auto-login can reuse them.
        if (captured.id && captured.pass) {
          try {
            const d = getData(); const acc = d.accounts.find((a) => a.name === accountName);
            if (acc) { acc.email = secret.encrypt(captured.id); acc.password = secret.encrypt(captured.pass); store.save(d); send('data-updated'); emit('automation-log', `🔑 [${accountName}] login credentials saved ${secret.available() ? '(encrypted)' : '(⚠️ OS encryption unavailable — stored as PLAINTEXT in data.json)'} for auto-login`); }
          } catch {}
        }
        emit('automation-log', `✅ [${accountName}] logged in as ${res.fbName || '(unknown)'} (c_user=${res.fbUserId || '?'})`);
      } else {
        emit('automation-log', `❌ [${accountName}] not logged in: ${res.message}`);
      }
    } catch (e) {
      console.error(`[disconnected] [${accountName}] verification error:`, e.message);
      // Ensure status is never left as 'logging_in' even if checkStatus threw.
      setAccountStatus(accountName, 'error', `Verification failed: ${e.message}`);
    }
  });
}

// Close a manual-login browser (used by the remote dashboard / programmatic close).
async function closeLoginBrowser(accountName) {
  const entry = loginBrowsers.get(accountName);
  if (entry) { try { await entry.browser.close(); } catch {} }
}

// =======================================================================
// IPC: AUTOMATION
// =======================================================================
ipcMain.handle('start-automation', async () => {
  try {
    if (_licenseState && _licenseState.enforced && !_licenseState.valid) return fail('License not active — activate the app before posting.'); // defense-in-depth: match the remote onStart gate (the license window normally withholds the UI, but never let posting start on an invalid enforced build)
    // The operator clicking Start (or Save & Start) means RUN NOW — always. This handler previously dropped the
    // renderer's runNow arg AND the dashboard Start deliberately passed false, so a manual Start silently fell through
    // to the daily schedule and slept until the next fire time (the "next run in 1439m" the operator hit). A manual
    // Start is a fresh operator-initiated run → `manual` resets the day's cycle counter + bypasses the per-account
    // pacing quota so it posts now instead of "running but posting nothing". The daily time still drives the UNATTENDED
    // next-day auto-start (the scheduled-task path calls start with runNow but WITHOUT manual → it respects the quota).
    const r = await orchestrator.start(getData, { runNow: true, manual: true });
    if (r && r.success !== false) setRunActive(true);
    return r;
  } catch (e) { return fail(e); }
});
ipcMain.handle('stop-automation', () => {
  if (!orchestrator.isRunning()) return fail('Automation is not running');
  orchestrator.stop();
  setRunActive(false); // explicit Stop clears the flag — no auto-resume on next launch
  return ok();
});
// RDP/unattended: report whether the keepalive scheduled task is installed and whether the app is being
// viewed over Remote Desktop right now — so the renderer can remind the operator to run the one-time setup
// (a fresh laptop would otherwise silently miss it → a run stalls the first time they disconnect).
function _runQuick(cmd, args) {
  return new Promise((resolve) => {
    try { execFile(cmd, args, { timeout: 5000, windowsHide: true }, (err, stdout) => resolve({ code: err ? (err.code != null ? err.code : 1) : 0, out: String(stdout || '') })); }
    catch { resolve({ code: 1, out: '' }); }
  });
}
// DAILY AUTO-START (Windows Task Scheduler): the Settings / Quick-Setup "auto-start daily" toggle arms a DAILY task that
// launches the app WITH --autostart at dailyPostTime, so the day's campaign runs even if the app was closed overnight.
// The boot hook (in app.whenReady) starts the orchestrator ONLY on that flagged launch — a manual launch never auto-posts,
// and a task launch while the app is already open is a no-op (single-instance lock quits it), so it can't double-post.
const _AUTOSTART_TN = 'ZaPost Daily Autostart';
ipcMain.handle('set-autostart', async (_e, opts = {}) => {
  if (process.platform !== 'win32') return fail('Daily auto-start is Windows-only.');
  try {
    if (opts && opts.enabled) {
      const t = /^([01]?\d|2[0-3]):([0-5]\d)$/.test(String(opts.time || '')) ? opts.time : '09:00';
      const r = await _runQuick('schtasks', ['/Create', '/F', '/SC', 'DAILY', '/TN', _AUTOSTART_TN, '/ST', t, '/TR', `"${process.execPath}" --autostart`]);
      return r.code === 0 ? ok() : fail(`scheduled-task create failed (schtasks exit ${r.code})${r.out ? ': ' + r.out.slice(0, 160) : ''}`);
    }
    await _runQuick('schtasks', ['/Delete', '/F', '/TN', _AUTOSTART_TN]); // disabling: remove the task (idempotent — a missing task is fine)
    return ok();
  } catch (e) { return fail(e); }
});
ipcMain.handle('get-autostart-status', async () => {
  if (process.platform !== 'win32') return ok({ registered: false });
  try { const r = await _runQuick('schtasks', ['/Query', '/TN', _AUTOSTART_TN]); return ok({ registered: r.code === 0 }); }
  catch { return ok({ registered: false }); }
});
function _rdpSetupDir() { return app.isPackaged ? path.join(process.resourcesPath, 'rdp-setup') : path.join(__dirname, 'scripts'); }
ipcMain.handle('rdp-status', async () => {
  if (process.platform !== 'win32') return { supported: false, keepaliveInstalled: true, remoteSession: false };
  let keepaliveInstalled = false, remoteSession = false;
  try { const r = await _runQuick('schtasks', ['/Query', '/TN', 'ZaPost RDP Keepalive']); keepaliveInstalled = r.code === 0; } catch {}
  try { const q = await _runQuick('qwinsta', []); remoteSession = /rdp-tcp#\d/i.test(q.out); } catch {}
  if (!remoteSession) remoteSession = /^rdp-/i.test(process.env.SESSIONNAME || ''); // fallback for an app launched within an RDP session
  return { supported: true, keepaliveInstalled, remoteSession };
});
// Open the folder with the one-time keepalive setup script (selected), so the operator can run it as admin.
ipcMain.handle('open-rdp-setup', async () => {
  try {
    const dir = _rdpSetupDir();
    const setup = path.join(dir, 'rdp-keepalive-setup.ps1');
    if (fs.existsSync(setup)) shell.showItemInFolder(setup);
    else await shell.openPath(dir);
    return ok();
  } catch (e) { return fail(e); }
});
// F4: clear the dealt-state/rotation so the next Start re-deals every post from #1 (guarded to stopped).
ipcMain.handle('reset-rotation', () => {
  try { return orchestrator.resetRotation(); } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
});
// On-demand moderator approval — approve held "Spam potentiel" posts now (stop → approve → continue).
ipcMain.handle('approve-held-now', async () => {
  try { return await orchestrator.approveHeldNow(getData()); } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
});
ipcMain.handle('pause-automation', () => {
  if (!orchestrator) return fail('Orchestrator not ready');
  if (!orchestrator.isRunning()) return fail('Automation is not running');
  userPauseActions++; // record user intent so a system resume won't override it
  orchestrator.pause(); return ok();
});
ipcMain.handle('resume-automation', () => {
  if (!orchestrator) return fail('Orchestrator not ready');
  if (!orchestrator.isRunning()) return fail('Automation is not running');
  if (!orchestrator.isPaused()) return fail('Automation is not paused');
  userPauseActions++; // record user intent so a system resume won't override it
  orchestrator.resume(); return ok();
});
ipcMain.handle('finish-automation', () => {
  if (!orchestrator) return fail('Orchestrator not ready');
  if (!orchestrator.isRunning()) return fail('Automation is not running');
  orchestrator.finish();
  setRunActive(false); // finish requested — clear flag so no resume on next launch
  return ok();
});
ipcMain.handle('get-automation-status', () => ok({ isRunning: orchestrator.isRunning(), isPaused: orchestrator.isPaused() }));

// DASHBOARD reads — bridged + called by the renderer but had NO handler (the dashboard plan / warm-up / proxy-health
// panels silently showed nothing). get-plan builds the normalized campaign plan in the MAIN process from persisted state.
ipcMain.handle('get-plan', () => {
  try {
    const { buildPlan } = require('./lib/plan');
    const d = getData();
    const plan = buildPlan({ posts: d.posts, accounts: d.accounts, groups: d.groups, settings: d.settings, rotation: store.loadRotation(), progress: store.loadProgress() });
    return ok({ data: plan });
  } catch (e) { return fail(e); }
});
ipcMain.handle('get-warmup-counts', () => {
  try {
    const out = {};
    for (const a of (getData().accounts || [])) if (a && a.name) { try { out[a.name] = store.loadRunCount(a.name); } catch { out[a.name] = 0; } }
    return ok({ data: out });
  } catch (e) { return fail(e); }
});
// Returned RAW (the renderer reads r.proxies directly, not r.data). getProxyHealth is already fail-safe (returns an empty shape on error).
ipcMain.handle('get-proxy-health', () => { try { return orchestrator.getProxyHealth(); } catch { return { proxies: [], summary: { total: 0, healthy: 0, failing: 0, onCooldown: 0 } }; } });

// OPEN the account's own browser: 'browse' = re-join a group / fix a held post AS this account (the Accounts-tab
// "Open Facebook…" button); 'autologin' = the Check button's human-like auto-login for a logged-out account with
// stored creds. Both were bridged + called but had NO handler (the button/Check silently errored). They reuse
// openLoginBrowser, so the login-browser guard (stop automation first) + cookie-save-on-close apply identically.
ipcMain.handle('open-account-browser', async (_e, accountName, groupId) => {
  // Optional groupId opens THAT FB group AS this account (confirm membership / re-join through its proxy). The URL is
  // built + sanitized HERE (single source of truth) so the renderer can only ever reach facebook.com/groups/<id> — never
  // an arbitrary-origin navigation of the account browser. No groupId → the plain feed (backward compatible).
  try {
    const raw = groupId != null ? String(groupId).trim() : '';
    const gid = raw.replace(/[^A-Za-z0-9._-]/g, ''); // digits OR a vanity slug only — strips slashes/protocol/query (no path/origin break-out)
    const gotoUrl = gid ? `https://www.facebook.com/groups/${encodeURIComponent(gid)}` : undefined;
    await openLoginBrowser(accountName, { mode: 'browse', gotoUrl });
    return ok();
  } catch (e) { return fail(e); }
});
ipcMain.handle('auto-login-account', async (_e, accountName) => {
  try { await openLoginBrowser(accountName, { mode: 'autologin' }); return ok(); }
  catch (e) { return fail(e); }
});

// =======================================================================
// IPC: SETTINGS / PROXIES / FILES / LICENSE
// =======================================================================
// Coerce + clamp numeric settings to sane ranges. Defense-in-depth: the UI guards on
// save, but the remote HTTP path (or a hand-edited data.json) could inject a 0/NaN/negative
// delay — a 0 inter-group/cycle delay hammers Facebook and gets accounts locked.
// Settings clamping now lives in lib/store.js (unit-tested, single source of truth). Kept as a thin
// hoisted wrapper so existing call sites are unchanged.
function clampSettings(s) { return store.clampSettings(s); }

ipcMain.handle('save-settings', async (_e, settings) => {
  try {
    const clean = clampSettings(settings);
    const merged = await store.update((data) => {
      data.settings = { ...store.DEFAULT_SETTINGS, ...data.settings, ...clean };
      return data.settings;
    });
    // Apply launchOnStartup immediately so toggling it takes effect without a restart.
    try { app.setLoginItemSettings({ openAtLogin: !!merged.launchOnStartup }); } catch {}
    // Apply the remote-access tunnel toggle live (start/stop without a restart).
    applyTunnelState(!!merged.enableTunnel);
    return ok();
  } catch (e) { return fail(e); }
});

ipcMain.handle('get-proxies', () => {
  const data = getData();
  return ok({ useProxies: !!data.useProxies, proxies: data.proxies || [] });
});
ipcMain.handle('save-proxies', async (_e, proxies) => {
  try {
    await store.update((d) => { d.proxies = Array.isArray(proxies) ? proxies : []; });
    _detectProxyGeo(true).catch(() => {}); // AUTO: learn the geo of any NEWLY-added proxy in the background (non-blocking — undetected only)
    return ok();
  } catch (e) { return fail(e); }
});
ipcMain.handle('toggle-proxies', async (_e, enabled) => {
  try { await store.update((d) => { d.useProxies = !!enabled; }); return ok(); }
  catch (e) { return fail(e); }
});

// AUTO-DETECT PROXY GEO — route a lookup THROUGH each proxy (pool + per-account) to learn its region, then set each
// account's timezone/locale from ITS OWN proxy, plus the global proxyTimezone/proxyLocale when the whole pool is one
// region. onlyUndetected=true (used on save-proxies) skips proxies already in settings.proxyGeo so re-saves stay cheap.
async function _detectProxyGeo(onlyUndetected) {
  const { detectProxyGeo } = require('./lib/geo');
  const d = getData();
  const known = (d.settings && d.settings.proxyGeo) || {};
  const uniq = new Set();
  for (const p of (d.proxies || [])) if (p && String(p).trim()) uniq.add(String(p).trim());
  for (const a of (d.accounts || [])) if (a && a.proxy && String(a.proxy).trim()) uniq.add(String(a.proxy).trim());
  const targets = [...uniq].filter((px) => !onlyUndetected || !known[px]);
  const geoMap = {}; const results = [];
  for (const px of targets) {
    const g = await detectProxyGeo(px);
    if (g.ok) { geoMap[px] = { timezone: g.timezone, locale: g.locale, countryCode: g.countryCode }; results.push({ proxy: px, ok: true, ...geoMap[px], ip: g.ip }); emit('automation-log', `🌍 proxy ${g.ip || ''} → ${g.timezone} / ${g.locale}`); }
    else { results.push({ proxy: px, ok: false, error: g.error }); emit('automation-log', `⚠️ proxy geo lookup failed: ${g.error}`); }
  }
  let applied = 0;
  if (Object.keys(geoMap).length) {
    await store.update((data) => {
      data.settings = data.settings || {};
      data.settings.proxyGeo = { ...(data.settings.proxyGeo || {}), ...geoMap };
      for (const a of data.accounts) { const px = a.proxy && String(a.proxy).trim(); if (px && data.settings.proxyGeo[px]) { a.timezone = data.settings.proxyGeo[px].timezone; a.locale = data.settings.proxyGeo[px].locale; applied++; } }
      // Whole pool is ONE region → also set the GLOBAL fallback (covers pool accounts with no own proxy + fills the Settings fields).
      const all = Object.values(data.settings.proxyGeo);
      if (all.length && new Set(all.map((x) => x.timezone)).size === 1) { data.settings.proxyTimezone = all[0].timezone; data.settings.proxyLocale = all[0].locale; }
    });
    send('data-updated');
  }
  return { results, applied, detected: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}
ipcMain.handle('detect-proxy-geo', async () => { try { return ok(await _detectProxyGeo(false)); } catch (e) { return fail(e); } });

ipcMain.handle('select-image', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'], filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }],
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

// ---- License enforcement state (M1-05) ----------------------------------------------------------
// The single source of truth the create handlers enforce against. When the license gate is OFF
// (owner/dev), the app runs unlimited. When ON, this holds the validated tier's limits. UI checks
// are advisory only — THIS is what actually blocks over-limit creates, including a direct IPC call.
let _licenseState = { valid: true, enforced: false, tier: 'owner', limits: { maxAccounts: Infinity, maxGroups: Infinity } };
function setLicenseState(r, enforced) {
  _licenseState = {
    valid: !!(r && r.valid),
    enforced: !!enforced,
    tier: (r && r.tier) || (enforced ? 'standard' : 'owner'),
    limits: license.limitsOf(r),
    expiry: (r && (r.expires || r.expiry)) || null, // carry the validated expiry so the UI can show "Valid Until"
  };
}
// Re-read the license cache, retrying through a TRANSIENT `unreadable` result — an AV/OneDrive/indexer briefly
// share-locking license.json (very common right after launch while the data folder is scanned), or the app's own
// writeCache .tmp→rename window. lib/license.js splits ENOENT (genuinely not activated → {valid:false}) from a
// locked-but-present file ({valid:false, unreadable:true}); only the former should ever gate a paying customer.
// Returns the first READABLE result, or the last unreadable one if it never cleared within the retry budget.
async function checkCachedResilient(tries = 6, backoffMs = 400) {
  let r = await license.checkCached(app.getPath('userData'), licenseServerUrl());
  for (let i = 0; i < tries && r && r.unreadable; i++) {
    await new Promise((res) => setTimeout(res, backoffMs));
    r = await license.checkCached(app.getPath('userData'), licenseServerUrl());
  }
  return r;
}
// One-shot re-check after a PROVISIONAL boot (license.json stayed locked through the launch retries). It confirms or
// locks the moment the file becomes readable, and keeps waiting while it stays locked — bounding the provisional
// (unverified) window instead of trusting it until the 6h re-validation.
let _licenseRecheckTimer = null;
function scheduleLicenseRecheck(delayMs) {
  try { if (_licenseRecheckTimer) clearTimeout(_licenseRecheckTimer); } catch {}
  _licenseRecheckTimer = setTimeout(async () => {
    try {
      const rr = await license.checkCached(app.getPath('userData'), licenseServerUrl());
      if (rr && rr.unreadable) { scheduleLicenseRecheck(120000); return; } // still locked — stay provisional, retry in 2 min
      setLicenseState(rr, true);
      try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('license-updated'); } catch {}
      if (!rr.valid) {
        try { if (orchestrator.isRunning()) { orchestrator.stop(); setRunActive(false); } } catch {}
        try { if (rr.revoked) showRevokedWindow(); else showLicenseWindow(); } catch {}
      }
    } catch {}
  }, delayMs);
}
// Returns a fail() result if creating `add` more of `kind` ('accounts'|'groups') would exceed the
// license limit; null if allowed. Enforced ONLY when the license gate is on (owner/dev = unlimited).
function overLimit(kind, currentCount, add = 1) {
  if (!_licenseState.enforced) return null;
  if (!_licenseState.valid) return fail('Your license is not active — restart and re-validate before adding accounts or groups.');
  const limit = kind === 'accounts' ? _licenseState.limits.maxAccounts : _licenseState.limits.maxGroups;
  if (!Number.isFinite(limit)) return null;
  if (currentCount + add > limit) return fail(`License limit reached: your ${_licenseState.tier} plan allows ${limit} ${kind} (you have ${currentCount}). Upgrade your plan to add more.`);
  return null;
}

// Real license info for the renderer (replaces the old permissive 9999 stub). Reflects the actual
// validated tier + limits; Infinity is surfaced as 9999 so the UI shows a number.
ipcMain.handle('get-license-info', () => {
  const L = _licenseState;
  const toN = (v) => (Number.isFinite(v) ? v : 9999);
  return { valid: L.valid, enforced: L.enforced, tier: L.tier, lifetime: !L.enforced && !L.expiry, expiry: L.expiry || null, maxAccounts: toN(L.limits.maxAccounts), maxGroups: toN(L.limits.maxGroups) };
});
ipcMain.handle('get-remote-url', () => tunnelUrl || '');
ipcMain.handle('open-logs-folder', () => {
  try { shell.openPath(LOG_DIR || app.getPath('userData')); return ok(); } catch (e) { return fail(e); }
});
ipcMain.on('validate-license-async', async (e, key) => {
  try {
    const r = await license.activate(app.getPath('userData'), key, licenseServerUrl());
    setLicenseState(r, true); // adopt the newly-validated tier's limits for enforcement
    if (r.valid) {
      e.sender.send('license-validation-result', { valid: true });
      if (licenseWindow) { licenseWindow.close(); licenseWindow = null; }
      if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    } else if (r.revoked) {
      e.sender.send('license-validation-result', { valid: false, message: r.message });
      if (licenseWindow) { licenseWindow.close(); licenseWindow = null; }
      showRevokedWindow();
    } else {
      e.sender.send('license-validation-result', { valid: false, message: r.message });
    }
  } catch (err) { e.sender.send('license-validation-result', { valid: false, message: err.message }); }
});
ipcMain.on('retry-license', () => {
  if (revokedWindow) { revokedWindow.close(); revokedWindow = null; }
  showLicenseWindow();
});

// License server URL config (used by the license screen if shown). Stored locally.
function licenseCfgPath() { return path.join(app.getPath('userData'), 'license-config.json'); }
function licenseServerUrl() { try { return JSON.parse(fs.readFileSync(licenseCfgPath(), 'utf8')).serverUrl || license.DEFAULT_SERVER; } catch { return license.DEFAULT_SERVER; } }
ipcMain.handle('get-server-url', () => { try { return JSON.parse(fs.readFileSync(licenseCfgPath(), 'utf8')).serverUrl || ''; } catch { return ''; } });
ipcMain.handle('update-server-url', (_e, url) => {
  try { fs.writeFileSync(licenseCfgPath(), JSON.stringify({ serverUrl: url })); return ok(); } catch (e) { return fail(e); }
});

// Shared cookie normalizer (kept identical to worker's).
// A1: default domain to .facebook.com if missing; wrap in try so one bad cookie can't throw.
function normalizeCookie(c) {
  try {
    const out = {
      name: c.name,
      value: String(c.value ?? ''),
      domain: c.domain || '.facebook.com',
      path: c.path || '/',
    };
    if (typeof c.expires === 'number' && c.expires > 0) out.expires = c.expires;
    if (typeof c.httpOnly === 'boolean') out.httpOnly = c.httpOnly;
    if (typeof c.secure === 'boolean') out.secure = c.secure;
    const ss = String(c.sameSite || '').toLowerCase();
    out.sameSite = ss === 'lax' ? 'Lax' : ss === 'strict' ? 'Strict' : 'None';
    return out;
  } catch {
    return { name: String(c && c.name || '__bad__'), value: '', domain: '.facebook.com', path: '/' };
  }
}
