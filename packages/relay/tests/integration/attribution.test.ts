import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type Db } from '../../src/db/db.ts'
import { MessageStore } from '../../src/messages/store.ts'
import { Fanout } from '../../src/fanout.ts'
import { PresenceRegistry } from '../../src/presence/registry.ts'
import { ClaimStore } from '../../src/claims/store.ts'
import { buildApp } from '../../src/app.ts'
import { seedPeerSecrets } from './_seed.ts'

/**
 * P4'a — attribution is RELAY-STAMPED, never sender-declared.
 *
 * The 8/22 incident was a thread of mutually-denying messages behind one
 * handle. The fix for a forged-denial incident must not itself be forgeable,
 * so `meta.instance` comes from the authenticated connection's
 * x-hangar-instance header and any client-supplied value is stripped at this
 * chokepoint — the same treatment RESERVED_META_KEYS already gets.
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
})
