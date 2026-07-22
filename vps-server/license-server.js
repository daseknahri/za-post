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
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ks = require('./keystore');

// ── LICENCE SIGNING KEY ──────────────────────────────────────────────────────────────────────────────────────────────
// The client refuses any grant that is not signed by this key, so an unsigned server is a server that activates
// nobody. Load it from LICENSE_SIGNING_KEY (base64 of the PKCS8 PEM) or ./signing-key.pem, and REFUSE TO BOOT if it
// is missing: a server that will not start is loudly broken and gets noticed during deploy, whereas one that quietly
// serves unsigned grants would look healthy while every customer drifted into lockout as their grace ran out.
// Never auto-generate — the public half is compiled into shipped clients, so the pair must be fixed and deliberate.
function loadSigningKey() {
  const b64 = String(process.env.LICENSE_SIGNING_KEY || '').trim();
  let pem = null;
  if (b64) { try { pem = Buffer.from(b64, 'base64').toString('utf8'); } catch { pem = null; } }
  if (!pem) { const f = path.join(__dirname, 'signing-key.pem'); if (fs.existsSync(f)) pem = fs.readFileSync(f, 'utf8'); }
  if (!pem || !/BEGIN (PRIVATE|ED25519 PRIVATE) KEY/.test(pem)) {
    console.error('\nFATAL: no licence signing key.\n  Set LICENSE_SIGNING_KEY (base64 of the PKCS8 PEM) or place signing-key.pem beside this file.\n  Generate a pair with:  node gen-signing-key.js\n  The PUBLIC half must match LICENSE_PUBKEY compiled into the client, or nobody can activate.\n');
    process.exit(1);
  }
  try { return crypto.createPrivateKey(pem); }
  catch (e) { console.error('\nFATAL: licence signing key is unreadable: ' + e.message + '\n'); process.exit(1); }
}
const SIGNING_KEY = loadSigningKey();

// Mint a signed grant. The payload binds the licence to ONE machine and ONE moment; the client verifies the
// signature over the encoded token, so no field inside it can be edited after the fact.
function signGrant({ license, hwid, tier, expires, nonce }) {
  const payload = { v: 1, key: String(license).toUpperCase(), hwid: String(hwid || ''), tier: tier || 'standard', iat: Date.now(), exp: Number(expires) || 0, nonce: String(nonce || '') };
  const token = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.sign(null, Buffer.from(token, 'utf8'), SIGNING_KEY).toString('base64');
  return { token, sig };
}

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
  // Echo the client's nonce inside the signed token so this response cannot be replayed to activate a second
  // install. Capped — it is opaque to us and only ever compared for equality.
  const nonce = String((req.body && req.body.nonce) || '').trim().slice(0, 64);
  const grant = () => ({
    valid: true, message: 'OK', tier: rec.tier || 'standard', maxAccounts: rec.maxAccounts, maxGroups: rec.maxGroups, expires: rec.expires || 0,
    // Sign against the BOUND machine, not merely the requesting one, so the token can never attest to a device the
    // key store did not actually bind.
    ...signGrant({ license, hwid: rec.hwid || hwid, tier: rec.tier, expires: rec.expires, nonce }),
  });
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
