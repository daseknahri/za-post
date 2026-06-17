// vps-server/revoke.js — revoke (or un-revoke) a license key.
//   node revoke.js AAAA-BBBB-CCCC-DDDD          (revoke)
//   node revoke.js AAAA-BBBB-CCCC-DDDD --unbind (revoke + clear its machine binding so it can re-activate)
//   node revoke.js AAAA-BBBB-CCCC-DDDD --restore (un-revoke)
const fs = require('fs'), path = require('path');
const KEYS = process.env.KEYS_PATH || path.join(__dirname, 'keys.json');
const key = String(process.argv[2] || '').trim().toUpperCase();
const db = JSON.parse(fs.readFileSync(KEYS, 'utf8'));
if (!db[key]) { console.log('Key not found:', key); process.exit(1); }
if (process.argv.includes('--restore')) db[key].revoked = false;
else db[key].revoked = true;
if (process.argv.includes('--unbind')) db[key].hwid = null;
fs.writeFileSync(KEYS, JSON.stringify(db, null, 2));
console.log(key, '->', db[key].revoked ? 'REVOKED' : 'active', db[key].hwid ? '(bound)' : '(unbound)');
