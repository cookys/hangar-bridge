import { afterEach, describe, expect, it } from 'vitest'
import { defaultHealthStatePath } from './paths.ts'

describe('health-state persistence path', () => {
  const original = process.env.HANGAR_CONFIG_DIR

  afterEach(() => {
    if (original === undefined) delete process.env.HANGAR_CONFIG_DIR
    else process.env.HANGAR_CONFIG_DIR = original
  })

  it('is stable per session and isolated between sibling sessions', () => {
    process.env.HANGAR_CONFIG_DIR = '/tmp/hangar-path-test'
    const alice = defaultHealthStatePath('session-alice')
    const aliceAgain = defaultHealthStatePath('session-alice')
    const sibling = defaultHealthStatePath('session-sibling')

    expect(aliceAgain).toBe(alice)
    expect(sibling).not.toBe(alice)
    expect(alice).not.toContain('session-alice')
    expect(alice).toMatch(/health-state-[0-9a-f]{24}\.json$/)
  })
})
