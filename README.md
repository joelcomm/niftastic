# Niftastic 🗺️✨

An augmented-reality web app for hunting NFTs on the WAX blockchain in the real world —
Pokémon Go meets NFTs. Built as a **mobile web app** (works on iOS Safari and Android Chrome),
which sidesteps Apple/Google app-store NFT restrictions entirely: no store review, no IAP rules,
and captured items are real AtomicAssets NFTs tradeable on any WAX marketplace.

## How it works

1. **Sign in** with WAX Cloud Wallet (a wallet is created free during sign-in if the user doesn't have one).
2. The **Hunt** screen shows a compass radar and a list of NFT drops within 5 km, refreshed as you move.
3. Tap **AR Hunt** to open the camera. NFTs float in the camera view, positioned by compass bearing
   and sized by distance. Walk into a drop's capture radius and tap the glowing NFT.
4. The Cloudflare Worker verifies your GPS position server-side, picks a matching NFT from the
   **vault wallet** (`boxinventory`), and **transfers it to your WAX wallet**, decrementing the
   drop's remaining supply.
5. The **Inventory** tab shows everything you've caught, live from the AtomicAssets API.

There is also a list-view **Capture** button (no AR required) — useful for accessibility,
desktop testing, and devices without a compass. The server enforces the geofence either way.

## Repo layout

| Path | What it is |
|---|---|
| `index.html` | The player app (single file, React UMD + Babel standalone, local `waxjs.js`) |
| `admin.html` | Drop manager: click a map to place geofenced NFT drops |
| `waxjs.js` | WaxJS dist-web bundle, served locally (CDN availability is unreliable) |
| `worker/` | Cloudflare Worker: drop storage (KV), geofence validation, vault-to-player transfers |
| `manifest.json` | PWA manifest so the app can be added to the home screen |

## Setup

### 1. Deploy the Worker

```bash
cd worker
npm install
npx wrangler kv namespace create DROPS      # paste the id into wrangler.toml
npx wrangler secret put WAX_PRIVATE_KEY     # active key of the VAULT account ("boxinventory")
npx wrangler secret put API_SECRET          # any strong random string
npx wrangler secret put ADMIN_SECRET        # a different strong random string
npx wrangler deploy
```

**Distribution model:** NFTs are distributed by *transfer from a vault wallet*, not minted.
Send the NFTs you want to drop to the vault account (`VAULT_ACCOUNT` in `worker/src/index.js`,
default `boxinventory`). Any NFT from any collection works — no collection authorization needed.
Keep only hunt inventory in the vault, since the worker holds its active key.

### 2. Configure the frontend

Edit `WAX_CONFIG` at the top of `index.html`:

- `workerBase` — your deployed worker URL (e.g. `https://niftastic-worker.yoursubdomain.workers.dev`)
- `apiSecret` — the same value you set as the `API_SECRET` wrangler secret
- `collection` — the collection shown in Inventory

### 3. Publish

Push this folder to a GitHub repo and enable GitHub Pages (the `.nojekyll` file is already here).
**HTTPS is required** — camera, geolocation, and device orientation only work on secure origins,
which GitHub Pages provides.

### 4. Place drops

Send the NFTs you want to distribute to the vault wallet. Then open `admin.html` (locally or
hosted), enter the worker URL and admin secret, click the map, enter the collection and template
ID (name, image, and current vault stock are looked up automatically), set quantity and capture
radius, and hit **Place Drop**. Drops appear to players within 5 km immediately.

## Testing without walking around

- Chrome DevTools → Sensors panel lets you spoof geolocation. Place a drop at your spoofed
  coordinates, and the list-view Capture button will light up.
- iOS Safari asks for motion/compass permission via an in-app prompt the first time AR opens.
- `GET {worker}/health` confirms the worker is live.

## Known limitations (MVP)

- **Client secret**: `apiSecret` ships in page source, so it deters casual abuse only; the real
  protections are the server-side geofence check, per-player rate limit, and the fact that the
  vault can only give away what it holds. GPS spoofing by a determined user is possible (same
  is true of Pokémon Go); vault stock is the backstop.
- **Drop storage** is a single KV key — fine for hundreds of drops, revisit (Durable Objects)
  for global scale or high capture concurrency.
- Compass heading quality varies by device; the list-view capture path always works.
