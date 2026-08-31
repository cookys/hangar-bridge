import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, loadToken, isInsideGitRepoWithRemote, assertSecretFilePrivate } from './config.ts'

let workdir = ''
beforeEach(() => { workdir = mkdtempSync(join(tmpdir(), 'mesh-')) })
afterEach(() => { rmSync(workdir, { recursive: true, force: true }) })

describe('loadConfig', () => {
  it('defaults final-mile delivery to the existing Claude Channel', () => {
    const p = join(workdir, 'final-mile-default.json')
    writeFileSync(p, JSON.stringify({ relay_url: 'https://mesh.example.com', token_path: join(workdir, 'tok') }))
    expect(loadConfig(p).final_mile).toEqual({ kind: 'claude-channel' })
  })

  it('accepts an exact Agent Call final-mile target and optional binary path', () => {
    const p = join(workdir, 'final-mile-agent-call.json')
    writeFileSync(p, JSON.stringify({
      relay_url: 'https://mesh.example.com',
      token_path: join(workdir, 'tok'),
      final_mile: { kind: 'agent-call', target: 'local-codex', bin: '/opt/bin/agent-call' },
    }))
    expect(loadConfig(p).final_mile).toEqual({
      kind: 'agent-call', target: 'local-codex', bin: '/opt/bin/agent-call',
      accept_broadcast: false,
    })
  })

  it('defaults the Agent Call binary to PATH lookup', () => {
    const p = join(workdir, 'final-mile-agent-call-default-bin.json')
    writeFileSync(p, JSON.stringify({
      relay_url: 'https://mesh.example.com',
      token_path: join(workdir, 'tok'),
      final_mile: { kind: 'agent-call', target: 'local-codex' },
    }))
    expect(loadConfig(p).final_mile).toEqual({
      kind: 'agent-call', target: 'local-codex', bin: 'agent-call',
      accept_broadcast: false,
    })
  })

  it('defaults accept_broadcast off, and reads an explicit opt-in', () => {
    // Default false is the behaviour change: an existing config on disk, which
    // cannot know this key, starts declining broadcasts after the upgrade. The
    // opt-in exists so a bridge can be put back without rebuilding the artifact.
    const p = join(workdir, 'final-mile-accept-broadcast.json')
    writeFileSync(p, JSON.stringify({
      relay_url: 'https://mesh.example.com',
      token_path: join(workdir, 'tok'),
      final_mile: { kind: 'agent-call', target: 'local-codex', accept_broadcast: true },
    }))
    const cfg = loadConfig(p)
    expect(cfg.final_mile).toEqual({
      kind: 'agent-call', target: 'local-codex', bin: 'agent-call',
      accept_broadcast: true,
    })
  })

  it('rejects permission relay with Agent Call final-mile', () => {
    const p = join(workdir, 'final-mile-permission.json')
    writeFileSync(p, JSON.stringify({
      relay_url: 'https://mesh.example.com',
      token_path: join(workdir, 'tok'),
      final_mile: { kind: 'agent-call', target: 'local-codex', bin: 'agent-call', accept_broadcast: false },
      permission_relay: { enabled: true, routing: 'never_relay' },
    }))
    expect(() => loadConfig(p)).toThrow(/peer authority cannot approve permissions/)
  })

  it('loads a valid config file', () => {
    const p = join(workdir, 'config.json')
    writeFileSync(p, JSON.stringify({
      relay_url: 'https://mesh.example.com', token_path: join(workdir, 'tok'),
      permission_relay: { enabled: false, routing: 'never_relay' },
      presence: { auto_publish_cwd: true, auto_publish_branch: true, auto_publish_repo: true },
      audit_log: join(workdir, 'audit')
    }))
    const cfg = loadConfig(p)
    expect(cfg.relay_url).toBe('https://mesh.example.com')
  })

  it('rejects config missing required field', () => {
    const p = join(workdir, 'bad.json')
    writeFileSync(p, JSON.stringify({ relay_url: 'x' }))
    expect(() => loadConfig(p)).toThrow()
  })

  it('requires nats config block when transport is nats', () => {
    const p = join(workdir, 'nats-missing.json')
    writeFileSync(p, JSON.stringify({
      transport: 'nats', relay_url: 'nats://localhost:4222', token_path: join(workdir, 'tok'),
      permission_relay: { enabled: false, routing: 'never_relay' },
      presence: { auto_publish_cwd: true, auto_publish_branch: true, auto_publish_repo: true },
      audit_log: join(workdir, 'audit'),
    }))
    expect(() => loadConfig(p)).toThrow()
  })

  it('accepts nats transport when nats block is present', () => {
    const p = join(workdir, 'nats-valid.json')
    writeFileSync(p, JSON.stringify({
      transport: 'nats',
      relay_url: 'https://mesh.example.com',
      token_path: join(workdir, 'tok'),
      nats: {
        url: 'nats://localhost:4222',
        nkey_seed_path: join(workdir, 'seed'),
        roster_path: join(workdir, 'fleet-roster.json'),
        inbox_prefix: '_INBOX.alice',
      },
      permission_relay: { enabled: false, routing: 'never_relay' },
      presence: { auto_publish_cwd: true, auto_publish_branch: true, auto_publish_repo: true },
      audit_log: join(workdir, 'audit'),
    }))
    const cfg = loadConfig(p)
    expect(cfg.transport).toBe('nats')
    expect(cfg.nats).toEqual({
      url: 'nats://localhost:4222',
      nkey_seed_path: join(workdir, 'seed'),
      roster_path: join(workdir, 'fleet-roster.json'),
      inbox_prefix: '_INBOX.alice',
    })
  })

  it('rejects ask_team permission routing on NATS where only direct reactive lanes exist', () => {
    const p = join(workdir, 'nats-team-permission.json')
    writeFileSync(p, JSON.stringify({
      transport: 'nats',
      relay_url: 'https://mesh.example.com',
      token_path: join(workdir, 'tok'),
      nats: {
        url: 'nats://localhost:4222',
        nkey_seed_path: join(workdir, 'seed'),
        roster_path: join(workdir, 'fleet-roster.json'),
      },
      permission_relay: { enabled: true, routing: 'ask_team' },
      audit_log: join(workdir, 'audit'),
    }))
    expect(() => loadConfig(p)).toThrow(/ask_team/)
  })

  it('defaults transport to sse when omitted', () => {
    const p = join(workdir, 'sse-default.json')
    writeFileSync(p, JSON.stringify({
      relay_url: 'https://mesh.example.com', token_path: join(workdir, 'tok'),
      permission_relay: { enabled: false, routing: 'never_relay' },
      presence: { auto_publish_cwd: true, auto_publish_branch: true, auto_publish_repo: true },
      audit_log: join(workdir, 'audit'),
    }))
    expect(loadConfig(p).transport).toBe('sse')
  })
})

