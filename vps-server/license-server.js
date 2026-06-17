// vps-server/license-server.js
// License validation server for "Za Post Comment Tool".
// Deploy on your VPS (e.g. 144.91.127.7:3509). The desktop app POSTs here on activation
// and on each launch. Pairs with the client in ../lib/license.js.
//
//   npm i express        (on the VPS)
//   ADMIN_TOKEN=somesecret node license-server.js
//
// Endpoints:
//   POST /api/validate  { license, hwid }  -> { valid, revoked?, message }
//   GET  /api/keys?admin=<ADMIN_TOKEN>      -> the key store (admin only)

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// Key store path — set KEYS_PATH to a PERSISTENT volume (e.g. /data/keys.json on Coolify)
// so keys + machine bindings survive redeploys. On first run, seed it from the bundled file.
const KEYS = process.env.KEYS_PATH || path.join(__dirname, 'keys.json');
try {
  if (!fs.existsSync(KEYS)) {
    fs.mkdirSync(path.dirname(KEYS), { recursive: true });
    const seed = path.join(__dirname, 'keys.json');
    fs.writeFileSync(KEYS, (KEYS !== seed && fs.existsSync(seed)) ? fs.readFileSync(seed) : '{}');
  }
} catch (e) { console.error('keys init:', e.message); }
const load = () => { try { return JSON.parse(fs.readFileSync(KEYS, 'utf8')); } catch { return {}; } };
const save = (d) => fs.writeFileSync(KEYS, JSON.stringify(d, null, 2));

// Seed the owner key from an env var so the secret never lives in Git.
// Set OWNER_KEY in Coolify to your owner license key. Added once if missing.
try {
  const ownerKey = String(process.env.OWNER_KEY || '').trim().toUpperCase();
  if (ownerKey) {
    const db = load();
    if (!db[ownerKey]) {
      db[ownerKey] = { hwid: null, revoked: false, expires: null, note: 'owner', createdAt: 0 };
      save(db);
      console.log('Seeded owner key from env');
    }
  }
} catch (e) { console.error('owner seed:', e.message); }

// Validate + bind a license to one machine (HWID). First activation binds; later launches
// must come from the same machine. Revoked/expired keys are rejected.
app.post('/api/validate', (req, res) => {
  const license = String((req.body && req.body.license) || '').trim().toUpperCase();
  const hwid = String((req.body && req.body.hwid) || '').trim();
  const db = load();
  const rec = db[license];
  if (!rec) return res.json({ valid: false, message: 'Invalid license key' });
  if (rec.revoked) return res.json({ valid: false, revoked: true, message: 'This license has been revoked' });
  if (rec.expires && Date.now() > rec.expires) return res.json({ valid: false, message: 'License expired' });
  if (!rec.hwid) { rec.hwid = hwid; rec.activatedAt = Date.now(); save(db); return res.json({ valid: true, message: 'Activated' }); }
  if (hwid && rec.hwid !== hwid) return res.json({ valid: false, message: 'License is already active on another device' });
  rec.lastSeen = Date.now(); save(db);
  return res.json({ valid: true, message: 'OK' });
});

// Admin view of all keys (protect ADMIN_TOKEN; set it via env).
app.get('/api/keys', (req, res) => {
  if (!process.env.ADMIN_TOKEN || req.query.admin !== process.env.ADMIN_TOKEN) return res.status(403).json({ error: 'forbidden' });
  res.json(load());
});

const PORT = process.env.PORT || 3509;
app.listen(PORT, '0.0.0.0', () => console.log('Za Post license server listening on :' + PORT));
