/**
 * Niftastic Worker — geofenced NFT drops distributed from a vault wallet.
 *
 * Distribution model: NFTs are pre-loaded into the vault account (boxinventory).
 * When a player captures a drop, the worker finds an asset of the drop's template
 * in the vault and TRANSFERS it to the player.
 *
 * Auto-spawn: when a logged-in player has few active drops nearby, the worker
 * spawns drops from a weighted template pool around them (with daily budgets,
 * per-player caps, geocell cooldowns, and TTLs). New players get a guaranteed
 * easy "starter" drop reserved just for them.
 *
 * Endpoints:
 *   GET  /health
 *   GET  /drops?lat=&lng=&account=   — nearby drops; may trigger auto-spawn
 *   POST /capture                    — { account, dropId, lat, lng } → transfer NFT
 *   GET/POST /admin/drops, DELETE /admin/drops/:id          (X-Admin-Secret)
 *   GET/POST /admin/pool,  DELETE /admin/pool/:template_id  (X-Admin-Secret)
 *
 * Secrets: WAX_PRIVATE_KEY (vault active key), API_SECRET, ADMIN_SECRET
 * Bindings: DB (D1)
 */

import { Api, JsonRpc } from "eosjs";
import { JsSignatureProvider } from "eosjs/dist/eosjs-jssig";

const WAX_RPC = "https://wax.greymass.com";
const ATOMIC_API = "https://wax.api.atomicassets.io";
const VAULT_ACCOUNT = "boxinventory";

const GPS_SLACK_METERS = 10; // GPS drift allowance on top of a drop's capture radius
const NEARBY_METERS = 5000;

// ---- Auto-spawn tuning ----
const SPAWN_CHECK_RADIUS_M = 2000; // if few active drops within this range, spawn
const MIN_ACTIVE_NEARBY = 3;       // target number of active drops around a player
const SPAWN_MIN_M = 50;            // spawned drops land between MIN and MAX meters away
const SPAWN_MAX_M = 400;
const SPAWN_TTL_HOURS = 48;        // uncaptured spawns expire
const SPAWN_CAPTURE_RADIUS = 10;
const DAILY_GLOBAL_SPAWN_CAP = 200;    // max spawn triggers per UTC day, worldwide
const DAILY_PLAYER_SPAWN_CAP = 5;      // max spawn triggers per account per UTC day
const CELL_COOLDOWN_MINUTES = 60;      // min gap between spawn triggers in one ~1km cell
const STARTER_MIN_M = 25;              // starter drop lands close and easy
const STARTER_MAX_M = 60;
const STARTER_TTL_HOURS = 72;

const rateLimit = new Map();
const RATE_WINDOW_MS = 30_000;

// ---- Impossible-travel gate ----
// Above airliner cruise speed = teleporting (GPS spoof / VPN relocation).
const MAX_TRAVEL_SPEED_KMH = 800;
// Ignore jumps below this distance — GPS jitter between nearby fixes can
// briefly imply absurd speeds without any fraud.
const MIN_TELEPORT_KM = 10;
const fraudFlagCooldown = new Map(); // account:kind -> ts, avoids flag spam from polling

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Api-Secret, X-Admin-Secret",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function isValidWaxAccount(account) {
  return typeof account === "string" && /^[a-z1-5.]{1,13}$/.test(account);
}

// Random point r meters (minM..maxM) from a center, uniform over the ring.
function randomPointNear(lat, lng, minM, maxM) {
  const r = Math.sqrt(Math.random() * (maxM * maxM - minM * minM) + minM * minM);
  const theta = Math.random() * 2 * Math.PI;
  return {
    lat: lat + (r * Math.cos(theta)) / 111320,
    lng: lng + (r * Math.sin(theta)) / (111320 * Math.cos((lat * Math.PI) / 180)),
  };
}

function geocell(lat, lng) {
  return lat.toFixed(2) + ":" + lng.toFixed(2); // ~1.1 km cells
}

