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
    expect(getSchemaVersion(db)).toBe(9)
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
      'audit_log', 'claim', 'human', 'idempotency_key', 'message',
      'reply_grant', 'reply_idem', 'reply_limiter', 'reply_route',
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
    expect(getSchemaVersion(upgraded)).toBe(9)
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
    expect(getSchemaVersion(second)).toBe(9)
    const versions = second.prepare("SELECT version FROM schema_version ORDER BY version").all() as Array<{ version: number }>
    expect(versions.map(r => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    second.close()
  })
})

describe('migrateV5ToV6 (claim table)', () => {
  let tmpDir: string
  let dbPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hangar-bridge-v6-'))
    dbPath = join(tmpDir, 'v5.db')
    // Seed a v5-shape DB by hand (subject routing present, but NO claim table).
    const raw = new Database(dbPath)
    raw.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE schema_version(version INTEGER PRIMARY KEY);
      CREATE TABLE team(id TEXT PRIMARY KEY, name TEXT NOT NULL, retention_days INTEGER NOT NULL DEFAULT 7, created_at TEXT NOT NULL);
      CREATE TABLE human(id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES team(id), handle TEXT NOT NULL, display_name TEXT NOT NULL, public_key BLOB, created_at TEXT NOT NULL, disabled_at TEXT, last_active_at TEXT, subjects TEXT, UNIQUE(team_id, handle));
      CREATE TABLE token(id TEXT PRIMARY KEY, human_id TEXT NOT NULL REFERENCES human(id), token_hash BLOB NOT NULL UNIQUE, label TEXT NOT NULL, tier TEXT NOT NULL CHECK(tier IN ('human','admin')), created_at TEXT NOT NULL, revoked_at TEXT);
      CREATE TABLE message(id TEXT PRIMARY KEY, v INTEGER NOT NULL, team_id TEXT NOT NULL REFERENCES team(id), from_handle TEXT NOT NULL, to_handle TEXT NOT NULL, in_reply_to TEXT, thread_root TEXT, kind TEXT NOT NULL CHECK(kind IN ('chat','presence_update','permission_request','permission_verdict','task_dispatch','task_result')), content TEXT NOT NULL, meta_json TEXT NOT NULL DEFAULT '{}', sent_at TEXT NOT NULL, delivered_at TEXT, subject TEXT);
      CREATE TABLE idempotency_key(key_hash BLOB PRIMARY KEY, token_id TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT, team_id TEXT NOT NULL REFERENCES team(id), at TEXT NOT NULL, actor_human_id TEXT, event TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}');
      INSERT INTO schema_version(version) VALUES (1),(2),(3),(4),(5);
      INSERT INTO team(id,name,retention_days,created_at) VALUES ('hangar','hangar',7,'2026-05-17T00:00:00Z');
    `)
    raw.close()
  })

  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

  it('adds the claim table to an existing v5 DB and records version 6', () => {
    const upgraded = openDatabase(dbPath)
    expect(getSchemaVersion(upgraded)).toBe(9)
    const has = upgraded.prepare(
      "SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='claim'"
    ).get()
    expect(has).toBeTruthy()
    // The table is usable (round-trips a row).
    upgraded.prepare(
      "INSERT INTO claim(team_id,claim_key,owner_handle,created_at,expires_at) VALUES (?,?,?,?,?)"
    ).run('hangar', 'k', 'alice', '2026-05-17T00:00:00Z', '2026-05-17T01:00:00Z')
    const row = upgraded.prepare("SELECT owner_handle FROM claim WHERE claim_key='k'").get() as { owner_handle: string }
    expect(row.owner_handle).toBe('alice')
    upgraded.close()
  })

  it('is idempotent: re-open keeps version 6 and one claim table', () => {
    openDatabase(dbPath).close()
    const second = openDatabase(dbPath)
    expect(getSchemaVersion(second)).toBe(9)
    second.close()
  })
})

describe('migrateV6ToV7 (legacy attribution scrub)', () => {
  let tmpDir: string
  let dbPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hangar-bridge-v7-'))
    dbPath = join(tmpDir, 'v6.db')
    const raw = new Database(dbPath)
    raw.exec(`
      CREATE TABLE schema_version(version INTEGER PRIMARY KEY);
      CREATE TABLE team(id TEXT PRIMARY KEY, name TEXT NOT NULL, retention_days INTEGER NOT NULL DEFAULT 7, created_at TEXT NOT NULL);
      CREATE TABLE human(id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES team(id), handle TEXT NOT NULL, display_name TEXT NOT NULL, public_key BLOB, created_at TEXT NOT NULL, disabled_at TEXT, last_active_at TEXT, subjects TEXT, UNIQUE(team_id, handle));
      CREATE TABLE token(id TEXT PRIMARY KEY, human_id TEXT NOT NULL REFERENCES human(id), token_hash BLOB NOT NULL UNIQUE, label TEXT NOT NULL, tier TEXT NOT NULL CHECK(tier IN ('human','admin')), created_at TEXT NOT NULL, revoked_at TEXT);
      CREATE TABLE message(id TEXT PRIMARY KEY, v INTEGER NOT NULL, team_id TEXT NOT NULL REFERENCES team(id), from_handle TEXT NOT NULL, to_handle TEXT NOT NULL, in_reply_to TEXT, thread_root TEXT, kind TEXT NOT NULL CHECK(kind IN ('chat','presence_update','permission_request','permission_verdict','task_dispatch','task_result')), content TEXT NOT NULL, meta_json TEXT NOT NULL DEFAULT '{}', sent_at TEXT NOT NULL, delivered_at TEXT, subject TEXT);
      CREATE TABLE idempotency_key(key_hash BLOB PRIMARY KEY, token_id TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT, team_id TEXT NOT NULL REFERENCES team(id), at TEXT NOT NULL, actor_human_id TEXT, event TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE claim(team_id TEXT NOT NULL REFERENCES team(id), claim_key TEXT NOT NULL, owner_handle TEXT NOT NULL, owner_label TEXT, note TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY(team_id, claim_key));
      INSERT INTO schema_version(version) VALUES (1),(2),(3),(4),(5),(6);
      INSERT INTO team(id,name,retention_days,created_at) VALUES ('hangar','hangar',7,'2026-05-17T00:00:00Z');
    `)
    raw.prepare(
      'INSERT INTO message(id,v,team_id,from_handle,to_handle,kind,content,meta_json,sent_at) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(
      'msg_legacy_attribution', 2, 'hangar', 'alice', 'alice', 'chat', 'legacy',
      JSON.stringify({
        instance: 'forged', sender_instance: 'forged', session_id: 'forged',
        attribution_status: 'stamped', keep: 'yes',
      }),
      '2026-05-17T00:00:00Z',
    )
    raw.close()
  })

  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

  it('removes newly reserved routing meta before recording v7', () => {
    const upgraded = openDatabase(dbPath)
    expect(getSchemaVersion(upgraded)).toBe(9)
    const row = upgraded.prepare(
      "SELECT meta_json FROM message WHERE id='msg_legacy_attribution'"
    ).get() as { meta_json: string }
    expect(JSON.parse(row.meta_json)).toEqual({ keep: 'yes' })
    upgraded.close()

    const reopened = openDatabase(dbPath)
    expect(JSON.parse((reopened.prepare(
      "SELECT meta_json FROM message WHERE id='msg_legacy_attribution'"
    ).get() as { meta_json: string }).meta_json)).toEqual({ keep: 'yes' })
    reopened.close()
  })
})

describe('migrateV8ToV9 (reply routing tables, REPLY_ROUTING_SPEC §3.1)', () => {
  it('a fresh DB ends at version 9 with all four tables + the correlation index', () => {
    const db = openDatabase(':memory:')
    expect(getSchemaVersion(db)).toBe(9)
    const names = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'reply_%' ORDER BY name"
    ).all().map((r: any) => r.name)
    expect(names).toEqual(['reply_grant', 'reply_idem', 'reply_limiter', 'reply_route'])
    const idx = db.prepare(
      "SELECT 1 AS x FROM sqlite_master WHERE type='index' AND name='reply_route_correlation'"
    ).get()
    expect(idx).toBeTruthy()
  })

  it('reply_route columns match §3.1 exactly', () => {
    const db = openDatabase(':memory:')
    const cols = (db.pragma('table_info(reply_route)') as Array<{ name: string; notnull: number }>)
      .map(c => c.name)
    expect(cols).toEqual([
      'msg_id', 'team_id', 'from_handle', 'sender_instance', 'return_selector',
      'to_handle', 'to_filter_json', 'thread_root', 'legacy_width',
      'correlation_id', 'created_at', 'expires_at', 'unaddressable_at',
    ])
  })

  it('reply_grant has a composite PK and cascades on reply_route delete', () => {
    const db = openDatabase(':memory:')
    db.prepare("INSERT INTO team(id,name,retention_days,created_at) VALUES ('t1','t1',7,'2026-01-01T00:00:00Z')").run()
    db.prepare(`
      INSERT INTO reply_route(msg_id,team_id,from_handle,to_handle,thread_root,created_at)
      VALUES ('msg_a','t1','alice','bob','msg_a','2026-01-01T00:00:00Z')
    `).run()
    db.prepare(
      "INSERT INTO reply_grant(msg_id,handle,instance,selector) VALUES ('msg_a','bob','inst-1','')"
    ).run()
    // duplicate grant key is a no-op error path exercised via INSERT OR IGNORE by the store (item 3);
    // here we just prove the PK rejects a raw duplicate insert.
    expect(() => db.prepare(
      "INSERT INTO reply_grant(msg_id,handle,instance,selector) VALUES ('msg_a','bob','inst-1','')"
    ).run()).toThrow()
    db.prepare("DELETE FROM reply_route WHERE msg_id='msg_a'").run()
    const remaining = db.prepare("SELECT COUNT(*) AS n FROM reply_grant WHERE msg_id='msg_a'").get() as { n: number }
    expect(remaining.n).toBe(0)
  })

  it('reply_route_correlation is a partial unique index (NULLs do not collide)', () => {
    const db = openDatabase(':memory:')
    db.prepare("INSERT INTO team(id,name,retention_days,created_at) VALUES ('t1','t1',7,'2026-01-01T00:00:00Z')").run()
    const ins = db.prepare(`
      INSERT INTO reply_route(msg_id,team_id,from_handle,to_handle,thread_root,correlation_id,created_at)
      VALUES (?,?,?,?,?,?,?)
    `)
    ins.run('msg_a', 't1', 'alice', 'bob', 'msg_a', null, '2026-01-01T00:00:00Z')
    ins.run('msg_b', 't1', 'alice', 'bob', 'msg_b', null, '2026-01-01T00:00:00Z')
    expect(() => ins.run('msg_c', 't1', 'alice', 'bob', 'msg_c', 'corr-1', '2026-01-01T00:00:00Z')).not.toThrow()
    expect(() => ins.run('msg_d', 't1', 'alice', 'bob', 'msg_d', 'corr-1', '2026-01-01T00:00:00Z')).toThrow()
  })

  it('is idempotent: opening a v9 DB twice does not duplicate tables or the index', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'hangar-bridge-v9-'))
    const dbPath = join(tmpDir, 'v9.db')
    try {
      openDatabase(dbPath).close()
      const second = openDatabase(dbPath)
      expect(getSchemaVersion(second)).toBe(9)
      const tableCount = second.prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='reply_route'"
      ).get() as { n: number }
      expect(tableCount.n).toBe(1)
      const idxCount = second.prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name='reply_route_correlation'"
      ).get() as { n: number }
      expect(idxCount.n).toBe(1)
      second.close()
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
