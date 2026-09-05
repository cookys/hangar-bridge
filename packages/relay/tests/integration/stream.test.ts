import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type Db } from '../../src/db/db.ts'
import { MessageStore } from '../../src/messages/store.ts'
import { Fanout } from '../../src/fanout.ts'
import { PresenceRegistry } from '../../src/presence/registry.ts'
import { buildApp } from '../../src/app.ts'
import { seedPeerSecrets } from './_seed.ts'
import { ClaimStore } from '../../src/claims/store.ts'

async function readNEvents(stream: ReadableStream<Uint8Array>, n: number, timeoutMs = 2000): Promise<string[]> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const events: string[] = []
  let buf = ''
  const deadline = Date.now() + timeoutMs
  while (events.length < n && Date.now() < deadline) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const timeoutPromise = new Promise<{ value: undefined; done: true }>(resolve =>
      setTimeout(() => resolve({ value: undefined, done: true }), remaining)
    )
    const { value, done } = await Promise.race([reader.read(), timeoutPromise])
    if (done) break
    buf += decoder.decode(value)
    const parts = buf.split('\n\n')
    buf = parts.pop() ?? ''
    events.push(...parts.filter(p => p.trim().length > 0))
  }
  try { await reader.cancel() } catch { /* ignore */ }
  return events
}

describe('GET /v1/stream', () => {
  let db: Db
  let store: MessageStore
  let app: ReturnType<typeof buildApp>
  let tok: { alice: string; bob: string }
  beforeEach(() => {
    db = openDatabase(':memory:')
    const peers = seedPeerSecrets(db, ['alice', 'bob'])
    tok = { alice: peers.alice!.token, bob: peers.bob!.token }
    store = new MessageStore(db)
    app = buildApp({ db, store, fanout: new Fanout(), presence: new PresenceRegistry(), claims: new ClaimStore(db), now: () => new Date() })
  })

  it('delivers a posted message to the target\'s open stream', async () => {
    const streamRes = await app.request('/v1/stream', { headers: { authorization: `Bearer ${tok.bob}` } })
    expect(streamRes.status).toBe(200)
    expect(streamRes.headers.get('content-type')).toContain('text/event-stream')

    await app.request('/v1/messages', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok.alice}`, 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'bob', kind: 'chat', content: 'hello' })
    })
    const events = await readNEvents(streamRes.body!, 1)
    const msg = events.find(e => e.includes('event: message'))
    expect(msg).toBeDefined()
    expect(msg!).toContain('"from":"alice"')
    expect(msg!).toContain('"content":"hello"')
  })

  it('?since=<id> replays buffered messages in order', async () => {
    for (const n of ['1','2','3']) {
      await app.request('/v1/messages', {
        method: 'POST',
        headers: { authorization: `Bearer ${tok.alice}`, 'content-type': 'application/json' },
        body: JSON.stringify({ to: 'bob', kind: 'chat', content: n })
      })
    }
    const streamRes = await app.request('/v1/stream?since=msg_00000000000000000000000000',
      { headers: { authorization: `Bearer ${tok.bob}` } })
    const events = await readNEvents(streamRes.body!, 3)
    const msgEvents = events.filter(e => e.includes('event: message'))
    expect(msgEvents).toHaveLength(3)
    expect(msgEvents[0]!).toContain('"content":"1"')
    expect(msgEvents[2]!).toContain('"content":"3"')
  })

  it('401 without auth', async () => {
    const res = await app.request('/v1/stream')
    expect(res.status).toBe(401)
  })

  // REPLY_ROUTING_SPEC.md §6.5: `~cli` is the CLI's mailbox identity, never a
  // valid streaming instance.
  it('400 reserved_instance for x-hangar-instance: ~cli', async () => {
    const res = await app.request('/v1/stream', {
      headers: { authorization: `Bearer ${tok.bob}`, 'x-hangar-instance': '~cli' },
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('reserved_instance')
  })

  // §4: every presentation path grants before handing the message to a
  // session, including the cold-start drain / ?since= replay backlog — a
  // subscriber that connects AFTER a message's live snapshot was taken must
  // still be granted once it drains that durable row.
  describe('§4 drain grants a late subscriber', () => {
    const INST = '01HRK7Y0000000000000000000'

    it('cold-start drain writes a grant for the connecting instance before the SSE write', async () => {
      const sent = await app.request('/v1/messages', {
        method: 'POST',
        headers: { authorization: `Bearer ${tok.alice}`, 'content-type': 'application/json' },
        body: JSON.stringify({ to: 'bob', kind: 'chat', content: 'hello' }),
      })
      const body = await sent.json() as { id: string }
      expect(store.hasGrant(body.id, 'bob', INST)).toBe(false)

      const streamRes = await app.request('/v1/stream', {
        headers: { authorization: `Bearer ${tok.bob}`, 'x-hangar-instance': INST },
      })
      await readNEvents(streamRes.body!, 1)
      expect(store.hasGrant(body.id, 'bob', INST)).toBe(true)
    })

    it('?since= replay writes a grant for the connecting instance', async () => {
      const sent = await app.request('/v1/messages', {
        method: 'POST',
        headers: { authorization: `Bearer ${tok.alice}`, 'content-type': 'application/json' },
        body: JSON.stringify({ to: 'bob', kind: 'chat', content: 'hello' }),
      })
      const body = await sent.json() as { id: string }
      const streamRes = await app.request('/v1/stream?since=msg_00000000000000000000000000', {
        headers: { authorization: `Bearer ${tok.bob}`, 'x-hangar-instance': INST },
      })
      await readNEvents(streamRes.body!, 1)
      expect(store.hasGrant(body.id, 'bob', INST)).toBe(true)
    })

    it('never throws when the route is missing (a pre-v8 backfill-skipped row)', async () => {
      // A durable row with no reply_route (simulating a row the backfill
      // skipped): the drain must still deliver it, just without a grant.
      const other = store.insert('hangar', 'alice', { to: 'bob', kind: 'chat', content: 'legacy row' })
      expect(store.getRoute(other.id)).toBeNull()
      const streamRes = await app.request('/v1/stream', {
        headers: { authorization: `Bearer ${tok.bob}`, 'x-hangar-instance': INST },
      })
      const events = await readNEvents(streamRes.body!, 1)
      expect(events.some(e => e.includes(other.id))).toBe(true)
    })
  })
})
