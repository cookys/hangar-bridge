import { describe, it, expect, afterEach } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Envelope } from '@hangar-bridge/shared'
import { Switchboard, listRegistrations, findPaneRegistration, type Registration } from './switchboard.ts'

const env = (over: Partial<Envelope> = {}): Envelope => ({
  id: 'msg_01HRK7Y000000000000000000A', v: 2,
  team: 'hangar', from: 'openclaw', to: 'cuda-kimi', subject: null,
  in_reply_to: null, thread_root: null, kind: 'chat', content: 'x', meta: {},
  sent_at: '2026-01-01T00:00:00.000Z', delivered_at: null, ...over,
})

const regs: Registration[] = [
  { name: 'revival.3d--codex', harness: 'codex', pid: 11, cwd: '/home/u/projects/revival.3d', repo: 'revival.3d' },
  { name: 'revival.3d--agy',   harness: 'agy',   pid: 12, cwd: '/home/u/projects/revival.3d', repo: 'revival.3d' },
  { name: 'wasm-yolo--agent',  harness: 'cursor', pid: 13, cwd: '/home/u/projects/wasm-yolo', repo: 'wasm-yolo' },
  { name: 'dead--codex',       harness: 'codex', pid: 99, cwd: '/home/u/projects/dead', repo: 'dead' },
]

function board(over: Partial<ConstructorParameters<typeof Switchboard>[0]> = {}) {
  const delivered: string[] = []
  const sb = new Switchboard({
    list: async () => regs,
    isAlive: pid => pid !== 99,
    deliver: async (_e, target) => {
      if (target === 'revival.3d--agy' && over.defaultTarget === 'FAIL-AGY') throw new Error('tmux_target_changed')
      delivered.push(target); return { status: 'injected_unverified' }
    },
    ...over,
  })
  return { sb, delivered }
}

describe('Switchboard', () => {
  it('publishes the union of live registrations\' projects and drops dead pids', async () => {
    const { sb } = board()
    await sb.refresh()
    expect(sb.repos()).toEqual(['revival.3d', 'wasm-yolo'])
    expect(sb.registrations().map(r => r.name)).not.toContain('dead--codex')
  })

  it('meta.local_target rings exactly that extension', async () => {
    const { sb, delivered } = board()
    await sb.refresh()
    const r = await sb.deliver(env({ meta: { local_target: 'revival.3d--agy' } }))
    expect(r.accepted).toEqual(['revival.3d--agy'])
    expect(delivered).toEqual(['revival.3d--agy'])
  })

  it('to_filter.repo rings every extension in that project, and no other', async () => {
    const { sb, delivered } = board()
    await sb.refresh()
    const r = await sb.deliver(env({ to: '@team', to_filter: { repo: 'revival.3d' } } as Partial<Envelope>))
    expect(r.accepted.sort()).toEqual(['revival.3d--agy', 'revival.3d--codex'])
    expect(delivered).not.toContain('wasm-yolo--agent')
  })

  it('a plain send falls back to the default target when configured, else to everyone', async () => {
    const a = board({ defaultTarget: 'wasm-yolo--agent' })
    await a.sb.refresh()
    expect((await a.sb.deliver(env())).accepted).toEqual(['wasm-yolo--agent'])
    const b = board()
    await b.sb.refresh()
    expect((await b.sb.deliver(env())).accepted.length).toBe(3)
  })

  it('one refused extension does not fail the delivery; all refused does', async () => {
    const partial = board({ defaultTarget: 'FAIL-AGY' })
    await partial.sb.refresh()
    const r = await partial.sb.deliver(env({ to: '@team', to_filter: { repo: 'revival.3d' } } as Partial<Envelope>))
    expect(r.accepted).toEqual(['revival.3d--codex'])
    expect(Object.keys(r.failed)).toEqual(['revival.3d--agy'])
    const none = new Switchboard({ list: async () => regs, isAlive: () => true, deliver: async () => { throw new Error('refused') } })
    await none.refresh()
    await expect(none.deliver(env())).rejects.toThrow(/every extension refused/)
  })

  it('a miss re-reads the registry once before giving up', async () => {
    let calls = 0
    const sb = new Switchboard({
      list: async () => { calls++; return calls === 1 ? [] : regs },
      isAlive: () => true,
      deliver: async () => ({ status: 'injected_unverified' }),
    })
    await sb.refresh()
    expect(sb.repos()).toEqual([])
    const r = await sb.deliver(env({ meta: { local_target: 'revival.3d--codex' } }))
    expect(r.accepted).toEqual(['revival.3d--codex'])
    expect(calls).toBe(2)
    await expect(sb.deliver(env({ meta: { local_target: 'nobody' } }))).rejects.toThrow(/no local extension/)
  })
})

