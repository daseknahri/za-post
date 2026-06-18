// main.js
// Electron main process for "Za Post Comment Tool" (restored, clean source).
// Implements the full IPC contract the recovered renderer expects, persists data
// via lib/store, runs automation via automation/orchestrator + worker, exposes a
// remote dashboard via server.js, and uses a permissive LOCAL license (no server).

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

// ---- persistent log file (assigned in whenReady, guarded until then) --------
let LOG_DIR = null;
let LOG_FILE = null;

function appendLogFile(line) {
  try {
    if (!LOG_FILE) return;
    fs.appendFile(LOG_FILE, '[' + new Date().toISOString() + '] ' + String(line) + '\n', () => {});
  } catch {}
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
// RUN_STATE_FILE is assigned in whenReady (after app paths are available).
// Declared here so setRunActive / isRunActive are accessible throughout the file.
let RUN_STATE_FILE = null;

/** Persist active=true/false atomically so a hard kill leaves the flag intact. */
function setRunActive(active) {
  try { fs.writeFileSync(RUN_STATE_FILE, JSON.stringify({ active: !!active, ts: Date.now() })); } catch {}
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
    try { remote.startTunnel(REMOTE_PORT, (u) => { tunnelUrl = u; send('remote-url-update', u); }); }
    catch (e) { tunnelActive = false; emit('automation-log', '🌐 Tunnel failed: ' + e.message); }
  } else if (!enabled && tunnelActive) {
    tunnelActive = false; tunnelUrl = '';
    try { remote.stopTunnel(); } catch {}
    send('remote-url-update', '');
    emit('automation-log', '🌐 Remote-access tunnel stopped');
  }
}
let orchestrator = null;
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
  // Natural completion: clear the run-active flag so no unwanted resume on next launch.
  if (channel === 'automation-stopped' && (payload === 'completed' || payload === 'finished')) {
    setRunActive(false);
  }
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

// Used by the remote dashboard (server.js hooks).
function addPostFromRemote(fields) {
  const data = getData();
  const imgPath = persistTemp(fields.imagePath, 'post');
  const commentImagePath = persistTemp(fields.commentImagePath, 'comment');
  data.posts.push({
    id: 'post-' + Date.now(), caption: fields.caption || '', comment: fields.comment || '',
    imagePaths: imgPath ? [imgPath] : [], imageUrl: fields.imageUrl || '',
    commentImagePath: commentImagePath || null, commentImageUrl: fields.commentImageUrl || '',
  });
  store.save(data); send('data-updated');
}
function deletePostByIndex(index) {
  const data = getData();
  if (index >= 0 && index < data.posts.length) { data.posts.splice(index, 1); store.save(data); send('data-updated'); }
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
  store.init(app.getPath('userData'));
  clearInterruptedLoginStates();

  // Kill any Chromium left orphaned by a previous crash/force-kill so its locked
  // profile dir doesn't block this session's launches. Best-effort, non-blocking.
  killOrphanChromium().then((n) => { if (n) { const m = `🧹 cleaned up ${n} orphaned browser process(es) from a previous run`; appendLogFile(m); emit('automation-log', m); } }).catch(() => {});

  // ---- run-state file (shutdown/crash resilience) ---------------------------
  RUN_STATE_FILE = path.join(app.getPath('userData'), 'run-state.json');

  // ---- Windows login-item (opt-in launchOnStartup) -------------------------
  try { app.setLoginItemSettings({ openAtLogin: !!(store.load().settings.launchOnStartup) }); } catch {}

  // ---- log file setup & startup rotation ------------------------------------
  LOG_DIR = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(LOG_DIR, { recursive: true });
  LOG_FILE = path.join(LOG_DIR, 'automation.log');
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > 5 * 1024 * 1024) {
      fs.renameSync(LOG_FILE, path.join(LOG_DIR, 'automation.log.1'));
    }
  } catch {}
  appendLogFile('--- session start ---');
  // ---------------------------------------------------------------------------

  orchestrator = new Orchestrator(emit, { isLoginOpen: (name) => loginBrowsers.has(name) });

  // Remote control server + tunnel (best effort). Hooks delegate all mutations
  // back here so the data store stays the single source of truth.
  await remote.startServer(REMOTE_PORT, {
    getData,
    getStatus: () => orchestrator.isRunning(),
    onStart: () => { setRunActive(true); return orchestrator.start(getData); },
    onStop: () => { orchestrator.stop(); setRunActive(false); },
    addPost: (fields) => addPostFromRemote(fields),
    deletePost: (index) => deletePostByIndex(index),
    setInterval: (minutes) => { const d = getData(); d.settings.waitInterval = minutes; store.save(d); send('data-updated'); },
    loginAccount: (name) => openLoginBrowser(name),
    closeLogin: (name) => closeLoginBrowser(name),
    getTunnelUrl: () => tunnelUrl || '',
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
    createWindow();
  } else {
    const r = await license.checkCached(app.getPath('userData'), licenseServerUrl());
    if (r.valid) createWindow();
    else if (r.revoked) showRevokedWindow();
    else showLicenseWindow();
  }

  // ---- Auto-resume after shutdown / crash ------------------------------------
  // Capture whether the previous session left the run-active flag set.
  const wasInterrupted = isRunActive();
  if (wasInterrupted && store.load().settings.resumeOnStartup !== false && mainWindow) {
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
  for (const [, entry] of loginBrowsers) { try { entry.browser.close(); } catch {} }
  remote.stopServer();
  if (process.platform !== 'darwin') app.quit();
});

