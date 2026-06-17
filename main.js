// main.js
// Electron main process for "Za Post Comment Tool" (restored, clean source).
// Implements the full IPC contract the recovered renderer expects, persists data
// via lib/store, runs automation via automation/orchestrator + worker, exposes a
// remote dashboard via server.js, and uses a permissive LOCAL license (no server).

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// Multi-profile support: `electron . --profile=base` runs an isolated instance
// (separate userData) so the two account sets (King + base) coexist, mirroring the
// two original apps. Default profile keeps the package name (the King set).
const PROFILE = (process.argv.find((a) => a.startsWith('--profile=')) || '').split('=')[1] || process.env.ZA_PROFILE;
if (PROFILE) app.setName('za-post-restored-' + PROFILE);

const store = require('./lib/store');
const remote = require('./server');
const { Orchestrator } = require('./automation/orchestrator');
const license = require('./lib/license');
const { chromiumPath } = require('./lib/chromium');

// Puppeteer (stealth) — used for interactive login + status checks.
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

process.on('uncaughtException', (e) => console.error('[FATAL] uncaughtException:', e));
process.on('unhandledRejection', (e) => console.error('[FATAL] unhandledRejection:', e));

const REMOTE_PORT = 3000;
let mainWindow = null;
let licenseWindow = null;
let revokedWindow = null;
let tunnelUrl = '';
let orchestrator = null;
const loginBrowsers = new Map(); // accountName -> { browser, interval }

// ---- helpers -----------------------------------------------------------
function getData() { return store.load(); }
function send(channel, payload) { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload); }
function emit(channel, payload) {
  send(channel, payload);
  if (channel === 'automation-log') remote.addLog(typeof payload === 'string' ? payload : JSON.stringify(payload));
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
  orchestrator = new Orchestrator(emit, { isLoginOpen: (name) => loginBrowsers.has(name) });

  // Remote control server + tunnel (best effort). Hooks delegate all mutations
  // back here so the data store stays the single source of truth.
  await remote.startServer(REMOTE_PORT, {
    getData,
    getStatus: () => orchestrator.isRunning(),
    onStart: () => orchestrator.start(getData),
    onStop: () => orchestrator.stop(),
    addPost: (fields) => addPostFromRemote(fields),
    deletePost: (index) => deletePostByIndex(index),
    setInterval: (minutes) => { const d = getData(); d.settings.waitInterval = minutes; store.save(d); send('data-updated'); },
    loginAccount: (name) => openLoginBrowser(name),
    closeLogin: (name) => closeLoginBrowser(name),
    getTunnelUrl: () => tunnelUrl || '',
    uploadDir: path.join(app.getPath('userData'), 'uploads'),
  });
  // Cloudflare tunnel is OPT-IN: its spawned binary can destabilize the app on some
  // systems, so it's off by default. Enable with ENABLE_TUNNEL=1 (or settings.enableTunnel).
  const wantTunnel = process.env.ENABLE_TUNNEL || (getData().settings && getData().settings.enableTunnel);
  if (wantTunnel) {
    try { remote.startTunnel(REMOTE_PORT, (url) => { tunnelUrl = url; send('remote-url-update', url); }); }
    catch (e) { console.error('[tunnel] disabled:', e.message); }
  }

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

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { remote.stopServer(); if (process.platform !== 'darwin') app.quit(); });

// =======================================================================
// IPC: DATA
// =======================================================================
ipcMain.handle('get-data', () => getData());
ipcMain.handle('save-data', (_e, data) => { store.save(data); return ok(); });

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
  const data = getData();
  data.accounts = data.accounts.filter((a) => a.name !== accountName);
  store.save(data);
  try { fs.rmSync(store.accountDir(accountName), { recursive: true, force: true }); } catch {}
  send('data-updated'); return ok();
});

ipcMain.handle('rename-account', (_e, oldName, newName) => {
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
    const arr = typeof cookies === 'string' ? JSON.parse(cookies) : cookies;
    if (!Array.isArray(arr) || !arr.every((c) => c && c.name && 'value' in c)) return fail('Invalid cookies format');
    store.writeCookies(accountName, arr);
    setAccountStatus(accountName, 'checking', 'Verifying…');
    send('data-updated');
    const status = await checkStatus(accountName);
    setAccountStatus(accountName, status.status, status.message, status);
    return ok({ status: status.status, message: status.message });
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
    if (cookies.length) { try { await page.setCookie(...cookies.map(normalizeCookie)); } catch {} }
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
    clearInterval(interval);
    loginBrowsers.delete(accountName);
    emit('automation-log', `🔐 [${accountName}] login window closed — verifying session...`);
    send('login-browser-closed', accountName);
    const res = await checkStatus(accountName);
    setAccountStatus(accountName, res.status, res.message, res);
    // Fix #6: final status log
    if (res.status === 'logged_in') {
      emit('automation-log', `✅ [${accountName}] logged in as ${res.fbName || '(unknown)'} (c_user=${res.fbUserId || '?'})`);
    } else {
      emit('automation-log', `❌ [${accountName}] not logged in: ${res.message}`);
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
  try { return await orchestrator.start(getData); } catch (e) { return fail(e); }
});
ipcMain.handle('stop-automation', () => {
  if (!orchestrator.isRunning()) return fail('Automation is not running');
  orchestrator.stop(); return ok();
});
ipcMain.handle('get-automation-status', () => ok({ isRunning: orchestrator.isRunning() }));

// =======================================================================
// IPC: SETTINGS / PROXIES / FILES / LICENSE
// =======================================================================
ipcMain.handle('save-settings', (_e, settings) => {
  const data = getData();
  data.settings = { ...store.DEFAULT_SETTINGS, ...data.settings, ...settings };
  store.save(data); return ok();
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
function normalizeCookie(c) {
  const out = { name: c.name, value: c.value, domain: c.domain, path: c.path || '/' };
  if (typeof c.expires === 'number' && c.expires > 0) out.expires = c.expires;
  if (typeof c.httpOnly === 'boolean') out.httpOnly = c.httpOnly;
  if (typeof c.secure === 'boolean') out.secure = c.secure;
  const ss = String(c.sameSite || '').toLowerCase();
  out.sameSite = ss === 'lax' ? 'Lax' : ss === 'strict' ? 'Strict' : 'None';
  return out;
}
