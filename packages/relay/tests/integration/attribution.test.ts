import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type Db } from '../../src/db/db.ts'
import { MessageStore } from '../../src/messages/store.ts'
import { Fanout, type Subscriber } from '../../src/fanout.ts'
import { PresenceRegistry } from '../../src/presence/registry.ts'
import { ClaimStore } from '../../src/claims/store.ts'
import { buildApp } from '../../src/app.ts'
import { seedPeerSecrets } from './_seed.ts'

async function readNEvents(
  stream: ReadableStream<Uint8Array>,
  n: number,
  timeoutMs = 500,
): Promise<string[]> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const events: string[] = []
  let buf = ''
  const deadline = Date.now() + timeoutMs
  while (events.length < n && Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const timeout = new Promise<{ value: undefined; done: true }>(resolve =>
      setTimeout(() => resolve({ value: undefined, done: true }), remaining)
    )
    const { value, done } = await Promise.race([reader.read(), timeout])
    if (done) break
    buf += decoder.decode(value)
    const parts = buf.split('\n\n')
    buf = parts.pop() ?? ''
    events.push(...parts.filter(p => p.trim().length > 0))
  }
  try { await reader.cancel() } catch { /* client already closed */ }
  return events
}

/**
 * P4'a — attribution is RELAY-STAMPED, never sender-declared.
 *
 * The 8/22 incident was a thread of mutually-denying messages behind one
 * handle. `meta.instance` comes from the authenticated handle request's
 * x-hangar-instance header and any client-supplied message-meta value is stripped
 * at this chokepoint — the same treatment RESERVED_META_KEYS already gets.
 * Same-handle processes share a bearer and therefore trust each other's header;
 * this field is deliberately forbidden from authorization or positive routing.
 */
describe('publish attribution stamping', () => {
  let db: Db
  let app: ReturnType<typeof buildApp>
  let tok: Record<string, string>
  let fanout: Fanout
  let store: MessageStore

  beforeEach(() => {
    db = openDatabase(':memory:')
    const peers = seedPeerSecrets(db, ['alice', 'bob'])
    tok = { alice: peers.alice!.token, bob: peers.bob!.token }
    fanout = new Fanout()
    store = new MessageStore(db)
    app = buildApp({
      db, store: new MessageStore(db), fanout: new Fanout(),
      presence: new PresenceRegistry(), claims: new ClaimStore(db), now: () => new Date(),
    })
  })

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    app.request('/v1/messages', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok.alice}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })

  it('stamps meta.instance from the authenticated header', async () => {
    const r = await post({ to: 'bob', kind: 'chat', content: 'hi' }, {
      'x-hangar-instance': '01HRK7Y0000000000000000000',
    })
    expect(r.status).toBe(201)
    const body = await r.json() as { meta: Record<string, string> }
    expect(body.meta.instance).toBe('01HRK7Y0000000000000000000')
  })

  it('STRIPS a client-supplied meta.instance — it cannot be forged', async () => {
    const r = await post({
      to: 'bob', kind: 'chat', content: 'hi',
      meta: { instance: 'FORGED-SIBLING-INSTANCE' },
    }, { 'x-hangar-instance': '01HRK7Y0000000000000000000' })
    const body = await r.json() as { meta: Record<string, string> }
    expect(body.meta.instance).toBe('01HRK7Y0000000000000000000')
    expect(body.meta.instance).not.toContain('FORGED')
  })

  it('strips a forged meta.instance even when NO header is presented', async () => {
    const r = await post({
      to: 'bob', kind: 'chat', content: 'hi',
      meta: { instance: 'FORGED' },
    })
    const body = await r.json() as { meta: Record<string, string> }
    expect(body.meta.instance).toBeUndefined()
  })

  it('strips a forged sender_instance even when NO header is presented', async () => {
    const r = await post({
      to: 'bob', kind: 'chat', content: 'hi',
      meta: { sender_instance: '01HRK7Y0000000000000000000' },
    })
    const body = await r.json() as { meta: Record<string, string> }
    expect(body.meta.sender_instance).toBeUndefined()
  })

  it('stamps per-message attribution status for modern and legacy publishers', async () => {
    const modern = await post({ to: 'bob', kind: 'chat', content: 'modern' }, {
      'x-hangar-attribution': 'v1',
    })
    const modernBody = await modern.json() as { meta: Record<string, string> }
    expect(modernBody.meta.attribution_status).toBe('unverifiable')

    const legacy = await post({ to: 'bob', kind: 'chat', content: 'legacy' })
    const legacyBody = await legacy.json() as { meta: Record<string, string> }
    expect(legacyBody.meta.attribution_status).toBeUndefined()
  })

  it('stamps modern publishers with a valid instance and rejects unknown versions', async () => {
    const stamped = await post({ to: 'bob', kind: 'chat', content: 'modern' }, {
      'x-hangar-attribution': 'v1',
      'x-hangar-instance': '01HRK7Y0000000000000000000',
    })
    const stampedBody = await stamped.json() as { meta: Record<string, string> }
    expect(stampedBody.meta.attribution_status).toBe('stamped')

    const invalid = await post({ to: 'bob', kind: 'chat', content: 'future' }, {
      'x-hangar-attribution': 'v999',
    })
    expect(invalid.status).toBe(400)
  })

  it('does not trust a body-supplied attribution status', async () => {
    const r = await post({
      to: 'bob', kind: 'chat', content: 'legacy',
      meta: { attribution_status: 'stamped' },
    })
    const body = await r.json() as { meta: Record<string, string> }
    expect(body.meta.attribution_status).toBeUndefined()
  })

  it('strips a client-supplied session_id claim (relay cannot verify it)', async () => {
    const r = await post({
      to: 'bob', kind: 'chat', content: 'hi',
      meta: { session_id: 'not-verifiable' },
    })
    const body = await r.json() as { meta: Record<string, string> }
    expect(body.meta.session_id).toBeUndefined()
  })

  it('keeps an explicitly display-only session claim under its own key', async () => {
    // CLAUDE_CODE_SESSION_ID cannot be relay-verified, so it ships under a name
    // that says so rather than masquerading as authenticated attribution.
    const r = await post({
      to: 'bob', kind: 'chat', content: 'hi',
      meta: { peer_session_claim: 'bde001da-3016' },
    })
    const body = await r.json() as { meta: Record<string, string> }
    expect(body.meta.peer_session_claim).toBe('bde001da-3016')
  })

  it('rejects a malformed instance header rather than stamping junk', async () => {
    const r = await post({ to: 'bob', kind: 'chat', content: 'hi' }, {
      'x-hangar-instance': 'not a ulid!!',
    })
    expect(r.status).toBe(400)
  })
})