/**
 * D5 items 4b/4c/4d + registry read for items 1/5 (§8.1): a reply's
 * meta.local_target is relay-stamped as `<name>@<generation>` — the courier
 * must resolve it against the LIVE registry (same name, same generation,
 * live pid, same harness), finalize the grant it was given, and ONLY THEN
 * paste. Any failure is a reported final-mile failure; there is no fallback
 * to "all panes of the project" the way a bare-name local_target (an
 * ordinary send_to_peer --local address, unaffected by this hardening) can
 * still legitimately reach exactly one extension by name alone.
 */
function fakeAgentCallList(json: string): { bin: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'hangar-registry-'))
  const bin = join(dir, 'agent-call')
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' '${json}'\n`)
  chmodSync(bin, 0o700)
  return { bin, dir }
}

describe('listRegistrations / findPaneRegistration — generation + tmux_pane fields', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

  it('carries generation and tmux_pane through when the registry reports them', async () => {
    const { bin, dir } = fakeAgentCallList(JSON.stringify([
      { name: 'revival.3d--agy', harness: 'agy', ingress: 'tmux', pid: process.pid, cwd: '/home/u/revival.3d', tmux_pane: '%12', generation: '01GEN0000000000000000000A' },
    ]))
    dirs.push(dir)
    const regs = await listRegistrations(bin)
    expect(regs[0]).toMatchObject({ name: 'revival.3d--agy', generation: '01GEN0000000000000000000A', tmuxPane: '%12' })
  })

  it('leaves generation/tmuxPane undefined when the registry omits them (older agent-call)', async () => {
    const { bin, dir } = fakeAgentCallList(JSON.stringify([
      { name: 'revival.3d--agy', harness: 'agy', ingress: 'tmux', pid: process.pid, cwd: '/home/u/revival.3d' },
    ]))
    dirs.push(dir)
    const regs = await listRegistrations(bin)
    expect(regs[0]!.generation).toBeUndefined()
    expect(regs[0]!.tmuxPane).toBeUndefined()
  })

  it('findPaneRegistration finds the registration whose tmux_pane matches', async () => {
    const { bin, dir } = fakeAgentCallList(JSON.stringify([
      { name: 'a--agy', harness: 'agy', ingress: 'tmux', pid: process.pid, cwd: '/x/a', tmux_pane: '%1', generation: '01GEN0000000000000000000A' },
      { name: 'b--codex', harness: 'codex', ingress: 'tmux', pid: process.pid, cwd: '/x/b', tmux_pane: '%2', generation: '01GEN0000000000000000000B' },
    ]))
    dirs.push(dir)
    const reg = await findPaneRegistration('%2', bin)
    expect(reg?.name).toBe('b--codex')
    expect(reg?.generation).toBe('01GEN0000000000000000000B')
  })

  it('findPaneRegistration returns undefined when no registration matches the pane', async () => {
    const { bin, dir } = fakeAgentCallList(JSON.stringify([
      { name: 'a--agy', harness: 'agy', ingress: 'tmux', pid: process.pid, cwd: '/x/a', tmux_pane: '%1', generation: '01GEN0000000000000000000A' },
    ]))
    dirs.push(dir)
    expect(await findPaneRegistration('%99', bin)).toBeUndefined()
  })
})

