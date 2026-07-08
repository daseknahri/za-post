// vps-server/gen-key.js — generate a new license key and add it to the key store.
//   node gen-key.js "customer name" [days] [tier]
//   node gen-key.js "acme corp" 365 pro      (expires in a year, pro tier)
//   node gen-key.js "trial user" 7 trial
// Omit days (or 0) for no expiry. tier ∈ trial|standard|pro (default standard).
const crypto = require('crypto');
const ks = require('./keystore');
const TIERS = new Set(['trial', 'standard', 'pro', 'owner']);

const note = process.argv[2] || '';
const days = parseInt(process.argv[3] || '0', 10);
const tier = String(process.argv[4] || 'standard').toLowerCase();
if (!TIERS.has(tier)) { console.error(`Unknown tier "${tier}" — use one of: ${[...TIERS].join(', ')}`); process.exit(2); }

const key = crypto.randomBytes(8).toString('hex').slice(0, 16).toUpperCase().match(/.{4}/g).join('-');
let db;
try { db = ks.load(); } catch (e) { console.error('Could not read the key store:', e.message); process.exit(1); }
db[key] = { hwid: null, revoked: false, expires: days > 0 ? Date.now() + days * 86400000 : null, tier, note, createdAt: Date.now() };
try { ks.save(db); ks.audit('create', key, `tier=${tier} note=${note}`); }
catch (e) { console.error('Could not write the key store:', e.message); process.exit(1); }
console.log('New license key:', key);
console.log('  tier:', tier, '| note:', note || '(none)', '| expires:', days > 0 ? days + ' days' : 'never');
console.log('Give this key to the customer. It binds to their machine on first activation.');
