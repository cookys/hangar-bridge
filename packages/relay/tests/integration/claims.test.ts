import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type Db } from '../../src/db/db.ts'
import { MessageStore } from '../../src/messages/store.ts'
import { Fanout } from '../../src/fanout.ts'
import { PresenceRegistry } from '../../src/presence/registry.ts'
import { ClaimStore } from '../../src/claims/store.ts'
import { buildApp } from '../../src/app.ts'
import { seedPeerSecrets } from './_seed.ts'

describe('/v1/claim', () => {
  let db: Db
  let app: ReturnType<typeof buildApp>
  let clock: number
  let aliceToken: string
  let bobToken: string
  beforeEach(() => {
    db = openDatabase(':memory:')
    const peers = seedPeerSecrets(db, ['alice', 'bob'])
    aliceToken = peers.alice!.token
    bobToken = peers.bob!.token
    clock = Date.parse('2026-01-01T00:00:00Z')
    const now = () => new Date(clock)
    app = buildApp({
      db, store: new MessageStore(db), fanout: new Fanout(),
      presence: new PresenceRegistry(), claims: new ClaimStore(db, now), now,
    })
  })

  const claim = (token: string, body: unknown) => app.request('/v1/claim', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const list = (token: string) => app.request('/v1/claims', {
    headers: { authorization: `Bearer ${token}` },
  })
  // Canonical release path: POST /v1/claim/release (body on POST is universally sent).
  const release = (token: string, body: unknown) => app.request('/v1/claim/release', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const releaseViaDelete = (token: string, body: unknown) => app.request('/v1/claim', {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  it('201 acquires; GET /v1/claims lists it', async () => {
    const res = await claim(aliceToken, { key: 'repo:x:configs/a.toml', ttl_seconds: 3600, note: 'editing' })
    expect(res.status).toBe(201)
    const body = await res.json() as any
    expect(body.renewed).toBe(false)
    expect(body.claim.owner_handle).toBe('alice')

    const l = await (await list(bobToken)).json() as any[]
    expect(l.map(c => c.claim_key)).toEqual(['repo:x:configs/a.toml'])
  })

  it('409 when another live owner holds the key', async () => {
    await claim(aliceToken, { key: 'k', ttl_seconds: 3600 })
    const res = await claim(bobToken, { key: 'k', ttl_seconds: 3600 })
    expect(res.status).toBe(409)
    const body = await res.json() as any
    expect(body.error).toBe('claim_conflict')
    expect(body.owner).toBe('alice')
  })

  it('same owner renew returns 201 renewed=true', async () => {
    await claim(aliceToken, { key: 'k', ttl_seconds: 3600 })
    const res = await claim(aliceToken, { key: 'k', ttl_seconds: 3600 })
    expect(res.status).toBe(201)
    expect((await res.json() as any).renewed).toBe(true)
  })

  it('expired claim is re-acquirable by another peer', async () => {
    await claim(aliceToken, { key: 'k', ttl_seconds: 1 })
    clock += 2000 // past 1s ttl
    const res = await claim(bobToken, { key: 'k', ttl_seconds: 60 })
    expect(res.status).toBe(201)
    expect((await res.json() as any).claim.owner_handle).toBe('bob')
  })

  it('owner releases; non-owner cannot', async () => {
    await claim(aliceToken, { key: 'k', ttl_seconds: 3600 })
    const bad = await release(bobToken, { key: 'k' })
    expect(bad.status).toBe(409)
    const ok = await release(aliceToken, { key: 'k' })
    expect(ok.status).toBe(200)
    expect((await ok.json() as any).released).toBe(true)
    expect((await (await list(aliceToken)).json() as any[]).length).toBe(0)
  })

  it('DELETE /v1/claim still works as a compat release path', async () => {
    await claim(aliceToken, { key: 'k', ttl_seconds: 3600 })
    const ok = await releaseViaDelete(aliceToken, { key: 'k' })
    expect(ok.status).toBe(200)
    expect((await ok.json() as any).released).toBe(true)
  })

  it('list hides expired claims', async () => {
    await claim(aliceToken, { key: 'short', ttl_seconds: 1 })
    await claim(aliceToken, { key: 'long', ttl_seconds: 3600 })
    clock += 2000
    const l = await (await list(aliceToken)).json() as any[]
    expect(l.map(c => c.claim_key)).toEqual(['long'])
  })

  it('400 on invalid key / ttl out of range', async () => {
    expect((await claim(aliceToken, { key: 'bad key!', ttl_seconds: 60 })).status).toBe(400)
    expect((await claim(aliceToken, { key: 'ok', ttl_seconds: 0 })).status).toBe(400)
    expect((await claim(aliceToken, { key: 'ok', ttl_seconds: 999999 })).status).toBe(400)
  })

  it('ttl_seconds defaults when omitted', async () => {
    const res = await claim(aliceToken, { key: 'k' })
    expect(res.status).toBe(201)
    const body = await res.json() as any
    // default 3600s from clock
    expect(body.claim.expires_at).toBe(new Date(clock + 3_600_000).toISOString())
  })

  it('401 without bearer', async () => {
    const res = await app.request('/v1/claims')
    expect(res.status).toBe(401)
  })
})
