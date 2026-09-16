import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ALL_MEMBER_CAPS, DEFAULT_GROUP_ID, HANGAR_TEAM_ID } from '@hangar-bridge/shared'
import { openDatabase } from '../db/db.ts'
import { hashToken, generateRawToken } from './hash.ts'
import { computeStrictSignals, loadPeersFile, seedPeers, type LoadedPeersFile } from './peers-file.ts'

function tmpPeersFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'peers-'))
  const path = join(dir, 'peers.json')
  writeFileSync(path, JSON.stringify(contents))
  return path
}

function strictLoaded(): LoadedPeersFile {
  return {
    mode: 'strict',
    peers: [
      { handle: 'alice', secret_sha256_hex: 'a'.repeat(64), display_name: 'alice', subjects: { owned: [], interest: [] }, default_group: 'cookys' },
      { handle: 'bob', secret_sha256_hex: 'b'.repeat(64), display_name: 'bob', subjects: { owned: [], interest: [] }, default_group: 'lab' },
    ],
    groups: [
      { id: 'cookys', description: '', history: 'all', members: [{ handle: 'alice', caps: ['chat', 'broadcast'] }] },
      { id: 'lab', description: 'Lab', history: 'since_join', members: [{ handle: 'bob', caps: ALL_MEMBER_CAPS.slice() }] },
    ],
  }
}

function groupMembers(db: ReturnType<typeof openDatabase>): Array<{ group_id: string; handle: string; caps: string[]; since_msg_id: string; member_since: string }> {
  return (db.prepare('SELECT group_id, handle, caps_json, since_msg_id, member_since FROM group_member ORDER BY group_id, handle').all() as Array<{
    group_id: string; handle: string; caps_json: string; since_msg_id: string; member_since: string
  }>).map(r => ({ ...r, caps: JSON.parse(r.caps_json) as string[] }))
}

describe('loadPeersFile', () => {
  it('parses a valid peers map', () => {
    const path = tmpPeersFile({
      openclaw: { secret_sha256_hex: 'a'.repeat(64) },
      gentoo: { secret_sha256_hex: 'b'.repeat(64), display_name: 'Gentoo Box' },
    })
    const peers = loadPeersFile(path)
    expect(peers).toEqual({
      mode: 'legacy',
      peers: [
        { handle: 'openclaw', secret_sha256_hex: 'a'.repeat(64), display_name: 'openclaw', subjects: { owned: [], interest: [] }, default_group: DEFAULT_GROUP_ID },
        { handle: 'gentoo', secret_sha256_hex: 'b'.repeat(64), display_name: 'Gentoo Box', subjects: { owned: [], interest: [] }, default_group: DEFAULT_GROUP_ID },
      ],
      groups: [{
        id: DEFAULT_GROUP_ID,
        description: 'migrated single group',
        history: 'all',
        members: [
          { handle: 'openclaw', caps: ALL_MEMBER_CAPS },
          { handle: 'gentoo', caps: ALL_MEMBER_CAPS },
        ],
      }],
    })
    rmSync(path, { force: true })
  })

  it('treats a flat file with a handle named groups as legacy', () => {
    const path = tmpPeersFile({ groups: { secret_sha256_hex: 'a'.repeat(64) } })
    expect(loadPeersFile(path).mode).toBe('legacy')
    rmSync(path, { force: true })
  })

  it('parses strict v2 peers and groups with defaults', () => {
    const path = tmpPeersFile({
      peers: {
        alice: { secret_sha256_hex: 'a'.repeat(64), default_group: 'cookys' },
      },
      groups: {
        cookys: { members: { alice: {} } },
      },
    })
    expect(loadPeersFile(path)).toEqual({
      mode: 'strict',
      peers: [{ handle: 'alice', secret_sha256_hex: 'a'.repeat(64), display_name: 'alice', subjects: { owned: [], interest: [] }, default_group: 'cookys' }],
      groups: [{ id: 'cookys', description: '', history: 'since_join', members: [{ handle: 'alice', caps: ALL_MEMBER_CAPS }] }],
    })
    rmSync(path, { force: true })
  })

  it('fail-closes strict v2 shape errors', () => {
    expect(() => loadPeersFile(tmpPeersFile({ peers: { alice: { secret_sha256_hex: 'a'.repeat(64) } }, groups: { cookys: { members: { alice: {} } } } }))).toThrow()
    expect(() => loadPeersFile(tmpPeersFile({ peers: { alice: { secret_sha256_hex: 'a'.repeat(64), default_group: 'lab' } }, groups: { cookys: { members: { alice: {} } } } }))).toThrow()
    expect(() => loadPeersFile(tmpPeersFile({ peers: { alice: { secret_sha256_hex: 'a'.repeat(64), default_group: 'cookys' } } }))).toThrow()
    expect(() => loadPeersFile(tmpPeersFile({ peers: { alice: { secret_sha256_hex: 'a'.repeat(64), default_group: 'cookys' } }, groups: { cookys: { members: { alice: {} } } }, extra: true }))).toThrow()
    expect(() => loadPeersFile(tmpPeersFile({ peers: { alice: { secret_sha256_hex: 'a'.repeat(64), default_group: 'cookys' } }, groups: { '@x': { members: { alice: {} } } } }))).toThrow()
  })

  it('rejects non-hex secret_sha256_hex', () => {
    const path = tmpPeersFile({ openclaw: { secret_sha256_hex: 'not-hex' } })
    expect(() => loadPeersFile(path)).toThrow()
    rmSync(path, { force: true })
  })

  it('rejects handle that does not match HANDLE_REGEX', () => {
    const path = tmpPeersFile({ 'Has-Capitals': { secret_sha256_hex: 'a'.repeat(64) } })
    expect(() => loadPeersFile(path)).toThrow()
    rmSync(path, { force: true })
  })

  it('throws a useful error when the file is missing', () => {
    expect(() => loadPeersFile('/nonexistent/peers.json')).toThrow(/peers file not found/)
  })
})

