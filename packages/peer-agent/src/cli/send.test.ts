import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSend } from './send.ts'

/**
 * D5 item 5 (§8.1): `hangar-bridge send` always sends BOTH identity headers.
 * x-hangar-instance is the courier's persisted instance inside a pane, the
 * literal ~cli outside any pane. x-hangar-return-selector is <name>@
 * <generation> when the local registry knows this pane, else ~none.
 */
describe('runSend — identity headers', () => {
  let workdir = ''
  const ORIGINAL_CONFIG_DIR = process.env.HANGAR_CONFIG_DIR
  const ORIGINAL_TMUX_PANE = process.env.TMUX_PANE

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'hangar-send-'))
    process.env.HANGAR_CONFIG_DIR = workdir
    delete process.env.TMUX_PANE
    mkdirSync(workdir, { recursive: true })
    writeFileSync(join(workdir, 'secret'), 'the-token', { mode: 0o600 })
  })

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true })
    if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.HANGAR_CONFIG_DIR
    else process.env.HANGAR_CONFIG_DIR = ORIGINAL_CONFIG_DIR
    if (ORIGINAL_TMUX_PANE === undefined) delete process.env.TMUX_PANE
    else process.env.TMUX_PANE = ORIGINAL_TMUX_PANE
  })

  function fakeFetch() {
    const calls: { url: string; init: RequestInit }[] = []
    const fn = vi.fn(async (url: string | URL, init: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({
        id: 'msg_01HRK7Y000000000000000000A', v: 2, team: 't1', from: 'a', to: 'bob',
        in_reply_to: null, thread_root: null, kind: 'chat', content: 'x', meta: {},
        sent_at: '2026-01-01T00:00:00.000Z', delivered_at: null,
      }), { status: 201 })
    })
    return { fn, calls }
  }

  it('outside any pane: x-hangar-instance is the literal ~cli, x-hangar-return-selector is ~none', async () => {
    const { fn, calls } = fakeFetch()
    await runSend(['bob', 'hi', '--relay', 'http://x'], { fetchImpl: fn as any })
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['x-hangar-instance']).toBe('~cli')
    expect(headers['x-hangar-return-selector']).toBe('~none')
  })

  it('inside a pane with a persisted courier instance: sends it verbatim', async () => {
    process.env.TMUX_PANE = '%7'
    writeFileSync(join(workdir, 'config.json'), JSON.stringify({
      relay_url: 'http://x', token_path: join(workdir, 'secret'), instance: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    }))
    const { fn, calls } = fakeFetch()
    await runSend(['bob', 'hi', '--relay', 'http://x'], {
      fetchImpl: fn as any, findPaneRegistration: async () => undefined,
    })
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['x-hangar-instance']).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV')
  })

  it('inside a pane with no persisted courier instance: mints one rather than sending ~cli', async () => {
    process.env.TMUX_PANE = '%7'
    const { fn, calls } = fakeFetch()
    await runSend(['bob', 'hi', '--relay', 'http://x'], {
      fetchImpl: fn as any, findPaneRegistration: async () => undefined, mintInstanceId: () => '01MINTED000000000000000000',
    })
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['x-hangar-instance']).toBe('01MINTED000000000000000000')
  })

  it('inside a pane the registry knows: sends <name>@<generation>', async () => {
    process.env.TMUX_PANE = '%7'
    writeFileSync(join(workdir, 'config.json'), JSON.stringify({
      relay_url: 'http://x', token_path: join(workdir, 'secret'), instance: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    }))
    const { fn, calls } = fakeFetch()
    const findPaneRegistration = vi.fn(async (pane: string) =>
      pane === '%7' ? { name: 'revival.3d--agy', generation: '01GEN0000000000000000000A' } : undefined)
    await runSend(['bob', 'hi', '--relay', 'http://x'], { fetchImpl: fn as any, findPaneRegistration })
    expect(findPaneRegistration).toHaveBeenCalledWith('%7')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['x-hangar-return-selector']).toBe('revival.3d--agy@01GEN0000000000000000000A')
  })

  it('inside a pane the registry does NOT know: sends ~none, not the pane id', async () => {
    process.env.TMUX_PANE = '%7'
    writeFileSync(join(workdir, 'config.json'), JSON.stringify({
      relay_url: 'http://x', token_path: join(workdir, 'secret'), instance: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    }))
    const { fn, calls } = fakeFetch()
    await runSend(['bob', 'hi', '--relay', 'http://x'], {
      fetchImpl: fn as any, findPaneRegistration: async () => undefined,
    })
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['x-hangar-return-selector']).toBe('~none')
  })

  it('a registration with no generation still selects ~none (cannot form a valid selector)', async () => {
    process.env.TMUX_PANE = '%7'
    const { fn, calls } = fakeFetch()
    await runSend(['bob', 'hi', '--relay', 'http://x'], {
      fetchImpl: fn as any, findPaneRegistration: async () => ({ name: 'revival.3d--agy' }),
    })
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['x-hangar-return-selector']).toBe('~none')
  })
})
