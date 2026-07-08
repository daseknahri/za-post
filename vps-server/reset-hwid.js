// vps-server/reset-hwid.js — unbind a license key from its machine so the client can RE-ACTIVATE on a new PC
// (new computer, reinstall, disk swap). Keeps the key active + its tier/expiry; only clears the hwid binding.
//   node reset-hwid.js AAAA-BBBB-CCCC-DDDD
// Exit codes: 0 = ok, 2 = usage / key-not-found, 1 = I/O error.
const ks = require('./keystore');

const key = String(process.argv[2] || '').trim().toUpperCase();
if (!key) { console.error('Usage: node reset-hwid.js <KEY>'); process.exit(2); }

let db;
try { db = ks.load(); }
catch (e) { console.error('Could not read the key store:', e.message); process.exit(1); }

if (!db[key]) { console.error('Key not found:', key); process.exit(2); }

const had = db[key].hwid || null;
db[key].hwid = null; // next activation on ANY machine re-binds it

try { ks.save(db); ks.audit('reset-hwid', key, had ? `was bound (${String(had).slice(0, 12)}…)` : 'was already unbound'); }
catch (e) { console.error('Could not write the key store:', e.message); process.exit(1); }

console.log(key, '-> machine binding cleared. The client can now activate on a new machine (it re-binds on next launch).');
