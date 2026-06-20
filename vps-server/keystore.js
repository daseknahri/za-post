// vps-server/keystore.js
// Shared load/save/audit for the license key store, used by license-server.js, gen-key.js and
// revoke.js so all three agree on the on-disk format. When KEYS_ENCRYPTION_KEY is set the store is
// AES-256-GCM encrypted at rest (M3-05); otherwise it stays plaintext (back-compat). Env is read
// lazily so a process can point KEYS_PATH/KEYS_ENCRYPTION_KEY wherever it needs.
const fs = require('fs');
const path = require('path');
const kc = require('./crypto');

function keysPath() { return process.env.KEYS_PATH || path.join(__dirname, 'keys.json'); }
function encKey() { return process.env.KEYS_ENCRYPTION_KEY || ''; }
function isEncryptedAtRest() { return !!encKey(); }

// Load the store. Returns {} only when the file does not exist yet (first run). A parse/decrypt
// failure THROWS — we must never silently treat a corrupt/wrong-key store as empty and overwrite it.
function load() {
  const file = keysPath();
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e && e.code === 'ENOENT') return {}; throw e; }
  const raw = JSON.parse(txt);
  if (kc.isEncrypted(raw)) {
    if (!encKey()) throw new Error('keys store is encrypted but KEYS_ENCRYPTION_KEY is not set');
    return kc.decrypt(raw, encKey());
  }
  return raw && typeof raw === 'object' ? raw : {};
}

function save(db) {
  const file = keysPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const out = encKey() ? kc.encrypt(db, encKey()) : db;
  // Atomic-ish: write a temp file then rename so a crash mid-write can't truncate the store.
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
  fs.renameSync(tmp, file);
}

function auditPath() { return path.join(path.dirname(keysPath()), 'key-audit.log'); }
// Append a tamper-evident-ish audit line for key lifecycle events (create/bind/revoke/restore).
// The license is truncated so the log itself isn't a key dump.
function audit(event, license, detail) {
  try { fs.appendFileSync(auditPath(), JSON.stringify({ ts: new Date().toISOString(), event, key: String(license || '').slice(0, 4) + '…', detail: detail || '' }) + '\n'); } catch {}
}

module.exports = { load, save, audit, keysPath, isEncryptedAtRest };