// =======================================================================
// IPC: DATA
// =======================================================================
ipcMain.handle('get-data', () => getData());
ipcMain.handle('save-data', (_e, data) => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fail('Invalid data');
  if (!Array.isArray(data.posts) || !Array.isArray(data.groups) || !Array.isArray(data.accounts)) return fail('Invalid data');
  store.save(data); return ok();
});

// =======================================================================
// IPC: POSTS
// =======================================================================
ipcMain.handle('add-post', (_e, post) => {
  try {
    const data = getData();
    const imagePaths = [];
    for (const img of post.images || []) { const p = store.saveBase64Image(img, 'post'); if (p) imagePaths.push(p); }
    let commentImagePath = null;
    if (post.commentImage) commentImagePath = store.saveBase64Image(post.commentImage, 'comment');
    data.posts.push({
      id: 'post-' + Date.now(),
      caption: post.caption || '',
      comment: post.comment || '',
      imagePaths,
      imageUrl: post.imageUrl || '',
      commentImagePath,
      commentImageUrl: post.commentImageUrl || '',
    });
    store.save(data);
    send('data-updated');
    return ok();
  } catch (e) { return fail(e); }
});

// =======================================================================
// IPC: BULK IMPORT
// =======================================================================
ipcMain.handle('add-posts-bulk', (_e, posts) => {
  try {
    if (!Array.isArray(posts)) return fail('Expected an array of posts');
    const data = getData();
    let added = 0, skipped = 0;
    const now = Date.now();
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
    store.save(data);
    send('data-updated');
    return ok({ added, skipped });
  } catch (e) { return fail(e); }
});

ipcMain.handle('add-groups-bulk', (_e, items) => {
  try {
    if (!Array.isArray(items)) return fail('Expected an array of group URLs/IDs');
    const data = getData();
    const existingIds = new Set(data.groups.map((g) => g.groupId));
    let added = 0, skipped = 0;
    const now = Date.now();
    for (let i = 0; i < items.length; i++) {
      const groupId = extractGroupId(String(items[i] || ''));
      if (!groupId || existingIds.has(groupId)) { skipped++; continue; }
      existingIds.add(groupId);
      data.groups.push({
        id: `group-${now}-${i}`,
        groupId,
        name: `Group ${data.groups.length + 1}`,
      });
      added++;
    }
    store.save(data);
    send('data-updated');
    return ok({ added, skipped });
  } catch (e) { return fail(e); }
});

