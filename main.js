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

function showLicenseWindow() {
  if (licenseWindow) { licenseWindow.focus(); return; }
  licenseWindow = new BrowserWindow({ width: 440, height: 400, resizable: false, title: 'License', icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'), webPreferences: { nodeIntegration: true, contextIsolation: false } });
  licenseWindow.removeMenu();
  licenseWindow.loadFile(path.join(__dirname, 'license-window.html'));
  licenseWindow.on('closed', () => { licenseWindow = null; });
}
function showRevokedWindow() {
  if (revokedWindow) { revokedWindow.focus(); return; }
  revokedWindow = new BrowserWindow({ width: 440, height: 400, resizable: false, title: 'License', webPreferences: { nodeIntegration: true, contextIsolation: false } });
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

  // Remote control server + tunnel (best effort). Hooks delegate all mutations
  // back here so the data store stays the single source of truth.
  await remote.startServer(REMOTE_PORT, {
    getData,
    getStatus: () => orchestrator.isRunning(),
    onStart: async () => { const r = await orchestrator.start(getData); if (r && r.success !== false) setRunActive(true); return r; },
    onStop: () => { orchestrator.stop(); setRunActive(false); },
    addPost: (fields) => addPostFromRemote(fields),
    deletePost: (index) => deletePostByIndex(index),
    setInterval: (minutes) => store.update((d) => { d.settings.waitInterval = clampSettings({ waitInterval: minutes }).waitInterval; }).then(() => send('data-updated')).catch(() => {}),
    loginAccount: (name) => openLoginBrowser(name),
    closeLogin: (name) => closeLoginBrowser(name),
    getTunnelUrl: () => tunnelUrl || '',
    getProxyHealth: () => orchestrator.getProxyHealth(), // E-X4: /api/proxies/health
    apiToken: REMOTE_TOKEN, // gate /api/* when reached over the public tunnel
    uploadDir: path.join(app.getPath('userData'), 'uploads'),
    imagesDir: store.paths.IMAGES_DIR,
  });
  // Cloudflare tunnel is OPT-IN: its spawned binary can destabilize the app on some
  // systems, so it's off by default. Enable with ENABLE_TUNNEL=1 (or settings.enableTunnel).
  const wantTunnel = process.env.ENABLE_TUNNEL || (getData().settings && getData().settings.enableTunnel);
  applyTunnelState(!!wantTunnel);

  // License gate — OPT-IN, off by default. When OFF, boot is identical to before.
  const LICENSE_ON = !!(process.env.ENABLE_LICENSE || (store.load().settings && store.load().settings.licenseEnabled));
  if (!LICENSE_ON) {
    setLicenseState({ valid: true, tier: 'owner', limits: license.UNLIMITED }, false); // owner/dev: unlimited
    createWindow();
  } else {
    const r = await license.checkCached(app.getPath('userData'), licenseServerUrl());
    setLicenseState(r, true); // enforce the validated tier's limits from here on
    if (r.valid) createWindow();
    else if (r.revoked) showRevokedWindow();
    else showLicenseWindow();
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
  }
  // ---------------------------------------------------------------------------

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
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
      d.posts = n.posts; d.groups = n.groups; d.accounts = n.accounts;
      d.settings = n.settings; d.proxies = n.proxies; d.useProxies = n.useProxies;
    });
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

ipcMain.handle('edit-post', async (_e, postId, updates) => {
  try {
    const found = await store.update((data) => {
      const p = data.posts.find((x) => x.id === postId);
      if (!p) return false;
      if (updates.caption !== undefined) p.caption = updates.caption;
      if (updates.comment !== undefined) p.comment = updates.comment;
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
    const warning = missing.length ? `Imported, but missing ${missing.join(' & ')} — Facebook will treat this account as logged out. Re-export cookies while logged in.` : undefined;
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
async function openLoginBrowser(accountName) {
  // Fix #6: already open guard
  if (loginBrowsers.has(accountName)) {
    emit('automation-log', `🔐 [${accountName}] login browser already open`);
    return;
  }

  // Fix #4: block login if automation is using this profile
  if (orchestrator && orchestrator.isRunning()) {
    emit('automation-log', `🔐 [${accountName}] cannot open login — automation is using this profile; stop automation first`);
    return;
  }

  emit('automation-log', `🔐 [${accountName}] opening login browser...`);

  store.sanitizeProfile(accountName, false); // wipe saved tabs + clear off-screen bounds so the login window is VISIBLE
  const browser = await puppeteer.launch({
    headless: false, userDataDir: store.profileDir(accountName),
    executablePath: chromiumPath(),
    defaultViewport: null,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled',
      '--no-first-run', '--no-default-browser-check', '--hide-crash-restore-bubble'],
  });
  // Close any tabs Chromium still restored, keep exactly one.
  const pages = await browser.pages();
  for (let i = 1; i < pages.length; i++) { try { await pages[i].close(); } catch {} }
  const page = pages[0] || (await browser.newPage());

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

  await page.goto('https://www.facebook.com/login', { waitUntil: 'domcontentloaded' }).catch(() => {});
  emit('automation-log', `🔐 [${accountName}] navigated to ${page.url()} — waiting for you to log in`);

  // Fix #7: set logging_in intermediate status
  setAccountStatus(accountName, 'logging_in', 'Login window open — waiting for manual login');

  send('login-browser-opened', accountName);

  let sessionDetectedLogged = false; // Fix #6: emit c_user detection only once

  // Fix #5: flush cookies on page close event
  page.on('close', async () => {
    try { store.writeCookies(accountName, await page.cookies()); } catch {}
  });

  const interval = setInterval(async () => {
    try {
      const pageCookies = await page.cookies();
      store.writeCookies(accountName, pageCookies);
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
      emit('automation-log', `🔐 [${accountName}] login window closed — verifying session...`);
      send('login-browser-closed', accountName);
      const res = await checkStatus(accountName);
      setAccountStatus(accountName, res.status, res.message, res);
      if (res.status === 'logged_in') {
        // Auto-capture: persist the credentials the user typed so auto-login can reuse them.
        if (captured.id && captured.pass) {
          try {
            const d = getData(); const acc = d.accounts.find((a) => a.name === accountName);
            if (acc) { acc.email = secret.encrypt(captured.id); acc.password = secret.encrypt(captured.pass); store.save(d); send('data-updated'); emit('automation-log', `🔑 [${accountName}] login credentials saved (encrypted) for auto-login`); }
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
    const r = await orchestrator.start(getData);
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
  try { await store.update((d) => { d.proxies = Array.isArray(proxies) ? proxies : []; }); return ok(); }
  catch (e) { return fail(e); }
});
ipcMain.handle('toggle-proxies', async (_e, enabled) => {
  try { await store.update((d) => { d.useProxies = !!enabled; }); return ok(); }
  catch (e) { return fail(e); }
});

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
