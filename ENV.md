# Environment variables & build config

All environment variables and runtime flags, grouped by where they apply. None are required for a
basic single-operator run — they enable optional features (licensing, the remote dashboard,
multi-instance, signed builds).

## Desktop app (`main.js`)

| Variable / flag | Default | What it does |
|---|---|---|
| `ENABLE_LICENSE=1` | off | Turn on the license gate at startup. When off, the app runs unlimited (owner/dev). When on, it validates against the VPS server and enforces the key's tier limits. Can also be enabled via `settings.licenseEnabled`. |
| `ENABLE_TUNNEL=1` | off | Start the Cloudflare quick tunnel so the remote dashboard is reachable over the internet. Also enableable via `settings.enableTunnel`. The tunnel URL carries an access token — get it from the app UI (it is kept out of the logs). |
| `--profile=<name>` / `ZA_PROFILE=<name>` | (default profile) | Run an isolated instance with its own `userData` dir (`za-post-restored-<name>`). Lets two account sets coexist on one machine. `--profile=base` is the second-instance convention. |
| `CLOUDFLARED_BIN=<path>` | bundled | Override the path to the `cloudflared` binary if the bundled one doesn't work on your system. |

Licensing server URL is stored per-machine in `license-config.json` (Settings → license screen), not
an env var; default is `lib/license.js` `DEFAULT_SERVER`.

## VPS license server (`vps-server/`)

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3509` | Port the license server listens on. |
| `OWNER_KEY` | (none) | Your owner license key — seeded into the store on first boot if missing. Keep it out of Git. |
| `ADMIN_TOKEN` | (none) | Required to call `GET /api/keys`. Send as `Authorization: Bearer <ADMIN_TOKEN>` (the `?admin=` query param is a deprecated fallback). With no token set, `/api/keys` is disabled. |
| `KEYS_PATH` | `vps-server/keys.json` | Path to the key store. Point at a **persistent volume** (e.g. `/data/keys.json` on Coolify) so keys + machine bindings survive redeploys. |
| `KEYS_ENCRYPTION_KEY` | (none) | When set, the key store is **AES-256-GCM encrypted at rest** (recommended). Without it the store is plaintext and the server warns at startup. `gen-key.js` / `revoke.js` read the same var, so set it everywhere you touch the store. |

Run the server **behind an HTTPS reverse proxy** (Coolify/Traefik terminate TLS) — see
`vps-server/DEPLOY-COOLIFY.md`. Key lifecycle events (create/bind/revoke) are written to
`key-audit.log` next to the key store.

## Build (`scripts/build-portable.js`, electron-builder)

| Variable | Default | What it does |
|---|---|---|
| `WIN_CODESIGN_VERSION` | auto-detected | Override the winCodeSign version the portable build seeds. Normally auto-detected from electron-builder; set this only if a version bump breaks the build (the script tells you when). |
| `CSC_LINK` | (none) | Path/URL to a code-signing certificate (`.pfx`). When set, signed builds avoid the SmartScreen "Windows protected your PC" warning. |
| `CSC_KEY_PASSWORD` | (none) | Password for the `CSC_LINK` certificate. |

## Tiers (placeholder business values — tune in `lib/license.js` `TIERS`)

| Tier | maxAccounts | maxGroups |
|---|---|---|
| `trial` | 3 | 10 |
| `standard` | 25 | 100 |
| `pro` | 100 | 500 |
| `owner` | ∞ | ∞ |

Generate a key for a tier: `node vps-server/gen-key.js "customer name" <days> <tier>`.
