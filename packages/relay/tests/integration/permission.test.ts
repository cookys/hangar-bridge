import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type Db } from '../../src/db/db.ts'
import { MessageStore } from '../../src/messages/store.ts'
import { Fanout } from '../../src/fanout.ts'
import { PresenceRegistry } from '../../src/presence/registry.ts'
import { buildApp } from '../../src/app.ts'
import { seedPeerSecrets } from './_seed.ts'
import { ClaimStore } from '../../src/claims/store.ts'

function appFor(db: Db) {
  return buildApp({
    db, store: new MessageStore(db), fanout: new Fanout(),
    presence: new PresenceRegistry(), claims: new ClaimStore(db), now: () => new Date(),
  })
}

describe('POST /v1/permission/respond', () => {
  let db: Db
  let app: ReturnType<typeof buildApp>
  let t: { a: string; b: string }
  beforeEach(() => {
    db = openDatabase(':memory:')
    const peers = seedPeerSecrets(db, ['alice', 'bob'])
    t = { a: peers.alice!.token, b: peers.bob!.token }
    app = appFor(db)
  })

  async function post(path: string, token: string, body: unknown) {
    return app.request(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
  }

  it('404 when no matching open permission_request', async () => {
    const res = await post('/v1/permission/respond', t.b,
      { request_id: 'abcde', verdict: 'allow' })
    expect(res.status).toBe(404)
  })

  it('synthesizes verdict envelope when matching request exists', async () => {
    await post('/v1/messages', t.a, {
      to: 'bob', kind: 'permission_request', content: 'delete build output',
      meta: { request_id: 'abcde', tool_name: 'Bash', input_preview: 'rm -rf dist/',
              requester: 'alice', expires_at: new Date(Date.now()+60_000).toISOString() }
    })
    const res = await post('/v1/permission/respond', t.b,
      { request_id: 'abcde', verdict: 'allow', reason: 'looked at diff' })
    expect(res.status).toBe(200)
    const verdict = db.prepare(
      "SELECT * FROM message WHERE kind='permission_verdict'"
    ).get() as any
    expect(verdict.to_handle).toBe('alice')
    expect(verdict.from_handle).toBe('bob')
    expect(JSON.parse(verdict.meta_json).behavior).toBe('allow')
    expect(JSON.parse(verdict.meta_json).reason).toBe('looked at diff')
  })

  it('rejects expired request', async () => {
    await post('/v1/messages', t.a, {
      to: 'bob', kind: 'permission_request', content: 'x',
      meta: { request_id: 'abcde', tool_name: 'Bash', input_preview: 'x',
              requester: 'alice', expires_at: new Date(Date.now()-1000).toISOString() }
    })
    const res = await post('/v1/permission/respond', t.b,
      { request_id: 'abcde', verdict: 'allow' })
    expect(res.status).toBe(410)
  })
})
