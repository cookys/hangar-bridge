import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HANGAR_TEAM_ID } from '@hangar-bridge/shared'
import { openDatabase } from '../db/db.ts'
import { hashToken, generateRawToken } from './hash.ts'
import { loadPeersFile, seedPeers } from './peers-file.ts'

function tmpPeersFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'peers-'))
  const path = join(dir, 'peers.json')
  writeFileSync(path, JSON.stringify(contents))
  return path
}

describe('loadPeersFile', () => {
  it('parses a valid peers map', () => {
    const path = tmpPeersFile({
      openclaw: { secret_sha256_hex: 'a'.repeat(64) },
      gentoo: { secret_sha256_hex: 'b'.repeat(64), display_name: 'Gentoo Box' },
    })
    const peers = loadPeersFile(path)
    expect(peers).toEqual([
      { handle: 'openclaw', secret_sha256_hex: 'a'.repeat(64), display_name: 'openclaw', subjects: { owned: [], interest: [] } },
      { handle: 'gentoo', secret_sha256_hex: 'b'.repeat(64), display_name: 'Gentoo Box', subjects: { owned: [], interest: [] } },
    ])
    rmSync(path, { force: true })
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
})
