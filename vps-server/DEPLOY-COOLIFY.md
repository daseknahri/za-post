# Deploy the license server on Hostinger VPS via Coolify

This folder is the license-validation server for the desktop app. The app POSTs
`{ license, hwid }` to `/api/validate` on activation and each launch.

## The one thing that matters most
`keys.json` (your keys + machine bindings) **must live on a persistent volume**, or it
resets every redeploy and all activations are lost. The Dockerfile sets `KEYS_PATH=/data/keys.json`
— you just mount a volume at **`/data`** in Coolify (Step 4).

The real `keys.json` is **gitignored** (it holds your owner key — never goes to GitHub). The
volume starts empty; the server seeds your owner key on first boot from the **`OWNER_KEY`** env
var (Step 5). Customer keys are created later with `gen-key.js` on the server.

---

## Step 1 — Repo
The whole project lives at `github.com/daseknahri/za-post` (this `vps-server/` is a subfolder).
The real `keys.json` is gitignored, so no secret is published — but keep the repo **private**
anyway, since it holds your sellable app source.

## Step 2 — New resource in Coolify
- **+ New → Application → Private Repository** → pick `daseknahri/za-post`, branch `main`.
- **Base Directory** = `/vps-server` ← important: tells Coolify to build from the subfolder.
- **Build Pack: Dockerfile** (auto-detected at `vps-server/Dockerfile`). (Nixpacks also works via `package.json` + start script, but Dockerfile is the most predictable.)

## Step 3 — Port
- Set **Ports Exposes = `3509`** (the app listens on `PORT`, default 3509; the Dockerfile sets it).
- Coolify's proxy (Traefik) maps your domain → this port.

## Step 4 — Persistent storage (critical)
- In the resource → **Storages / Persistent Storage → Add**:
  - **Name:** `license-data`
  - **Mount Path:** `/data`
- This makes `/data/keys.json` survive redeploys.

## Step 5 — Environment variables
- **`LICENSE_SIGNING_KEY`** = base64 of the PKCS8 PEM private key (from `node gen-signing-key.js`).
  **The server refuses to boot without it.** Clients from v1.0.253 on reject any grant that is not signed by
  it, so an unsigned server activates nobody. Its public half is compiled into the client — replacing this
  value locks out every already-shipped build, so set it once and never rotate it casually.
- `OWNER_KEY` = your owner license key — seeded into the volume on first boot.
  (Kept in Coolify's env, not in Git, so the secret never gets published.)
- `ADMIN_TOKEN` = a long secret (protects `GET /api/keys`).
- `KEYS_PATH` = `/data/keys.json` (already set by the Dockerfile; add it here too if using Nixpacks).
- (Optional) `PORT` = `3509`.

## Step 6 — Domain + HTTPS
- Coolify gives a domain (or set your own subdomain, e.g. `license.yourdomain.com`) and issues
  **auto‑HTTPS** via Let's Encrypt. Recommended — the app can then use `https://license.yourdomain.com`.
- No domain? Use the VPS IP: the endpoint is `http://<vps-ip>:3509` (open that port in Hostinger's firewall).

## Step 7 — Deploy & verify
Click **Deploy**. Then test (replace the URL with your domain/IP):
```bash
# Must return valid:true AND a "token" + "sig" pair. Without those two fields the server is running
# unsigned, and every v1.0.253+ client will refuse it — check LICENSE_SIGNING_KEY before shipping.
curl -X POST https://license.yourdomain.com/api/validate \
  -H "Content-Type: application/json" \
  -d '{"license":"YOUR-OWNER-KEY","hwid":"test-machine-1","nonce":"n1"}'

# list keys (admin) — header only; the ?admin= query param was REMOVED (it leaked the token into
# Nginx/Cloudflare access logs).
curl -H "Authorization: Bearer YOUR_ADMIN_TOKEN" https://license.yourdomain.com/api/keys
```

## Step 8 — Point the desktop app at this server
Two ways:
1. **Bake it in** (for the installer): in `../lib/license.js`, set
   `const DEFAULT_SERVER = 'https://license.yourdomain.com';`
2. **At runtime**: open the app's **License screen → ⚙ Settings → Server URL** and enter the URL
   (this calls `update-server-url`, no rebuild needed).

## Step 9 — Manage keys (via Coolify terminal)
Open the resource's **Terminal** in Coolify and run:
```bash
KEYS_PATH=/data/keys.json node gen-key.js "customer name"     # new key
KEYS_PATH=/data/keys.json node gen-key.js "trial" 7           # 7-day key
KEYS_PATH=/data/keys.json node revoke.js  AAAA-BBBB-CCCC-DDDD # revoke
```
(They read/write the same `/data/keys.json` the server uses.)

---

### Notes
- Redeploys keep your keys (volume at `/data`). `OWNER_KEY` only seeds the owner key into an
  empty volume on first run — it never overwrites existing keys or bindings.
- Health: `GET /api/validate` with no body returns `{valid:false}` — useful for a Coolify healthcheck
  (or add a dedicated `/health` route later).
- If you keep your old VPS too, you can run both; the app talks to whichever URL it's pointed at.
