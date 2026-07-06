/**
 * Niftastic Worker — geofenced NFT drops distributed from a vault wallet.
 *
 * Distribution model: NFTs are pre-loaded into the vault account (boxinventory).
 * When a player captures a drop, the worker finds an asset of the drop's template
 * in the vault and TRANSFERS it to the player. No minting, no collection
 * authorization required — any NFT from any collection can be dropped.
 *
 * Endpoints:
 *   GET  /health                     — liveness check
 *   GET  /drops?lat=&lng=            — active drops near a point (public fields only)
 *   POST /capture                    — { account, dropId, lat, lng } → transfers NFT to account
 *   GET  /admin/drops                — all drops incl. remaining counts   (X-Admin-Secret)
 *   POST /admin/drops                — create a drop                      (X-Admin-Secret)
 *   DELETE /admin/drops/:id          — remove a drop                      (X-Admin-Secret)
 *
 * Secrets (wrangler secret put ...): WAX_PRIVATE_KEY (vault active key), API_SECRET, ADMIN_SECRET
 * KV binding: DROPS
 */

import { Api, JsonRpc } from "eosjs";
import { JsSignatureProvider } from "eosjs/dist/eosjs-jssig";

const WAX_RPC = "https://wax.greymass.com";
const ATOMIC_API = "https://wax.api.atomicassets.io";

// The wallet that holds the NFTs to be distributed.
const VAULT_ACCOUNT = "boxinventory";

// How far outside a drop's capture radius we still allow, to absorb GPS drift.
const GPS_SLACK_METERS = 30;
// Max nearby-drop query distance.
const NEARBY_METERS = 5000;

const DROPS_KEY = "drops";

// Per-account+drop rate limit (in-memory; resets when the worker instance recycles).
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

async function loadDrops(env) {
  const raw = await env.DROPS.get(DROPS_KEY);
  return raw ? JSON.parse(raw) : [];
}

async function saveDrops(env, drops) {
  await env.DROPS.put(DROPS_KEY, JSON.stringify(drops));
}

function publicDrop(d) {
  return {
    id: d.id,
    name: d.name,
    image: d.image,
    template_id: d.template_id,
    collection_name: d.collection_name || null,
    lat: d.lat,
    lng: d.lng,
    captureRadius: d.captureRadius,
    remaining: d.remaining,
    rarity: d.rarity || null,
  };
}

async function alreadyOwns(account, templateId) {
  // Best effort — if the check fails, allow the capture rather than block it.
  try {
    const url =
      `${ATOMIC_API}/atomicassets/v1/assets?owner=${account}` +
      `&template_id=${templateId}&limit=1`;
    const res = await fetch(url);
    if (!res.ok) return false;
    const body = await res.json();
    return Array.isArray(body.data) && body.data.length > 0;
  } catch {
    return false;
  }
}

// Find one asset of this template currently sitting in the vault.
async function pickVaultAsset(drop) {
  const url =
    `${ATOMIC_API}/atomicassets/v1/assets?owner=${VAULT_ACCOUNT}` +
    `&template_id=${drop.template_id}&limit=1&order=asc&sort=asset_id`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("vault lookup failed: HTTP " + res.status);
  const body = await res.json();
  const asset = (body.data || [])[0];
  return asset ? asset.asset_id : null;
}

