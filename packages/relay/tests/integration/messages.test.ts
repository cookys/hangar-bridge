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
  let app: ReturnType<typeof buildApp>
  let aliceToken: string
  beforeEach(() => {
    db = openDatabase(':memory:')
    const peers = seedPeerSecrets(db, ['alice', 'bob'])
    aliceToken = peers.alice!.token
    app = buildApp({ db, store: new MessageStore(db), fanout: new Fanout(), presence: new PresenceRegistry(), claims: new ClaimStore(db), now: () => new Date() })
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
})
