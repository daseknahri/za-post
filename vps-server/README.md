# License Server (VPS side)

The desktop app's license gate (`../lib/license.js`) validates keys against this server
and binds each key to one machine (HWID). Deploy this on your VPS (the one at
`144.91.127.7:3509`, or any host the app's License → Settings points to).

## Deploy
```bash
# on the VPS, in this folder
npm init -y && npm i express
ADMIN_TOKEN=pick-a-secret node license-server.js     # listens on :3509 (or $PORT)
# keep it running with pm2/systemd, e.g.:  pm2 start license-server.js --name za-license
```
If the existing server at `:3509` is already serving the old `/api/automation-script`,
either add the `/api/validate` route from `license-server.js` into it, or run this on a
different port and point the app there (License screen → ⚙ Settings → Server URL).

## Manage keys
```bash
node gen-key.js "customer name"        # new key, no expiry  -> prints the key
node gen-key.js "trial" 7              # new key, expires in 7 days
node revoke.js  AAAA-BBBB-CCCC-DDDD    # revoke a key (app shows revoked.html)
node revoke.js  AAAA-... --unbind      # revoke + clear machine binding
node revoke.js  AAAA-... --restore     # un-revoke
curl "http://localhost:3509/api/keys?admin=pick-a-secret"   # list all keys
```

## How it works
- App POSTs `{ license, hwid }` to `/api/validate` on activation and each launch.
- First activation **binds** the key to that machine's HWID; later launches from a
  different machine are refused (`License already in use on another device`).
- `revoked` keys return `{ revoked: true }` → the app shows the "revoked" screen.
- If the server is **unreachable**, the app falls back to an offline allow-list (only the
  pre-embedded owner key works offline; customer keys require the server).

## Keys
- `keys.json` is the store (seeded with your **owner key**). Back it up.
- The owner key also works offline (its hash is embedded in the client).
- The HMAC `SERVER_SECRET` from setup is only needed if you switch to signed-token keys later.
