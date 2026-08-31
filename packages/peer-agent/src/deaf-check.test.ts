import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkChannelsFlag, checkChannelCapability, type DeafCheckResult } from './deaf-check.ts'

/**
 * P0 deaf-immunity: walk the /proc ancestor chain looking for a `claude`
 * process, and verify its argv contains a channels flag naming OUR mcp
 * config key. Fail-open everywhere: no /proc, no claude ancestor, or no
 * known key ⇒ 'skip', never a false DEAF.
 */

// Build a fake /proc tree: each entry is [pid, ppid, argv[]]
function fakeProc(entries: Array<[number, number, string[]]>): string {
  const root = mkdtempSync(join(tmpdir(), 'fakeproc-'))
  for (const [pid, ppid, argv] of entries) {
    const d = join(root, String(pid))
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'cmdline'), argv.join('\0') + '\0')
    writeFileSync(join(d, 'status'), `Name:\t${argv[0]}\nPid:\t${pid}\nPPid:\t${ppid}\n`)
  }
  return root
}

const KEY = 'hangar-bridge-peer-agent'

describe('checkChannelsFlag', () => {
  it('verified when direct parent is claude with dev flag + our key', () => {
    const proc = fakeProc([
      [100, 1, ['claude', '--dangerously-skip-permissions', '--dangerously-load-development-channels', `server:${KEY}`]],
      [200, 100, ['node', 'peer-agent/dist/index.js']],
    ])
    const r: DeafCheckResult = checkChannelsFlag({ procRoot: proc, selfPid: 200, mcpKey: KEY })
    expect(r.state).toBe('verified')
  })

  it('accepts the non-dev --channels flag form too', () => {
    const proc = fakeProc([
      [100, 1, ['claude', '--channels', `server:${KEY}`]],
      [200, 100, ['node', 'index.js']],
    ])
    expect(checkChannelsFlag({ procRoot: proc, selfPid: 200, mcpKey: KEY }).state).toBe('verified')
  })

  it('deaf when claude ancestor has no channels flag at all', () => {
    const proc = fakeProc([
      [100, 1, ['claude', '--dangerously-skip-permissions']],
      [200, 100, ['node', 'index.js']],
    ])
    const r = checkChannelsFlag({ procRoot: proc, selfPid: 200, mcpKey: KEY })
    expect(r.state).toBe('deaf')
    expect(r.reason).toMatch(/no channels flag/i)
  })

  it('deaf when the flag names a DIFFERENT server key', () => {
    const proc = fakeProc([
      [100, 1, ['claude', '--dangerously-load-development-channels', 'server:hangar-bridge-peers']],
      [200, 100, ['node', 'index.js']],
    ])
    const r = checkChannelsFlag({ procRoot: proc, selfPid: 200, mcpKey: KEY })
    expect(r.state).toBe('deaf')
    expect(r.reason).toContain('hangar-bridge-peers')
  })

  it('walks THROUGH shim wrappers (sh -> pnpm -> node) to find claude', () => {
    const proc = fakeProc([
      [50, 1, ['claude', '--dangerously-load-development-channels', `server:${KEY}`]],
      [60, 50, ['sh', '-c', 'exec pnpm start']],
      [70, 60, ['pnpm', 'start']],
      [200, 70, ['node', 'index.js']],
    ])
    expect(checkChannelsFlag({ procRoot: proc, selfPid: 200, mcpKey: KEY }).state).toBe('verified')
  })

  it('skip (fail-open) when no claude appears in the ancestor chain — non-Claude harness', () => {
    const proc = fakeProc([
      [90, 1, ['codex', 'exec']],
      [200, 90, ['node', 'index.js']],
    ])
    const r = checkChannelsFlag({ procRoot: proc, selfPid: 200, mcpKey: KEY })
    expect(r.state).toBe('skip')
    expect(r.reason).toMatch(/no claude ancestor/i)
  })

  it('skip (fail-open) when procRoot is unreadable', () => {
    const r = checkChannelsFlag({ procRoot: '/nonexistent-proc', selfPid: 200, mcpKey: KEY })
    expect(r.state).toBe('skip')
  })

  it('skip when mcpKey is unknown (HANGAR_MCP_KEY not plumbed)', () => {
    const proc = fakeProc([
      [100, 1, ['claude', '--dangerously-load-development-channels', `server:${KEY}`]],
      [200, 100, ['node', 'index.js']],
    ])
    const r = checkChannelsFlag({ procRoot: proc, selfPid: 200, mcpKey: undefined })
    expect(r.state).toBe('skip')
    expect(r.reason).toMatch(/mcp key/i)
  })

  it('caps ancestor walk to avoid pid-cycle loops', () => {
    // 1 -> 2 -> 1 cycle, no claude
    const proc = fakeProc([
      [1, 2, ['init']],
      [2, 1, ['weird']],
      [200, 2, ['node', 'index.js']],
    ])
    expect(checkChannelsFlag({ procRoot: proc, selfPid: 200, mcpKey: KEY }).state).toBe('skip')
  })

  it('verified when two channels are loaded with repeated flags', () => {
    const proc = fakeProc([
      [100, 1, ['claude',
        '--dangerously-load-development-channels', 'server:agent-call-local',
        '--dangerously-load-development-channels', `server:${KEY}`]],
      [200, 100, ['node', 'index.js']],
    ])
    expect(checkChannelsFlag({ procRoot: proc, selfPid: 200, mcpKey: KEY }).state).toBe('verified')
  })

  it('deaf when two channels are space-joined into one value (claude admits neither)', () => {
    // Claude Code 2.1.251 treats the whole value as one channel name, so this
    // session is actually deaf. The check must not split it into two keys and
    // report a false verified.
    const proc = fakeProc([
      [100, 1, ['claude', '--dangerously-load-development-channels', `server:agent-call-local server:${KEY}`]],
      [200, 100, ['node', 'index.js']],
    ])
    const r = checkChannelsFlag({ procRoot: proc, selfPid: 200, mcpKey: KEY })
    expect(r.state).toBe('deaf')
  })

  it('deaf when two channels are comma-joined into one value', () => {
    const proc = fakeProc([
      [100, 1, ['claude', `--dangerously-load-development-channels=server:agent-call-local,server:${KEY}`]],
      [200, 100, ['node', 'index.js']],
    ])
    expect(checkChannelsFlag({ procRoot: proc, selfPid: 200, mcpKey: KEY }).state).toBe('deaf')
  })
})

