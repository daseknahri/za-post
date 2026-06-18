// server.js
// Express remote-control API + dashboard, matched to the recovered public/index.html,
// optionally exposed via a Cloudflare quick-tunnel. All state mutations are delegated
// back to main.js through injected hooks (so the Electron data store stays the source
// of truth).

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const multer = require('multer');

let httpServer = null;
let activeTunnel = null;             // cloudflared Tunnel handle (for clean shutdown)
let logs = [];                       // in-memory ring buffer (max 500)
let hooks = {
  getData: () => ({ posts: [] }),
  getStatus: () => false,
  onStart: () => {},
  onStop: () => {},
  addPost: () => {},                 // (postFields) => void   persists via main.js
  deletePost: () => {},              // (index) => void
  setInterval: () => {},             // (minutes) => void
  loginAccount: () => {},            // (name) => Promise
  closeLogin: () => {},              // (name) => void
  getTunnelUrl: () => '',            // () => string
};

function shapeLog(l) {
  const msg = l.msg || '';
  const type = /error|fail|❌|🚫/i.test(msg) ? 'error' : /success|✅|posted|published|complete/i.test(msg) ? 'success' : 'info';
  return { timestamp: l.t, type, message: msg };
}

function addLog(msg) {
  logs.push({ t: Date.now(), msg });
  if (logs.length > 500) logs = logs.slice(-500);
}

function startServer(port, injected) {
  hooks = { ...hooks, ...injected };
  // Uploads must go to a WRITABLE dir. In a packaged app __dirname is inside the
  // read-only asar, so main.js injects userData/uploads. Falls back to public/uploads in dev.
  const UPLOAD_DIR = hooks.uploadDir || path.join(__dirname, 'public', 'uploads');
  const IMAGES_DIR = hooks.imagesDir || path.join(path.dirname(UPLOAD_DIR), 'storage', 'images');
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB cap

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '15mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/uploads', express.static(UPLOAD_DIR));
  app.use('/images', express.static(IMAGES_DIR));

  // ---- automation -----------------------------------------------------
  app.get('/api/automation/status', (_req, res) => {
    const running = hooks.getStatus();
    res.json({ isRunning: running, pid: running ? process.pid : null, logs: logs.slice(-80).map(shapeLog) });
  });
  app.post('/api/automation/start', (_req, res) => {
    try { hooks.onStart(); res.json({ success: true }); } catch (e) { res.json({ success: false, error: e.message }); }
  });
  app.post('/api/automation/stop', (_req, res) => {
    try { hooks.onStop(); res.json({ success: true }); } catch (e) { res.json({ success: false, error: e.message }); }
  });

  // ---- posts ----------------------------------------------------------
  app.get('/api/posts', (_req, res) => {
    const posts = (hooks.getData().posts || []).map((p) => ({
      caption: p.caption || '',
      comment: p.comment || '',
      imagePath: (p.imagePaths && p.imagePaths[0]) || p.imagePath || '',
      commentImagePath: p.commentImagePath || '',
    }));
    res.json({ posts });
  });

  app.post('/api/posts/add', upload.fields([{ name: 'image', maxCount: 1 }, { name: 'commentImage', maxCount: 1 }]), (req, res) => {
    try {
      const caption = (req.body.caption || '').trim();
      if (!caption) return res.json({ success: false, error: 'Caption is required' });
      hooks.addPost({
        caption,
        comment: req.body.comment || '',
        imageUrl: req.body.imageUrl || '',
        commentImageUrl: req.body.commentImageUrl || '',
        imagePath: req.files && req.files.image ? req.files.image[0].path : null,
        commentImagePath: req.files && req.files.commentImage ? req.files.commentImage[0].path : null,
      });
      res.json({ success: true });
    } catch (e) { res.json({ success: false, error: e.message }); }
  });

  app.delete('/api/posts/:index', (req, res) => {
    try { hooks.deletePost(parseInt(req.params.index, 10)); res.json({ success: true }); }
    catch (e) { res.json({ success: false, error: e.message }); }
  });

  // ---- logs / interval (parity with original server) -------------------
  app.get('/api/automation/logs', (_req, res) => res.json({ logs: logs.slice(-150).map(shapeLog) }));
  app.get('/api/tunnel-url', (_req, res) => res.json({ url: hooks.getTunnelUrl() || '' }));
  app.post('/api/automation/interval', (req, res) => {
    const minutes = parseInt(req.body.minutes ?? req.body.interval, 10);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
      return res.json({ success: false, error: 'Invalid interval. Must be between 1 and 1440 minutes.' });
    }
    try { hooks.setInterval(minutes); res.json({ success: true, message: `Interval updated to ${minutes} minutes. Restart automation for changes to take effect.` }); }
    catch (e) { res.json({ success: false, error: e.message }); }
  });

  // ---- accounts / groups (parity with original server) -----------------
  app.get('/api/accounts', (_req, res) => res.json({ accounts: hooks.getData().accounts || [] }));
  app.get('/api/groups', (_req, res) => res.json({ groups: hooks.getData().groups || [] }));
  app.post('/api/accounts/:name/login', async (req, res) => {
    try { await hooks.loginAccount(req.params.name); res.json({ success: true, message: `Login window opened for ${req.params.name}` }); }
    catch (e) { res.json({ success: false, error: e.message }); }
  });
  app.post('/api/accounts/:name/close-login', (req, res) => {
    try { hooks.closeLogin(req.params.name); res.json({ success: true, message: `Login window closed for ${req.params.name}` }); }
    catch (e) { res.json({ success: false, error: e.message }); }
  });

  // Bind localhost-only by default (no LAN exposure). The Cloudflare tunnel still
  // works — it connects to localhost. Set host:'0.0.0.0' via hooks only if LAN access is wanted.
  const host = hooks.host || '127.0.0.1';
  return new Promise((resolve) => {
    httpServer = app.listen(port, host, () => { addLog(`Remote server on ${host}:${port}`); resolve(port); });
    httpServer.on('error', (e) => { addLog(`Server error: ${e.message}`); resolve(null); });
  });
}