describe('Switchboard — selector-bearing local_target (courier reply hardening, §8.1)', () => {
  const GEN = '01GEN0000000000000000000A'
  const target: Registration = {
    name: 'revival.3d--agy', harness: 'agy', pid: 12, cwd: '/home/u/revival.3d', repo: 'revival.3d', generation: GEN,
  }

  function boardWithFinalize(over: {
    finalizeGrant?: (msgId: string, selector: string) => Promise<boolean>
    regs?: Registration[]
    isAlive?: (pid: number) => boolean
  } = {}) {
    const delivered: string[] = []
    const finalizeCalls: Array<{ msgId: string; selector: string }> = []
    const sb = new Switchboard({
      list: async () => over.regs ?? [target],
      isAlive: over.isAlive ?? (() => true),
      deliver: async (_e, t) => { delivered.push(t); return { status: 'injected_unverified' } },
      finalizeGrant: over.finalizeGrant
        ? async (msgId, selector) => { finalizeCalls.push({ msgId, selector }); return over.finalizeGrant!(msgId, selector) }
        : undefined,
    })
    return { sb, delivered, finalizeCalls }
  }

  it('finalizes the grant BEFORE pasting; only a true (200) result allows delivery', async () => {
    const { sb, delivered, finalizeCalls } = boardWithFinalize({ finalizeGrant: async () => true })
    await sb.refresh()
    const selector = `revival.3d--agy@${GEN}`
    const r = await sb.deliver(env({ id: 'msg_01HRK7Y000000000000000FIN1', meta: { local_target: selector } }))
    expect(finalizeCalls).toEqual([{ msgId: 'msg_01HRK7Y000000000000000FIN1', selector }])
    expect(r.accepted).toEqual(['revival.3d--agy'])
    expect(delivered).toEqual(['revival.3d--agy'])
  })

  it('finalize_failed: a non-200 finalize result suppresses the paste entirely', async () => {
    const { sb, delivered, finalizeCalls } = boardWithFinalize({ finalizeGrant: async () => false })
    await sb.refresh()
    const selector = `revival.3d--agy@${GEN}`
    await expect(sb.deliver(env({ meta: { local_target: selector } }))).rejects.toThrow(/finalize_failed/)
    expect(finalizeCalls.length).toBe(1)
    expect(delivered).toEqual([])
  })

  it('finalize_failed when no finalizeGrant dependency is wired at all (fail closed, never paste unfinalised)', async () => {
    const { sb, delivered } = boardWithFinalize({ finalizeGrant: undefined })
    await sb.refresh()
    await expect(sb.deliver(env({ meta: { local_target: `revival.3d--agy@${GEN}` } }))).rejects.toThrow(/finalize_failed/)
    expect(delivered).toEqual([])
  })

  describe('return_target_gone reasons — never a broadcast fallback', () => {
    it('not_registered: no registration with that name', async () => {
      const { sb, delivered, finalizeCalls } = boardWithFinalize({ finalizeGrant: async () => true, regs: [] })
      await sb.refresh()
      await expect(sb.deliver(env({ meta: { local_target: `ghost--codex@${GEN}` } })))
        .rejects.toThrow(/return_target_gone reason=not_registered/)
      expect(finalizeCalls).toEqual([])
      expect(delivered).toEqual([])
    })

    it('generation_stale: name exists but the registry now reports a different generation', async () => {
      const stale = { ...target, generation: '01GEN0000000000000000000Z' }
      const { sb, delivered, finalizeCalls } = boardWithFinalize({ finalizeGrant: async () => true, regs: [stale] })
      await sb.refresh()
      await expect(sb.deliver(env({ meta: { local_target: `revival.3d--agy@${GEN}` } })))
        .rejects.toThrow(/return_target_gone reason=generation_stale/)
      expect(finalizeCalls).toEqual([])
      expect(delivered).toEqual([])
    })

    it('pid_dead: name + generation match but the pid is gone', async () => {
      const { sb, delivered, finalizeCalls } = boardWithFinalize({
        finalizeGrant: async () => true, regs: [target], isAlive: () => false,
      })
      await sb.refresh()
      await expect(sb.deliver(env({ meta: { local_target: `revival.3d--agy@${GEN}` } })))
        .rejects.toThrow(/return_target_gone reason=pid_dead/)
      expect(finalizeCalls).toEqual([])
      expect(delivered).toEqual([])
    })

    it('harness_changed: the name-derived harness no longer matches the registered one', async () => {
      // "revival.3d--agy" derives an expected harness of "agy" (§8.1 naming:
      // <basename of cwd>--<pane current command>); the registry now reports
      // "codex" for the SAME name+generation — an anomaly, never trusted.
      const mismatched = { ...target, harness: 'codex' }
      const { sb, delivered, finalizeCalls } = boardWithFinalize({ finalizeGrant: async () => true, regs: [mismatched] })
      await sb.refresh()
      await expect(sb.deliver(env({ meta: { local_target: `revival.3d--agy@${GEN}` } })))
        .rejects.toThrow(/return_target_gone reason=harness_changed/)
      expect(finalizeCalls).toEqual([])
      expect(delivered).toEqual([])
    })

    it('none_selector: local_target is the literal ~none (no pane was ever registered)', async () => {
      const { sb, delivered, finalizeCalls } = boardWithFinalize({ finalizeGrant: async () => true })
      await sb.refresh()
      await expect(sb.deliver(env({ meta: { local_target: '~none' } })))
        .rejects.toThrow(/return_target_gone reason=none_selector/)
      expect(finalizeCalls).toEqual([])
      expect(delivered).toEqual([])
    })
  })

  it('a not_registered miss re-reads the registry once before giving up (a just-attached pane)', async () => {
    let calls = 0
    const delivered: string[] = []
    const sb = new Switchboard({
      list: async () => { calls++; return calls === 1 ? [] : [target] },
      isAlive: () => true,
      deliver: async (_e, t) => { delivered.push(t); return { status: 'injected_unverified' } },
      finalizeGrant: async () => true,
    })
    await sb.refresh()
    const r = await sb.deliver(env({ meta: { local_target: `revival.3d--agy@${GEN}` } }))
    expect(r.accepted).toEqual(['revival.3d--agy'])
    expect(calls).toBe(2)
    expect(delivered).toEqual(['revival.3d--agy'])
  })

  it('dead registrations are still visible for reason-diagnosis even though registrations()/repos() stay alive-filtered', async () => {
    const { sb } = boardWithFinalize({ finalizeGrant: async () => true, regs: [target], isAlive: () => false })
    await sb.refresh()
    // Unchanged existing contract: repos()/registrations() report only LIVE
    // extensions (broadcast/default routing must never ring a dead pane).
    expect(sb.registrations()).toEqual([])
    expect(sb.repos()).toEqual([])
    // But resolving a selector against a dead registration still gets a
    // SPECIFIC reason (pid_dead, asserted above), not a generic "not found" —
    // the hardening needs the full raw list, not the alive-filtered one.
  })
})
