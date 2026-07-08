// scripts/diagnose-proxies.js — offline proxy validator (E-X4).
//   node scripts/diagnose-proxies.js [--profile=base]
// Reads the proxy list (pool + per-account) from data.json, validates each one's FORMAT, and
// TCP-connects to its host:port to see if it's reachable. This is a first-pass health check — a
// reachable proxy can still reject auth. DO NOT run while automation is active (it reads the proxy
// list that the running app may be writing).
const net = require('net');
const fs = require('fs');
const path = require('path');
const { parseProxy } = require('../automation/worker');

function userDataDir() {
  const profile = (process.argv.find((a) => a.startsWith('--profile=')) || '').split('=')[1] || process.env.ZA_PROFILE;
  const name = profile ? `za-post-restored-${profile}` : 'za-post-restored';
  const appData = process.env.APPDATA || path.join(process.env.HOME || '', '.config');
  return path.join(appData, name);
}

function loadProxies() {
  const file = process.env.ZA_DATA || path.join(userDataDir(), 'data.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const pool = Array.isArray(data.proxies) ? data.proxies : [];
  const perAccount = (data.accounts || []).map((a) => a.proxy).filter((p) => p && String(p).trim());
  return [...new Set([...pool, ...perAccount])];
}

function tcpCheck(host, port, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const fin = (ok, reason) => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve({ ok, reason }); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => fin(true, 'reachable'));
    sock.once('timeout', () => fin(false, 'timeout'));
    sock.once('error', (e) => fin(false, e.code || e.message));
    try { sock.connect(port, host); } catch (e) { fin(false, e.message); }
  });
}

(async () => {
  let proxies;
  try { proxies = loadProxies(); }
  catch (e) { console.error('Could not read the proxy list:', e.message); process.exit(1); }
  if (!proxies.length) { console.log('No proxies configured.'); process.exit(0); }
  console.log(`Checking ${proxies.length} proxy(ies) — TCP reachability only (not a full auth/egress test)\n`);
  let alive = 0, dead = 0, bad = 0;
  for (const str of proxies) {
    const p = parseProxy(str);
    if (!p) { console.log(`  ✗ INVALID  ${str}`); bad++; continue; }
    const host = p.server.replace(/^\w+:\/\//, '').split(':')[0];
    const port = Number(p.server.split(':').pop());
    const r = await tcpCheck(host, port);
    if (r.ok) { console.log(`  ✓ alive    ${p.server}`); alive++; }
    else { console.log(`  ✗ DEAD     ${p.server}  (${r.reason})`); dead++; }
  }
  console.log(`\n${alive} alive, ${dead} dead, ${bad} invalid (of ${proxies.length}).`);
  console.log('Note: TCP-reachable ≠ working (a reachable proxy can still reject auth). Do not run while automation is active.');
  process.exit(dead || bad ? 1 : 0);
})();
