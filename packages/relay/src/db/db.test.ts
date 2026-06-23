import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase, getSchemaVersion, type Db } from './db.ts'

describe('openDatabase', () => {
  let db: Db
  beforeEach(() => { db = openDatabase(':memory:') })

  it('applies schema and reports latest version', () => {
    expect(getSchemaVersion(db)).toBe(5)
  })

  it('human table has last_active_at column (v2)', () => {
    const cols = db.pragma('table_info(human)') as Array<{ name: string }>
    expect(cols.some(c => c.name === 'last_active_at')).toBe(true)
  })

  it('drops legacy pair_code table at v3', () => {
    const names = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all().map((r: any) => r.name)
    expect(names).not.toContain('pair_code')
  })

  it('pre-seeds the singleton hangar team (D10)', () => {
    const row = db.prepare("SELECT id, name FROM team WHERE id='hangar'").get() as { id: string; name: string } | undefined
    expect(row).toEqual({ id: 'hangar', name: 'hangar' })
  })

  it('has all expected tables', () => {
    const names = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map((r: any) => r.name)
    expect(names).toEqual(expect.arrayContaining([
      'audit_log', 'human', 'idempotency_key', 'message',
      'schema_version', 'team', 'token'
    ]))
  })

  it('enforces human.handle uniqueness within a team', () => {
    db.prepare("INSERT INTO team(id,name,retention_days,created_at) VALUES (?,?,?,?)")
      .run('t1', 'acme', 7, new Date().toISOString())
    const ins = db.prepare(
      "INSERT INTO human(id,team_id,handle,display_name,created_at) VALUES (?,?,?,?,?)"
    )
    ins.run('h1', 't1', 'alice', 'Alice', new Date().toISOString())
    expect(() => ins.run('h2', 't1', 'alice', 'Alice2', new Date().toISOString())).toThrow()
  })

  it('rejects message with invalid kind', () => {
    db.prepare("INSERT INTO team(id,name,retention_days,created_at) VALUES (?,?,?,?)")
      .run('t1', 'acme', 7, new Date().toISOString())
    expect(() => db.prepare(
      "INSERT INTO message(id,v,team_id,from_handle,to_handle,kind,content,sent_at) VALUES (?,?,?,?,?,?,?,?)"
    ).run('msg_x', 1, 't1', 'a', 'b', 'invalid', 'x', new Date().toISOString())).toThrow()
  })

  it('accepts task_dispatch and task_result kinds (v4 widening)', () => {
    db.prepare("INSERT INTO team(id,name,retention_days,created_at) VALUES (?,?,?,?)")
      .run('t1', 'acme', 7, new Date().toISOString())
    const ins = db.prepare(
      "INSERT INTO message(id,v,team_id,from_handle,to_handle,kind,content,sent_at) VALUES (?,?,?,?,?,?,?,?)"
    )
    expect(() =>
      ins.run('msg_d', 2, 't1', 'a', 'b', 'task_dispatch', 'run pytest', new Date().toISOString())
    ).not.toThrow()
    expect(() =>
      ins.run('msg_r', 2, 't1', 'b', 'a', 'task_result', 'exit 0', new Date().toISOString())
    ).not.toThrow()
  })
})

describe('migrateV3ToV4 (rebuild path)', () => {
  let tmpDir: string
  let dbPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hangar-bridge-migrate-'))
    dbPath = join(tmpDir, 'v3.db')
    // Seed a v3-shape DB by hand (without task_dispatch / task_result in CHECK).
    const raw = new Database(dbPath)
    raw.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE schema_version(version INTEGER PRIMARY KEY);
      CREATE TABLE team(id TEXT PRIMARY KEY, name TEXT NOT NULL, retention_days INTEGER NOT NULL DEFAULT 7, created_at TEXT NOT NULL);
      CREATE TABLE human(id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES team(id), handle TEXT NOT NULL, display_name TEXT NOT NULL, public_key BLOB, created_at TEXT NOT NULL, disabled_at TEXT, last_active_at TEXT, UNIQUE(team_id, handle));
      CREATE TABLE token(id TEXT PRIMARY KEY, human_id TEXT NOT NULL REFERENCES human(id), token_hash BLOB NOT NULL UNIQUE, label TEXT NOT NULL, tier TEXT NOT NULL CHECK(tier IN ('human','admin')), created_at TEXT NOT NULL, revoked_at TEXT);
      CREATE TABLE message(
        id TEXT PRIMARY KEY, v INTEGER NOT NULL, team_id TEXT NOT NULL REFERENCES team(id),
        from_handle TEXT NOT NULL, to_handle TEXT NOT NULL, in_reply_to TEXT, thread_root TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('chat','presence_update','permission_request','permission_verdict')),
        content TEXT NOT NULL, meta_json TEXT NOT NULL DEFAULT '{}', sent_at TEXT NOT NULL, delivered_at TEXT
      );
      CREATE TABLE idempotency_key(key_hash BLOB PRIMARY KEY, token_id TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT, team_id TEXT NOT NULL REFERENCES team(id), at TEXT NOT NULL, actor_human_id TEXT, event TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}');
      INSERT INTO schema_version(version) VALUES (1),(2),(3);
      INSERT INTO team(id,name,retention_days,created_at) VALUES ('hangar','hangar',7,'2026-05-17T00:00:00Z');
    `)
    raw.prepare(
      "INSERT INTO message(id,v,team_id,from_handle,to_handle,kind,content,sent_at) VALUES (?,?,?,?,?,?,?,?)"
    ).run('msg_legacy_chat', 1, 'hangar', 'alice', 'bob', 'chat', 'pre-migration', '2026-05-17T00:00:00Z')
    raw.close()
  })

  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

  it('rebuilds message table to accept new kinds and preserves existing rows', () => {
    const upgraded = openDatabase(dbPath)
    expect(getSchemaVersion(upgraded)).toBe(5)
    const legacy = upgraded.prepare("SELECT content FROM message WHERE id='msg_legacy_chat'").get() as { content: string } | undefined
    expect(legacy?.content).toBe('pre-migration')
    expect(() =>
      upgraded.prepare(
        "INSERT INTO message(id,v,team_id,from_handle,to_handle,kind,content,sent_at) VALUES (?,?,?,?,?,?,?,?)"
      ).run('msg_new_d', 2, 'hangar', 'alice', 'bob', 'task_dispatch', 'go', '2026-05-17T00:00:01Z')
    ).not.toThrow()
    upgraded.close()
  })

  it('is idempotent: second open does not rebuild again', () => {
    openDatabase(dbPath).close()
    const second = openDatabase(dbPath)
    expect(getSchemaVersion(second)).toBe(5)
    const versions = second.prepare("SELECT version FROM schema_version ORDER BY version").all() as Array<{ version: number }>
    expect(versions.map(r => r.version)).toEqual([1, 2, 3, 4, 5])
    second.close()
  })
})
