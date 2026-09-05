import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type Db } from '../../src/db/db.ts'
import { MessageStore } from '../../src/messages/store.ts'
import { Fanout } from '../../src/fanout.ts'
import { PresenceRegistry } from '../../src/presence/registry.ts'
import { buildApp } from '../../src/app.ts'
import { seedPeerSecrets } from './_seed.ts'
import { ClaimStore } from '../../src/claims/store.ts'

describe('POST /v1/messages', () => {
  let db: Db
  let store: MessageStore
  let app: ReturnType<typeof buildApp>
  let aliceToken: string
  beforeEach(() => {
    db = openDatabase(':memory:')
    const peers = seedPeerSecrets(db, ['alice', 'bob'])
    aliceToken = peers.alice!.token
    store = new MessageStore(db)
    app = buildApp({ db, store, fanout: new Fanout(), presence: new PresenceRegistry(), claims: new ClaimStore(db), now: () => new Date() })
  })

  async function post(body: unknown, headers: Record<string, string> = {}) {
    return app.request('/v1/messages', {
      method: 'POST',
      headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    })
  }

  // Layer 2 (sender-stamp anti-spoof): the `from` field on the response
  // envelope must match the bearer-authenticated peer, regardless of any
  // client-supplied `from` field.
  it('201 + full envelope on valid chat; relay stamps from (Layer 2)', async () => {
    const res = await post({ to: 'bob', kind: 'chat', content: 'hi' })
    expect(res.status).toBe(201)
    const e = await res.json() as any
    expect(e.id).toMatch(/^msg_/)
    expect(e.from).toBe('alice')
  })

  it('Layer 2 — client cannot spoof `from`: schema rejects client-supplied from with 400', async () => {
    // OutboundMessageSchema is z.strict() so any client-supplied `from` field
    // is structurally rejected before the request reaches the store. Combined
    // with `store.insert(team, c.get('peer').handle, ...)` this guarantees the
    // envelope's `from` always equals the bearer-authenticated peer.
    const res = await post({ to: 'bob', from: 'mallory', kind: 'chat', content: 'pwn' })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('invalid_body')
  })

  it('400 on unknown kind', async () => {
    const res = await post({ to: 'bob', kind: 'surprise', content: 'x' })
    expect(res.status).toBe(400)
  })

  it('400 on unknown recipient', async () => {
    const res = await post({ to: 'mallory', kind: 'chat', content: 'x' })
    expect(res.status).toBe(400)
  })

  it('401 without bearer', async () => {
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'bob', kind: 'chat', content: 'x' })
    })
    expect(res.status).toBe(401)
  })

  it('Idempotency-Key: same key returns same envelope, stores once', async () => {
    const key = 'idem-1'
    const a = await (await post({ to: 'bob', kind: 'chat', content: 'x' }, { 'idempotency-key': key })).json() as any
    const b = await (await post({ to: 'bob', kind: 'chat', content: 'x' }, { 'idempotency-key': key })).json() as any
    expect(a.id).toBe(b.id)
    const count = db.prepare("SELECT COUNT(*) AS c FROM message").get() as { c: number }
    expect(count.c).toBe(1)
  })

  it('413 or 400 on content over MAX_CONTENT_BYTES', async () => {
    const big = 'a'.repeat(70_000)
    const res = await post({ to: 'bob', kind: 'chat', content: big })
    expect([400, 413]).toContain(res.status)
  })

  // §8.1 return-selector grammar (item 3): parsed and syntax-checked at the
  // send chokepoint, regardless of the addressRules flag.
  describe('x-hangar-return-selector (§8.1)', () => {
    it('400 invalid_return_selector on a malformed header', async () => {
      const res = await post(
        { to: 'bob', kind: 'chat', content: 'x' },
        { 'x-hangar-return-selector': 'not-a-selector' }
      )
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string; retryable: boolean }
      expect(body.error).toBe('invalid_return_selector')
      expect(body.retryable).toBe(false)
    })

    it('accepts the literal ~none', async () => {
      const res = await post(
        { to: 'bob', kind: 'chat', content: 'x' },
        { 'x-hangar-return-selector': '~none' }
      )
      expect(res.status).toBe(201)
    })

    it('accepts a well-formed <name>@<ULID>', async () => {
      const res = await post(
        { to: 'bob', kind: 'chat', content: 'x' },
        { 'x-hangar-return-selector': 'agy@01HRK7Y0000000000000000000' }
      )
      expect(res.status).toBe(201)
    })

    it('absent header is accepted (no selector)', async () => {
      const res = await post({ to: 'bob', kind: 'chat', content: 'x' })
      expect(res.status).toBe(201)
    })
  })

  // §3.2 write order: route + one grant per snapshot entry + the message row,
  // all inside one transaction, BEFORE fanout ever writes a live SSE event.
  describe('§3.2 write order (route + grants before delivery)', () => {
    it('a directed task_dispatch matching nobody leaves no route (today: no row either)', async () => {
      const res = await post({
        to: 'bob', kind: 'task_dispatch', content: 'run',
        to_filter: { instance: '01HRK7Y0000000000000000099' },
      }, { 'x-hangar-instance': '01HRK7Y0000000000000000000' })
      expect(res.status).toBe(201)
      const body = await res.json() as { id: string; matched: number }
      expect(body.matched).toBe(0)
      expect(store.getRoute(body.id)).toBeNull()
    })

    it('an ordinary chat to a bare handle gets a route + a grant for the (only) live subscriber', async () => {
      const fanout = new Fanout()
      fanout.subscribe({ handle: 'bob', team_id: 'hangar', instance: 'inst-bob', deliver: () => {} })
      const app2 = buildApp({
        db, store, fanout, presence: new PresenceRegistry(), claims: new ClaimStore(db), now: () => new Date(),
      })
      const res = await app2.request('/v1/messages', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json',
          'x-hangar-instance': '01HRK7Y0000000000000000001',
        },
        body: JSON.stringify({ to: 'bob', kind: 'chat', content: 'hi' }),
      })
      expect(res.status).toBe(201)
      const body = await res.json() as { id: string }
      const route = store.getRoute(body.id)
      expect(route).not.toBeNull()
      expect(route!.from_handle).toBe('alice')
      expect(route!.sender_instance).toBe('01HRK7Y0000000000000000001')
      expect(store.hasGrant(body.id, 'bob', 'inst-bob')).toBe(true)
    })

    it('protocol kinds (task_result etc.) get no route, message row unaffected', async () => {
      const dispatch = await post(
        { to: 'bob', kind: 'task_dispatch', content: 'run' },
        { 'x-hangar-instance': '01HRK7Y0000000000000000000' }
      )
      const dispatchBody = await dispatch.json() as { id: string }
      const res = await app.request('/v1/messages', {
        method: 'POST',
        headers: { authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          to: 'bob', kind: 'task_result', content: 'done', in_reply_to: dispatchBody.id,
        }),
      })
      expect(res.status).toBe(201)
      const body = await res.json() as { id: string }
      expect(store.getRoute(body.id)).toBeNull()
      const row = db.prepare('SELECT id FROM message WHERE id=?').get(body.id)
      expect(row).toBeTruthy()
    })

    it('route + grant are already committed when a live subscriber\'s deliver callback fires', async () => {
      const fanout = new Fanout()
      let sawRouteAndGrant = false
      let deliveredId: string | null = null
      fanout.subscribe({
        handle: 'bob', team_id: 'hangar', instance: 'inst-bob',
        deliver: (e) => {
          deliveredId = e.id
          const route = store.getRoute(e.id)
          sawRouteAndGrant = route !== null && store.hasGrant(e.id, 'bob', 'inst-bob')
        },
      })
      const app2 = buildApp({
        db, store, fanout, presence: new PresenceRegistry(), claims: new ClaimStore(db), now: () => new Date(),
      })
      const res = await app2.request('/v1/messages', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json',
          'x-hangar-instance': '01HRK7Y0000000000000000001',
        },
        body: JSON.stringify({ to: 'bob', kind: 'chat', content: 'hi' }),
      })
      expect(res.status).toBe(201)
      expect(deliveredId).not.toBeNull()
      expect(sawRouteAndGrant).toBe(true)
    })
  })

  // §11 audience report must appear on the to_filter (directed) response too,
  // not only the plain-branch response — including the idempotency-cached replay.
  describe('§11 audience report on the to_filter response', () => {
    it('a directed task_dispatch response carries live[]/durable/matched, and the idempotent replay matches', async () => {
      const fanout = new Fanout()
      fanout.subscribe({ handle: 'bob', team_id: 'hangar', instance: '01HRK7Y0000000000000000099', deliver: () => {} })
      const app2 = buildApp({
        db, store, fanout, presence: new PresenceRegistry(), claims: new ClaimStore(db), now: () => new Date(),
      })
      const key = 'idem-audience-1'
      const headers = {
        authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json',
        'x-hangar-instance': '01HRK7Y0000000000000000000', 'idempotency-key': key,
      }
      const body = {
        to: 'bob', kind: 'task_dispatch', content: 'run',
        to_filter: { instance: '01HRK7Y0000000000000000099' },
      }
      const first = await app2.request('/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) })
      expect(first.status).toBe(201)
      const firstBody = await first.json() as { live: string[]; durable: string[]; matched: number }
      expect(firstBody.live).toEqual(['bob#01HRK7Y0000000000000000099'])
      expect(firstBody.durable).toEqual(['bob'])
      expect(firstBody.matched).toBe(1)

      const second = await app2.request('/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) })
      expect(second.status).toBe(201)
      const secondBody = await second.json() as { live: string[]; durable: string[]; matched: number }
      expect(secondBody).toEqual(firstBody)
    })
  })
})
