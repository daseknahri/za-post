// vps-server/gen-key.js — generate a new license key and add it to keys.json.
//   node gen-key.js "customer name" [days]
//   node gen-key.js "acme corp" 365      (expires in a year)
//   node gen-key.js "trial user" 7
// Omit days (or 0) for no expiry.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const KEYS = process.env.KEYS_PATH || path.join(__dirname, 'keys.json');
const note = process.argv[2] || '';
const days = parseInt(process.argv[3] || '0', 10);

const key = crypto.randomBytes(8).toString('hex').slice(0, 16).toUpperCase().match(/.{4}/g).join('-');
let db = {}; try { db = JSON.parse(fs.readFileSync(KEYS, 'utf8')); } catch {}
db[key] = { hwid: null, revoked: false, expires: days > 0 ? Date.now() + days * 86400000 : null, note, createdAt: Date.now() };
fs.writeFileSync(KEYS, JSON.stringify(db, null, 2));
console.log('New license key:', key);
console.log('  note:', note || '(none)', '| expires:', days > 0 ? days + ' days' : 'never');
console.log('Give this key to the customer. It binds to their machine on first activation.');