function bbox(lat, lng, meters) {
  const dLat = meters / 111320;
  const dLng = meters / (111320 * Math.cos((lat * Math.PI) / 180));
  return { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
}

function publicDrop(d) {
  return {
    id: d.id,
    name: d.name,
    image: d.image,
    backImage: d.back_image || null,
    video: d.video || null,
    template_id: d.template_id,
    collection_name: d.collection_name || null,
    lat: d.lat,
    lng: d.lng,
    captureRadius: d.capture_radius,
    remaining: d.remaining,
    rarity: d.rarity || null,
    source: d.source,
  };
}

// Active = has stock, not expired.
const ACTIVE_SQL = "remaining > 0 AND (expires_at IS NULL OR expires_at > ?)";

async function activeDropsNear(env, lat, lng, meters, account) {
  const now = new Date().toISOString();
  const b = bbox(lat, lng, meters);
  const rows = (
    await env.DB.prepare(
      `SELECT * FROM drops WHERE ${ACTIVE_SQL}
       AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
       AND (reserved_for IS NULL OR reserved_for = ?)`
    )
      .bind(now, b.minLat, b.maxLat, b.minLng, b.maxLng, account || "")
      .all()
  ).results;
  return rows
    .map((d) => ({ ...d, distance: Math.round(haversineMeters(lat, lng, d.lat, d.lng)) }))
    .filter((d) => d.distance <= meters)
    .sort((a, b2) => a.distance - b2.distance);
}

// Compare a claimed position against the account's most recent capture.
// Returns violation details if the implied travel speed is impossible.
async function travelViolation(env, account, lat, lng) {
  const last = await env.DB.prepare(
    "SELECT lat, lng, created FROM captures WHERE account = ? AND lat IS NOT NULL ORDER BY id DESC LIMIT 1"
  ).bind(account).first();
  if (!last) return null;
  const km = haversineMeters(lat, lng, last.lat, last.lng) / 1000;
  if (km < MIN_TELEPORT_KM) return null;
  const hours = Math.max((Date.now() - Date.parse(last.created)) / 3600_000, 1 / 3600);
  const speedKmh = km / hours;
  if (speedKmh <= MAX_TRAVEL_SPEED_KMH) return null;
  return {
    km: Math.round(km),
    minutes: Math.round(hours * 60),
    speed_kmh: Math.round(speedKmh),
    from: { lat: last.lat, lng: last.lng },
    to: { lat, lng },
  };
}

async function flagFraud(env, account, kind, detail) {
  const key = account + ":" + kind;
  const last = fraudFlagCooldown.get(key);
  if (last && Date.now() - last < 10 * 60_000) return; // one flag per account/kind/10min
  fraudFlagCooldown.set(key, Date.now());
  try {
    await env.DB.prepare(
      "INSERT INTO fraud_flags (account, kind, detail, created) VALUES (?,?,?,?)"
    ).bind(account, kind, JSON.stringify(detail), new Date().toISOString()).run();
  } catch { /* flagging must never break gameplay */ }
}

async function alreadyOwns(env, account, templateId) {
  // Cheap local check first, then best-effort on-chain check.
  const prior = await env.DB.prepare(
    "SELECT 1 FROM captures WHERE account = ? AND template_id = ? LIMIT 1"
  ).bind(account, templateId).first();
  if (prior) return true;
  try {
    const res = await fetch(
      `${ATOMIC_API}/atomicassets/v1/assets?owner=${account}&template_id=${templateId}&limit=1`
    );
    if (!res.ok) return false;
    const body = await res.json();
    return Array.isArray(body.data) && body.data.length > 0;
  } catch {
    return false;
  }
}

async function pickVaultAsset(templateId) {
  const res = await fetch(
    `${ATOMIC_API}/atomicassets/v1/assets?owner=${VAULT_ACCOUNT}` +
    `&template_id=${templateId}&limit=1&order=asc&sort=asset_id`
  );
  if (!res.ok) throw new Error("vault lookup failed: HTTP " + res.status);
  const body = await res.json();
  const asset = (body.data || [])[0];
  return asset ? asset.asset_id : null;
}

function waxApi(env) {
  return new Api({
    rpc: new JsonRpc(WAX_RPC, { fetch }),
    signatureProvider: new JsSignatureProvider([env.WAX_PRIVATE_KEY]),
  });
}

async function transferTo(env, account, assetId, dropName) {
  return waxApi(env).transact(
    {
      actions: [
        {
          account: "atomicassets",
          name: "transfer",
          authorization: [{ actor: VAULT_ACCOUNT, permission: "active" }],
          data: {
            from: VAULT_ACCOUNT,
            to: account,
            asset_ids: [assetId],
            memo: `Niftastic capture: ${dropName}`.slice(0, 256),
          },
        },
      ],
    },
    { blocksBehind: 3, expireSeconds: 30 }
  );
}

// Mint-on-demand: requires VAULT_ACCOUNT to be an authorized minter on the collection.
async function mintTo(env, account, drop) {
  return waxApi(env).transact(
    {
      actions: [
        {
          account: "atomicassets",
          name: "mintasset",
          authorization: [{ actor: VAULT_ACCOUNT, permission: "active" }],
          data: {
            authorized_minter: VAULT_ACCOUNT,
            collection_name: drop.collection_name,
            schema_name: drop.schema_name,
            template_id: drop.template_id,
            new_asset_owner: account,
            immutable_data: [],
            mutable_data: [],
            tokens_to_back: [],
          },
        },
      ],
    },
    { blocksBehind: 3, expireSeconds: 30 }
  );
}

/* ============================================================
   Geo-obstacle avoidance — random points never land on mapped
   streets/highways or in water (OpenStreetMap via Overpass).
   ============================================================ */
const OVERPASS_URLS = [
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];
const OVERPASS_FETCH_TIMEOUT_MS = 8000;
const ROAD_BUFFER_M = 12;   // min distance from a vehicular road centerline
const WATER_BUFFER_M = 10;  // min distance from water edges / stream centerlines
const VEHICLE_ROADS =
  "motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|" +
  "living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link";

const obstacleCache = new Map(); // cell key -> { at, data } (per-isolate hot cache)
const OBSTACLE_TTL_MS = 10 * 60_000;
const GEO_CACHE_TTL_MS = 30 * 24 * 3600_000; // roads/water rarely change — D1 cache for a month

async function fetchObstacles(env, lat, lng, radiusM) {
  const key = geocell(lat, lng) + ":" + Math.round(radiusM / 100);
  const hit = obstacleCache.get(key);
  if (hit && Date.now() - hit.at < OBSTACLE_TTL_MS) return hit.data;

  // Persistent cache: any successful fetch for this cell serves for 30 days.
  try {
    const row = await env.DB.prepare("SELECT data, at FROM geo_cache WHERE cell = ?").bind(key).first();
    if (row && Date.now() - Date.parse(row.at) < GEO_CACHE_TTL_MS) {
      const data = JSON.parse(row.data);
      obstacleCache.set(key, { at: Date.now(), data });
      return data;
    }
  } catch { /* cache miss path */ }

  const b = bbox(lat, lng, radiusM);
  const bb = `${b.minLat},${b.minLng},${b.maxLat},${b.maxLng}`;
  const q =
    `[out:json][timeout:6];(` +
    `way[highway~"^(${VEHICLE_ROADS})$"](${bb});` +
    `way[natural=water](${bb});relation[natural=water](${bb});` +
    `way[waterway~"^(river|stream|canal|riverbank)$"](${bb});` +
    `way[natural=coastline](${bb});` +
    `);out geom;`;
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Niftastic/1.0 (AR NFT hunt; drop placement checks; contact: joel@niftycompany.com)",
        },
        body: "data=" + encodeURIComponent(q),
        signal: AbortSignal.timeout(OVERPASS_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) continue; // rate-limited or down — try the next mirror
      const data = parseObstacles(await res.json());
      obstacleCache.set(key, { at: Date.now(), data });
      try {
        await env.DB.prepare(
          "INSERT INTO geo_cache (cell, data, at) VALUES (?,?,?) " +
          "ON CONFLICT(cell) DO UPDATE SET data=excluded.data, at=excluded.at"
        ).bind(key, JSON.stringify(data), new Date().toISOString()).run();
      } catch { /* persistence is best-effort */ }
      return data;
    } catch { /* try next mirror */ }
  }
  return null; // all mirrors unavailable — place unchecked rather than block gameplay
}