ipcMain.handle('delete-post', (_e, postId) => {
  const data = getData();
  data.posts = data.posts.filter((p) => p.id !== postId);
  store.save(data); send('data-updated'); return ok();
});

ipcMain.handle('edit-post', (_e, postId, updates) => {
  const data = getData();
  const p = data.posts.find((x) => x.id === postId);
  if (!p) return fail('Post not found');
  if (updates.caption !== undefined) p.caption = updates.caption;
  if (updates.comment !== undefined) p.comment = updates.comment;
  store.save(data); send('data-updated'); return ok();
});

// =======================================================================
// IPC: GROUPS
// =======================================================================
ipcMain.handle('add-group', (_e, group) => {
  const data = getData();
  const groupId = extractGroupId(group.groupId);
  if (!groupId) return fail('Invalid group ID / URL');
  data.groups.push({ id: 'group-' + Date.now(), groupId, name: group.name || `Group ${data.groups.length + 1}` });
  store.save(data); send('data-updated'); return ok();
});

ipcMain.handle('delete-group', (_e, groupId) => {
  const data = getData();
  data.groups = data.groups.filter((g) => g.id !== groupId && g.groupId !== groupId);
  // Prune the deleted group from every account's assignedGroups so the worker never
  // wastes a cycle on a group that no longer exists.
  const valid = new Set(data.groups.map((g) => g.id));
  for (const a of data.accounts) a.assignedGroups = (a.assignedGroups || []).filter((id) => valid.has(id));
  store.save(data); send('data-updated'); return ok();
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
ipcMain.handle('create-account', (_e, accountName, alias) => {
  const data = getData();
  if (!accountName) return fail('Account name required');
  if (data.accounts.some((a) => a.name === accountName)) return fail('Account already exists');
  data.accounts.push({
    name: accountName, alias: alias || '', status: 'not_logged_in', lastMessage: '',
    assignedGroups: [], postFilter: 'all', postingOrder: 'post-centric-unique', enabled: true,
  });
  store.profileDir(accountName); // create profile dir
  store.save(data); send('data-updated'); return ok();
});

// Enable/disable an account for automation (disabled accounts are skipped by the orchestrator).
ipcMain.handle('toggle-account', (_e, accountName, enabled) => {
  const data = getData();
  const a = data.accounts.find((x) => x.name === accountName);
  if (!a) return fail('Account not found');
  a.enabled = enabled === undefined ? a.enabled === false : !!enabled;
  store.save(data); send('data-updated'); return ok({ enabled: a.enabled });
});

ipcMain.handle('delete-account', (_e, accountName) => {
  if (orchestrator && orchestrator.isRunning()) return fail('Stop automation before deleting an account');
  if (loginBrowsers.has(accountName)) return fail('Close the login browser for this account first');
  const data = getData();
  data.accounts = data.accounts.filter((a) => a.name !== accountName);
  store.save(data);
  try { fs.rmSync(store.accountDir(accountName), { recursive: true, force: true }); } catch {}
  send('data-updated'); return ok();
});

ipcMain.handle('set-account-credentials', (_e, accountName, email, password) => {
  const data = getData();
  const a = data.accounts.find((x) => x.name === accountName);
  if (!a) return fail('Account not found');
  a.email = email || '';
  a.password = password || '';
  store.save(data);
  send('data-updated');
  return ok();
});

ipcMain.handle('rename-account', (_e, oldName, newName) => {
  if (orchestrator && orchestrator.isRunning()) return fail('Stop automation before renaming an account');
  if (loginBrowsers.has(oldName)) return fail('Close the login browser for this account first');
  const data = getData();
  const a = data.accounts.find((x) => x.name === oldName);
  if (!a) return fail('Account not found');
  if (data.accounts.some((x) => x.name === newName)) return fail('Name already in use');
  try {
    const from = store.accountDir(oldName), to = path.join(store.paths.ACCOUNTS_DIR, store.sanitizeName(newName));
    if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to);
  } catch (e) { return fail(e); }
  a.name = newName;
  store.save(data); send('data-updated'); return ok();
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
    const arr = raw.filter((c) => c && typeof c === 'object' && c.name && 'value' in c);
    const skipped = raw.length - arr.length;
    if (!arr.length) return fail('No valid cookies found (each entry needs name + value)');
    store.writeCookies(accountName, arr);
    console.log(`[import-cookies] ${accountName}: imported ${arr.length}, skipped ${skipped} junk entries`);
    setAccountStatus(accountName, 'checking', 'Verifying…');
    send('data-updated');
    const status = await checkStatus(accountName);
    setAccountStatus(accountName, status.status, status.message, status);
    return ok({ status: status.status, message: status.message, imported: arr.length, skipped });
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
    store.sanitizeProfile(accountName); // don't restore old tabs
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
  const data = getData();
  const a = data.accounts.find((x) => x.name === name);
  if (a) {
    a.status = status; a.lastMessage = message || '';
    if (result && result.fbUserId) a.fbUserId = result.fbUserId;
    if (result && result.fbName !== undefined) a.fbName = result.fbName;
    if (result && result.status === 'logged_in') a.lastChecked = Date.now();
    // Opportunistically prune any assignedGroups that no longer exist in data.groups.
    const valid = new Set(data.groups.map((g) => g.id));
    a.assignedGroups = (a.assignedGroups || []).filter((id) => valid.has(id));
    store.save(data); send('data-updated');
  }
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

  store.sanitizeProfile(accountName); // wipe any saved tabs so it won't reopen 40 old pages
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
            if (acc) { acc.email = captured.id; acc.password = captured.pass; store.save(d); send('data-updated'); emit('automation-log', `🔑 [${accountName}] login credentials saved for auto-login`); }
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
ipcMain.handle('pause-automation', () => {
  if (!orchestrator) return fail('Orchestrator not ready');
  if (!orchestrator.isRunning()) return fail('Automation is not running');
  orchestrator.pause(); return ok();
});
ipcMain.handle('resume-automation', () => {
  if (!orchestrator) return fail('Orchestrator not ready');
  if (!orchestrator.isRunning()) return fail('Automation is not running');
  if (!orchestrator.isPaused()) return fail('Automation is not paused');
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
ipcMain.handle('save-settings', (_e, settings) => {
  const data = getData();
  data.settings = { ...store.DEFAULT_SETTINGS, ...data.settings, ...settings };
  store.save(data);
  // Apply launchOnStartup immediately so toggling it takes effect without a restart.
  try { app.setLoginItemSettings({ openAtLogin: !!data.settings.launchOnStartup }); } catch {}
  // Apply the remote-access tunnel toggle live (start/stop without a restart).
  applyTunnelState(!!data.settings.enableTunnel);
  return ok();
});

ipcMain.handle('get-proxies', () => {
  const data = getData();
  return ok({ useProxies: !!data.useProxies, proxies: data.proxies || [] });
});
ipcMain.handle('save-proxies', (_e, proxies) => {
  const data = getData(); data.proxies = Array.isArray(proxies) ? proxies : []; store.save(data); return ok();
});
ipcMain.handle('toggle-proxies', (_e, enabled) => {
  const data = getData(); data.useProxies = !!enabled; store.save(data); return ok();
});

ipcMain.handle('select-image', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'], filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }],
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

// Permissive LOCAL license — the app runs without a validation server.
ipcMain.handle('get-license-info', () => ({ valid: true, lifetime: true, maxGroups: 9999, maxAccounts: 9999 }));
ipcMain.handle('get-remote-url', () => tunnelUrl || '');
ipcMain.handle('open-logs-folder', () => {
  try { shell.openPath(LOG_DIR || app.getPath('userData')); return ok(); } catch (e) { return fail(e); }
});
ipcMain.on('validate-license-async', async (e, key) => {
  try {
    const r = await license.activate(app.getPath('userData'), key, licenseServerUrl());
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
