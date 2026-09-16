import { describe, it, expect } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ALL_MEMBER_CAPS } from '@hangar-bridge/shared'
import { loadPeersFile } from '../auth/peers-file.ts'
import { peersGroupsInit } from './peers-groups-init.ts'

function tmpPeersFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'relay-peers-groups-init-'))
  const path = join(dir, 'peers.json')
  writeFileSync(path, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 })
  return path
}

function capture(argv: readonly string[], now = 1_700_000_000_000): { stdout: string; stderr: string } {
  let stdout = ''
  let stderr = ''
  peersGroupsInit(argv, {
    stdout: text => { stdout += text },
    stderr: text => { stderr += text },
  }, { now: () => now })
  return { stdout, stderr }
}

describe('peersGroupsInit', () => {
  it('prints a v2 dry-run document for a legacy peers file', () => {
    const path = tmpPeersFile({
      openclaw: {
        secret_sha256_hex: 'a'.repeat(64),
        display_name: 'Openclaw',
        subjects: { owned: ['hangar'], interest: ['hangar>'] },
      },
      gentoo: { secret_sha256_hex: 'b'.repeat(64) },
    })
    try {
      const { stdout, stderr } = capture(['--peers', path])
      const doc = JSON.parse(stdout)
      expect(stderr).toBe(`dry-run: pass --write to replace ${path} (a .bak.1700000000 copy is kept)\n`)
      expect(doc).toEqual({
        peers: {
          openclaw: {
            secret_sha256_hex: 'a'.repeat(64),
            display_name: 'Openclaw',
            subjects: { owned: ['hangar'], interest: ['hangar>'] },
            default_group: 'cookys',
          },
          gentoo: {
            secret_sha256_hex: 'b'.repeat(64),
            default_group: 'cookys',
          },
        },
        groups: {
          cookys: {
            description: 'migrated single group',
            history: 'all',
            members: {
              openclaw: { caps: ALL_MEMBER_CAPS },
              gentoo: { caps: ALL_MEMBER_CAPS },
            },
          },
        },
      })
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true })
    }
  })

  it('writes v2 with a backup, preserves hashes, and reloads strict', () => {
    const path = tmpPeersFile({
      openclaw: { secret_sha256_hex: 'c'.repeat(64) },
      gentoo: { secret_sha256_hex: 'd'.repeat(64) },
    })
    try {
      const { stdout, stderr } = capture(['--peers', path, '--group', 'guest-lab', '--write'], 1_700_000_001_000)
      const backup = `${path}.bak.1700000001`
      expect(stderr).toBe('')
      expect(stdout).toBe(`wrote ${path} (v2, 2 peers in group guest-lab); backup ${backup}\n`)
      expect(existsSync(backup)).toBe(true)
      expect(JSON.parse(readFileSync(backup, 'utf8'))).toEqual({
        openclaw: { secret_sha256_hex: 'c'.repeat(64) },
        gentoo: { secret_sha256_hex: 'd'.repeat(64) },
      })
      const loaded = loadPeersFile(path)
      expect(loaded.mode).toBe('strict')
      expect(loaded.peers.map(peer => [peer.handle, peer.secret_sha256_hex]).sort()).toEqual([
        ['gentoo', 'd'.repeat(64)],
        ['openclaw', 'c'.repeat(64)],
      ])
      expect(loaded.groups).toEqual([{
        id: 'guest-lab',
        description: 'migrated single group',
        history: 'all',
        members: [
          { handle: 'openclaw', caps: ALL_MEMBER_CAPS },
          { handle: 'gentoo', caps: ALL_MEMBER_CAPS },
        ],
      }])
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true })
    }
  })

  it('no-ops when the file is already strict', () => {
    const path = tmpPeersFile({
      peers: {
        openclaw: { secret_sha256_hex: 'e'.repeat(64), default_group: 'cookys' },
      },
      groups: {
        cookys: { history: 'all', members: { openclaw: { caps: ['chat'] } } },
      },
    })
    try {
      const before = readFileSync(path, 'utf8')
      const { stdout, stderr } = capture(['--peers', path, '--write'])
      expect(stdout).toBe('peers.json is already v2 (strict); nothing to do\n')
      expect(stderr).toBe('')
      expect(readFileSync(path, 'utf8')).toBe(before)
      expect(existsSync(`${path}.bak.1700000000`)).toBe(false)
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true })
    }
  })

  it('rejects an invalid group id', () => {
    const path = tmpPeersFile({ openclaw: { secret_sha256_hex: 'f'.repeat(64) } })
    try {
      expect(() => capture(['--peers', path, '--group', 'bad!'])).toThrow(/invalid group id/)
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true })
    }
  })

  it('treats a legacy handle named groups as a peer, not as the v2 groups section', () => {
    const path = tmpPeersFile({
      groups: { secret_sha256_hex: '1'.repeat(64), display_name: 'Groups Handle' },
    })
    try {
      chmodSync(path, 0o600)
      const { stdout } = capture(['--peers', path])
      const doc = JSON.parse(stdout)
      expect(doc.peers.groups).toEqual({
        secret_sha256_hex: '1'.repeat(64),
        display_name: 'Groups Handle',
        default_group: 'cookys',
      })
      expect(doc.groups.cookys.members.groups).toEqual({ caps: ALL_MEMBER_CAPS })
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true })
    }
  })
})