// Admin diagnostic: shows what each Overpass mirror returns for an area.
async function geoDebug(lat, lng, radiusM) {
  const b = bbox(lat, lng, radiusM);
  const bb = `${b.minLat},${b.minLng},${b.maxLat},${b.maxLng}`;
  const q =
    `[out:json][timeout:6];(` +
    `way[highway~"^(${VEHICLE_ROADS})$"](${bb});` +
    `way[natural=water](${bb});relation[natural=water](${bb});` +
    `way[waterway~"^(river|stream|canal|riverbank)$"](${bb});` +
    `way[natural=coastline](${bb});` +
    `);out geom;`;
  const results = [];
  for (const url of OVERPASS_URLS) {
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Niftastic/1.0 (AR NFT hunt; drop placement checks; contact: joel@niftycompany.com)",
        },
        body: "data=" + encodeURIComponent(q),
      });
      const text = await res.text();
      let parsed = null;
      try {
        const data = parseObstacles(JSON.parse(text));
        parsed = { roads: data.roads.length, waterLines: data.waterLines.length, waterRings: data.waterRings.length };
      } catch { /* not JSON */ }
      results.push({ url, status: res.status, ms: Date.now() - started, bytes: text.length, parsed, snippet: parsed ? undefined : text.slice(0, 180) });
    } catch (e) {
      results.push({ url, error: String(e.message || e), ms: Date.now() - started });
    }
  }
  return results;
}