describe('production stream instance wiring', () => {
  class CapturingFanout extends Fanout {
    lastSubscriber: Subscriber | undefined
    override subscribe(sub: Subscriber): void {
      this.lastSubscriber = sub
      super.subscribe(sub)
    }
  }

  it('passes the authenticated stream instance into the real Fanout subscriber', async () => {
    const db = openDatabase(':memory:')
    const peers = seedPeerSecrets(db, ['alice'])
    const fanout = new CapturingFanout()
    const app = buildApp({
      db, store: new MessageStore(db), fanout, presence: new PresenceRegistry(),
      claims: new ClaimStore(db), now: () => new Date(),
    })
    const ac = new AbortController()
    const instance = '01HRK7Y0000000000000000000'
    const res = await app.request('/v1/stream', {
      headers: {
        authorization: `Bearer ${peers.alice!.token}`,
        'x-hangar-instance': instance,
      },
      signal: ac.signal,
    })
    expect(res.status).toBe(200)
    expect(fanout.lastSubscriber?.instance).toBe(instance)
    ac.abort()
  })

  it('drains a message from another handle even when instance strings collide', async () => {
    const db = openDatabase(':memory:')
    const peers = seedPeerSecrets(db, ['alice', 'bob'])
    const store = new MessageStore(db)
    const app = buildApp({
      db, store, fanout: new Fanout(), presence: new PresenceRegistry(),
      claims: new ClaimStore(db), now: () => new Date(),
    })
    const instance = '01HRK7Y0000000000000000000'
    const sent = await app.request('/v1/messages', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${peers.alice!.token}`,
        'content-type': 'application/json',
        'x-hangar-instance': instance,
      },
      body: JSON.stringify({ to: 'bob', kind: 'chat', content: 'collision-safe' }),
    })
    const body = await sent.json() as { id: string }

    const stream = await app.request('/v1/stream', {
      headers: {
        authorization: `Bearer ${peers.bob!.token}`,
        'x-hangar-instance': instance,
      },
    })
    const events = await readNEvents(stream.body!, 1)
    expect(events.some(e => e.includes(body.id))).toBe(true)
  })
})

/**
 * gen-3 F5 residual: when the sender is the only subscriber on the recipient
 * handle, the per-instance exclusion means nobody receives the row. It must
 * still count as delivered — otherwise it stays in the durable buffer and a
 * later cold start on that handle drains the sender its own old message back.
 */
describe('self-excluded delivery accounting', () => {
  let db: Db
  let app: ReturnType<typeof buildApp>
  let fanout: Fanout
  let store: MessageStore
  let tok: string

  beforeEach(() => {
    db = openDatabase(':memory:')
    const peers = seedPeerSecrets(db, ['alice', 'bob'])
    tok = peers.alice!.token
    fanout = new Fanout()
    store = new MessageStore(db)
    app = buildApp({
      db, store, fanout, presence: new PresenceRegistry(),
      claims: new ClaimStore(db), now: () => new Date(),
    })
  })

  const INST = '01HRK7Y0000000000000000000'

  it('marks a self-excluded-only direct message as delivered', async () => {
    // alice's own session is the sole subscriber on the `alice` handle
    fanout.subscribe({ handle: 'alice', team_id: 'hangar', instance: INST, deliver: () => {} })
    const r = await app.request('/v1/messages', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', 'x-hangar-instance': INST },
      body: JSON.stringify({ to: 'alice', kind: 'chat', content: 'to my sibling' }),
    })
    expect(r.status).toBe(201)
    const body = await r.json() as { id: string; delivered_at: string | null }
    expect(body.delivered_at).not.toBeNull()
    // and it must not resurface on a cold-start drain for alice
    expect(store.fetchPendingSince('hangar', 'alice', '').map(e => e.id)).not.toContain(body.id)
  })

  it('does NOT mark delivered when the recipient genuinely has no subscriber', async () => {
    const r = await app.request('/v1/messages', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', 'x-hangar-instance': INST },
      body: JSON.stringify({ to: 'bob', kind: 'chat', content: 'nobody home' }),
    })
    const body = await r.json() as { id: string; delivered_at: string | null }
    expect(body.delivered_at).toBeNull()
    expect(store.fetchPendingSince('hangar', 'bob', '').map(e => e.id)).toContain(body.id)
  })

  it('does not echo a durable self-message to its originating instance', async () => {
    const sent = await app.request('/v1/messages', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tok}`,
        'content-type': 'application/json',
        'x-hangar-instance': INST,
      },
      body: JSON.stringify({ to: 'alice', kind: 'chat', content: 'for sibling' }),
    })
    const body = await sent.json() as { id: string }

    const own = await app.request('/v1/stream', {
      headers: { authorization: `Bearer ${tok}`, 'x-hangar-instance': INST },
    })
    const ownEvents = await readNEvents(own.body!, 1, 100)
    expect(ownEvents.some(e => e.includes(body.id))).toBe(false)
    expect(store.fetchPendingSince('hangar', 'alice', '').map(e => e.id)).toContain(body.id)

    const sibling = await app.request('/v1/stream', {
      headers: {
        authorization: `Bearer ${tok}`,
        'x-hangar-instance': '01HRK7Y0000000000000000001',
      },
    })
    const siblingEvents = await readNEvents(sibling.body!, 1)
    expect(siblingEvents.some(e => e.includes(body.id))).toBe(true)
  })
})

