# WAX Blockchain Integration Knowledge

Distilled from the Blockchain Heroes WAR project (github.com/joelcomm/blockchain-heroes-war).
Copy this file into any new WAX project — ideally as `CLAUDE.md` (or referenced from it) so
Claude Code loads it automatically.

## Proven endpoints (as of July 2026)

| Purpose | Endpoint | Notes |
|---|---|---|
| WAX RPC (chain API) | `https://wax.greymass.com` | Used for both client login and server-side transactions |
| AtomicAssets API (primary) | `https://wax.api.atomicassets.io` | Official; used by the Worker for ownership checks |
| AtomicAssets API (alt) | `https://aa.wax.blacklusion.io` | Used client-side in the game; good fallback |
| IPFS gateway | Configured in `WAX_CONFIG.ipfsGateway` in index.html | NFT images come as bare IPFS hashes or `ipfs://` URIs — always normalize |

## Client-side: WaxJS wallet login

- Use the **waxjs dist-web bundle served locally** (`waxjs.js`), not a CDN — CDN availability was unreliable.
- **Babel-standalone gotcha:** if the app uses Babel in the browser, capture the waxjs global in a
  plain `<script>` **before** any Babel-processed script runs, because Babel's eval scope can shadow globals:
  ```html
  <script src="waxjs.js"></script>
  <script>
    window.__WaxJSClass = waxjs.WaxJS || waxjs.default?.WaxJS || waxjs.default || null;
  </script>
  ```
- The exported class location varies by bundle version — check `waxjs.WaxJS`, `waxjs.default.WaxJS`,
  and `waxjs.default`, in that order.
- Init: `new WaxJS({ rpcEndpoint: "https://wax.greymass.com", tryAutoLogin: false })`, then
  `await wax.isAutoLoginAvailable()` to silently restore a session, else `await wax.login()`
  (opens WAX Cloud Wallet popup — must be triggered by a user gesture or popup blockers eat it).
- Retry init on an interval (~10 attempts) in case the script is still loading.

## Reading a player's NFTs (AtomicAssets)

- REST query, no auth needed:
  `GET {atomicApiBase}/atomicassets/v1/assets?owner={account}&collection_name={collection}&schema_name={schema}&limit=...&page=...`
- Paginate; responses cap around 100–1000 per page.
- Normalize each asset defensively: image may live in `asset.data.img`, may be a bare IPFS hash,
  an `ipfs://` URI, or a full URL. Prefix bare hashes with the IPFS gateway.
- Key fields: `asset.template.template_id`, `asset.data` (immutable template data merged with mutable data),
  `asset.asset_id`.

## Server-side minting (Cloudflare Worker pattern)

Full working implementation: `worker/src/index.js` in the blockchain-heroes-war repo.

Architecture: the game client calls a Cloudflare Worker endpoint; the Worker holds the private key
and signs a `mintasset` transaction with eosjs. **Never put the private key in client code.**

- Stack: `eosjs` (`Api`, `JsonRpc`, `JsSignatureProvider`) inside a CF Worker; deploy with wrangler.
- Secrets via `env` (wrangler secrets): `WAX_PRIVATE_KEY`, `API_SECRET` (shared secret the client must send).
- Mint action shape:
  ```js
  { account: "atomicassets", name: "mintasset",
    authorization: [{ actor: MINTER_ACCOUNT, permission: "active" }],
    data: { authorized_minter: MINTER_ACCOUNT, collection_name, schema_name,
            template_id, new_asset_owner: player,
            immutable_data: [], mutable_data: [], tokens_to_back: [] } }
  ```
  with `{ blocksBehind: 3, expireSeconds: 30 }`.
- The minter account must be an **authorized minter on the collection** (set via atomicassets `addcolauth`/collection config).
- Safeguards that proved necessary:
  - Validate WAX account format: `/^[a-z1-5.]{1,13}$/`
  - Duplicate-ownership check via AtomicAssets API before minting (return 409 if already owned);
    if the check itself fails, mint anyway rather than block.
  - Simple per-player-per-badge rate limit (in-memory Map is fine for a Worker; resets on restart).
  - CORS headers on every response incl. OPTIONS preflight (the game is on a different origin — GitHub Pages).

## Blockchain Heroes specifics (this collection)

- Collection: `officialhero`; badge schema: `herobadges`; minter account: `heroes`.
- Example badge template_id: `904586` ("Blockchain Heroes WARS Badge").
- Main game config lives in `WAX_CONFIG` near the top of `index.html`.

## Deployment setup used

- Frontend: single-file `index.html` on GitHub Pages (needs `.nojekyll`). React 18 UMD + Babel standalone via cdnjs.
- Backend: Cloudflare Worker (`worker/` dir, wrangler.toml), endpoints `POST /mint` and `GET /health`.
