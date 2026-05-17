import { describe, it, expect, beforeEach } from 'vitest'
import { SenderGate } from './gate.ts'

/**
 * Layer 3 of the 5-layer auth defense — Roster gate.
 *
 * The roster is refreshed every 60s from the relay's `/v1/peers` (see
 * peer-agent/src/index.ts `refreshRoster`). An incoming envelope's `from`
 * field is checked against the roster before injection. With the relay
 * doing Layer 1 bearer-auth + Layer 2 sender-stamp, this layer adds
 * defense-in-depth: even if a token leaked, the receiver still won't act
 * on messages from a peer name it doesn't know.
 */
describe('SenderGate — Layer 3 (Roster gate)', () => {
  let g: SenderGate
  beforeEach(() => { g = new SenderGate(['alice','bob','charlie']) })

  it('accepts known handles', () => { expect(g.accept('alice')).toBe(true) })
  it('rejects unknown handles, increments metric', () => {
    expect(g.accept('mallory')).toBe(false)
    expect(g.violations()).toBe(1)
  })
  it('roster can be refreshed', () => {
    g.setRoster(['alice'])
    expect(g.accept('bob')).toBe(false)
  })
})