/**
 * An ephemeral message documented a reply path that did not exist: the comment
 * points the receiver at meta.correlation_id instead of in_reply_to (which 400s
 * on an unknown parent, since there is no durable row to reference), the
 * anti-forgery strip removes any correlation_id the sender supplied, and the
 * ephemeral branch generated none. Both routes closed, so a peer that received
 * one could only open a new, thread-less message. Reported first-hand by the
 * aimax395 peer after hitting the 400.
 *
 * The relay is already editing meta on that exact line, and a relay-generated id
 * is authoritative by construction — unlike a sender-supplied one.
 */
describe('ephemeral messages carry a usable reply handle', () => {
  let db: Db
  let app: ReturnType<typeof buildApp>
  let fanout: Fanout
  let tok: string

  beforeEach(() => {
    db = openDatabase(':memory:')
    const peers = seedPeerSecrets(db, ['alice', 'bob'])
    tok = peers.alice!.token
    fanout = new Fanout()
    app = buildApp({
      db, store: new MessageStore(db), fanout, presence: new PresenceRegistry(),
      claims: new ClaimStore(db), now: () => new Date(),
    })
  })

  const INST = '01HRK7Y0000000000000000000'

  it('stamps a correlation_id alongside the ephemeral flag', async () => {
    const got: Envelope[] = []
    fanout.subscribe({ handle: 'bob', team_id: 'hangar', instance: INST, deliver: e => { got.push(e) } })
    const r = await app.request('/v1/messages', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        to: 'bob', kind: 'chat', content: 'hello group',
        to_filter: { instance: INST },
      }),
    })
    expect(r.status).toBe(201)
    expect(got).toHaveLength(1)
    expect(got[0]!.meta['ephemeral']).toBe('1')
    // the whole point: the receiver has something to echo back
    expect(got[0]!.meta['correlation_id']).toBeTruthy()
  })

  it('the correlation_id is relay-generated, so a forged one cannot survive', async () => {
    const got: Envelope[] = []
    fanout.subscribe({ handle: 'bob', team_id: 'hangar', instance: INST, deliver: e => { got.push(e) } })
    await app.request('/v1/messages', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        to: 'bob', kind: 'chat', content: 'hi',
        to_filter: { instance: INST },
        meta: { correlation_id: 'FORGED' },
      }),
    })
    expect(got[0]!.meta['correlation_id']).not.toBe('FORGED')
  })
})
