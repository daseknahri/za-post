#!/usr/bin/env node
// gen-signing-key.js — mint the Ed25519 pair that licence grants are signed with.
//
// The PRIVATE half lives ONLY on the VPS (env LICENSE_SIGNING_KEY). Whoever holds it can mint a valid licence for
// any machine, so it must never enter Git, a screenshot, or a client build.
// The PUBLIC half is compiled into the client as LICENSE_PUBKEY in lib/license.js.
//
// Run this ONCE. Regenerating invalidates every licence already issued: existing clients carry the OLD public key,
// so tokens signed by a new private key fail verification and every customer is locked out at their next check.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, 'signing-key.pem');
if (fs.existsSync(out) && !process.argv.includes('--force')) {
  console.error(`\nRefusing to overwrite ${out}\n  A pair already exists. Overwriting it locks out every client built against the current public key.\n  Pass --force only if you intend exactly that.\n`);
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pubPem = publicKey.export({ type: 'spki', format: 'pem' });

fs.writeFileSync(out, privPem, { mode: 0o600 });

console.log('\n1) VPS environment variable (Coolify → Environment Variables):\n');
console.log('LICENSE_SIGNING_KEY=' + Buffer.from(privPem).toString('base64'));
console.log('\n2) Paste this PUBLIC key into lib/license.js as LICENSE_PUBKEY, then rebuild the client:\n');
console.log(JSON.stringify(String(pubPem).trim().replace(/\r\n/g, '\n')));
console.log(`\nPrivate key also written to ${out} (git-ignored). Delete it once the env var is set on the server.\n`);
