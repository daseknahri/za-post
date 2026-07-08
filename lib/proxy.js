// lib/proxy.js
// E-X3/E-X4: ProxyHealthManager — tracks per-proxy failures and applies a short, exponential
// cool-down so a dead proxy isn't retried instantly every cycle. STRICTLY off the posting critical
// path: it never blocks a post (the worker reports outcomes; the operator/diagnostics consult the
// stats). Optional cross-restart persistence; entries with no activity in the last hour are pruned
// on load so the file can't grow unbounded or resurrect stale state.
const fs = require('fs');

const HOUR = 3600000;
const BASE_COOLDOWN_MS = 5 * 60000;   // 5 min after the first failure, doubles per consecutive fail
const MAX_COOLDOWN_MS = 2 * HOUR;

class ProxyHealthManager {
  constructor() { this.map = new Map(); }

  _rec(proxyStr) {
    let r = this.map.get(proxyStr);
    if (!r) { r = { consecutiveFailCount: 0, lastFail: 0, lastOk: 0, lastReason: '', cooldownUntil: 0 }; this.map.set(proxyStr, r); }
    return r;
  }

  // Record a failure (407 / connection refused / timeout / proxy-chain error). Sets an exponential
  // cool-down so the same dead proxy isn't hammered each cycle.
  markFail(proxyStr, reason, now = Date.now()) {
    if (!proxyStr) return null;
    const r = this._rec(proxyStr);
    r.consecutiveFailCount += 1;
    r.lastFail = now;
    r.lastReason = String(reason || 'unknown');
    r.cooldownUntil = now + Math.min(BASE_COOLDOWN_MS * Math.pow(2, r.consecutiveFailCount - 1), MAX_COOLDOWN_MS);
    return r;
  }

  // Record a success — clears the failure streak and any cool-down.
  markOk(proxyStr, now = Date.now()) {
    if (!proxyStr) return null;
    const r = this._rec(proxyStr);
    r.consecutiveFailCount = 0;
    r.lastOk = now;
    r.lastReason = '';
    r.cooldownUntil = 0;
    return r;
  }

  isOnCooldown(proxyStr, now = Date.now()) {
    const r = this.map.get(proxyStr);
    return !!(r && r.cooldownUntil > now);
  }

  getStats(now = Date.now()) {
    const proxies = [];
    for (const [url, r] of this.map) {
      const onCooldown = r.cooldownUntil > now;
      proxies.push({
        url,
        alive: !onCooldown && r.consecutiveFailCount === 0,
        consecutiveFailCount: r.consecutiveFailCount,
        lastFail: r.lastFail || 0, lastOk: r.lastOk || 0,
        lastReason: r.lastReason || '',
        onCooldownUntil: r.cooldownUntil || 0,
      });
    }
    const summary = {
      total: proxies.length,
      healthy: proxies.filter((p) => p.alive).length,
      failing: proxies.filter((p) => p.consecutiveFailCount > 0).length,
      onCooldown: proxies.filter((p) => p.onCooldownUntil > now).length,
    };
    return { proxies, summary };
  }

  save(path) {
    // Atomic tmp+fsync+rename (mirror store.writeFileAtomic) so a torn/0-byte write can't corrupt proxy-health.json.
    try {
      const data = JSON.stringify({ v: 1, savedAt: Date.now(), entries: [...this.map.entries()] }, null, 2);
      const tmp = path + '.tmp';
      const fd = fs.openSync(tmp, 'w');
      try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, path);
      return true;
    } catch { return false; }
  }

  // Load from disk, pruning entries with no activity in the last hour (stale).
  load(path, now = Date.now()) {
    try {
      const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
      const entries = Array.isArray(raw.entries) ? raw.entries : [];
      this.map = new Map();
      for (const [url, r] of entries) {
        if (!url || !r) continue;
        const last = Math.max(Number(r.lastFail) || 0, Number(r.lastOk) || 0);
        if (now - last > HOUR) continue; // prune stale
        this.map.set(url, {
          consecutiveFailCount: Number(r.consecutiveFailCount) || 0,
          lastFail: Number(r.lastFail) || 0, lastOk: Number(r.lastOk) || 0,
          lastReason: String(r.lastReason || ''), cooldownUntil: Number(r.cooldownUntil) || 0,
        });
      }
      return true;
    } catch { return false; }
  }
}

module.exports = { ProxyHealthManager, BASE_COOLDOWN_MS, MAX_COOLDOWN_MS };
