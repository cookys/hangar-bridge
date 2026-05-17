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
  return db
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

export function getSchemaVersion(db: Db): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null }
  return row.v ?? 0
}

export function closeDatabase(db: Db): void {
  db.close()
}
