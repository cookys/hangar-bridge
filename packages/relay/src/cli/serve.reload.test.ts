import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../db/db.ts'
import { initRelayFromPeersFile } from './init.ts'
import { reloadRoster } from './serve.ts'

function tmpPeersFile(dir: string, contents: unknown): string {
  const path = join(dir, 'peers.json')
  writeFileSync(path, JSON.stringify(contents))
  return path
}

describe('reloadRoster (SIGHUP roster reload)', () => {
  it('seeds a peer added to the file after startup, with no restart', () => {
    const db = openDatabase(':memory:')
    const dir = mkdtempSync(join(tmpdir(), 'relay-reload-'))
    const path = tmpPeersFile(dir, { openclaw: { secret_sha256_hex: 'a'.repeat(64) } })
    initRelayFromPeersFile(db, { peers_file: path })

    writeFileSync(path, JSON.stringify({
      openclaw: { secret_sha256_hex: 'a'.repeat(64) },
      'twgs-revival-cookys': { secret_sha256_hex: 'b'.repeat(64) },
    }))
    expect(reloadRoster(db, path)).toBe(true)

    const handles = (db.prepare('SELECT handle FROM human ORDER BY handle').all() as Array<{ handle: string }>)
      .map(h => h.handle)
    expect(handles).toEqual(['openclaw', 'twgs-revival-cookys'])
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects a malformed file and keeps the already-seeded authorization', () => {
    const db = openDatabase(':memory:')
    const dir = mkdtempSync(join(tmpdir(), 'relay-reload-'))
    const path = tmpPeersFile(dir, { openclaw: { secret_sha256_hex: 'a'.repeat(64) } })
    initRelayFromPeersFile(db, { peers_file: path })

    writeFileSync(path, '{ this is not valid json')
    expect(reloadRoster(db, path)).toBe(false)

    const handles = (db.prepare('SELECT handle FROM human ORDER BY handle').all() as Array<{ handle: string }>)
      .map(h => h.handle)
    expect(handles).toEqual(['openclaw'])
    rmSync(dir, { recursive: true, force: true })
  })
})
