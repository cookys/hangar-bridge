import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { runInit } from './init.ts'

let workdir = ''
const ORIGINAL_CONFIG_DIR = process.env.HANGAR_CONFIG_DIR

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'hangar-init-'))
  process.env.HANGAR_CONFIG_DIR = workdir
})

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true })
  if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.HANGAR_CONFIG_DIR
  else process.env.HANGAR_CONFIG_DIR = ORIGINAL_CONFIG_DIR
})

describe('runInit', () => {
  it('writes secret + config + audit dir, prints sha256 entry for peers.json', () => {
    const logs: string[] = []
    const r = runInit({
      relayUrl: 'http://192.168.101.6:8443',
      handle: 'openclaw',
      rand: () => Buffer.from('a'.repeat(32)),
      out: s => logs.push(s),
    })
    const secret = readFileSync(join(workdir, 'secret'), 'utf8')
    expect(secret).toBe(Buffer.from('a'.repeat(32)).toString('base64url'))
    const expectedSha = createHash('sha256').update(secret).digest('hex')
    expect(r.secret_sha256_hex).toBe(expectedSha)
    expect(r.handle).toBe('openclaw')
    expect(logs.join('\n')).toContain(`"openclaw": { "secret_sha256_hex": "${expectedSha}"`)

    const cfg = JSON.parse(readFileSync(join(workdir, 'config.json'), 'utf8'))
    expect(cfg.relay_url).toBe('http://192.168.101.6:8443')
    expect(cfg.token_path).toBe(join(workdir, 'secret'))
    expect(existsSync(join(workdir, 'audit'))).toBe(true)
  })

  it('refuses to overwrite an existing secret without --force', () => {
    runInit({ relayUrl: 'http://r/', handle: 'a', rand: () => Buffer.alloc(32) })
    expect(() => runInit({ relayUrl: 'http://r/', handle: 'a', rand: () => Buffer.alloc(32) }))
      .toThrow(/secret already exists/)
  })

  it('rotates the secret when force=true', () => {
    runInit({ relayUrl: 'http://r/', handle: 'a', rand: () => Buffer.from('a'.repeat(32)) })
    const first = readFileSync(join(workdir, 'secret'), 'utf8')
    runInit({ relayUrl: 'http://r/', handle: 'a', force: true, rand: () => Buffer.from('b'.repeat(32)), out: () => {} })
    const second = readFileSync(join(workdir, 'secret'), 'utf8')
    expect(first).not.toBe(second)
  })
})
