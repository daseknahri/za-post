// lib/chrome-bridge.js — a tiny localhost-only HTTP receiver for the "Import from Chrome" companion extension.
//
// WHY: modern Chrome (v127+) App-Bound-Encrypts the session cookies (c_user/xs, "v20"), so they can ONLY be read
// inside the real running Chrome — a folder copy or direct DPAPI/SQLite read gets the account logged OUT. The
// companion extension runs INSIDE Chrome, reads the full Facebook cookie set (incl. datr) via the sanctioned
// chrome.cookies API, and POSTs it here. This receiver hands each payload to onImport() which creates/updates the
// matching account and writes its cookie jar — so the app's own Chromium can run the account with the SAME device
// identity (datr) + session, on the same IP, with no re-login (no "new device" checkpoint).
//
// SECURITY: bound to 127.0.0.1 ONLY, token-gated (the token is baked into the generated extension), body-size capped.
'use strict';
const http = require('http');

function startBridge({ port, token, onImport, log }) {
  const say = (m) => { try { if (log) log(m); } catch {} };
  const server = http.createServer((req, res) => {
    // The extension has host_permissions for 127.0.0.1 so it bypasses CORS; these headers are belt-and-suspenders.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-bridge-token');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    // Health probe the extension can use to confirm the app is up (no token needed — returns nothing sensitive).
    if (req.method === 'GET' && req.url === '/ping') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, app: 'za-post-chrome-bridge' })); }
    if (req.method !== 'POST' || req.url !== '/bridge') { res.writeHead(404); return res.end('not found'); }

    let body = '';
    let aborted = false;
    req.on('data', (c) => { body += c; if (body.length > 6 * 1024 * 1024) { aborted = true; try { res.writeHead(413); res.end(); } catch {} req.destroy(); } });
    req.on('end', async () => {
      if (aborted) return;
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'bad json' })); }
      // Constant-time-ish token check (length guard + strict compare). Missing/mismatched token → 401, never imports.
      const tok = String((payload && payload.token) || req.headers['x-bridge-token'] || '');
      if (!token || tok.length !== String(token).length || tok !== String(token)) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
      try {
        const r = await onImport(payload);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(Object.assign({ ok: true }, r || {})));
      } catch (e) {
        say('Chrome bridge import failed: ' + ((e && e.message) || e));
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: (e && e.message) || 'import failed' }));
      }
    });
    req.on('error', () => { try { res.destroy(); } catch {} });
  });
  server.on('error', (e) => say('Chrome bridge server error: ' + ((e && e.message) || e)));
  server.listen(port, '127.0.0.1', () => say(`Chrome import bridge listening on 127.0.0.1:${port}`));
  return server;
}

// Map a Chrome cookie (chrome.cookies.getAll shape) → the app's stored cookie shape (what store.writeCookies keeps and
// the worker injects via normalizeCookie). Chrome sameSite: 'no_restriction'|'lax'|'strict'|'unspecified'.
function mapChromeCookie(c) {
  if (!c || !c.name || c.value == null || String(c.value) === '') return null; // drop empty-value cookies (mirrors import-cookies/bulk; keeps the jar clean + the xs-presence check honest)
  const ss = String(c.sameSite || '').toLowerCase();
  const sameSite = ss === 'no_restriction' ? 'None' : ss === 'lax' ? 'Lax' : ss === 'strict' ? 'Strict' : undefined;
  const out = {
    name: String(c.name),
    value: String(c.value),
    domain: c.domain ? String(c.domain) : '.facebook.com',
    path: c.path ? String(c.path) : '/',
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
  };
  if (sameSite) out.sameSite = sameSite;
  if (typeof c.expirationDate === 'number' && isFinite(c.expirationDate)) out.expires = Math.floor(c.expirationDate);
  return out;
}

module.exports = { startBridge, mapChromeCookie };
