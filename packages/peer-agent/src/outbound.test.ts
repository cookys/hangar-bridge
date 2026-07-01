import { describe, it, expect, vi } from 'vitest'
import { RelayClient } from './outbound.ts'

describe('RelayClient', () => {
  it('sends POST /v1/messages with bearer and idempotency key', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fakeFetch = vi.fn(async (url: string | URL, init: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({
        id: 'msg_01HRK7Y000000000000000000A',
        v: 2, team: 't1', from: 'alice', to: 'bob',
        in_reply_to: null, thread_root: null, kind: 'chat', content: 'hi', meta: {},
        sent_at: '2026-01-01T00:00:00.000Z', delivered_at: null,
      }), { status: 201, headers: { 'content-type': 'application/json' } })
    })
    const c = new RelayClient({ relayUrl: 'https://x', token: 'tok' }, { fetch: fakeFetch as any })
    const r = await c.send({ to: 'bob', kind: 'chat', content: 'hi' })
    expect(r.id).toBe('msg_01HRK7Y000000000000000000A')
    expect(calls[0]!.url).toBe('https://x/v1/messages')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer tok')
    expect(headers['idempotency-key']).toMatch(/^[a-z0-9-]+$/)
  })

  it('throws on non-201 with body', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'invalid_body' }), { status: 400 }))
    const c = new RelayClient({ relayUrl: 'https://x', token: 'tok' }, { fetch: fakeFetch as any })
    await expect(c.send({ to: 'bob', kind: 'chat', content: 'x' })).rejects.toThrow(/invalid_body/)
  })

  it('listPeers calls GET /v1/peers', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(JSON.stringify([{ handle: 'alice', online: true }]), { status: 200 }))
    const c = new RelayClient({ relayUrl: 'https://x', token: 'tok' }, { fetch: fakeFetch as any })
    const list = await c.listPeers()
    expect(list[0]!.handle).toBe('alice')
  })

  it('claim: 201 → ok result with renewed flag', async () => {
    const calls: string[] = []
    const fakeFetch = vi.fn(async (url: string | URL) => {
      calls.push(String(url))
      return new Response(JSON.stringify({
        claim: { team_id: 'hangar', claim_key: 'k', owner_handle: 'alice', owner_label: 'l', note: null, created_at: 't', expires_at: 't2' },
        renewed: false,
      }), { status: 201 })
    })
    const c = new RelayClient({ relayUrl: 'https://x', token: 'tok' }, { fetch: fakeFetch as any })
    const r = await c.claim({ key: 'k', ttl_seconds: 60 })
    expect(calls[0]).toBe('https://x/v1/claim')
    expect(r.ok).toBe(true)
    if (r.ok) { expect(r.renewed).toBe(false); expect(r.claim.owner_handle).toBe('alice') }
  })

  it('claim: 409 → conflict result', async () => {
    const fakeFetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'claim_conflict', owner: 'bob', expires_at: 't2' }), { status: 409 }))
    const c = new RelayClient({ relayUrl: 'https://x', token: 'tok' }, { fetch: fakeFetch as any })
    const r = await c.claim({ key: 'k' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.conflict.owner).toBe('bob')
  })

  it('claim: other status throws', async () => {
    const fakeFetch = vi.fn(async () => new Response('boom', { status: 500 }))
    const c = new RelayClient({ relayUrl: 'https://x', token: 'tok' }, { fetch: fakeFetch as any })
    await expect(c.claim({ key: 'k' })).rejects.toThrow(/claim failed: 500/)
  })

  it('listClaims calls GET /v1/claims', async () => {
    const calls: string[] = []
    const fakeFetch = vi.fn(async (url: string | URL) => {
      calls.push(String(url))
      return new Response(JSON.stringify([{ claim_key: 'k', owner_handle: 'alice' }]), { status: 200 })
    })
    const c = new RelayClient({ relayUrl: 'https://x', token: 'tok' }, { fetch: fakeFetch as any })
    const l = await c.listClaims()
    expect(calls[0]).toBe('https://x/v1/claims')
    expect(l[0]!.claim_key).toBe('k')
  })

  it('releaseClaim: 200 released / 409 conflict (POST /v1/claim/release)', async () => {
    const calls: { url: string; method?: string }[] = []
    const okFetch = vi.fn(async (url: string | URL, init: RequestInit) => {
      calls.push({ url: String(url), method: init.method })
      return new Response(JSON.stringify({ released: true }), { status: 200 })
    })
    const c1 = new RelayClient({ relayUrl: 'https://x', token: 'tok' }, { fetch: okFetch as any })
    const r1 = await c1.releaseClaim('k')
    expect(r1).toEqual({ ok: true, released: true })
    // Robustness: release must be a POST (DELETE bodies are dropped by some proxies).
    expect(calls[0]!.url).toBe('https://x/v1/claim/release')
    expect(calls[0]!.method).toBe('POST')

    const conflictFetch = vi.fn(async () => new Response(JSON.stringify({ error: 'claim_conflict', owner: 'bob' }), { status: 409 }))
    const c2 = new RelayClient({ relayUrl: 'https://x', token: 'tok' }, { fetch: conflictFetch as any })
    const r2 = await c2.releaseClaim('k')
    expect(r2).toEqual({ ok: false, owner: 'bob' })
  })
})
