// lib/secret.js
// Encrypt secrets (Facebook account email/password) at rest with Electron's safeStorage — OS-backed
// encryption (Windows DPAPI / macOS Keychain / Linux libsecret) tied to the OS user, with no key for
// us to manage or leak. (M3-01.) Graceful by design: outside the Electron main process (standalone
// scripts, tests) encryption is unavailable, so values pass through as plaintext and any LEGACY
// plaintext already in data.json stays readable. Encrypted values carry an `enc:v1:` marker, so
// decrypt is transparent and idempotent.
let safeStorage;
try { const e = require('electron'); safeStorage = e && e.safeStorage; } catch {}

const PREFIX = 'enc:v1:';

function available() {
  try { return !!(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable()); }
  catch { return false; }
}

// Encrypt a string for at-rest storage. Returns the value UNCHANGED when it's empty, already
// encrypted, or when OS encryption isn't available (dev/standalone) — so we never lose data.
function encrypt(plain) {
  if (plain == null || plain === '') return plain;
  const s = String(plain);
  if (s.startsWith(PREFIX)) return s; // already encrypted — idempotent
  if (!available()) return s;
  try { return PREFIX + safeStorage.encryptString(s).toString('base64'); } catch { return s; }
}

// Decrypt a stored value. Legacy plaintext (no marker) is returned as-is. An encrypted value that
// can't be decrypted here (no safeStorage / different OS user) returns '' so we never type ciphertext.
function decrypt(stored) {
  if (stored == null) return stored;
  const s = String(stored);
  if (!s.startsWith(PREFIX)) return stored;
  if (!available()) return '';
  try { return safeStorage.decryptString(Buffer.from(s.slice(PREFIX.length), 'base64')); } catch { return ''; }
}

function isEncrypted(stored) { return typeof stored === 'string' && stored.startsWith(PREFIX); }

module.exports = { encrypt, decrypt, isEncrypted, available };
