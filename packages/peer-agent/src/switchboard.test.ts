import { describe, it, expect } from 'vitest'
import type { Envelope } from '@hangar-bridge/shared'
import { Switchboard, type Registration } from './switchboard.ts'

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
