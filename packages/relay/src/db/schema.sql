-- hangar-bridge relay schema v6
--
-- D10 stub posture: single-tenant. `team_id` is constant `'hangar'` everywhere
-- in application code. Schema retains the column + FK for minimal churn vs
-- upstream claude-mesh. The `team` row is pre-seeded below so init/store/etc.
-- don't need to insert it.
--
-- Upstream's pair_code flow is gone (P2 auth simplification — single shared
-- secret per peer, populated by manual scp to ~/.config/hangar-bridge/secret;
-- relay reads peers map from ~/.config/hangar-bridge/peers.json and seeds the
-- `human` + `token` rows on startup). `human` and `token` SQL names stay per
-- C1 — TS identifiers were renamed to `PeerRecord` etc, but the schema is
-- unchanged to keep migration risk at zero.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS team (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  retention_days INTEGER NOT NULL DEFAULT 7,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS human (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES team(id),
  handle TEXT NOT NULL,
  display_name TEXT NOT NULL,
  public_key BLOB,
  created_at TEXT NOT NULL,
  disabled_at TEXT,
  last_active_at TEXT,
  subjects TEXT,              -- JSON {owned,interest} for the namespace ACL (v5)
  UNIQUE(team_id, handle)
);

CREATE TABLE IF NOT EXISTS token (
  id TEXT PRIMARY KEY,
  human_id TEXT NOT NULL REFERENCES human(id),
  token_hash BLOB NOT NULL UNIQUE,
  label TEXT NOT NULL,
  tier TEXT NOT NULL CHECK(tier IN ('human', 'admin')),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_token_human ON token(human_id);

CREATE TABLE IF NOT EXISTS message (
  id TEXT PRIMARY KEY,
  v INTEGER NOT NULL,
  team_id TEXT NOT NULL REFERENCES team(id),
  from_handle TEXT NOT NULL,
  to_handle TEXT NOT NULL,    -- peer handle or '@team'
  in_reply_to TEXT,
  thread_root TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('chat','presence_update','permission_request','permission_verdict','task_dispatch','task_result')),
  content TEXT NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}',
  sent_at TEXT NOT NULL,
  delivered_at TEXT,
  subject TEXT               -- dotted routing key, NULL = legacy fan-out (v5)
);
CREATE INDEX IF NOT EXISTS idx_message_team_id ON message(team_id, id);
CREATE INDEX IF NOT EXISTS idx_message_to_handle ON message(team_id, to_handle, id);
CREATE INDEX IF NOT EXISTS idx_message_thread ON message(thread_root);

CREATE TABLE IF NOT EXISTS idempotency_key (
  key_hash BLOB PRIMARY KEY,
  token_id TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL REFERENCES team(id),
  at TEXT NOT NULL,
  actor_human_id TEXT,
  event TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_audit_team_at ON audit_log(team_id, at);

-- Cooperative advisory asset lock (v6, fleet-coordination stage 3 / P4). One live
-- owner per (team, claim_key); expires_at gives TTL-based auto-release so a crashed
-- claimer never wedges an asset forever (same philosophy as presence TTL). This is a
-- roster-cooperative lock, NOT namespace-ACL-gated (any authenticated peer may claim).
CREATE TABLE IF NOT EXISTS claim (
  team_id      TEXT NOT NULL REFERENCES team(id),
  claim_key    TEXT NOT NULL,
  owner_handle TEXT NOT NULL,
  owner_label  TEXT,
  note         TEXT,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  PRIMARY KEY (team_id, claim_key)
);
CREATE INDEX IF NOT EXISTS idx_claim_expires ON claim(team_id, expires_at);

INSERT OR IGNORE INTO schema_version(version) VALUES (1);
INSERT OR IGNORE INTO schema_version(version) VALUES (2);
INSERT OR IGNORE INTO schema_version(version) VALUES (3);
INSERT OR IGNORE INTO schema_version(version) VALUES (4);
INSERT OR IGNORE INTO schema_version(version) VALUES (5);
INSERT OR IGNORE INTO schema_version(version) VALUES (6);

-- D10: single fixed team row. All authenticated requests bind to this team.
INSERT OR IGNORE INTO team(id, name, retention_days, created_at)
  VALUES ('hangar', 'hangar', 7, '2026-05-17T00:00:00Z');
