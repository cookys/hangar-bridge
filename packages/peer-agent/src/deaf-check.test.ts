import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkChannelsFlag, type DeafCheckResult } from './deaf-check.ts'

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
})
