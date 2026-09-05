import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, loadToken, isInsideGitRepoWithRemote, assertSecretFilePrivate, saveConfig } from './config.ts'

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
      accept_broadcast: false, switchboard: false, list_refresh_ms: 30_000,
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
      accept_broadcast: false, switchboard: false, list_refresh_ms: 30_000,
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
      accept_broadcast: true, switchboard: false, list_refresh_ms: 30_000,
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

  /**
   * D5 item 4a (§8.1): the courier persists its instance id in config.json so
   * a restart keeps every grant it holds valid ("no grant migration is
   * needed on restart"). It is optional and format-checked the same way as
   * every other instance id in the system.
   */
  describe('instance persistence (§8.1)', () => {
    it('is absent by default', () => {
      const p = join(workdir, 'no-instance.json')
      writeFileSync(p, JSON.stringify({ relay_url: 'https://mesh.example.com', token_path: join(workdir, 'tok') }))
      expect(loadConfig(p).instance).toBeUndefined()
    })

    it('round-trips a persisted instance id', () => {
      const p = join(workdir, 'with-instance.json')
      writeFileSync(p, JSON.stringify({
        relay_url: 'https://mesh.example.com', token_path: join(workdir, 'tok'),
        instance: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      }))
      expect(loadConfig(p).instance).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV')
    })

    it('rejects a malformed instance id', () => {
      const p = join(workdir, 'bad-instance.json')
      writeFileSync(p, JSON.stringify({
        relay_url: 'https://mesh.example.com', token_path: join(workdir, 'tok'),
        instance: 'not-a-ulid',
      }))
      expect(() => loadConfig(p)).toThrow()
    })
  })

  describe('saveConfig', () => {
    it('writes a new instance id into an existing config file, preserving other fields', () => {
      const p = join(workdir, 'save.json')
      writeFileSync(p, JSON.stringify({
        relay_url: 'https://mesh.example.com', token_path: join(workdir, 'tok'), self: 'cuda',
      }))
      saveConfig(p, { instance: '01ARZ3NDEKTSV4RRFFQ69G5FAV' })
      const cfg = loadConfig(p)
      expect(cfg.instance).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV')
      expect(cfg.relay_url).toBe('https://mesh.example.com')
      expect(cfg.self).toBe('cuda')
    })

    it('overwrites a previously persisted instance id', () => {
      const p = join(workdir, 'overwrite.json')
      writeFileSync(p, JSON.stringify({
        relay_url: 'https://mesh.example.com', token_path: join(workdir, 'tok'),
        instance: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      }))
      saveConfig(p, { instance: '01ARZ3NDEKTSV4RRFFQ69G5FAW' })
      expect(loadConfig(p).instance).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAW')
    })

    it('writes the file with owner-only permissions', () => {
      const p = join(workdir, 'perms.json')
      writeFileSync(p, JSON.stringify({ relay_url: 'https://mesh.example.com', token_path: join(workdir, 'tok') }))
      saveConfig(p, { instance: '01ARZ3NDEKTSV4RRFFQ69G5FAV' })
      if (process.platform !== 'win32') {
        expect(statSync(p).mode & 0o777).toBe(0o600)
      }
    })

    it('refuses a patch that would fail schema validation', () => {
      const p = join(workdir, 'invalid-patch.json')
      writeFileSync(p, JSON.stringify({ relay_url: 'https://mesh.example.com', token_path: join(workdir, 'tok') }))
      expect(() => saveConfig(p, { instance: 'not-a-ulid' })).toThrow()
      // The file on disk is untouched by a rejected patch.
      expect(JSON.parse(readFileSync(p, 'utf8'))).not.toHaveProperty('instance')
    })
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

  it('switchboard: accepts agent-call without a target, rejects a plain courier without one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hangar-cfg-'))
    const sb = join(dir, 'sb.json')
    writeFileSync(sb, JSON.stringify({
      relay_url: 'http://127.0.0.1:1', token_path: '/dev/null',
      final_mile: { kind: 'agent-call', switchboard: true },
    }))
    const cfg = loadConfig(sb)
    expect(cfg.final_mile.kind).toBe('agent-call')
    if (cfg.final_mile.kind === 'agent-call') {
      expect(cfg.final_mile.switchboard).toBe(true)
      expect(cfg.final_mile.target).toBeUndefined()
    }
    const plain = join(dir, 'plain.json')
    writeFileSync(plain, JSON.stringify({
      relay_url: 'http://127.0.0.1:1', token_path: '/dev/null',
      final_mile: { kind: 'agent-call' },
    }))
    expect(() => loadConfig(plain)).toThrow(/needs a target/)
  })
