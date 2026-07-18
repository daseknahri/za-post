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
  addPostsBulk: async () => ({ added: 0, skipped: 0 }), // (posts[, {replace}]) => {added,skipped}  bulk JSON insert
  deletePost: () => {},              // (index) => void
  setInterval: () => {},             // (minutes) => void
  loginAccount: () => {},            // (name) => Promise
  closeLogin: () => {},              // (name) => void
  getTunnelUrl: () => '',            // () => string
  getProxyHealth: () => ({ proxies: [], summary: { total: 0, healthy: 0, failing: 0, onCooldown: 0 } }), // E-X4
};

function shapeLog(l) {
  const msg = l.msg || '';
  // Classify by explicit emoji markers first (most reliable), then fall back to words —
  // but never let "errors=0" / "Errors: 0" (a success summary) read as an error.
  const zeroErr = /errors?\s*[:=]\s*0\b/i.test(msg);
  const type = (/❌|🚫|🛑/.test(msg) || (/\b(error|errors|failed|failure)\b/i.test(msg) && !zeroErr)) ? 'error'
    : (/✅|🎉|🏁/.test(msg) || /\b(posted|published|complete|completed|success)\b/i.test(msg)) ? 'success'
    : 'info';
  return { timestamp: l.t, type, message: msg };
}

function addLog(msg) {
  logs.push({ t: Date.now(), msg });
  if (logs.length > 500) logs = logs.slice(-500);
}

// In-memory per-IP rate limiter (no external dep) — bounds token brute-forcing + flooding the browser-spawning
// endpoints when the API is public via the tunnel. Keyed per (ip, limit) so different limiters don't share a bucket;
// expired buckets are pruned so the map can't grow unbounded.
const _rlBuckets = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const now = Date.now();
    const key = (req.ip || (req.socket && req.socket.remoteAddress) || '?') + '|' + max + '|' + windowMs;
    let b = _rlBuckets.get(key);
    if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + windowMs }; _rlBuckets.set(key, b); }
    if (++b.count > max) return res.status(429).json({ success: false, error: 'Too many requests — slow down.' });
    if (_rlBuckets.size > 5000) { for (const [k, v] of _rlBuckets) if (now > v.resetAt) _rlBuckets.delete(k); }
    next();
  };
}

// Remote error responder: log the real error server-side, return only a GENERIC message to the (possibly remote,
// tunnel-exposed) client so store/filesystem internals + userData paths never leak over the wire.
function apiErr(res, e, code) {
  try { addLog(`API error: ${(e && e.stack) || (e && e.message) || e}`); } catch {}
  return res.status(code || 200).json({ success: false, error: 'Operation failed' });
}