function stopServer() {
  try { httpServer && httpServer.close(); } catch {} httpServer = null;
  try { activeTunnel && activeTunnel.stop && activeTunnel.stop(); } catch {} activeTunnel = null;
}
function stopTunnel() { try { activeTunnel && activeTunnel.stop && activeTunnel.stop(); } catch {} activeTunnel = null; }

// Start a Cloudflare quick tunnel (trycloudflare.com) for remote access to the dashboard.
// We parse the URL from cloudflared's own output (the bundled cloudflared package's built-in
// 'url' regex is outdated for newer cloudflared builds, so it never fires). Robust + isolated:
// child errors/exit can't crash the app.
async function startTunnel(port, onUrl) {
  try {
    // Use Tunnel.quick() — it builds `cloudflared tunnel --url …` (a quick trycloudflare
    // tunnel). NB: the package's tunnel({'--url':…}) builds `tunnel run --url …` which is
    // for NAMED tunnels and exits immediately — that was the long-standing bug.
    const { Tunnel } = require('cloudflared');
    const t = Tunnel.quick(`http://localhost:${port}`);
    activeTunnel = t;
    const url = await new Promise((resolve) => {
      let resolved = false;
      const done = (u) => { if (!resolved) { resolved = true; resolve(u); } };
      const scan = (chunk) => { const m = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i); if (m) done(m[0]); };
      try { t.on('url', (u) => { const m = String(u).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i); done(m ? m[0] : u); }); } catch {}
      try { t.on('stdout', scan); t.on('stderr', scan); } catch {}
      try { t.on('error', (e) => addLog(`Tunnel error: ${e && e.message ? e.message : e}`)); } catch {}
      try { t.on('exit', () => done(null)); } catch {}
      setTimeout(() => done(null), 30000); // quick tunnels usually appear in ~5s; allow margin
    });
    if (url) { addLog(`🌐 Remote access ready: ${url}`); onUrl && onUrl(url); }
    else { addLog('🌐 Tunnel started but no URL was captured (check connectivity).'); }
    return url;
  } catch (e) { addLog(`🌐 Tunnel unavailable: ${e && e.message ? e.message : e}`); return null; }
}

module.exports = { startServer, stopServer, startTunnel, stopTunnel, addLog };
