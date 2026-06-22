// vps-server/license-server.js
// License validation server for "Za Post Comment Tool". Deploy on your VPS BEHIND AN HTTPS PROXY
// (Coolify/Traefik terminate TLS — see DEPLOY-COOLIFY.md). The desktop app POSTs here on activation
// and on each launch. Pairs with the client in ../lib/license.js.
//
//   npm i express                                    (on the VPS)
//   ADMIN_TOKEN=secret KEYS_ENCRYPTION_KEY=secret2 node license-server.js
//
// Endpoints:
//   GET  /health                              -> 200 { ok:true }                (no auth)
//   POST /api/validate  { license, hwid }     -> { valid, revoked?, tier, maxAccounts, maxGroups, expires }
//   GET  /api/keys                            -> the key store (admin: Authorization: Bearer <ADMIN_TOKEN>)

const express = require('express');
const ks = require('./keystore');

const app = express();
app.use(express.json({ limit: '64kb' }));
app.set('trust proxy', 1); // we sit behind an HTTPS reverse proxy; trust X-Forwarded-* for req.ip

// Dependency-free fixed-window rate limiter (M3-04). Per-IP; throttles brute-force key guessing and
// DoS without pulling in express-rate-limit. Entries self-expire; the map is pruned periodically.
function rateLimiter({ windowMs, max, name }) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [ip, e] of hits) if (now - e.start >= windowMs) hits.delete(ip); }, windowMs).unref();
  return (req, res, next) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    let e = hits.get(ip);
    if (!e || now - e.start >= windowMs) { e = { start: now, count: 0 }; hits.set(ip, e); }
    if (++e.count > max) return res.status(429).json({ valid: false, message: 'Too many requests — slow down.' });
    next();
  };
}

// Admin auth — prefer Authorization: Bearer <ADMIN_TOKEN> (M3-04); the ?admin= query param is a
// DEPRECATED fallback (it leaks into proxy/access logs). 403 when ADMIN_TOKEN is unset.
function adminAuth(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return res.status(403).json({ error: 'admin disabled — set ADMIN_TOKEN' });
  const hdr = req.get('authorization') || '';
  // Header-only (Bearer) — the ?admin= query fallback was removed: query strings leak into Nginx/Cloudflare
  // access logs, exposing ADMIN_TOKEN. Send `Authorization: Bearer <token>`.
  const provided = hdr.startsWith('Bearer ') ? hdr.slice(7).trim() : '';
  if (provided !== token) return res.status(403).json({ error: 'forbidden' });
  next();
}

// Seed the owner key from an env var so the secret never lives in Git. Added once if missing.
try {
  const ownerKey = String(process.env.OWNER_KEY || '').trim().toUpperCase();
  if (ownerKey) {
    const db = ks.load();
    if (!db[ownerKey]) {
      db[ownerKey] = { hwid: null, revoked: false, expires: null, tier: 'owner', note: 'owner', createdAt: 0 };
      ks.save(db); ks.audit('create', ownerKey, 'owner (seeded from env)');
      console.log('Seeded owner key from env');
    }
  }
} catch (e) { console.error('owner seed:', e.message); }

app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

// Validate + bind a license to one machine (HWID). First activation binds; later launches must come
// from the same machine. Revoked/expired keys are rejected. Returns the tier + limits the client
// enforces (per-seat model).
app.post('/api/validate', rateLimiter({ windowMs: 60000, max: 30, name: 'validate' }), (req, res) => {
  const license = String((req.body && req.body.license) || '').trim().toUpperCase();
  const hwid = String((req.body && req.body.hwid) || '').trim();
  let db;
  try { db = ks.load(); } catch (e) { console.error('keys load:', e.message); return res.status(503).json({ valid: false, message: 'Server key store unavailable' }); }
  const rec = db[license];
  if (!rec) return res.json({ valid: false, message: 'Invalid license key' });
  if (rec.revoked) return res.json({ valid: false, revoked: true, message: 'This license has been revoked' });
  if (rec.expires && Date.now() > rec.expires) return res.json({ valid: false, message: 'License expired' });
  const grant = () => ({ valid: true, message: 'OK', tier: rec.tier || 'standard', maxAccounts: rec.maxAccounts, maxGroups: rec.maxGroups, expires: rec.expires || 0 });
  if (!rec.hwid) { rec.hwid = hwid; rec.activatedAt = Date.now(); ks.save(db); ks.audit('bind', license, 'hwid=' + hwid.slice(0, 8)); return res.json({ ...grant(), message: 'Activated' }); }
  if (hwid && rec.hwid !== hwid) return res.json({ valid: false, message: 'License is already active on another device' });
  rec.lastSeen = Date.now(); ks.save(db);
  return res.json(grant());
});

// Admin view of all keys.
app.get('/api/keys', rateLimiter({ windowMs: 60000, max: 20, name: 'keys' }), adminAuth, (_req, res) => {
  try { res.json(ks.load()); } catch (e) { res.status(503).json({ error: 'key store unavailable: ' + e.message }); }
});

const PORT = process.env.PORT || 3509;
if (!ks.isEncryptedAtRest()) console.warn('⚠️  KEYS_ENCRYPTION_KEY is not set — the key store is stored in PLAINTEXT. Set it to encrypt keys.json at rest (see DEPLOY-COOLIFY.md).');
app.listen(PORT, '0.0.0.0', () => console.log('Za Post license server listening on :' + PORT + (ks.isEncryptedAtRest() ? ' (key store encrypted)' : '')));
