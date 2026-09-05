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

  /**
   * P2 — the instance id has to travel on BOTH lanes (presence body and SSE
   * header) with the same value, or the relay writes one row key and deletes
   * another.
   */
  it('setPresence posts the process identity alongside the summary', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fakeFetch = vi.fn(async (url: string | URL, init: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response('{}', { status: 200 })
    })
    const c = new RelayClient({ relayUrl: 'https://x', token: 'tok' }, { fetch: fakeFetch as any })
    await c.setPresence({
      summary: 'working', instance: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      delivery_state: 'deaf', caps: 'disposition', worktree: 'agent-1',
    })
    expect(calls[0]!.url).toBe('https://x/v1/presence')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      summary: 'working', instance: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      delivery_state: 'deaf', caps: 'disposition', worktree: 'agent-1',
    })
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

/**
 * undici returns a socket to its pool only once the response body has been
 * consumed. setPresence ignored its body, so every 30 s heartbeat parked one
 * socket until garbage collection — a courier daemon that barely allocates was
 * found holding 110 connections to the relay (crosshair8-hero, 2026-09-02).
 */
/**
 * D5 item 1 (§5.1): the MCP reply_to_peer tool posts here. The client itself
 * does no local refusal logic — it hands back whatever status + body the
 * relay returns, success or refusal, so tools.ts can surface a relay
 * refusal verbatim (acceptance: "relay refusals surface verbatim").
 */
describe('RelayClient.reply — POST /v1/replies', () => {
  it('sends idempotency-key, x-hangar-instance and x-hangar-return-selector', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fakeFetch = vi.fn(async (url: string | URL, init: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({
        id: 'msg_01HRK7Y000000000000000000C', v: 2, team: 't1', from: 'a', to: 'bob',
        in_reply_to: 'msg_01HRK7Y000000000000000000A', thread_root: 'msg_01HRK7Y000000000000000000A',
        kind: 'chat', content: 'ack', meta: {}, sent_at: '2026-01-01T00:00:00.000Z', delivered_at: null,
        live: ['bob#01A'], durable: ['bob'], matched: 1, sender_state: 'live',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const c = new RelayClient({ relayUrl: 'https://x', token: 'tok', instance: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }, { fetch: fakeFetch as any })
    const r = await c.reply(
      { in_reply_to: 'msg_01HRK7Y000000000000000000A', content: 'ack' },
      { idempotencyKey: 'idem-key-1', returnSelector: 'pane@01GEN0000000000000000000A' },
    )
    expect(calls[0]!.url).toBe('https://x/v1/replies')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['idempotency-key']).toBe('idem-key-1')
    expect(headers['x-hangar-instance']).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV')
    expect(headers['x-hangar-return-selector']).toBe('pane@01GEN0000000000000000000A')
    expect(r.ok).toBe(true)
    expect(r.status).toBe(200)
    expect((r.body as any).id).toBe('msg_01HRK7Y000000000000000000C')
  })

  it('omits x-hangar-return-selector when none is given', async () => {
    const calls: { init: RequestInit }[] = []
    const fakeFetch = vi.fn(async (_url: string | URL, init: RequestInit) => {
      calls.push({ init })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    const c = new RelayClient({ relayUrl: 'https://x', token: 'tok' }, { fetch: fakeFetch as any })
    await c.reply({ in_reply_to: 'msg_01HRK7Y000000000000000000A', content: 'ack' }, { idempotencyKey: 'k' })
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['x-hangar-return-selector']).toBeUndefined()
  })

  it('returns a relay refusal (non-200) as a structured outcome, never throwing', async () => {
    const fakeFetch = vi.fn(async () => new Response(JSON.stringify({
      error: 'not_a_recipient', message: 'you are not in this route\'s grants', retryable: false,
    }), { status: 403 }))
    const c = new RelayClient({ relayUrl: 'https://x', token: 'tok' }, { fetch: fakeFetch as any })
    const r = await c.reply({ in_reply_to: 'msg_01HRK7Y000000000000000000A', content: 'ack' }, { idempotencyKey: 'k' })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(403)
    expect(r.body).toEqual({ error: 'not_a_recipient', message: 'you are not in this route\'s grants', retryable: false })
  })
})

describe('RelayClient.finalizeGrant — POST /v1/grants/finalize', () => {
  it('sends x-hangar-instance and returns ok:true on 200', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fakeFetch = vi.fn(async (url: string | URL, init: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ msg_id: 'msg_01HRK7Y000000000000000000A', selector: 'pane@01GEN0000000000000000000A', outcome: 'replaced' }), { status: 200 })
    })
    const c = new RelayClient({ relayUrl: 'https://x', token: 'tok', instance: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }, { fetch: fakeFetch as any })
    const r = await c.finalizeGrant('msg_01HRK7Y000000000000000000A', 'pane@01GEN0000000000000000000A')
    expect(calls[0]!.url).toBe('https://x/v1/grants/finalize')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers['x-hangar-instance']).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ msg_id: 'msg_01HRK7Y000000000000000000A', selector: 'pane@01GEN0000000000000000000A' })
    expect(r.ok).toBe(true)
  })

  it('returns ok:false on 404 grant_not_found', async () => {
    const fakeFetch = vi.fn(async () => new Response(JSON.stringify({ error: 'grant_not_found' }), { status: 404 }))
    const c = new RelayClient({ relayUrl: 'https://x', token: 'tok', instance: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }, { fetch: fakeFetch as any })
    const r = await c.finalizeGrant('msg_01HRK7Y000000000000000000A', 'pane@01GEN0000000000000000000A')
    expect(r.ok).toBe(false)
    expect(r.status).toBe(404)
  })
})

describe('RelayClient — response bodies are always consumed', () => {
  it('setPresence drains the body of a 200', async () => {
    let res: Response | undefined
    const fakeFetch = vi.fn(async () => { res = new Response('{"ok":true}', { status: 200 }); return res })
    const c = new RelayClient({ relayUrl: 'https://x', token: 'tok' }, { fetch: fakeFetch as any })
    await c.setPresence({ summary: 'hi' })
    expect(res!.bodyUsed).toBe(true)
  })

  it('setPresence drains the body of an error too, then throws', async () => {
    let res: Response | undefined
    const fakeFetch = vi.fn(async () => { res = new Response('nope', { status: 503 }); return res })
    const c = new RelayClient({ relayUrl: 'https://x', token: 'tok' }, { fetch: fakeFetch as any })
    await expect(c.setPresence({ summary: 'hi' })).rejects.toThrow(/presence failed: 503/)
    expect(res!.bodyUsed).toBe(true)
  })
})
