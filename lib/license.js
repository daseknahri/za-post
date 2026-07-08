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
const OFFLINE_ALLOW = new Set(['1d61961cd26bde29253326e1a464b034390ceb517466107e5a20928eda2cade1']);
// Server URL: an env var (baked by the build's start.bat, e.g. LICENSE_SERVER_URL=https://license.yourdomain.com)
// wins; otherwise the raw-IP fallback. The runtime License-screen "Server URL" override (licenseServerUrl in
// main.js) still takes precedence over this, so a client can also point it without a rebuild.
const DEFAULT_SERVER = process.env.LICENSE_SERVER_URL || 'https://lisence.ibnbatoutaweb.com';
const VALIDATE_TIMEOUT_MS = 3000;                 // shortened from 6s so a slow server can't stall the gate
const GRACE_MS = 7 * 24 * 60 * 60 * 1000;         // customers may run offline for 7 days since last good check
const UNLIMITED = { maxAccounts: Infinity, maxGroups: Infinity };
// Tier NAMES are kept for display/reporting, but ALL tiers are UNLIMITED on account/group count (owner
// decision 2026-06-26 — pure PER-SEAT licensing: the key controls access / expiry / device-lock / revocation,
// NOT how many accounts or groups you run).
const TIERS = {
  trial:    { ...UNLIMITED },
  standard: { ...UNLIMITED },
  pro:      { ...UNLIMITED },
  owner:    { ...UNLIMITED },
};

function hwid() { try { return machineId ? machineId() : require('os').hostname(); } catch { return require('os').hostname(); } }
function normalize(key) { return String(key || '').trim().toUpperCase(); }
function isOwnerKey(key) { return OFFLINE_ALLOW.has(crypto.createHash('sha256').update(normalize(key)).digest('hex')); }
function offlineValid(key) { return isOwnerKey(key); } // back-compat alias
function cacheFile(userData) { return path.join(userData, 'license.json'); }
function readCache(userData) {
  // Split READ from PARSE (same hazard store.load() handles): a TRANSIENT Windows lock (Defender/OneDrive/indexer,
  // or the writeCache .tmp→rename window) on an EXISTING, intact license.json must NOT read as "no license" — that
  // bypasses the offline grace and, worse, STOPS a running campaign at the ~6h re-check. Only a genuinely ABSENT
  // file (ENOENT) is "not activated". An existing-but-unreadable/garbled file returns a sentinel the caller treats
  // as AMBIGUOUS (never as valid → no enforcement bypass for a planted unreadable file).
  let txt;
  try { txt = fs.readFileSync(cacheFile(userData), 'utf8'); }
  catch (e) { return (e && e.code === 'ENOENT') ? null : { __unreadable: true }; }
  try { return JSON.parse(txt); } catch { return { __unreadable: true }; }
}
function writeCache(userData, obj) { try { const f = cacheFile(userData); const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, f); } catch {} } // atomic tmp+rename so a crash/power-loss can't leave a zero-byte/partial license.json (which would force re-activation)
function clearCache(userData) { try { fs.unlinkSync(cacheFile(userData)); } catch {} }

// Effective limits — ALWAYS unlimited now (pure per-seat). Tier base, server overrides, and cached limits are
// all ignored for COUNTING; the license still gates ACCESS (valid / expiry / device-lock / revocation / grace).
function limitsFor(/* tier, overrides */) {
  return { ...UNLIMITED };
}

// Normalize a server /api/validate response into a uniform result. PURE — no I/O. (Unit-tested.)
function decideFromResponse(d, key, now = Date.now()) {
  d = d || {};
  // The OWNER key is the master key — ALWAYS valid, regardless of the server's verdict (never hwid-locked, never
  // "active on another device", never revoked). The owner uses it across machines + to verify builds.
  if (isOwnerKey(key)) return { valid: true, tier: 'owner', limits: { ...UNLIMITED }, expires: 0, message: 'Activated (owner)' };
  if (d.revoked) return { valid: false, revoked: true, message: d.message || 'License revoked' };
  const expires = d.expires ? Number(d.expires) : 0;
  if (expires && expires < now) return { valid: false, expired: true, message: 'License expired' };
  if (d.valid) {
    // (owner keys already returned at the top) — customers map their server tier → limits.
    const tier = d.tier || 'standard';
    return { valid: true, tier, limits: limitsFor(tier, d), expires, message: d.message || 'Activated' };
  }
  return { valid: false, message: d.message || 'Invalid license key' };
}

// Decide validity when the server is UNREACHABLE. PURE — no I/O. (Unit-tested.)
//   owner key → valid offline (unlimited); customer → valid only within the grace window and not
//   expired; otherwise fail-closed.
function decideOffline(key, cache, now = Date.now(), graceMs = GRACE_MS, currentHwid = null) {
  if (isOwnerKey(key)) return { valid: true, offline: true, tier: 'owner', limits: { ...UNLIMITED }, message: 'Activated (offline owner key)' };
  if (cache && normalize(cache.key) === normalize(key) && cache.lastValidated) {
    // Device-lock on the OFFLINE path too: a cached customer license is valid ONLY on the machine it was bound to.
    // currentHwid is injected by validate(); it defaults to null so the PURE unit tests opt out. Fail closed on a
    // missing/mismatched cached hwid (persist() always writes the real hwid → absent = tampered to dodge the lock).
    if (currentHwid && cache.hwid !== currentHwid) return { valid: false, message: 'License is bound to a different machine' };
    const expires = Number(cache.expires) || 0;
    if (expires && expires < now) return { valid: false, expired: true, message: 'License expired (offline)' };
    const age = now - Number(cache.lastValidated);
    // NB: no `age >= 0` guard. A BACKWARD clock correction (NTP/manual/CMOS) makes now < lastValidated → age < 0;
    // rejecting that wrongly locks out a genuine offline client still well within grace. The forward-clock
    // anti-extension bound (age <= graceMs) is kept, and lastValidated only advances on a REAL server check, so the
    // grace window still can't self-extend. (Math.max(0, age) keeps the days-left readout from exceeding the full grace.)
    if (age <= graceMs) {
      const daysLeft = Math.max(0, Math.ceil((graceMs - Math.max(0, age)) / 86400000));
      return { valid: true, offline: true, grace: true, tier: cache.tier || 'standard', limits: { ...UNLIMITED }, message: `Offline — using cached license (${daysLeft} day(s) of offline use left)` };
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
      return decideOffline(key, cache, undefined, undefined, id);
    }
  }
  return decideOffline(key, cache, undefined, undefined, id);
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
  // A transient lock on an EXISTING license.json → ambiguous, NOT invalid. valid:false keeps a non-payer out (a real
  // missing file is ENOENT→null→invalid below), but the `unreadable` flag tells callers (esp. the ~6h re-validator)
  // NOT to tear down a running campaign — just retry next cycle once the lock clears.
  if (c && c.__unreadable) return { valid: false, unreadable: true, message: 'License file temporarily unreadable — will re-check' };
  if (!c || !c.key) return { valid: false };
  if (!c.hwid || c.hwid !== hwid()) return { valid: false, message: 'License is bound to a different machine' }; // fail CLOSED: a missing cached hwid = tampered (persist() ALWAYS writes one)
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