function startServer(port, injected) {
  hooks = { ...hooks, ...injected };
  // Uploads must go to a WRITABLE dir. In a packaged app __dirname is inside the
  // read-only asar, so main.js injects userData/uploads. Falls back to public/uploads in dev.
  const UPLOAD_DIR = hooks.uploadDir || path.join(__dirname, 'public', 'uploads');
  const IMAGES_DIR = hooks.imagesDir || path.join(path.dirname(UPLOAD_DIR), 'storage', 'images');
  // Wrapped: a non-writable uploads dir (EACCES/EPERM/ENOTDIR) must NOT throw synchronously out of startServer — that
  // would reject the awaited call in main.js's whenReady chain and skip createWindow() (a headless zombie with no UI).
  // Degrade instead: the API + app still start; only image uploads are unavailable.
  try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); fs.mkdirSync(IMAGES_DIR, { recursive: true }); }
  catch (e) { addLog(`Remote API: uploads dir not writable (${e.message}) — image uploads disabled, server still starting`); }
  const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB cap

  const app = express();
  // The dashboard is SAME-ORIGIN on the tunnel URL — no legitimate cross-origin need. Disabling CORS removes
  // the browser's same-origin barrier exploit if a token-bearing URL ever leaks to another origin.
  app.use(cors({ origin: false }));
  app.use(express.json({ limit: '15mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use((_req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); next(); });
  app.use(express.static(path.join(__dirname, 'public')));

  // When a token is configured (set by main.js whenever the public tunnel is enabled), require it on
  // every /api route AND on the static image dirs (post/comment creative). The dashboard is reached as
  // `<url>/?token=…`; its bootstrap forwards the token as the X-Access-Token header on /api calls and
  // appends ?token=… to image <img> src. Without gating the image dirs, anyone with the tunnel base URL
  // could scrape every client image; without gating /api they could control automation and read data.
  const API_TOKEN = hooks.apiToken || null;
  const tokenGate = (req, res, next) => {
    if (!API_TOKEN) return next(); // local use (no tunnel) → no token required
    const tok = req.get('X-Access-Token') || req.query.token;
    // Constant-time compare: `===` short-circuits at the first differing byte → a remote token timing side-channel.
    // The length guard is required (timingSafeEqual throws on unequal-length buffers; leaking only LENGTH is fine for a fixed-length token).
    const _ta = Buffer.from(String(tok || '')), _tb = Buffer.from(String(API_TOKEN));
    if (_ta.length === _tb.length && require('crypto').timingSafeEqual(_ta, _tb)) return next();
    return res.status(401).json({ success: false, error: 'Unauthorized — open the dashboard with ?token=… (see the app).' });
  };
  app.use('/uploads', tokenGate, express.static(UPLOAD_DIR));
  app.use('/images', tokenGate, express.static(IMAGES_DIR));
  app.use('/api', rateLimit(120, 10000)); // per-IP throttle BEFORE tokenGate so failed-auth floods are counted too
  if (API_TOKEN) app.use('/api', tokenGate);

  // ---- automation -----------------------------------------------------
  app.get('/api/automation/status', (_req, res) => {
    const running = hooks.getStatus();
    res.json({ isRunning: running, pid: running ? process.pid : null, logs: logs.slice(-80).map(shapeLog) });
  });
  app.post('/api/automation/start', async (_req, res) => {
    try { const r = await hooks.onStart(); res.json(r && r.success === false ? r : { success: true }); } catch (e) { apiErr(res, e); }
  });
  app.post('/api/automation/stop', (_req, res) => {
    try { hooks.onStop(); res.json({ success: true }); } catch (e) { apiErr(res, e); }
  });

  // ---- posts ----------------------------------------------------------
  app.get('/api/posts', (_req, res) => {
    const posts = (hooks.getData().posts || []).map((p) => ({
      caption: p.caption || '',
      comment: p.comment || '',
      imagePath: require('path').basename((p.imagePaths && p.imagePaths[0]) || p.imagePath || ''), // L2: basename only — the /images/<name> static route already serves by basename (consumer does .split(/[\/\\]/).pop()); the full on-disk path leaked the OS username + userData layout
      commentImagePath: require('path').basename(p.commentImagePath || ''),
    }));
    res.json({ posts });
  });

  app.post('/api/posts/add', upload.fields([{ name: 'image', maxCount: 1 }, { name: 'commentImage', maxCount: 1 }]), async (req, res) => {
    // multer wrote the uploads to UPLOAD_DIR before this handler runs — on the empty-caption early-return (or a throw)
    // hooks.addPost never persists them, so they'd leak forever. Clean them on the non-success paths.
    const _cleanupUploads = () => { try { for (const k of ['image', 'commentImage']) { const f = req.files && req.files[k] && req.files[k][0]; if (f && f.path) { try { require('fs').unlinkSync(f.path); } catch {} } } } catch {} };
    try {
      const caption = (req.body.caption || '').trim();
      if (!caption) { _cleanupUploads(); return res.json({ success: false, error: 'Caption is required' }); }
      await hooks.addPost({
        caption,
        comment: req.body.comment || '',
        imageUrl: req.body.imageUrl || '',
        commentImageUrl: req.body.commentImageUrl || '',
        imagePath: req.files && req.files.image ? req.files.image[0].path : null,
        commentImagePath: req.files && req.files.commentImage ? req.files.commentImage[0].path : null,
      });
      res.json({ success: true });
    } catch (e) { _cleanupUploads(); apiErr(res, e); }
  });

  // BULK add posts from an external server in ONE request (one disk write) — the endpoint for API automation.
  // JSON body: { "posts": [ { "caption": "...(required)", "comment": "...", "imageUrl": "...", "commentImageUrl": "..." }, ... ], "replace": false }
  // A raw JSON array is also accepted. Blank captions are skipped. replace=true clears the library first
  // (full refresh). Returns { success, added, skipped, replaced }. Token-gated like every /api route.
  app.post('/api/posts/bulk', rateLimit(20, 60000), async (req, res) => {
    try {
      const posts = Array.isArray(req.body) ? req.body : (req.body && req.body.posts);
      if (!Array.isArray(posts)) return res.status(400).json({ success: false, error: 'Body must be a JSON array of posts, or { "posts": [ … ] }.' });
      if (posts.length > 1000) return res.status(400).json({ success: false, error: 'Too many posts in one request (max 1000).' });
      const replace = !!(req.body && !Array.isArray(req.body) && req.body.replace);
      const r = await hooks.addPostsBulk(posts, { replace });
      res.json({ success: true, added: (r && r.added) || 0, skipped: (r && r.skipped) || 0, replaced: replace });
    } catch (e) { apiErr(res, e, 500); }
  });

  app.delete('/api/posts/:index', async (req, res) => {
    try { await hooks.deletePost(parseInt(req.params.index, 10)); res.json({ success: true }); }
    catch (e) { apiErr(res, e); }
  });

  // ---- logs / interval (parity with original server) -------------------
  app.get('/api/automation/logs', (_req, res) => res.json({ logs: logs.slice(-150).map(shapeLog) }));
  app.get('/api/tunnel-url', (_req, res) => res.json({ url: hooks.getTunnelUrl() || '' }));
  app.post('/api/automation/interval', async (req, res) => {
    const _b = req.body || {}; // Express 5 leaves req.body undefined on an empty/non-JSON body — guard before deref (else a token-bearing empty POST 500s with a stack)
    const minutes = parseInt(_b.minutes ?? _b.interval, 10);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
      return res.json({ success: false, error: 'Invalid interval. Must be between 1 and 1440 minutes.' });
    }
    try { await hooks.setInterval(minutes); res.json({ success: true, message: `Interval updated to ${minutes} minutes. Restart automation for changes to take effect.` }); }
    catch (e) { apiErr(res, e); }
  });

  // ---- accounts / groups (parity with original server) -----------------
  app.get('/api/accounts', (_req, res) => {
    // Never expose credentials/cookies over the network — map to display-safe fields only.
    // Moderators are not posting accounts — keep them out of the remote poster list (parity with the local UI).
    const accounts = (hooks.getData().accounts || []).filter((a) => !a.isModerator).map((a) => ({
      name: a.name, alias: a.alias, status: a.status, lastMessage: a.lastMessage,
      enabled: a.enabled !== false, assignedGroups: a.assignedGroups || [],
      fbName: a.fbName, lastChecked: a.lastChecked,
    }));
    res.json({ accounts });
  });
  app.get('/api/groups', (_req, res) => res.json({ groups: hooks.getData().groups || [] }));
  // E-X4: proxy health snapshot (behind the same X-Access-Token as the other /api routes).
  app.get('/api/proxies/health', (_req, res) => { try { res.json(hooks.getProxyHealth()); } catch (e) { apiErr(res, e, 500); } });
  app.post('/api/accounts/:name/login', rateLimit(6, 60000), async (req, res) => {
    // Propagate a blocked result (e.g. the license gate on an enforced+invalid build returns {success:false}) instead
    // of always reporting "Login window opened" — mirrors the onStart handler above so the API response is truthful.
    try { const r = await hooks.loginAccount(req.params.name); res.json(r && r.success === false ? r : { success: true, message: `Login window opened for ${req.params.name}` }); }
    catch (e) { apiErr(res, e); }
  });
  app.post('/api/accounts/:name/close-login', (req, res) => {
    try { hooks.closeLogin(req.params.name); res.json({ success: true, message: `Login window closed for ${req.params.name}` }); }
    catch (e) { apiErr(res, e); }
  });
  // Enable/disable an account remotely (parity with the desktop On/Off toggle). Body { enabled?:bool } — omit to flip.
  app.post('/api/accounts/:name/toggle', async (req, res) => {
    try {
      if (typeof hooks.toggleAccount !== 'function') return res.json({ success: false, error: 'toggle not supported' });
      await hooks.toggleAccount(req.params.name, req.body && req.body.enabled);
      res.json({ success: true });
    } catch (e) { apiErr(res, e); }
  });

  // Terminal error-handling middleware (AFTER all routes). Body-parser malformed-JSON SyntaxError and multer LIMIT_*
  // errors are raised at the middleware layer BEFORE any route try/catch, so without this they fall to Express's
  // finalhandler which returns err.stack (userData/asar paths) to the possibly-tunnel-exposed client. Route them
  // through the SAME generic-message-only contract as apiErr — log the real error server-side, leak nothing over the wire.
  app.use((err, _req, res, _next) => {
    try { addLog(`API error (mw): ${(err && err.stack) || (err && err.message) || err}`); } catch {}
    const code = (err && (err.status || err.statusCode)) || (err instanceof SyntaxError ? 400 : (err && err.code && String(err.code).startsWith('LIMIT_') ? 413 : 500));
    if (!res.headersSent) res.status(code).json({ success: false, error: 'Operation failed' });
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
async function startTunnel(port, onUrl, onDown) {
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
    // #10: watch for the tunnel CHILD dying AFTER establishment. The in-promise 'exit' handler above is idempotent (a
    // no-op once the URL resolved), so without this a dead trycloudflare quick-tunnel (they exit after hours) is never
    // noticed: activeTunnel points at a dead handle and the caller's tunnelActive flag stays true → a re-enable is a
    // no-op and the remote dashboard 502s for the rest of the run. Surface it so the caller resets + revives.
    if (url) { try { t.on('exit', () => { if (activeTunnel !== t) return; activeTunnel = null; addLog('🌐 Remote tunnel exited (cloudflared child died) — remote access is down until it revives.'); if (typeof onDown === 'function') { try { onDown(); } catch {} } }); } catch {} } // review-fix: gate the WHOLE handler (incl. onDown) on identity — a STALE tunnel's delayed exit must not reset the state of a DIFFERENT live tunnel (would flap the URL + leak cloudflared children over a long run)
    return url;
  } catch (e) { addLog(`🌐 Tunnel unavailable: ${e && e.message ? e.message : e}`); return null; }
}

module.exports = { startServer, stopServer, startTunnel, stopTunnel, addLog };