/**
 * Deafness mode 2 (gen-3 Fable F1). The MCP log carries TWO distinct strings:
 *
 *   'not in --channels list for this session'          ← flag missing, mode 1
 *   'server did not declare claude/channel capability' ← handshake, mode 2
 *
 * The ancestor-chain flag check cannot see mode 2 at all. The withdrawn proposal
 * was a traffic signal ("did we emit any inbound within N seconds"), which
 * false-positives on any healthy-but-quiet fleet AND contradicts this plan's own
 * ruling that emit success never proves client rendering.
 *
 * Mode 2 is not a traffic question — it is what THIS server declared about
 * itself, so it is answerable at startup by introspection, deterministically and
 * with zero false positives.
 */
describe('checkChannelCapability', () => {
  it('verified when the server declares experimental claude/channel', () => {
    const r = checkChannelCapability({ experimental: { 'claude/channel': {} }, tools: {} })
    expect(r.state).toBe('verified')
  })

  it('deaf when the capability block omits claude/channel — mode 2', () => {
    const r = checkChannelCapability({ experimental: {}, tools: {} })
    expect(r.state).toBe('deaf')
    expect(r.reason).toMatch(/capability/i)
  })

  it('deaf when there is no experimental block at all', () => {
    expect(checkChannelCapability({ tools: {} }).state).toBe('deaf')
  })

  it('the permission sub-capability is not required for channel delivery', () => {
    // permission relay is off by default; its absence must not read as deafness
    expect(checkChannelCapability({ experimental: { 'claude/channel': {} }, tools: {} }).state).toBe('verified')
  })
})