function parseObstacles(osm) {
  const roads = [], waterLines = [], waterRings = [];
  const addWay = (tags, geometry) => {
    if (!geometry || geometry.length < 2) return;
    const line = geometry.map((g) => [g.lat, g.lon]);
    if (tags.highway) roads.push(line);
    else if (tags.natural === "coastline" || tags.waterway) waterLines.push(line);
    else if (tags.natural === "water") {
      const [f, l] = [line[0], line[line.length - 1]];
      if (line.length > 3 && f[0] === l[0] && f[1] === l[1]) waterRings.push(line);
      else waterLines.push(line);
    }
  };
  for (const el of osm.elements || []) {
    if (el.type === "way") addWay(el.tags || {}, el.geometry);
    else if (el.type === "relation") {
      for (const m of el.members || []) {
        if (m.type === "way" && m.geometry) addWay({ natural: "water" }, m.geometry);
      }
    }
  }
  return { roads, waterLines, waterRings };
}

// Distance from a point to a polyline, in meters (equirectangular local approx).
function nearLine(latP, lngP, line, bufferM) {
  const toXY = (lat, lng) => [
    (lng - lngP) * 111320 * Math.cos((latP * Math.PI) / 180),
    (lat - latP) * 111320,
  ];
  const buf2 = bufferM * bufferM;
  let [ax, ay] = toXY(line[0][0], line[0][1]);
  for (let i = 1; i < line.length; i++) {
    const [bx, by] = toXY(line[i][0], line[i][1]);
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, (-ax * dx - ay * dy) / len2)) : 0;
    const cx = ax + t * dx, cy = ay + t * dy;
    if (cx * cx + cy * cy <= buf2) return true;
    ax = bx; ay = by;
  }
  return false;
}

