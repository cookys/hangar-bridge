-- hangar-bridge relay schema v7
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
  subject TEXT,              -- dotted routing key, NULL = legacy fan-out (v5)
  to_filter_json TEXT        -- presence-backed audience narrowing {instance?,repo?}, NULL = none (v8)
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

-- Reply routing (REPLY_ROUTING_SPEC.md §3.1, schema v9). A route is stamped for
-- every accepted user-authored message so a later reply can resolve who may
-- answer it and where. Never deleted while the message row it belongs to can
-- still be presented; expired/legacy routes are swept by the purge sweep.
CREATE TABLE IF NOT EXISTS reply_route (
  msg_id           TEXT PRIMARY KEY,   -- == the envelope id the receiver sees
  team_id          TEXT NOT NULL,
  from_handle      TEXT NOT NULL,
  sender_instance  TEXT,               -- relay-stamped; NULL only on pre-rollout rows
  return_selector  TEXT,               -- from x-hangar-return-selector header; courier panes only
  to_handle        TEXT NOT NULL,      -- '@team', a handle, or '@mailbox:<handle>'
  to_filter_json   TEXT,
  thread_root      TEXT NOT NULL,      -- effective root, never NULL (§3.3)
  legacy_width     TEXT,               -- NULL | 'handle' | 'team-not-sender' | 'unreplyable' (§5.3)
  correlation_id   TEXT,               -- alias key for ephemeral chat (existing meta.correlation_id)
  created_at       TEXT NOT NULL,
  expires_at       TEXT,               -- NULL = follows the message row; set for ephemeral + legacy
  unaddressable_at TEXT                -- tombstone (§5.4): set, never deleted, so later grants still insert
);
CREATE UNIQUE INDEX IF NOT EXISTS reply_route_correlation ON reply_route(correlation_id) WHERE correlation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS reply_grant (
  msg_id TEXT NOT NULL REFERENCES reply_route(msg_id) ON DELETE CASCADE,
  handle TEXT NOT NULL,
  instance TEXT NOT NULL,              -- '~cli' for the operator mailbox
  selector TEXT NOT NULL DEFAULT '',   -- '<name>@<generation>' when the courier pasted into a pane; '' otherwise (§5.2)
  PRIMARY KEY (msg_id, handle, instance, selector)
);

-- Relay-side reply limiter (§9): fixed 10-minute window per (thread_root, handle).
-- Rows older than 2 windows are swept by the purge loop (purgeReplyState).
CREATE TABLE IF NOT EXISTS reply_limiter (
  thread_root TEXT NOT NULL, handle TEXT NOT NULL,
  window_start TEXT NOT NULL,          -- fixed window, floor(now / window) as ISO
  count INTEGER NOT NULL,
  PRIMARY KEY (thread_root, handle, window_start)
);

-- Idempotency ledger for /v1/replies (§3.1, §5.1). Scoped to (team, handle) via
-- key_hash so two handles never see each other's results.
CREATE TABLE IF NOT EXISTS reply_idem (
  key_hash BLOB PRIMARY KEY,            -- sha256 of length-prefixed (team_id, handle, key): len‖bytes for each
  request_digest BLOB NOT NULL,         -- sha256 of RFC 8785 (JCS) canonical JSON of {in_reply_to, content, meta}
  state TEXT NOT NULL CHECK(state IN ('pending','committed','final','error')),
  lease TEXT NOT NULL,                  -- ULID; changes on every takeover (fencing token)
  reserved_at TEXT NOT NULL,            -- refreshed on every takeover
  result_status INTEGER,                -- HTTP status to replay
  result_json TEXT,                     -- body to replay: at 'committed' (before fanout), 'final', or 'error'
  error_until TEXT                      -- for 'error' rows that may be re-executed (reply_storm): retry_after
);

INSERT OR IGNORE INTO schema_version(version) VALUES (1);
INSERT OR IGNORE INTO schema_version(version) VALUES (2);
INSERT OR IGNORE INTO schema_version(version) VALUES (3);
INSERT OR IGNORE INTO schema_version(version) VALUES (4);
INSERT OR IGNORE INTO schema_version(version) VALUES (5);
INSERT OR IGNORE INTO schema_version(version) VALUES (6);
-- Version 7 is recorded by migrateV6ToV7 only after legacy attribution meta
-- has been scrubbed. Do not pre-insert it here: existing databases execute this
-- file before migrations too.

-- D10: single fixed team row. All authenticated requests bind to this team.
INSERT OR IGNORE INTO team(id, name, retention_days, created_at)
  VALUES ('hangar', 'hangar', 7, '2026-05-17T00:00:00Z');
