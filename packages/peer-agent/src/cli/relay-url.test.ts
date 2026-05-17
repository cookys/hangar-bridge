import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveRelayUrl } from './relay-url.ts'

let workdir = ''
const ORIGINAL_CONFIG_DIR = process.env.HANGAR_CONFIG_DIR

describe('resolveRelayUrl', () => {
  beforeEach(() => {
    delete process.env.HANGAR_RELAY
    workdir = mkdtempSync(join(tmpdir(), 'hangar-cfg-'))
    process.env.HANGAR_CONFIG_DIR = workdir
  })

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
    if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.HANGAR_CONFIG_DIR
    else process.env.HANGAR_CONFIG_DIR = ORIGINAL_CONFIG_DIR
  })

  it('prefers --relay flag over everything else', () => {
    process.env.HANGAR_RELAY = 'http://env:8443'
    writeConfig('http://cfg:8443')
    expect(resolveRelayUrl(['--relay', 'http://flag:8443'])).toBe('http://flag:8443')
  })

  it('falls back to HANGAR_RELAY env when no flag', () => {
    process.env.HANGAR_RELAY = 'http://env:8443'
    writeConfig('http://cfg:8443')
    expect(resolveRelayUrl([])).toBe('http://env:8443')
  })

  it('falls back to ~/.config/hangar-bridge/config.json relay_url when neither flag nor env', () => {
    writeConfig('http://cfg:8443')
    expect(resolveRelayUrl([])).toBe('http://cfg:8443')
  })

  it('throws a helpful error when nothing is configured', () => {
    expect(() => resolveRelayUrl([])).toThrow(/missing relay URL/)
  })

  it('ignores an unparseable config.json and treats as missing', () => {
    writeFileSync(join(workdir, 'config.json'), '{not valid json')
    expect(() => resolveRelayUrl([])).toThrow(/missing relay URL/)
  })

  it('ignores a config.json without relay_url and treats as missing', () => {
    writeFileSync(join(workdir, 'config.json'), JSON.stringify({ self_handle: 'alice' }))
    expect(() => resolveRelayUrl([])).toThrow(/missing relay URL/)
  })
})

function writeConfig(relayUrl: string): void {
  mkdirSync(workdir, { recursive: true })
  writeFileSync(join(workdir, 'config.json'), JSON.stringify({ relay_url: relayUrl, token_path: '/tmp/x' }))
}
