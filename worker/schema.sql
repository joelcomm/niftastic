-- Niftastic D1 schema
CREATE TABLE IF NOT EXISTS drops (
  id TEXT PRIMARY KEY,
  grp TEXT,
  name TEXT NOT NULL,
  template_id TEXT NOT NULL,
  collection_name TEXT,
  image TEXT,
  back_image TEXT,
  video TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  capture_radius INTEGER NOT NULL DEFAULT 50,
  remaining INTEGER NOT NULL DEFAULT 1,
  captured INTEGER NOT NULL DEFAULT 0,
  rarity TEXT,
  once_per_player INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'admin',   -- 'admin' | 'spawn' | 'starter'
  reserved_for TEXT,                      -- starter drops are visible only to this account
  expires_at TEXT,                        -- ISO timestamp; NULL = never expires
  distribution TEXT NOT NULL DEFAULT 'transfer', -- 'transfer' (from vault) | 'mint' (on demand)
  schema_name TEXT,                       -- required when distribution = 'mint'
  created TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drops_geo ON drops(lat, lng);
CREATE INDEX IF NOT EXISTS idx_drops_active ON drops(remaining, expires_at);

-- Templates eligible for auto-spawning, with rarity weights.
CREATE TABLE IF NOT EXISTS pool (
  template_id TEXT PRIMARY KEY,
  collection_name TEXT,
  name TEXT,
  image TEXT,
  back_image TEXT,
  video TEXT,
  weight INTEGER NOT NULL DEFAULT 10,
  enabled INTEGER NOT NULL DEFAULT 1,
  distribution TEXT NOT NULL DEFAULT 'transfer', -- 'transfer' | 'mint'
  schema_name TEXT,
  guarantee INTEGER NOT NULL DEFAULT 0 -- 1 = guaranteed once per player, excluded from ambient spawns
);

-- Every successful capture (also powers once-per-player and starter logic).
CREATE TABLE IF NOT EXISTS captures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account TEXT NOT NULL,
  drop_id TEXT,
  template_id TEXT,
  asset_id TEXT,
  tx_id TEXT,
  created TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_captures_account ON captures(account);

-- Spawn triggers, for budget enforcement.
CREATE TABLE IF NOT EXISTS spawn_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account TEXT,
  geocell TEXT,
  day TEXT NOT NULL,
  created TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spawn_day ON spawn_events(day);
CREATE INDEX IF NOT EXISTS idx_spawn_account ON spawn_events(account, day);
CREATE INDEX IF NOT EXISTS idx_spawn_cell ON spawn_events(geocell, created);
