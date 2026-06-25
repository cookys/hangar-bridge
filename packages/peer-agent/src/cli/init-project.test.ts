import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { writeProjectMcpJson } from '../mcp-registration.ts'
import { deriveHandle, deriveProjectName, parseProjectNameFromGitRemote, runInitProject } from './init-project.ts'

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
    const name = 'cookys-myproj'
    const peersFile = join(tempProjectRoot, 'peers.json')
    writeFileSync(peersFile, '{}')
    await runInitProject({
      name,
      relayUrl: 'http://localhost:8443',
      dir: tempProjectRoot,
      peersFile,
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
    const server = mcp.mcpServers['hangar-bridge-peers-cookys-myproj']
    expect(server).toBeDefined()
    expect(server.command).toBe(process.execPath)
    expect(server.args[0]).toMatch(/index\.js$/)
    expect(server.env.HANGAR_CONFIG_DIR).toBe(expectedConfigDir)
  })

  it('auto-derives the project name from the github origin remote', async () => {
    const gitDir = join(tempProjectRoot, '.git')
    const configPath = join(gitDir, 'config')
    const peersFile = join(tempProjectRoot, 'peers.json')
    writeFileSync(peersFile, '{}')
    await runInitProject({
      relayUrl: 'http://localhost:8443',
      dir: tempProjectRoot,
      peersFile,
    })
    expect(existsSync(configPath)).toBe(false)

    rmSync(join(tempConfigHome, 'hangar-bridge'), { recursive: true, force: true })
    rmSync(join(tempProjectRoot, '.mcp.json'), { force: true })
    execFileSync('git', ['init'], { cwd: tempProjectRoot, stdio: 'ignore' })
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:cookys/foo.git'], { cwd: tempProjectRoot })

    await runInitProject({
      relayUrl: 'http://localhost:8443',
      dir: tempProjectRoot,
      peersFile,
    })

    const expectedConfigDir = join(tempConfigHome, 'hangar-bridge', 'projects', 'cookys-foo')
    expect(existsSync(join(expectedConfigDir, 'config.json'))).toBe(true)
    const mcp = JSON.parse(readFileSync(join(tempProjectRoot, '.mcp.json'), 'utf8'))
    expect(mcp.mcpServers['hangar-bridge-peers-cookys-foo']).toBeDefined()
  })

  it('aborts before writing when the relay peers file already contains the handle', async () => {
    const peersFile = join(tempProjectRoot, 'peers.json')
    writeFileSync(peersFile, JSON.stringify({ 'custom-handle': { secret_sha256_hex: 'a'.repeat(64) } }))

    await expect(runInitProject({
      name: 'myproj',
      relayUrl: 'http://localhost:8443',
      handle: 'custom-handle',
      dir: tempProjectRoot,
      peersFile,
    })).rejects.toThrow(/custom-handle/)

    const expectedConfigDir = join(tempConfigHome, 'hangar-bridge', 'projects', 'myproj')
    expect(existsSync(expectedConfigDir)).toBe(false)
    expect(existsSync(join(tempProjectRoot, '.mcp.json'))).toBe(false)
  })

  it('aborts before writing when the project config directory already exists without force', async () => {
    const peersFile = join(tempProjectRoot, 'peers.json')
    writeFileSync(peersFile, '{}')
    const existingConfigDir = join(tempConfigHome, 'hangar-bridge', 'projects', 'myproj')
    mkdirSync(existingConfigDir, { recursive: true })

    await expect(runInitProject({
      name: 'myproj',
      relayUrl: 'http://localhost:8443',
      dir: tempProjectRoot,
      peersFile,
    })).rejects.toThrow(/already exists/)

    expect(existsSync(join(existingConfigDir, 'secret'))).toBe(false)
    expect(existsSync(join(tempProjectRoot, '.mcp.json'))).toBe(false)
  })
})

describe('project name derivation', () => {
  let tempProjectRoot = ''

  beforeEach(() => {
    tempProjectRoot = mkdtempSync(join(tmpdir(), 'hangar-proj-root-'))
  })

  afterEach(() => {
    rmSync(tempProjectRoot, { recursive: true, force: true })
  })

  it('parses supported github remote forms', () => {
    expect(parseProjectNameFromGitRemote('git@github.com:cookys/foo.git')).toBe('cookys-foo')
    expect(parseProjectNameFromGitRemote('https://github.com/kevin/foo')).toBe('kevin-foo')
    expect(parseProjectNameFromGitRemote('https://github.com/kevin/foo.git')).toBe('kevin-foo')
    expect(parseProjectNameFromGitRemote('https://gitlab.com/kevin/foo.git')).toBeUndefined()
  })

  it('falls back to the project root basename without a parseable origin', () => {
    expect(deriveProjectName(tempProjectRoot)).toBe(tempProjectRoot.split('/').pop())
  })
})

describe('writeProjectMcpJson', () => {
  it('merge-preserves unrelated server keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hangar-mcp-'))
    try {
      writeFileSync(join(dir, '.mcp.json'), JSON.stringify({
        mcpServers: {
          existing: { command: 'node', args: ['server.js'] },
        },
      }))

      writeProjectMcpJson({
        dir,
        configDir: join(dir, 'config'),
        serverName: 'hangar-bridge-peers-myproj',
      })

      const mcp = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'))
      expect(mcp.mcpServers.existing).toEqual({ command: 'node', args: ['server.js'] })
      expect(mcp.mcpServers['hangar-bridge-peers-myproj']).toBeDefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
