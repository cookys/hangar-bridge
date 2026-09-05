import { describe, it, expect } from 'vitest'
import { parseAddressRulesEnv } from './serve.ts'

/**
 * REPLY_ROUTING_SPEC.md §6 rollout flag. Mirrors the HANGAR_BROADCAST_GATE
 * pattern (deps.broadcastGate): defaults to 'off' so an existing deployment's
 * behaviour never changes on upgrade — only an explicit 'on' enables the new
 * §6.1-6.3 refusals.
 */
describe('parseAddressRulesEnv (HANGAR_RELAY_ADDRESS_RULES)', () => {
  it("'on' -> 'on'", () => {
    expect(parseAddressRulesEnv('on')).toBe('on')
  })

  it('anything else -> off', () => {
    expect(parseAddressRulesEnv(undefined)).toBe('off')
    expect(parseAddressRulesEnv('')).toBe('off')
    expect(parseAddressRulesEnv('true')).toBe('off')
    expect(parseAddressRulesEnv('ON')).toBe('off')
    expect(parseAddressRulesEnv('enforce')).toBe('off')
  })
})
