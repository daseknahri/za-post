// vps-server/crypto.js
// AES-256-GCM at-rest encryption for the license key store (M3-05). The key is derived from
// KEYS_ENCRYPTION_KEY with scrypt, so any passphrase works. On-disk format when encrypted:
//   { __enc__: 1, salt, iv, tag, ct }   (all base64)
// GCM gives integrity too — a tampered file fails decryption instead of silently loading garbage.
const crypto = require('crypto');

function deriveKey(passphrase, salt) { return crypto.scryptSync(String(passphrase), salt, 32); }

function encrypt(obj, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(obj), 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { __enc__: 1, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: tag.toString('base64'), ct: ct.toString('base64') };
}

function isEncrypted(blob) { return !!(blob && typeof blob === 'object' && blob.__enc__); }

function decrypt(blob, passphrase) {
  const salt = Buffer.from(blob.salt, 'base64');
  const iv = Buffer.from(blob.iv, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const ct = Buffer.from(blob.ct, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8'));
}

module.exports = { encrypt, decrypt, isEncrypted };
