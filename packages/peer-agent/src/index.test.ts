import { describe, it, expect, vi } from 'vitest'
import { resolveCourierInstance } from './index.ts'
import type { HangarConfig } from './config.ts'

/**
 * Repair round item 2 (review finding, adopted): a switchboard courier's
 * whole restart-stability story (§8.1 — "no grant migration is needed on
 * restart") depends on its instance id actually landing on disk. Silently
 * falling back to an ephemeral instance when the write fails would look
 * like success right up until the next restart, when every grant keyed to
 * the old (never-persisted) instance quietly goes stale — a courier that
 * "works" until it doesn't, with no signal in between. Refuse to start
 * instead, the same way every other fatal startup precondition in this
 * file does (throw -> main().catch -> process.exit(1)).
 */
describe('resolveCourierInstance', () => {
  const cfg = (over: Partial<HangarConfig> = {}) => over as HangarConfig

  it('reuses an already-persisted instance without minting or saving anything', () => {
    const saveConfig = vi.fn()
    const newInstanceId = vi.fn(() => 'SHOULD-NOT-BE-MINTED')
    const id = resolveCourierInstance(cfg({ instance: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }), '/tmp/cfg.json', { saveConfig, newInstanceId })
    expect(id).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV')
    expect(saveConfig).not.toHaveBeenCalled()
    expect(newInstanceId).not.toHaveBeenCalled()
  })

  it('mints and persists a fresh instance when none is configured', () => {
    const saveConfig = vi.fn()
    const newInstanceId = vi.fn(() => '01MINTED0000000000000000000')
    const id = resolveCourierInstance(cfg({}), '/tmp/cfg.json', { saveConfig, newInstanceId })
    expect(id).toBe('01MINTED0000000000000000000')
    expect(saveConfig).toHaveBeenCalledWith('/tmp/cfg.json', { instance: '01MINTED0000000000000000000' })
  })

  it('aborts (throws) when the minted instance cannot be persisted, rather than starting ephemeral', () => {
    const saveConfig = vi.fn(() => { throw new Error('EACCES: permission denied') })
    const newInstanceId = vi.fn(() => '01MINTED0000000000000000000')
    expect(() => resolveCourierInstance(cfg({}), '/tmp/cfg.json', { saveConfig, newInstanceId }))
      .toThrow(/EACCES: permission denied/)
  })

  it('the abort error names the config path and explains the consequence', () => {
    const saveConfig = vi.fn(() => { throw new Error('disk full') })
    const newInstanceId = vi.fn(() => '01MINTED0000000000000000000')
    expect(() => resolveCourierInstance(cfg({}), '/tmp/cfg.json', { saveConfig, newInstanceId }))
      .toThrow(/\/tmp\/cfg\.json/)
  })
})