describe('seedPeers', () => {
  it('inserts human + token under the hangar team_id, idempotent on re-run', () => {
    const db = openDatabase(':memory:')
    const raw = generateRawToken()
    const hashHex = hashToken(raw).toString('hex')
    seedPeers(db, [{ handle: 'openclaw', secret_sha256_hex: hashHex, display_name: 'openclaw' }])
    seedPeers(db, [{ handle: 'openclaw', secret_sha256_hex: hashHex, display_name: 'openclaw' }])

    const humans = db.prepare("SELECT handle, team_id FROM human").all() as Array<{ handle: string; team_id: string }>
    expect(humans).toEqual([{ handle: 'openclaw', team_id: HANGAR_TEAM_ID }])
    const tokens = db.prepare("SELECT label, revoked_at FROM token").all() as Array<{ label: string; revoked_at: string | null }>
    expect(tokens).toEqual([{ label: 'shared-secret', revoked_at: null }])
  })

  it('rotates the secret: old token revoked, new active token replaces it', () => {
    const db = openDatabase(':memory:')
    const rawOld = generateRawToken()
    const rawNew = generateRawToken()
    seedPeers(db, [{ handle: 'gentoo', secret_sha256_hex: hashToken(rawOld).toString('hex'), display_name: 'gentoo' }])
    seedPeers(db, [{ handle: 'gentoo', secret_sha256_hex: hashToken(rawNew).toString('hex'), display_name: 'gentoo' }])

    const tokens = db.prepare("SELECT revoked_at, hex(token_hash) AS h FROM token ORDER BY created_at ASC").all() as Array<{ revoked_at: string | null; h: string }>
    expect(tokens.length).toBe(2)
    expect(tokens[0]!.revoked_at).not.toBeNull()
    expect(tokens[1]!.revoked_at).toBeNull()
    expect(tokens[1]!.h.toLowerCase()).toBe(hashToken(rawNew).toString('hex').toLowerCase())
  })

  it('clears disabled_at if the same handle is re-seeded after being disabled', () => {
    const db = openDatabase(':memory:')
    const raw = generateRawToken()
    seedPeers(db, [{ handle: 'openclaw', secret_sha256_hex: hashToken(raw).toString('hex'), display_name: 'openclaw' }])
    db.prepare("UPDATE human SET disabled_at=? WHERE handle=?").run(new Date().toISOString(), 'openclaw')
    seedPeers(db, [{ handle: 'openclaw', secret_sha256_hex: hashToken(raw).toString('hex'), display_name: 'openclaw' }])
    const row = db.prepare("SELECT disabled_at FROM human WHERE handle=?").get('openclaw') as { disabled_at: string | null }
    expect(row.disabled_at).toBeNull()
  })

  it('legacy mode seeds every peer into cookys with all caps and since 0, without revoking vanished humans', () => {
    const writes: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      writes.push(String(chunk))
      return true
    })
    const db = openDatabase(':memory:')
    seedPeers(db, [{ handle: 'old', secret_sha256_hex: 'f'.repeat(64), display_name: 'old', subjects: { owned: [], interest: [] }, default_group: DEFAULT_GROUP_ID }])
    const loaded = loadPeersFile(tmpPeersFile({ alice: { secret_sha256_hex: 'a'.repeat(64) } }))
    const diff = seedPeers(db, loaded, new Date('2026-05-17T00:00:00Z'))
    spy.mockRestore()

    expect(diff.mode).toBe('legacy')
    expect(groupMembers(db).map(r => ({ group_id: r.group_id, handle: r.handle, caps: r.caps, since_msg_id: r.since_msg_id }))).toEqual([
      { group_id: 'cookys', handle: 'alice', caps: ALL_MEMBER_CAPS, since_msg_id: '0' },
      { group_id: 'cookys', handle: 'old', caps: ALL_MEMBER_CAPS, since_msg_id: '0' },
    ])
    expect(db.prepare("SELECT disabled_at FROM human WHERE handle='old'").get()).toEqual({ disabled_at: null })
    expect(writes.filter(w => w.includes('peers.legacy_mode'))).toHaveLength(1)
  })

  it('strict mode inserts since_join members with msg_ watermarks and preserves existing member_since/since_msg_id', () => {
    const db = openDatabase(':memory:')
    const now = new Date('2026-05-17T00:00:00Z')
    seedPeers(db, strictLoaded(), now)
    const firstBob = groupMembers(db).find(r => r.group_id === 'lab' && r.handle === 'bob')!
    expect(firstBob.since_msg_id).toMatch(/^msg_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(firstBob.member_since).toBe(now.toISOString())
    seedPeers(db, strictLoaded(), new Date('2026-05-18T00:00:00Z'))
    const secondBob = groupMembers(db).find(r => r.group_id === 'lab' && r.handle === 'bob')!
    expect(secondBob.since_msg_id).toBe(firstBob.since_msg_id)
    expect(secondBob.member_since).toBe(firstBob.member_since)
    expect(groupMembers(db).find(r => r.group_id === 'cookys' && r.handle === 'alice')!.since_msg_id).toBe('0')
  })

  it('strict mode removes vanished group memberships and vanished handles', () => {
    const db = openDatabase(':memory:')
    const first = strictLoaded()
    seedPeers(db, first, new Date('2026-05-17T00:00:00Z'))
    const second: LoadedPeersFile = {
      mode: 'strict',
      peers: [first.peers[0]!],
      groups: [{ id: 'cookys', description: '', history: 'all', members: [{ handle: 'alice', caps: ['chat'] }] }],
    }
    const diff = seedPeers(db, second, new Date('2026-05-18T00:00:00Z'))
    expect(groupMembers(db).map(r => [r.group_id, r.handle])).toEqual([['cookys', 'alice']])
    expect(db.prepare("SELECT disabled_at FROM human WHERE handle='bob'").get()).toEqual({ disabled_at: '2026-05-18T00:00:00.000Z' })
    expect(db.prepare("SELECT event, detail_json FROM audit_log WHERE event='peer.removed'").get()).toEqual({
      event: 'peer.removed',
      detail_json: JSON.stringify({ handle: 'bob' }),
    })
    expect(diff.shrunk).toEqual(expect.arrayContaining([
      { handle: 'bob', group: 'lab', reason: 'group_deleted' },
      { handle: 'alice', group: 'cookys', reason: 'caps' },
    ]))
    expect(diff.removed_handles).toEqual(['bob'])
  })

  it('strict diff reports grown memberships', () => {
    const db = openDatabase(':memory:')
    const first = strictLoaded()
    seedPeers(db, first, new Date('2026-05-17T00:00:00Z'))
    const second: LoadedPeersFile = {
      mode: 'strict',
      peers: [...first.peers, { handle: 'c', secret_sha256_hex: 'c'.repeat(64), display_name: 'c', subjects: { owned: [], interest: [] }, default_group: 'lab' }],
      groups: [
        first.groups[0]!,
        { id: 'lab', description: 'Lab', history: 'since_join', members: [{ handle: 'bob', caps: ALL_MEMBER_CAPS.slice() }, { handle: 'c', caps: ['chat'] }] },
      ],
    }
    const diff = seedPeers(db, second, new Date('2026-05-18T00:00:00Z'))
    expect(diff.grown).toEqual([{ handle: 'c', group: 'lab' }])
  })

  it('refuses legacy-over-strict and leaves memberships unchanged', () => {
    const db = openDatabase(':memory:')
    seedPeers(db, strictLoaded(), new Date('2026-05-17T00:00:00Z'))
    const before = groupMembers(db)
    expect(computeStrictSignals(db).strict).toBe(true)
    const legacy = loadPeersFile(tmpPeersFile({ alice: { secret_sha256_hex: 'a'.repeat(64) } }))
    expect(() => seedPeers(db, legacy, new Date('2026-05-18T00:00:00Z'))).toThrow(/groups_section_removed/)
    expect(groupMembers(db)).toEqual(before)
  })
})
