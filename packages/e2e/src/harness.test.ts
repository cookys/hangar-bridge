import { describe, it, expect } from 'vitest'
import { startHarness } from './harness.ts'
import { generateRawToken } from '../../relay/src/auth/hash.ts'

describe('startHarness', () => {
  it('provisions N peers, each with a valid shared secret', async () => {
    const h = await startHarness(['alice','bob','charlie'])
    try {
      const res = await fetch(new URL('/v1/peers', h.relayUrl), {
        headers: { authorization: `Bearer ${h.peers.alice!.token}` }
      })
      const peers = await res.json() as Array<{ handle: string }>
      expect(peers.map(p => p.handle).sort()).toEqual(['alice','bob','charlie'])
    } finally { await h.cleanup() }
  })

  it('message sent by alice can be fetched on bob\'s stream (via ?since=)', async () => {
    const h = await startHarness(['alice','bob'])
    try {
      await fetch(new URL('/v1/messages', h.relayUrl), {
        method: 'POST',
        headers: { authorization: `Bearer ${h.peers.alice!.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ to: 'bob', kind: 'chat', content: 'hello' })
      })
      const res = await fetch(new URL('/v1/stream?since=msg_00000000000000000000000000', h.relayUrl), {
        headers: { authorization: `Bearer ${h.peers.bob!.token}`, accept: 'text/event-stream' }
      })
      const reader = res.body!.getReader()
      const { value } = await reader.read()
      const text = new TextDecoder().decode(value)
      expect(text).toContain('"content":"hello"')
      try { await reader.cancel() } catch { /* ignore */ }
    } finally { await h.cleanup() }
  })

  // OKR-3 + P2 exit criterion: shared-secret happy + rejected-wrong-secret e2e.
  it('shared-secret: rejects a bearer that was never seeded', async () => {
    const h = await startHarness(['alice'])
    try {
      const wrong = generateRawToken()
      const res = await fetch(new URL('/v1/peers', h.relayUrl), {
        headers: { authorization: `Bearer ${wrong}` }
      })
      expect(res.status).toBe(401)
    } finally { await h.cleanup() }
  })

  it('admin tier routes are gone: /v1/admin returns 404', async () => {
    const h = await startHarness(['alice'])
    try {
      const r1 = await fetch(new URL('/v1/admin/users', h.relayUrl), {
        method: 'POST',
        headers: { authorization: `Bearer ${h.peers.alice!.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ handle: 'mallory', display_name: 'Mallory' }),
      })
      expect(r1.status).toBe(404)
      const r2 = await fetch(new URL('/v1/auth/pair', h.relayUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pair_code: 'HANGAR-X', device_label: 'x' }),
      })
      expect(r2.status).toBe(404)
    } finally { await h.cleanup() }
  })
})
