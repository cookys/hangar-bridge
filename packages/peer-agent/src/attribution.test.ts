import { describe, it, expect, vi } from 'vitest'
import { RelayClient } from './outbound.ts'
import { peerCaps, BASE_PEER_CAPS } from './tools.ts'
import { HealthState, withOutboundHealth } from './health-state.ts'
import type { DeafCheckResult } from './deaf-check.ts'

/**
 * P4'a/P4'c peer-agent side.
 *
 * The relay stamps attribution from the x-hangar-instance header, so the client
 * must actually send it on the publish path — otherwise the whole chain is inert.
 * The DEAF marker rides as a meta key because the subject-routing spec renders
 * meta into the channel envelope: visible without the receiver querying for it,
 * and without touching the <channel> tag shape.
 */
describe('peer-agent attribution', () => {
  const mkClient = (capture: { headers?: Record<string, string>; body?: string }) => {
    const fetchImpl = vi.fn(async (_u: unknown, init: RequestInit) => {
      capture.headers = init.headers as Record<string, string>
      capture.body = init.body as string
      return new Response(JSON.stringify({ id: 'msg_x', meta: {} }), { status: 201 })
    })
    return new RelayClient(
      {
        relayUrl: 'http://relay.test', token: 'tok',
        instance: '01HRK7Y0000000000000000000', attributionVersion: 'v1',
      },
      { fetch: fetchImpl as unknown as typeof fetch },
    )
  }

  it('sends x-hangar-instance on publish so the relay can stamp attribution', async () => {
    const cap: { headers?: Record<string, string> } = {}
    await mkClient(cap).send({ to: 'bob', kind: 'chat', content: 'hi' })
    expect(cap.headers?.['x-hangar-instance']).toBe('01HRK7Y0000000000000000000')
    expect(cap.headers?.['x-hangar-attribution']).toBe('v1')
  })

  it('omits the header when no instance is configured (legacy behaviour)', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 'm', meta: {} }), { status: 201 }))
    let seen: Record<string, string> | undefined
    const f = vi.fn(async (_u: unknown, init: RequestInit) => {
      seen = init.headers as Record<string, string>
      return fetchImpl()
    })
    const c = new RelayClient(
      { relayUrl: 'http://relay.test', token: 'tok' },
      { fetch: f as unknown as typeof fetch },
    )
    await c.send({ to: 'bob', kind: 'chat', content: 'hi' })
    expect(seen && 'x-hangar-instance' in seen).toBe(false)
  })
})

describe('attribution capability bit', () => {
  it('advertises attribution-v1 alongside the per-message protocol declaration', () => {
    expect(peerCaps(true)).toContain('attribution-v1')
    expect(peerCaps(false)).toContain('attribution-v1')
    expect(BASE_PEER_CAPS).toContain('attribution-v1')
  })
})

describe('DEAF outbound marker', () => {
  const deaf = (sinceMs: number): HealthState =>
    new HealthState({ state: 'deaf', reason: 'no channels flag' } as DeafCheckResult, sinceMs)

  it('exposes sender_health and deaf_since as meta keys when deaf', () => {
    const m = deaf(1_700_000_000_000).outboundMeta()
    expect(m['sender_health']).toBe('deaf')
    expect(m['deaf_since']).toBe('2023-11-14T22:13:20.000Z')
  })

  it('adds nothing when healthy — no marker noise on the common path', () => {
    const ok = new HealthState({ state: 'verified', reason: 'ok' } as DeafCheckResult)
    expect(ok.outboundMeta()).toEqual({})
    const skipped = new HealthState({ state: 'skip', reason: 'non-claude harness' } as DeafCheckResult)
    expect(skipped.outboundMeta()).toEqual({})
  })

  it('deaf_since is what makes two months distinguishable from five minutes', () => {
    const a = deaf(1_700_000_000_000).outboundMeta()['deaf_since']
    const b = deaf(1_700_000_300_000).outboundMeta()['deaf_since']
    expect(a).not.toBe(b)
  })

  it('decorates a shared PeerTransport send payload and overrides forged health meta', () => {
    const msg = withOutboundHealth({
      to: 'bob', kind: 'chat', content: 'hi',
      meta: { sender_health: 'healthy', keep: 'yes' },
    }, deaf(1_700_000_000_000))
    expect(msg.meta).toMatchObject({
      keep: 'yes', sender_health: 'deaf', deaf_since: '2023-11-14T22:13:20.000Z',
    })
  })
})
