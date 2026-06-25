import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveHandle, runInitProject } from './init-project.ts'

describe('deriveHandle', () => {
  it('derives from hostname and project name', () => {
    const h = deriveHandle('my-proj')
    expect(h).toMatch(/^[a-z][a-z0-9_-]{0,31}$/)
    expect(h).toContain('my-proj')
  })

  it('sanitizes non-alphanumeric characters and collapses dashes', () => {
    const h = deriveHandle('proj@123!!foo')
    expect(h).not.toContain('@')
    expect(h).not.toContain('!')
    expect(h).not.toContain('--')
    expect(h).toMatch(/^[a-z][a-z0-9_-]{0,31}$/)
  })

  it('uses override if valid', () => {
    expect(deriveHandle('proj', 'custom-handle')).toBe('custom-handle')
  })
})

describe('runInitProject', () => {
  let tempConfigHome = ''
  let tempProjectRoot = ''
  const ORIGINAL_XDG = process.env.XDG_CONFIG_HOME
  const ORIGINAL_CONFIG_DIR = process.env.HANGAR_CONFIG_DIR

  beforeEach(() => {
    tempConfigHome = mkdtempSync(join(tmpdir(), 'hangar-xdg-'))
    tempProjectRoot = mkdtempSync(join(tmpdir(), 'hangar-proj-root-'))
    process.env.XDG_CONFIG_HOME = tempConfigHome
  })

  afterEach(() => {
    rmSync(tempConfigHome, { recursive: true, force: true })
    rmSync(tempProjectRoot, { recursive: true, force: true })
    if (ORIGINAL_XDG === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = ORIGINAL_XDG
    if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.HANGAR_CONFIG_DIR
    else process.env.HANGAR_CONFIG_DIR = ORIGINAL_CONFIG_DIR
  })

  it('creates project config structure and project-scoped .mcp.json', async () => {
    const name = 'myproj'
    await runInitProject({
      name,
      relayUrl: 'http://localhost:8443',
      dir: tempProjectRoot,
    })

    const expectedConfigDir = join(tempConfigHome, 'hangar-bridge', 'projects', name)
    expect(existsSync(join(expectedConfigDir, 'secret'))).toBe(true)
    expect(existsSync(join(expectedConfigDir, 'config.json'))).toBe(true)
    expect(existsSync(join(expectedConfigDir, 'audit'))).toBe(true)

    // Check directory modes (Unix only)
    if (process.platform !== 'win32') {
      const dirStat = statSync(expectedConfigDir)
      expect(dirStat.mode & 0o777).toBe(0o700)
      const auditStat = statSync(join(expectedConfigDir, 'audit'))
      expect(auditStat.mode & 0o777).toBe(0o700)
      const configStat = statSync(join(expectedConfigDir, 'config.json'))
      expect(configStat.mode & 0o777).toBe(0o600)
    }

    // Check .mcp.json content
    const mcpPath = join(tempProjectRoot, '.mcp.json')
    expect(existsSync(mcpPath)).toBe(true)
    const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'))
    expect(mcp.mcpServers).toBeDefined()
    const server = mcp.mcpServers['hangar-bridge-peers']
    expect(server).toBeDefined()
    expect(server.command).toBe(process.execPath)
    expect(server.args[0]).toMatch(/index\.js$/)
    expect(server.env.HANGAR_CONFIG_DIR).toBe(expectedConfigDir)
  })
})
