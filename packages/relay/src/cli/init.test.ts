import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HANGAR_TEAM_ID } from '@hangar-bridge/shared'
import { openDatabase } from '../db/db.ts'
import { initRelayFromPeersFile } from './init.ts'

function tmpPeersFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'relay-init-'))
  const path = join(dir, 'peers.json')
  writeFileSync(path, JSON.stringify(contents))
  return path
}

describe('initRelayFromPeersFile', () => {
  it('seeds humans + tokens for every peer in peers.json under the hangar team', () => {
    const db = openDatabase(':memory:')
    const path = tmpPeersFile({
      openclaw: { secret_sha256_hex: 'a'.repeat(64) },
      gentoo: { secret_sha256_hex: 'b'.repeat(64) },
    })
    const r = initRelayFromPeersFile(db, { peers_file: path })
    expect(r.seeded.sort()).toEqual(['gentoo', 'openclaw'])
    const teams = db.prepare("SELECT id FROM team").all() as Array<{ id: string }>
    expect(teams).toEqual([{ id: HANGAR_TEAM_ID }])
    const handles = db.prepare("SELECT handle FROM human ORDER BY handle").all() as Array<{ handle: string }>
    expect(handles.map(h => h.handle)).toEqual(['gentoo', 'openclaw'])
    rmSync(path, { force: true })
  })

  it('is idempotent on repeated startup', () => {
    const db = openDatabase(':memory:')
    const path = tmpPeersFile({ openclaw: { secret_sha256_hex: 'c'.repeat(64) } })
    initRelayFromPeersFile(db, { peers_file: path })
    initRelayFromPeersFile(db, { peers_file: path })
    expect(db.prepare("SELECT COUNT(*) AS c FROM human").get()).toEqual({ c: 1 })
    expect(db.prepare("SELECT COUNT(*) AS c FROM token").get()).toEqual({ c: 1 })
    rmSync(path, { force: true })
  })
})
