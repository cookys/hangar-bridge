import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type Db } from '../../src/db/db.ts'
import { MessageStore } from '../../src/messages/store.ts'
import { Fanout } from '../../src/fanout.ts'
import { PresenceRegistry } from '../../src/presence/registry.ts'
import { buildApp } from '../../src/app.ts'
import { seedPeerSecrets } from './_seed.ts'
import { ClaimStore } from '../../src/claims/store.ts'

describe('presence + peers', () => {
  let db: Db
  let app: ReturnType<typeof buildApp>
  let token: string
  beforeEach(() => {
    db = openDatabase(':memory:')
    const peers = seedPeerSecrets(db, ['alice', 'bob'])
    token = peers.alice!.token
    app = buildApp({
      db,
      store: new MessageStore(db),
      fanout: new Fanout(),
      presence: new PresenceRegistry(), claims: new ClaimStore(db),
      now: () => new Date(),
    })
  })

  it('POST /v1/presence stores summary, GET /v1/peers reflects it', async () => {
    await app.request('/v1/presence', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ summary: 'grinding auth', branch: 'auth-refactor' })
    })
    const res = await app.request('/v1/peers', { headers: { authorization: `Bearer ${token}` } })
    expect(res.status).toBe(200)
    const list = await res.json() as any[]
    const alice = list.find(p => p.handle === 'alice')
    expect(alice.online).toBe(true)
    expect(alice.summary).toBe('grinding auth')
    expect(alice.sessions[0].branch).toBe('auth-refactor')
  })
})