describe('loadToken', () => {
  it('reads a token file', () => {
    const p = join(workdir, 'token')
    writeFileSync(p, 'some-token', { mode: 0o600 })
    expect(loadToken(p)).toBe('some-token')
  })
  it('trims whitespace / trailing newline', () => {
    const p = join(workdir, 'token')
    writeFileSync(p, 'tok\n', { mode: 0o600 })
    expect(loadToken(p)).toBe('tok')
  })
  it('throws if token file missing', () => {
    expect(() => loadToken(join(workdir, 'nope'))).toThrow(/token file not found/)
  })
})

describe('assertSecretFilePrivate', () => {
  it('accepts mode 0600 and rejects group/world-readable NKey seeds', () => {
    const privatePath = join(workdir, 'private-seed')
    const exposedPath = join(workdir, 'exposed-seed')
    writeFileSync(privatePath, 'SUPRIVATE', { mode: 0o600 })
    writeFileSync(exposedPath, 'SUEXPOSED', { mode: 0o640 })
    expect(() => assertSecretFilePrivate(privatePath, 'NKey seed')).not.toThrow()
    if (process.platform !== 'win32') {
      expect(() => assertSecretFilePrivate(exposedPath, 'NKey seed')).toThrow(/mode 0600/)
    }
  })
})

describe('isInsideGitRepoWithRemote', () => {
  it('returns false for a non-git directory', () => {
    expect(isInsideGitRepoWithRemote(workdir)).toBe(false)
  })
  it('returns false for a git repo with no remotes', () => {
    mkdirSync(join(workdir, '.git'), { recursive: true })
    writeFileSync(join(workdir, '.git/config'), '[core]\nrepositoryformatversion = 0\n')
    expect(isInsideGitRepoWithRemote(workdir)).toBe(false)
  })
  it('returns true for a git repo with a remote', () => {
    mkdirSync(join(workdir, '.git'), { recursive: true })
    writeFileSync(join(workdir, '.git/config'),
      '[core]\nrepositoryformatversion = 0\n\n[remote "origin"]\n  url = git@github.com:x/y.git\n')
    expect(isInsideGitRepoWithRemote(workdir)).toBe(true)
  })
  it('detects a linked worktree whose .git is a pointer file', () => {
    const common = join(workdir, 'common.git')
    const linked = join(common, 'worktrees', 'linked')
    const tree = join(workdir, 'tree')
    mkdirSync(linked, { recursive: true })
    mkdirSync(tree)
    writeFileSync(join(common, 'config'), '[remote "origin"]\n  url = git@example/repo.git\n')
    writeFileSync(join(linked, 'commondir'), '../..\n')
    writeFileSync(join(tree, '.git'), `gitdir: ${linked}\n`)
    expect(isInsideGitRepoWithRemote(tree)).toBe(true)
  })
})
