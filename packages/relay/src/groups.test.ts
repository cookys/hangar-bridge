import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ALL_MEMBER_CAPS } from '@hangar-bridge/shared'
import { openDatabase } from './db/db.ts'
import {
  loadMemberships,
  members,
  readerScope,
  requireCap,
  sharedAudience,
} from './groups.ts'

function seededDb() {
  const db = openDatabase(':memory:')
  db.prepare("INSERT OR IGNORE INTO peer_group(id,team_id,description,history,created_at) VALUES ('lab','hangar','Lab','since_join','2026-05-17T00:00:00Z')").run()
  db.prepare("INSERT OR IGNORE INTO peer_group(id,team_id,description,history,created_at) VALUES ('other','hangar','Other','since_join','2026-05-17T00:00:00Z')").run()
  const ins = db.prepare('INSERT OR REPLACE INTO group_member(group_id,handle,caps_json,member_since,since_msg_id) VALUES (?,?,?,?,?)')
  ins.run('cookys', 'a', JSON.stringify(ALL_MEMBER_CAPS), '2026-05-17T00:00:00Z', '0')
  ins.run('cookys', 'b', JSON.stringify(['chat', 'broadcast']), '2026-05-17T00:00:00Z', 'msg_01HRK7Y0000000000000000000')
  ins.run('lab', 'b', JSON.stringify(['chat']), '2026-05-17T00:00:00Z', 'msg_01HRK7Y0000000000000000002')
  ins.run('lab', 'c', JSON.stringify(['chat']), '2026-05-17T00:00:00Z', '0')
  ins.run('other', 'd', JSON.stringify(['chat']), '2026-05-17T00:00:00Z', '0')
  return db
}

describe('groups helpers', () => {
  it('loads memberships for a handle', () => {
    const m = loadMemberships(seededDb(), 'b')
    expect([...m.keys()].sort()).toEqual(['cookys', 'lab'])
    expect(m.get('cookys')!.caps).toEqual(new Set(['chat', 'broadcast']))
    expect(m.get('lab')!.since_msg_id).toBe('msg_01HRK7Y0000000000000000002')
  })

  it('lists members of a group', () => {
    expect(members(seededDb(), 'lab')).toEqual(new Set(['b', 'c']))
  })

  it('returns distinct handles sharing at least one group, excluding non-shared peers and self', () => {
    expect(sharedAudience(seededDb(), 'b')).toEqual(new Set(['a', 'c']))
  })

  it('checks capability outcomes without admitting group existence', () => {
    const m = loadMemberships(seededDb(), 'b')
    expect(requireCap(m, 'cookys', 'chat')).toBe('ok')
    expect(requireCap(m, 'lab', 'broadcast')).toBe('cap_denied')
    expect(requireCap(m, 'missing', 'chat')).toBe('unknown_group')
  })

  it('builds an executable reader scope using group-specific since ids', () => {
    const db = seededDb()
    db.exec('CREATE TABLE sample_message(id TEXT PRIMARY KEY, group_id TEXT NOT NULL)')
    const ins = db.prepare('INSERT INTO sample_message(id, group_id) VALUES (?, ?)')
    ins.run('msg_01HRK7Y0000000000000000000', 'cookys')
    ins.run('msg_01HRK7Y0000000000000000001', 'cookys')
    ins.run('msg_01HRK7Y0000000000000000002', 'lab')
    ins.run('msg_01HRK7Y0000000000000000003', 'lab')
    ins.run('msg_01HRK7Y0000000000000000004', 'other')
    const scope = readerScope(loadMemberships(db, 'b'))
    const rows = db.prepare(`SELECT id FROM sample_message WHERE ${scope.sql} ORDER BY id`).all(...scope.params) as Array<{ id: string }>
    expect(rows.map(r => r.id)).toEqual([
      'msg_01HRK7Y0000000000000000001',
      'msg_01HRK7Y0000000000000000003',
    ])
  })

  it('empty reader scope is fail-closed', () => {
    const db = seededDb()
    db.exec('CREATE TABLE sample_message(id TEXT PRIMARY KEY, group_id TEXT NOT NULL)')
    db.prepare("INSERT INTO sample_message(id, group_id) VALUES ('msg_01HRK7Y0000000000000000001', 'cookys')").run()
    const scope = readerScope(new Map())
    expect(db.prepare(`SELECT id FROM sample_message WHERE ${scope.sql}`).all(...scope.params)).toEqual([])
  })

  it('keeps the five store fetch helpers free of post-query .filter calls', () => {
    const source = readFileSync(join(process.cwd(), 'src/messages/store.ts'), 'utf8')
    for (const name of ['fetchSince', 'fetchPendingSince', 'fetchInboxSince', 'fetchInboxIdsAfter', 'fetchMailboxSince']) {
      const start = source.indexOf(`${name}(`)
      expect(start, `${name} exists`).toBeGreaterThanOrEqual(0)
      const next = source.indexOf('\n  ', source.indexOf('\n  }', start) + 4)
      const body = source.slice(start, next === -1 ? undefined : next)
      expect(body).not.toContain('.filter(')
    }
  })
})
