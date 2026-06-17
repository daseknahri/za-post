const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let axios; try { axios = require('axios'); } catch {}
let machineId; try { machineId = require('node-machine-id').machineIdSync; } catch {}

// sha256 of valid offline keys — lets the owner activate without the VPS reachable.
const OFFLINE_ALLOW = new Set(['2d12582d7aea7f9cb1f7167c2ce2f5838fa23f272c3335e3a1d3f5b9bb7bd087']);
const DEFAULT_SERVER = 'http://144.91.127.7:3509';

function hwid() { try { return machineId ? machineId() : require('os').hostname(); } catch { return require('os').hostname(); } }
function normalize(key) { return String(key || '').trim().toUpperCase(); }
function offlineValid(key) { return OFFLINE_ALLOW.has(crypto.createHash('sha256').update(normalize(key)).digest('hex')); }
function cacheFile(userData) { return path.join(userData, 'license.json'); }
function readCache(userData) { try { return JSON.parse(fs.readFileSync(cacheFile(userData), 'utf8')); } catch { return null; } }
function writeCache(userData, obj) { try { fs.writeFileSync(cacheFile(userData), JSON.stringify(obj)); } catch {} }
function clearCache(userData) { try { fs.unlinkSync(cacheFile(userData)); } catch {} }

async function validate(key, serverUrl) {
  key = normalize(key); const id = hwid();
  const url = (serverUrl || DEFAULT_SERVER).replace(/\/+$/, '') + '/api/validate';
  if (axios) {
    try {
      const res = await axios.post(url, { license: key, hwid: id }, { timeout: 6000 });
      const d = res.data || {};
      if (d.revoked) return { valid: false, revoked: true, message: d.message || 'License revoked' };
      if (d.valid) return { valid: true, message: d.message || 'Activated' };
      return { valid: false, message: d.message || 'Invalid license key' };
    } catch (e) {
      if (offlineValid(key)) return { valid: true, offline: true, message: 'Activated (offline)' };
      return { valid: false, message: 'Could not reach license server' };
    }
  }
  return offlineValid(key) ? { valid: true, offline: true } : { valid: false, message: 'No validator available' };
}
async function activate(userData, key, serverUrl) {
  const r = await validate(key, serverUrl);
  if (r.valid) writeCache(userData, { key: normalize(key), hwid: hwid(), ts: Date.now() });
  return r;
}
async function checkCached(userData, serverUrl) {
  const c = readCache(userData);
  if (!c || !c.key) return { valid: false };
  if (c.hwid && c.hwid !== hwid()) return { valid: false, message: 'License is bound to a different machine' };
  const r = await validate(c.key, serverUrl);
  if (r.revoked) clearCache(userData);
  return r;
}
module.exports = { hwid, validate, activate, checkCached, clearCache, offlineValid, DEFAULT_SERVER };
