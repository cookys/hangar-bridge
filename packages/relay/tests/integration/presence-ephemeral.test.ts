import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type Db } from '../../src/db/db.ts'
import { MessageStore } from '../../src/messages/store.ts'
import { Fanout } from '../../src/fanout.ts'
import { PresenceRegistry } from '../../src/presence/registry.ts'
import { ClaimStore } from '../../src/claims/store.ts'
import { buildApp } from '../../src/app.ts'
import { seedPeerSecrets } from './_seed.ts'
import type { Envelope } from '@hangar-bridge/shared'

/**
 * A presence heartbeat is a liveness signal, not a message.
 *
 * Persisting it put 99.3% of the durable buffer (measured 2026-08-31: 8301 rows
 * against 59 substantive ones) into rows nobody ever needs to re-read, which
 * made poll_inbox — the pull mainline for harnesses that render no server
 * notifications — unusable for its actual job of checking for missed traffic.
 *
 * Nothing is lost by dropping the row. The durable buffer's contract is "you
 * will not miss messages while offline", and a heartbeat is not in that
 * contract: a peer coming back online reads current truth from /v1/peers, and
 * a three-day-old "(connected)" tells it nothing. Live subscribers still get
 * the broadcast, which is the only delivery presence ever needed.
 */
describe('presence heartbeats are ephemeral', () => {
  let db: Db
  let app: ReturnType<typeof buildApp>
  let store: MessageStore
  let fanout: Fanout
  let tok: Record<string, string>

  beforeEach(() => {
    db = openDatabase(':memory:')
    const peers = seedPeerSecrets(db, ['alice', 'bob'])
    tok = { alice: peers.alice!.token, bob: peers.bob!.token }
    store = new MessageStore(db)
    fanout = new Fanout()
    app = buildApp({
      db, store, fanout, presence: new PresenceRegistry(),
      claims: new ClaimStore(db), now: () => new Date(),
    })
  })

  const beat = (who: string, summary = '(connected)') =>
    app.request('/v1/presence', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok[who]}`, 'content-type': 'application/json' },
      body: JSON.stringify({ summary }),
    })

  it('leaves no durable row behind', async () => {
    expect((await beat('alice')).status).toBe(200)
    expect(store.fetchInboxSince('hangar', 'bob', '', 100)).toHaveLength(0)
  })

  it('still reaches live subscribers — delivery was never the problem', async () => {
    const got: Envelope[] = []
    fanout.subscribe({ handle: 'bob', team_id: 'hangar', deliver: e => { got.push(e) } })
    await beat('alice', 'working on the relay')
    expect(got).toHaveLength(1)
    expect(got[0]!.kind).toBe('presence_update')
    expect(got[0]!.content).toBe('working on the relay')
  })

  it('a burst of heartbeats cannot bury substantive messages in poll_inbox', async () => {
    // The reported symptom: paging through screens of (connected) to reach real traffic.
    await app.request('/v1/messages', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok.alice}`, 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'bob', kind: 'chat', content: 'the one that matters' }),
    })
    for (let i = 0; i < 40; i++) await beat('alice')

    const page = store.fetchInboxSince('hangar', 'bob', '', 50)
    expect(page).toHaveLength(1)
    expect(page[0]!.content).toBe('the one that matters')
  })

  it('presence still updates the registry — /v1/peers stays the source of truth', async () => {
    await beat('alice', 'busy')
    const res = await app.request('/v1/peers', { headers: { authorization: `Bearer ${tok.bob}` } })
    const peers = await res.json() as Array<{ handle: string; summary: string; online: boolean }>
    const alice = peers.find(p => p.handle === 'alice')
    expect(alice?.summary).toBe('busy')
  })
})
