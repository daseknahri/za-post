// lib/license.js
// Client-side licensing: machine-bound per-seat keys with tiered limits and an OFFLINE GRACE
// PERIOD. Model (owner decision, 2026-06-20):
//   - Per-seat tiers: each key maps to a tier → { maxAccounts, maxGroups }, enforced in the backend.
//   - Offline grace: a customer may run for GRACE_MS since the last SUCCESSFUL server validation,
//     then the app locks until it can re-validate. The owner key always works offline (unlimited).
//   - Revocation still takes effect within the grace window on the next successful check.
// The validate/activate/checkCached functions do the I/O; decideFromResponse/decideOffline are the
// PURE decision core (unit-tested in tests/license.test.js).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let axios; try { axios = require('axios'); } catch {}
let machineId; try { machineId = require('node-machine-id').machineIdSync; } catch {}

// sha256 of the OWNER key — it always activates offline (unlimited). Customer keys use the grace cache.
const OFFLINE_ALLOW = new Set(['2d12582d7aea7f9cb1f7167c2ce2f5838fa23f272c3335e3a1d3f5b9bb7bd087']);
const DEFAULT_SERVER = 'http://144.91.127.7:3509';
const VALIDATE_TIMEOUT_MS = 3000;                 // shortened from 6s so a slow server can't stall the gate
const GRACE_MS = 7 * 24 * 60 * 60 * 1000;         // customers may run offline for 7 days since last good check
const UNLIMITED = { maxAccounts: Infinity, maxGroups: Infinity };
// Default tier → limits. Placeholder BUSINESS values — tune to your pricing. The VPS server returns
// a `tier` (and may override with explicit maxAccounts/maxGroups in the validate response).
const TIERS = {
  trial:    { maxAccounts: 3,        maxGroups: 10 },
  standard: { maxAccounts: 25,       maxGroups: 100 },
  pro:      { maxAccounts: 100,      maxGroups: 500 },
  owner:    { maxAccounts: Infinity, maxGroups: Infinity },
};

function hwid() { try { return machineId ? machineId() : require('os').hostname(); } catch { return require('os').hostname(); } }
function normalize(key) { return String(key || '').trim().toUpperCase(); }
function isOwnerKey(key) { return OFFLINE_ALLOW.has(crypto.createHash('sha256').update(normalize(key)).digest('hex')); }
function offlineValid(key) { return isOwnerKey(key); } // back-compat alias
function cacheFile(userData) { return path.join(userData, 'license.json'); }
function readCache(userData) { try { return JSON.parse(fs.readFileSync(cacheFile(userData), 'utf8')); } catch { return null; } }
function writeCache(userData, obj) { try { fs.writeFileSync(cacheFile(userData), JSON.stringify(obj)); } catch {} }
function clearCache(userData) { try { fs.unlinkSync(cacheFile(userData)); } catch {} }

// Coerce a numeric limit; missing / non-positive → unlimited (Infinity).
function lim(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : Infinity; }
// Resolve the effective limits for a tier + any explicit server overrides.
function limitsFor(tier, overrides) {
  const base = TIERS[tier] || UNLIMITED;
  const o = overrides || {};
  const mA = o.maxAccounts != null ? lim(o.maxAccounts) : base.maxAccounts;
  const mG = o.maxGroups != null ? lim(o.maxGroups) : base.maxGroups;
  return { maxAccounts: mA, maxGroups: mG };
}

// Normalize a server /api/validate response into a uniform result. PURE — no I/O. (Unit-tested.)
function decideFromResponse(d, key, now = Date.now()) {
  d = d || {};
  if (d.revoked) return { valid: false, revoked: true, message: d.message || 'License revoked' };
  const expires = d.expires ? Number(d.expires) : 0;
  if (expires && expires < now) return { valid: false, expired: true, message: 'License expired' };
  if (d.valid) {
    if (isOwnerKey(key)) return { valid: true, tier: 'owner', limits: { ...UNLIMITED }, expires, message: d.message || 'Activated' };
    const tier = d.tier || 'standard';
    return { valid: true, tier, limits: limitsFor(tier, d), expires, message: d.message || 'Activated' };
  }
  return { valid: false, message: d.message || 'Invalid license key' };
}

// Decide validity when the server is UNREACHABLE. PURE — no I/O. (Unit-tested.)
//   owner key → valid offline (unlimited); customer → valid only within the grace window and not
//   expired; otherwise fail-closed.
function decideOffline(key, cache, now = Date.now(), graceMs = GRACE_MS) {
  if (isOwnerKey(key)) return { valid: true, offline: true, tier: 'owner', limits: { ...UNLIMITED }, message: 'Activated (offline owner key)' };
  if (cache && normalize(cache.key) === normalize(key) && cache.lastValidated) {
    const expires = Number(cache.expires) || 0;
    if (expires && expires < now) return { valid: false, expired: true, message: 'License expired (offline)' };
    const age = now - Number(cache.lastValidated);
    if (age >= 0 && age <= graceMs) {
      const daysLeft = Math.max(0, Math.ceil((graceMs - age) / 86400000));
      return { valid: true, offline: true, grace: true, tier: cache.tier || 'standard', limits: cache.limits || { ...UNLIMITED }, message: `Offline — using cached license (${daysLeft} day(s) of offline use left)` };
    }
    return { valid: false, message: 'Offline grace period expired — connect to the internet to re-validate your license' };
  }
  return { valid: false, message: 'Could not reach license server' };
}

async function validate(key, serverUrl, userData) {
  key = normalize(key); const id = hwid();
  const url = (serverUrl || DEFAULT_SERVER).replace(/\/+$/, '') + '/api/validate';
  const cache = userData ? readCache(userData) : null;
  if (axios) {
    try {
      const res = await axios.post(url, { license: key, hwid: id }, { timeout: VALIDATE_TIMEOUT_MS });
      return decideFromResponse(res.data, key);
    } catch (e) {
      return decideOffline(key, cache);
    }
  }
  return decideOffline(key, cache);
}

// Persist the cache. lastValidated only advances on a REAL server validation (not offline grace),
// so the grace window can't extend itself.
function persist(userData, key, r, prevLastValidated) {
  const lastValidated = r.offline ? (Number(prevLastValidated) || 0) : Date.now();
  writeCache(userData, { key: normalize(key), hwid: hwid(), ts: Date.now(), lastValidated, tier: r.tier || 'standard', limits: r.limits || { ...UNLIMITED }, expires: r.expires || 0 });
}

async function activate(userData, key, serverUrl) {
  const prev = readCache(userData);
  const r = await validate(key, serverUrl, userData);
  if (r.valid) persist(userData, key, r, prev && prev.lastValidated);
  return r;
}

async function checkCached(userData, serverUrl) {
  const c = readCache(userData);
  if (!c || !c.key) return { valid: false };
  if (c.hwid && c.hwid !== hwid()) return { valid: false, message: 'License is bound to a different machine' };
  const r = await validate(c.key, serverUrl, userData);
  if (r.revoked) { clearCache(userData); return r; }
  if (r.valid) persist(userData, c.key, r, c.lastValidated);
  return r;
}

// Effective limits to enforce given a validation result (Infinity = unlimited).
function limitsOf(result) { return (result && result.limits) || { ...UNLIMITED }; }

module.exports = {
  hwid, validate, activate, checkCached, clearCache, offlineValid, isOwnerKey,
  decideFromResponse, decideOffline, limitsFor, limitsOf,
  DEFAULT_SERVER, GRACE_MS, UNLIMITED, TIERS, VALIDATE_TIMEOUT_MS,
};
