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

const GPS_SLACK_METERS = 30;
const NEARBY_METERS = 5000;

// ---- Auto-spawn tuning ----
const SPAWN_CHECK_RADIUS_M = 2000; // if few active drops within this range, spawn
const MIN_ACTIVE_NEARBY = 3;       // target number of active drops around a player
const SPAWN_MIN_M = 50;            // spawned drops land between MIN and MAX meters away
const SPAWN_MAX_M = 400;
const SPAWN_TTL_HOURS = 48;        // uncaptured spawns expire
const SPAWN_CAPTURE_RADIUS = 40;
const DAILY_GLOBAL_SPAWN_CAP = 200;    // max spawn triggers per UTC day, worldwide
const DAILY_PLAYER_SPAWN_CAP = 5;      // max spawn triggers per account per UTC day
const CELL_COOLDOWN_MINUTES = 60;      // min gap between spawn triggers in one ~1km cell
const STARTER_MIN_M = 25;              // starter drop lands close and easy
const STARTER_MAX_M = 60;
const STARTER_TTL_HOURS = 72;

const rateLimit = new Map();
const RATE_WINDOW_MS = 30_000;

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

async function transferTo(env, account, assetId, dropName) {
  const api = new Api({
    rpc: new JsonRpc(WAX_RPC, { fetch }),
    signatureProvider: new JsSignatureProvider([env.WAX_PRIVATE_KEY]),
  });
  return api.transact(
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
      reserved_for, expires_at, created)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  await env.DB.batch(
    drops.map((d) =>
      stmt.bind(
        d.id, d.grp, d.name, d.template_id, d.collection_name, d.image, d.back_image, d.video,
        d.lat, d.lng, d.capture_radius, d.remaining, d.captured, d.rarity, d.once_per_player,
        d.source, d.reserved_for, d.expires_at, d.created
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

  const pool = (
    await env.DB.prepare("SELECT * FROM pool WHERE enabled = 1").all()
  ).results;
  if (!pool.length) return 0;

  const toSpawn = MIN_ACTIVE_NEARBY - nearbyActiveCount;
  const drops = [];
  for (let i = 0; i < toSpawn; i++) {
    const entry = weightedPick(pool);
    // Skip templates the vault no longer stocks (best effort).
    try {
      if (!(await pickVaultAsset(entry.template_id))) continue;
    } catch { /* API hiccup — spawn anyway; capture re-checks */ }
    drops.push(dropFromPoolEntry(entry, randomPointNear(lat, lng, SPAWN_MIN_M, SPAWN_MAX_M)));
  }
  if (drops.length) await insertDrops(env, drops);

  await env.DB.prepare(
    "INSERT INTO spawn_events (account, geocell, day, created) VALUES (?,?,?,?)"
  ).bind(account, cell, day, now).run();

  return drops.length;
}

// New players (zero captures) get one guaranteed, reserved, close-by drop.
async function maybeStarter(env, lat, lng, account) {
  const captured = await env.DB.prepare(
    "SELECT 1 FROM captures WHERE account = ? LIMIT 1"
  ).bind(account).first();
  if (captured) return 0;

  const now = new Date().toISOString();
  const existing = await env.DB.prepare(
    `SELECT 1 FROM drops WHERE reserved_for = ? AND ${ACTIVE_SQL} LIMIT 1`
  ).bind(account, now).first();
  if (existing) return 0;

  const pool = (
    await env.DB.prepare("SELECT * FROM pool WHERE enabled = 1 ORDER BY weight DESC LIMIT 3").all()
  ).results;
  if (!pool.length) return 0;

  // Most common template with actual vault stock.
  for (const entry of pool) {
    try {
      if (!(await pickVaultAsset(entry.template_id))) continue;
    } catch { /* try it anyway */ }
    const drop = dropFromPoolEntry(entry, randomPointNear(lat, lng, STARTER_MIN_M, STARTER_MAX_M), {
      source: "starter",
      reservedFor: account,
      ttlHours: STARTER_TTL_HOURS,
      captureRadius: 60,
    });
    await insertDrops(env, [drop]);
    return 1;
  }
  return 0;
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
      const activeClose = await activeDropsNear(env, lat, lng, SPAWN_CHECK_RADIUS_M, account);
      spawned += await maybeStarter(env, lat, lng, account);
      spawned += await maybeSpawn(env, lat, lng, account, activeClose.length + spawned);
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

  let assetId;
  try {
    assetId = await pickVaultAsset(drop.template_id);
  } catch (err) {
    return json({ error: "vault lookup failed", detail: String(err.message || err) }, 502);
  }
  if (!assetId) {
    await env.DB.prepare("UPDATE drops SET remaining = 0 WHERE id = ?").bind(dropId).run();
    return json({ error: "drop exhausted" }, 410);
  }

  // Claim stock BEFORE transferring so two simultaneous captures can't both win.
  const claim = await env.DB.prepare(
    "UPDATE drops SET remaining = remaining - 1, captured = captured + 1 WHERE id = ? AND remaining > 0"
  ).bind(dropId).run();
  if (!claim.meta.changes) return json({ error: "drop exhausted" }, 410);

  let result;
  try {
    result = await transferTo(env, account, assetId, drop.name);
  } catch (err) {
    // Give the stock back on failure.
    await env.DB.prepare(
      "UPDATE drops SET remaining = remaining + 1, captured = captured - 1 WHERE id = ?"
    ).bind(dropId).run();
    return json({ error: "transfer failed", detail: String(err.message || err) }, 502);
  }

  await env.DB.prepare(
    "INSERT INTO captures (account, drop_id, template_id, asset_id, tx_id, created) VALUES (?,?,?,?,?,?)"
  ).bind(account, dropId, drop.template_id, assetId, result.transaction_id, now).run();

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
        captureRadius, quantity, rarity, oncePerPlayer, scatter,
      } = body || {};
      if (!name || !template_id) return json({ error: "name and template_id required" }, 400);
      if (typeof lat !== "number" || typeof lng !== "number") {
        return json({ error: "lat and lng are required numbers" }, 400);
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
        created: new Date().toISOString(),
      });

      const created =
        scatterRadius > 0 && qty > 1
          ? Array.from({ length: qty }, () => makeDrop(randomPointNear(lat, lng, 0, scatterRadius), 1))
          : [makeDrop({ lat, lng }, qty)];

      await insertDrops(env, created);
      return json({ ok: true, drops: created.map(publicDrop) }, 201);
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
      const { template_id, collection_name, name, image, back_image, video, weight, enabled } = body || {};
      if (!template_id) return json({ error: "template_id required" }, 400);
      await env.DB.prepare(
        `INSERT INTO pool (template_id, collection_name, name, image, back_image, video, weight, enabled)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(template_id) DO UPDATE SET
           collection_name=excluded.collection_name, name=excluded.name, image=excluded.image,
           back_image=excluded.back_image, video=excluded.video,
           weight=excluded.weight, enabled=excluded.enabled`
      ).bind(
        String(template_id), collection_name || null, name || null, image || null,
        back_image || null, video || null,
        Math.max(1, Number(weight) || 10), enabled === false ? 0 : 1
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
