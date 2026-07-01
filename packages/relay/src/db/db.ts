import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export type Db = Database.Database

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_PATH = join(__dirname, 'schema.sql')

export function openDatabase(path: string): Db {
  const db = new Database(path)
  const schema = readFileSync(SCHEMA_PATH, 'utf8')
  db.exec(schema)
  migrateV1ToV2(db)
  migrateV2ToV3(db)
  migrateV3ToV4(db)
  migrateV4ToV5(db)
  migrateV5ToV6(db)
  return db
}

/**
 * Adds the `claim` table (cooperative advisory asset lock, P4). A NEW table needs no
 * ALTER, so `CREATE TABLE IF NOT EXISTS` in schema.sql covers fresh DBs and this probe
 * covers already-open v5 DBs (creates the table if missing, then records version 6).
 */
function migrateV5ToV6(db: Db): void {
  const has = db.prepare(
    "SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='claim'"
  ).get()
  if (!has) {
    db.exec(`
      CREATE TABLE claim (
        team_id      TEXT NOT NULL REFERENCES team(id),
        claim_key    TEXT NOT NULL,
        owner_handle TEXT NOT NULL,
        owner_label  TEXT,
        note         TEXT,
        created_at   TEXT NOT NULL,
        expires_at   TEXT NOT NULL,
        PRIMARY KEY (team_id, claim_key)
      )
    `)
    db.exec('CREATE INDEX IF NOT EXISTS idx_claim_expires ON claim(team_id, expires_at)')
  }
  db.exec('INSERT OR IGNORE INTO schema_version(version) VALUES (6)')
}

/**
 * Adds subject routing + ACL columns: `message.subject` (the dotted routing key,
 * nullable) and `human.subjects` (JSON {owned,interest} for the namespace ACL).
 * ALTER TABLE ADD COLUMN guarded by pragma table_info (mirrors migrateV1ToV2) —
 * NOT CREATE IF NOT EXISTS, which never adds a column to an existing table. No
 * subject index: the by-handle scan is served by idx_message_to_handle and the
 * subject filter runs in JS (single shared matcher), so an index would be dead.
 */
function migrateV4ToV5(db: Db): void {
  const msgCols = db.pragma('table_info(message)') as Array<{ name: string }>
  if (!msgCols.some(c => c.name === 'subject')) {
    db.exec('ALTER TABLE message ADD COLUMN subject TEXT')
  }
  const humanCols = db.pragma('table_info(human)') as Array<{ name: string }>
  if (!humanCols.some(c => c.name === 'subjects')) {
    db.exec('ALTER TABLE human ADD COLUMN subjects TEXT')
  }
  db.exec('INSERT OR IGNORE INTO schema_version(version) VALUES (5)')
}

function migrateV1ToV2(db: Db): void {
  const cols = db.pragma('table_info(human)') as Array<{ name: string }>
  if (!cols.some(c => c.name === 'last_active_at')) {
    db.exec('ALTER TABLE human ADD COLUMN last_active_at TEXT')
    db.exec('UPDATE human SET last_active_at = created_at WHERE last_active_at IS NULL')
  }
  db.exec('INSERT OR IGNORE INTO schema_version(version) VALUES (2)')
}

/**
 * Drops the legacy `pair_code` table. In hangar-bridge each peer carries a
 * pre-distributed shared secret in `~/.config/hangar-bridge/secret`; the relay
 * reads `peers.json` at startup and seeds the `human` + `token` rows directly,
 * so there is no longer a pair-code consumption step.
 */
function migrateV2ToV3(db: Db): void {
  db.exec('DROP TABLE IF EXISTS pair_code')
  db.exec('INSERT OR IGNORE INTO schema_version(version) VALUES (3)')
}

/**
 * Widens message.kind CHECK to admit task_dispatch + task_result. SQLite cannot
 * ALTER a CHECK constraint in place, so the table must be rebuilt. Probes the
 * existing CREATE statement and skips when the new kinds are already allowed
 * (fresh DB on v4 schema.sql, or repeat-open of an already-migrated DB).
 */
function migrateV3ToV4(db: Db): void {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='message'"
  ).get() as { sql: string } | undefined
  if (row && row.sql.includes("'task_dispatch'")) {
    db.exec('INSERT OR IGNORE INTO schema_version(version) VALUES (4)')
    return
  }
  db.exec('BEGIN')
  try {
    db.exec(`
      CREATE TABLE message_v4 (
        id TEXT PRIMARY KEY,
        v INTEGER NOT NULL,
        team_id TEXT NOT NULL REFERENCES team(id),
        from_handle TEXT NOT NULL,
        to_handle TEXT NOT NULL,
        in_reply_to TEXT,
        thread_root TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('chat','presence_update','permission_request','permission_verdict','task_dispatch','task_result')),
        content TEXT NOT NULL,
        meta_json TEXT NOT NULL DEFAULT '{}',
        sent_at TEXT NOT NULL,
        delivered_at TEXT
      )
    `)
    db.exec(`
      INSERT INTO message_v4(id, v, team_id, from_handle, to_handle, in_reply_to,
                             thread_root, kind, content, meta_json, sent_at, delivered_at)
      SELECT id, v, team_id, from_handle, to_handle, in_reply_to,
             thread_root, kind, content, meta_json, sent_at, delivered_at
      FROM message
    `)
    db.exec('DROP TABLE message')
    db.exec('ALTER TABLE message_v4 RENAME TO message')
    db.exec('CREATE INDEX IF NOT EXISTS idx_message_team_id ON message(team_id, id)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_message_to_handle ON message(team_id, to_handle, id)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_message_thread ON message(thread_root)')
    db.exec('INSERT OR IGNORE INTO schema_version(version) VALUES (4)')
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export function getSchemaVersion(db: Db): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null }
  return row.v ?? 0
}

export function closeDatabase(db: Db): void {
  db.close()
}