function insideRing(latP, lngP, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i], [yj, xj] = ring[j];
    if ((yi > latP) !== (yj > latP) &&
        lngP < ((xj - xi) * (latP - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function isBlocked(lat, lng, obs) {
  if (!obs) return false;
  for (const r of obs.roads) if (nearLine(lat, lng, r, ROAD_BUFFER_M)) return true;
  for (const l of obs.waterLines) if (nearLine(lat, lng, l, WATER_BUFFER_M)) return true;
  for (const ring of obs.waterRings) {
    if (insideRing(lat, lng, ring) || nearLine(lat, lng, ring, WATER_BUFFER_M)) return true;
  }
  return false;
}

// Generate `count` random points around a center that avoid roads and water.
// Falls back to unchecked placement if an area is so dense nothing clears
// (or if obstacle data is unavailable) — the game must keep working.
// The returned array carries a `geoChecked` property for observability.
async function safePointsNear(env, lat, lng, minM, maxM, count) {
  const obs = await fetchObstacles(env, lat, lng, maxM + 50);
  const points = [];
  for (let i = 0; i < count; i++) {
    let point = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      const cand = randomPointNear(lat, lng, minM, maxM);
      if (!isBlocked(cand.lat, cand.lng, obs)) { point = cand; break; }
    }
    points.push(point || randomPointNear(lat, lng, minM, maxM));
  }
  points.geoChecked = obs !== null;
  return points;
}

/* ============================================================
   Auto-spawn
   ============================================================ */

function weightedPick(entries) {
  const total = entries.reduce((n, e) => n + e.weight, 0);
  let r = Math.random() * total;
  for (const e of entries) {
    r -= e.weight;
    if (r <= 0) return e;
  }
  return entries[entries.length - 1];
}

function dropFromPoolEntry(entry, point, opts = {}) {
  return {
    id: crypto.randomUUID(),
    grp: null,
    name: entry.name || "Mystery NFT",
    template_id: entry.template_id,
    collection_name: entry.collection_name,
    image: entry.image,
    back_image: entry.back_image,
    video: entry.video,
    distribution: entry.distribution || "transfer",
    schema_name: entry.schema_name || null,
    lat: point.lat,
    lng: point.lng,
    capture_radius: opts.captureRadius || SPAWN_CAPTURE_RADIUS,
    remaining: 1,
    captured: 0,
    rarity: null,
    once_per_player: 0,
    source: opts.source || "spawn",
    reserved_for: opts.reservedFor || null,
    expires_at: new Date(Date.now() + (opts.ttlHours || SPAWN_TTL_HOURS) * 3600_000).toISOString(),
    created: new Date().toISOString(),
  };
}

async function insertDrops(env, drops) {
  const stmt = env.DB.prepare(
    `INSERT INTO drops (id, grp, name, template_id, collection_name, image, back_image, video,
      lat, lng, capture_radius, remaining, captured, rarity, once_per_player, source,
      reserved_for, expires_at, distribution, schema_name, created)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  await env.DB.batch(
    drops.map((d) =>
      stmt.bind(
        d.id, d.grp, d.name, d.template_id, d.collection_name, d.image, d.back_image, d.video,
        d.lat, d.lng, d.capture_radius, d.remaining, d.captured, d.rarity, d.once_per_player,
        d.source, d.reserved_for, d.expires_at, d.distribution || "transfer", d.schema_name || null,
        d.created
      )
    )
  );
}

// Spawn drops around a player if the area is sparse and budgets allow.
// Returns the number of drops spawned.
async function maybeSpawn(env, lat, lng, account, nearbyActiveCount) {
  if (nearbyActiveCount >= MIN_ACTIVE_NEARBY) return 0;

  const day = new Date().toISOString().slice(0, 10);
  const cell = geocell(lat, lng);
  const now = new Date().toISOString();

  const [globalCount, playerCount, cellRecent] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM spawn_events WHERE day = ?").bind(day).first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM spawn_events WHERE account = ? AND day = ?")
      .bind(account, day).first(),
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM spawn_events WHERE geocell = ? AND created > ?"
    ).bind(cell, new Date(Date.now() - CELL_COOLDOWN_MINUTES * 60_000).toISOString()).first(),
  ]);
  if (globalCount.n >= DAILY_GLOBAL_SPAWN_CAP) return 0;
  if (playerCount.n >= DAILY_PLAYER_SPAWN_CAP) return 0;
  if (cellRecent.n > 0) return 0;

  // Guaranteed one-per-player templates are handled separately, never ambient.
  const pool = (
    await env.DB.prepare("SELECT * FROM pool WHERE enabled = 1 AND guarantee = 0").all()
  ).results;
  if (!pool.length) return 0;

  const toSpawn = MIN_ACTIVE_NEARBY - nearbyActiveCount;
  const points = await safePointsNear(env, lat, lng, SPAWN_MIN_M, SPAWN_MAX_M, toSpawn);
  const drops = [];
  for (let i = 0; i < toSpawn; i++) {
    const entry = weightedPick(pool);
    // Mint-on-demand templates never run dry; vault templates need stock (best effort).
    if (entry.distribution !== "mint") {
      try {
        if (!(await pickVaultAsset(entry.template_id))) continue;
      } catch { /* API hiccup — spawn anyway; capture re-checks */ }
    }
    drops.push(dropFromPoolEntry(entry, points[drops.length]));
  }
  if (drops.length) await insertDrops(env, drops);

  await env.DB.prepare(
    "INSERT INTO spawn_events (account, geocell, day, created) VALUES (?,?,?,?)"
  ).bind(account, cell, day, now).run();

  return drops.length;
}

// Guaranteed one-per-player templates (e.g. the Founders Badge): every account
// that does not own one gets a reserved drop nearby. Once owned, never again.
// In-memory cache of confirmed ownership avoids re-hitting the chain API on
// every drops poll (resets on worker recycle, which is fine — it re-checks once).
const ownedCache = new Map();

async function maybeGuaranteed(env, lat, lng, account) {
  const entries = (
    await env.DB.prepare("SELECT * FROM pool WHERE enabled = 1 AND guarantee = 1").all()
  ).results;
  let spawned = 0;
  const now = new Date().toISOString();

  for (const entry of entries) {
    // Already has a live reserved drop for this template? Nothing to do.
    const existing = await env.DB.prepare(
      `SELECT 1 FROM drops WHERE reserved_for = ? AND template_id = ? AND ${ACTIVE_SQL} LIMIT 1`
    ).bind(account, entry.template_id, now).first();
    if (existing) continue;

    const cacheKey = account + ":" + entry.template_id;
    if (ownedCache.get(cacheKey)) continue;
    if (await alreadyOwns(env, account, entry.template_id)) {
      ownedCache.set(cacheKey, true);
      continue;
    }

    // Vault-transfer guarantees need stock; mint ones never run dry.
    if (entry.distribution !== "mint") {
      try {
        if (!(await pickVaultAsset(entry.template_id))) continue;
      } catch { /* try it anyway */ }
    }

    const [point] = await safePointsNear(env, lat, lng, STARTER_MIN_M, STARTER_MAX_M, 1);
    const drop = dropFromPoolEntry(entry, point, {
      source: "starter",
      reservedFor: account,
      ttlHours: STARTER_TTL_HOURS,
      captureRadius: 15, // slightly forgiving — often a player's very first capture
    });
    drop.once_per_player = 1;
    await insertDrops(env, [drop]);
    spawned++;
  }
  return spawned;
}

/* ============================================================
   Handlers
   ============================================================ */

async function handleNearbyDrops(url, env) {
  const lat = parseFloat(url.searchParams.get("lat"));
  const lng = parseFloat(url.searchParams.get("lng"));
  const account = url.searchParams.get("account");
  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return json({ error: "lat and lng query params required" }, 400);
  }

  let spawned = 0;
  if (isValidWaxAccount(account) && account !== VAULT_ACCOUNT) {
    try {
      // Teleporting accounts can still LOOK at drops, but nothing spawns for them.
      const violation = await travelViolation(env, account, lat, lng);
      if (violation) {
        await flagFraud(env, account, "impossible_travel_spawn", violation);
      } else {
        const activeClose = await activeDropsNear(env, lat, lng, SPAWN_CHECK_RADIUS_M, account);
        spawned += await maybeGuaranteed(env, lat, lng, account);
        spawned += await maybeSpawn(env, lat, lng, account, activeClose.length + spawned);
      }
    } catch { /* spawning must never break the drops feed */ }
  }

  const drops = await activeDropsNear(env, lat, lng, NEARBY_METERS, account);
  return json({ drops: drops.map((d) => ({ ...publicDrop(d), distance: d.distance })), spawned });
}

async function handleCapture(request, env) {
  if (request.headers.get("X-Api-Secret") !== env.API_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const { account, dropId, lat, lng } = body || {};
  if (!isValidWaxAccount(account)) return json({ error: "invalid WAX account" }, 400);
  if (account === VAULT_ACCOUNT) return json({ error: "vault account cannot capture" }, 400);
  if (typeof lat !== "number" || typeof lng !== "number") {
    return json({ error: "lat and lng are required numbers" }, 400);
  }

  const rlKey = `${account}:${dropId}`;
  const last = rateLimit.get(rlKey);
  if (last && Date.now() - last < RATE_WINDOW_MS) {
    return json({ error: "too many attempts, slow down" }, 429);
  }
  rateLimit.set(rlKey, Date.now());

  // Physics check: nobody claims from two distant cities in minutes.
  const violation = await travelViolation(env, account, lat, lng);
  if (violation) {
    await flagFraud(env, account, "impossible_travel_capture", violation);
    return json(
      {
        error: "impossible travel detected — captures from this location are blocked",
        distance_km: violation.km,
        minutes_since_last_claim: violation.minutes,
      },
      403
    );
  }

  const now = new Date().toISOString();
  const drop = await env.DB.prepare("SELECT * FROM drops WHERE id = ?").bind(dropId).first();
  if (!drop) return json({ error: "drop not found" }, 404);
  if (drop.remaining <= 0 || (drop.expires_at && drop.expires_at <= now)) {
    return json({ error: "drop exhausted" }, 410);
  }
  if (drop.reserved_for && drop.reserved_for !== account) {
    return json({ error: "drop not found" }, 404);
  }

  const dist = haversineMeters(lat, lng, drop.lat, drop.lng);
  if (dist > drop.capture_radius + GPS_SLACK_METERS) {
    return json(
      { error: "too far away", distance: Math.round(dist), required: drop.capture_radius },
      403
    );
  }

  if (drop.once_per_player && (await alreadyOwns(env, account, drop.template_id))) {
    return json({ error: "already captured", template_id: drop.template_id }, 409);
  }

  const isMint = drop.distribution === "mint";

  let assetId = null;
  if (!isMint) {
    try {
      assetId = await pickVaultAsset(drop.template_id);
    } catch (err) {
      return json({ error: "vault lookup failed", detail: String(err.message || err) }, 502);
    }
    if (!assetId) {
      await env.DB.prepare("UPDATE drops SET remaining = 0 WHERE id = ?").bind(dropId).run();
      return json({ error: "drop exhausted" }, 410);
    }
  }

  // Claim stock BEFORE transferring so two simultaneous captures can't both win.
  const claim = await env.DB.prepare(
    "UPDATE drops SET remaining = remaining - 1, captured = captured + 1 WHERE id = ? AND remaining > 0"
  ).bind(dropId).run();
  if (!claim.meta.changes) return json({ error: "drop exhausted" }, 410);

  let result;
  try {
    result = isMint
      ? await mintTo(env, account, drop)
      : await transferTo(env, account, assetId, drop.name);
  } catch (err) {
    // Give the stock back on failure.
    await env.DB.prepare(
      "UPDATE drops SET remaining = remaining + 1, captured = captured - 1 WHERE id = ?"
    ).bind(dropId).run();
    return json({ error: isMint ? "mint failed" : "transfer failed", detail: String(err.message || err) }, 502);
  }

  const cf = request.cf || {};
  await env.DB.prepare(
    "INSERT INTO captures (account, drop_id, template_id, asset_id, tx_id, lat, lng, ip_country, as_org, created) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).bind(
    account, dropId, drop.template_id, assetId, result.transaction_id,
    lat, lng, cf.country || null, cf.asOrganization || null, now
  ).run();

  return json({
    ok: true,
    transaction_id: result.transaction_id,
    asset_id: assetId,
    drop: publicDrop({ ...drop, remaining: drop.remaining - 1 }),
  });
}

async function handleAdmin(request, url, env) {
  if (request.headers.get("X-Admin-Secret") !== env.ADMIN_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  const parts = url.pathname.split("/").filter(Boolean); // ["admin", resource, maybe id]
  const resource = parts[1];

  if (resource === "fraud" && request.method === "GET") {
    const rows = (
      await env.DB.prepare("SELECT * FROM fraud_flags ORDER BY id DESC LIMIT 200").all()
    ).results;
    return json({
      flags: rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null })),
    });
  }

  if (resource === "geodebug" && request.method === "GET") {
    if (url.searchParams.get("echo")) {
      const res = await fetch("https://httpbin.org/headers", {
        headers: { "User-Agent": "Niftastic/1.0 (test)" },
      });
      return json(await res.json());
    }
    const lat = parseFloat(url.searchParams.get("lat"));
    const lng = parseFloat(url.searchParams.get("lng"));
    const r = parseFloat(url.searchParams.get("r")) || 300;
    if (Number.isNaN(lat) || Number.isNaN(lng)) return json({ error: "lat/lng required" }, 400);
    return json({ mirrors: await geoDebug(lat, lng, r) });
  }

  /* ----- drops ----- */
  if (resource === "drops") {
    if (request.method === "GET" && parts.length === 2) {
      const rows = (
        await env.DB.prepare("SELECT * FROM drops WHERE remaining > 0 ORDER BY created DESC LIMIT 500").all()
      ).results;
      return json({ drops: rows.map((d) => ({ ...publicDrop(d), captured: d.captured, expires_at: d.expires_at })) });
    }

    if (request.method === "POST" && parts.length === 2) {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      const {
        name, template_id, collection_name, image, back_image, video, lat, lng,
        captureRadius, quantity, rarity, oncePerPlayer, scatter, distribution, schema_name,
      } = body || {};
      if (!name || !template_id) return json({ error: "name and template_id required" }, 400);
      if (typeof lat !== "number" || typeof lng !== "number") {
        return json({ error: "lat and lng are required numbers" }, 400);
      }
      if (distribution === "mint" && (!collection_name || !schema_name)) {
        return json({ error: "mint drops require collection_name and schema_name" }, 400);
      }

      const qty = Math.max(1, Number(quantity) || 1);
      const scatterRadius = Math.max(0, Number(scatter) || 0);
      const groupId = crypto.randomUUID();

      const makeDrop = (point, remaining) => ({
        id: crypto.randomUUID(),
        grp: groupId,
        name,
        template_id: String(template_id),
        collection_name: collection_name || null,
        image: image || null,
        back_image: back_image || null,
        video: video || null,
        lat: point.lat,
        lng: point.lng,
        capture_radius: Math.max(10, Number(captureRadius) || 50),
        remaining,
        captured: 0,
        rarity: rarity || null,
        once_per_player: oncePerPlayer ? 1 : 0,
        source: "admin",
        reserved_for: null,
        expires_at: null,
        distribution: distribution === "mint" ? "mint" : "transfer",
        schema_name: schema_name || null,
        created: new Date().toISOString(),
      });

      let created, geoChecked = null;
      if (scatterRadius > 0 && qty > 1) {
        const points = await safePointsNear(env, lat, lng, 0, scatterRadius, qty);
        geoChecked = points.geoChecked;
        created = points.map((p) => makeDrop(p, 1));
      } else {
        created = [makeDrop({ lat, lng }, qty)]; // exact admin click — placed as-is
      }

      await insertDrops(env, created);
      return json({ ok: true, geoChecked, drops: created.map(publicDrop) }, 201);
    }

    if (request.method === "DELETE" && parts.length === 3) {
      const res = await env.DB.prepare("DELETE FROM drops WHERE id = ?").bind(parts[2]).run();
      if (!res.meta.changes) return json({ error: "drop not found" }, 404);
      return json({ ok: true });
    }
  }

  /* ----- pool ----- */
  if (resource === "pool") {
    if (request.method === "GET" && parts.length === 2) {
      const rows = (await env.DB.prepare("SELECT * FROM pool ORDER BY weight DESC").all()).results;
      return json({ pool: rows });
    }

    if (request.method === "POST" && parts.length === 2) {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      const { template_id, collection_name, name, image, back_image, video, weight, enabled,
        distribution, schema_name, guarantee } = body || {};
      if (!template_id) return json({ error: "template_id required" }, 400);
      if (distribution === "mint" && (!collection_name || !schema_name)) {
        return json({ error: "mint entries require collection_name and schema_name" }, 400);
      }
      await env.DB.prepare(
        `INSERT INTO pool (template_id, collection_name, name, image, back_image, video, weight, enabled,
           distribution, schema_name, guarantee)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(template_id) DO UPDATE SET
           collection_name=excluded.collection_name, name=excluded.name, image=excluded.image,
           back_image=excluded.back_image, video=excluded.video,
           weight=excluded.weight, enabled=excluded.enabled,
           distribution=excluded.distribution, schema_name=excluded.schema_name,
           guarantee=excluded.guarantee`
      ).bind(
        String(template_id), collection_name || null, name || null, image || null,
        back_image || null, video || null,
        Math.max(1, Number(weight) || 10), enabled === false ? 0 : 1,
        distribution === "mint" ? "mint" : "transfer", schema_name || null,
        guarantee ? 1 : 0
      ).run();
      return json({ ok: true }, 201);
    }

    if (request.method === "DELETE" && parts.length === 3) {
      const res = await env.DB.prepare("DELETE FROM pool WHERE template_id = ?").bind(parts[2]).run();
      if (!res.meta.changes) return json({ error: "not in pool" }, 404);
      return json({ ok: true });
    }
  }

  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (url.pathname === "/health") {
      return json({ ok: true, service: "niftastic-worker", vault: VAULT_ACCOUNT });
    }
    if (url.pathname === "/drops" && request.method === "GET") {
      return handleNearbyDrops(url, env);
    }
    if (url.pathname === "/capture" && request.method === "POST") {
      return handleCapture(request, env);
    }
    if (url.pathname.startsWith("/admin/")) {
      return handleAdmin(request, url, env);
    }
    return json({ error: "not found" }, 404);
  },
};