async function transferTo(env, account, assetId, dropName) {
  const signatureProvider = new JsSignatureProvider([env.WAX_PRIVATE_KEY]);
  const rpc = new JsonRpc(WAX_RPC, { fetch });
  const api = new Api({ rpc, signatureProvider });

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
  if (!isValidWaxAccount(account)) {
    return json({ error: "invalid WAX account" }, 400);
  }
  if (account === VAULT_ACCOUNT) {
    return json({ error: "vault account cannot capture" }, 400);
  }
  if (typeof lat !== "number" || typeof lng !== "number") {
    return json({ error: "lat and lng are required numbers" }, 400);
  }

  const rlKey = `${account}:${dropId}`;
  const last = rateLimit.get(rlKey);
  if (last && Date.now() - last < RATE_WINDOW_MS) {
    return json({ error: "too many attempts, slow down" }, 429);
  }
  rateLimit.set(rlKey, Date.now());

  const drops = await loadDrops(env);
  const drop = drops.find((d) => d.id === dropId);
  if (!drop) return json({ error: "drop not found" }, 404);
  if (drop.remaining <= 0) return json({ error: "drop exhausted" }, 410);

  const dist = haversineMeters(lat, lng, drop.lat, drop.lng);
  if (dist > drop.captureRadius + GPS_SLACK_METERS) {
    return json(
      { error: "too far away", distance: Math.round(dist), required: drop.captureRadius },
      403
    );
  }

  if (drop.oncePerPlayer && (await alreadyOwns(account, drop.template_id))) {
    return json({ error: "already captured", template_id: drop.template_id }, 409);
  }

  let assetId;
  try {
    assetId = await pickVaultAsset(drop);
  } catch (err) {
    return json({ error: "vault lookup failed", detail: String(err.message || err) }, 502);
  }
  if (!assetId) {
    // Vault ran dry even though the drop counter had stock left.
    drop.remaining = 0;
    await saveDrops(env, drops);
    return json({ error: "drop exhausted" }, 410);
  }

  let result;
  try {
    result = await transferTo(env, account, assetId, drop.name);
  } catch (err) {
    return json({ error: "transfer failed", detail: String(err.message || err) }, 502);
  }

  drop.remaining -= 1;
  drop.captured = (drop.captured || 0) + 1;
  await saveDrops(env, drops);

  return json({
    ok: true,
    transaction_id: result.transaction_id,
    asset_id: assetId,
    drop: publicDrop(drop),
  });
}

async function handleNearbyDrops(url, env) {
  const lat = parseFloat(url.searchParams.get("lat"));
  const lng = parseFloat(url.searchParams.get("lng"));
  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return json({ error: "lat and lng query params required" }, 400);
  }

  const drops = await loadDrops(env);
  const nearby = drops
    .filter((d) => d.remaining > 0)
    .map((d) => ({
      ...publicDrop(d),
      distance: Math.round(haversineMeters(lat, lng, d.lat, d.lng)),
    }))
    .filter((d) => d.distance <= NEARBY_METERS)
    .sort((a, b) => a.distance - b.distance);

  return json({ drops: nearby });
}

async function handleAdmin(request, url, env) {
  if (request.headers.get("X-Admin-Secret") !== env.ADMIN_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  const parts = url.pathname.split("/").filter(Boolean); // ["admin", "drops", maybe id]

  if (request.method === "GET" && parts.length === 2) {
    return json({ drops: await loadDrops(env) });
  }

  if (request.method === "POST" && parts.length === 2) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const {
      name, template_id, collection_name, image, lat, lng,
      captureRadius, quantity, rarity, oncePerPlayer,
    } = body || {};
    if (!name || !template_id) return json({ error: "name and template_id required" }, 400);
    if (typeof lat !== "number" || typeof lng !== "number") {
      return json({ error: "lat and lng are required numbers" }, 400);
    }

    const drop = {
      id: crypto.randomUUID(),
      name,
      template_id: String(template_id),
      collection_name: collection_name || null,
      image: image || null,
      lat,
      lng,
      captureRadius: Math.max(10, Number(captureRadius) || 50),
      remaining: Math.max(1, Number(quantity) || 1),
      captured: 0,
      rarity: rarity || null,
      oncePerPlayer: Boolean(oncePerPlayer),
      created: new Date().toISOString(),
    };

    const drops = await loadDrops(env);
    drops.push(drop);
    await saveDrops(env, drops);
    return json({ ok: true, drop }, 201);
  }

  if (request.method === "DELETE" && parts.length === 3) {
    const id = parts[2];
    const drops = await loadDrops(env);
    const next = drops.filter((d) => d.id !== id);
    if (next.length === drops.length) return json({ error: "drop not found" }, 404);
    await saveDrops(env, next);
    return json({ ok: true });
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

    if (url.pathname.startsWith("/admin/drops")) {
      return handleAdmin(request, url, env);
    }

    return json({ error: "not found" }, 404);
  },
};
