import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type Db } from '../../src/db/db.ts'
import { MessageStore } from '../../src/messages/store.ts'
import { Fanout } from '../../src/fanout.ts'
import { PresenceRegistry } from '../../src/presence/registry.ts'
import { buildApp } from '../../src/app.ts'
import { seedPeerSecrets } from './_seed.ts'
import { ClaimStore } from '../../src/claims/store.ts'
import { newMessageId, newInstanceId } from '@hangar-bridge/shared'

/**
 * REPLY_ROUTING_SPEC.md §8.1 "Grant finalisation" — POST /v1/grants/finalize.
 * The courier calls this under its own bearer + instance, right before
 * pasting into a pane, to replace the blank grant the send transaction gave
 * it with a selector-bearing one (or widen it to a further pane).
 */
describe('POST /v1/grants/finalize (REPLY_ROUTING_SPEC.md §8.1)', () => {
  let db: Db
  let store: MessageStore
  let app: ReturnType<typeof buildApp>
  let tok: Record<string, string>
  const COURIER_INSTANCE = newInstanceId()

  beforeEach(() => {
    db = openDatabase(':memory:')
    const peers = seedPeerSecrets(db, ['alice', 'courier'])
    tok = { alice: peers.alice!.token, courier: peers.courier!.token }
    store = new MessageStore(db)
    const deps = {
      db, store, fanout: new Fanout(), presence: new PresenceRegistry(),
      claims: new ClaimStore(db), now: () => new Date(),
    }
    app = buildApp(deps)
  })

  function seedRouteWithBlankGrant(msgId: string) {
    store.insertRoute({
      msg_id: msgId, team_id: 'hangar', from_handle: 'alice', sender_instance: newInstanceId(),
      to_handle: 'courier', thread_root: msgId, created_at: new Date().toISOString(),
    })
    store.insertGrants(msgId, [{ handle: 'courier', instance: COURIER_INSTANCE, selector: '' }])
  }

  async function finalize(selector: string, msgId: string, opts: { instance?: string | null } = {}) {
    const headers: Record<string, string> = { authorization: `Bearer ${tok.courier}`, 'content-type': 'application/json' }
    if (opts.instance !== null) headers['x-hangar-instance'] = opts.instance ?? COURIER_INSTANCE
    return app.request('/v1/grants/finalize', {
      method: 'POST', headers, body: JSON.stringify({ msg_id: msgId, selector }),
    })
  }

  it('blank -> replaced: the first finalise for a pane replaces the blank grant', async () => {
    const msgId = newMessageId()
    seedRouteWithBlankGrant(msgId)
    const selector = `paneA@${newInstanceId()}`
    const res = await finalize(selector, msgId)
    expect(res.status).toBe(200)
    const body = await res.json() as { msg_id: string; selector: string; outcome: string }
    expect(body).toEqual({ msg_id: msgId, selector, outcome: 'replaced' })
    expect(store.hasGrant(msgId, 'courier', COURIER_INSTANCE, '')).toBe(false)
    expect(store.hasGrant(msgId, 'courier', COURIER_INSTANCE, selector)).toBe(true)
  })

  it('a further selector -> inserted: widens alongside an existing non-blank grant', async () => {
    const msgId = newMessageId()
    seedRouteWithBlankGrant(msgId)
    const s1 = `paneA@${newInstanceId()}`
    const s2 = `paneB@${newInstanceId()}`
    await finalize(s1, msgId)
    const res = await finalize(s2, msgId)
    expect(res.status).toBe(200)
    const body = await res.json() as { outcome: string }
    expect(body.outcome).toBe('inserted')
    expect(store.hasGrant(msgId, 'courier', COURIER_INSTANCE, s1)).toBe(true)
    expect(store.hasGrant(msgId, 'courier', COURIER_INSTANCE, s2)).toBe(true)
  })

  it('an exact selector already granted -> exists (no-op)', async () => {
    const msgId = newMessageId()
    seedRouteWithBlankGrant(msgId)
    const selector = `paneA@${newInstanceId()}`
    await finalize(selector, msgId)
    const res = await finalize(selector, msgId)
    expect(res.status).toBe(200)
    const body = await res.json() as { outcome: string }
    expect(body.outcome).toBe('exists')
  })

  it('neither a blank nor a non-blank grant exists -> 404 grant_not_found', async () => {
    const msgId = newMessageId()
    // No route/grant seeded at all for this msg_id.
    const res = await finalize(`paneA@${newInstanceId()}`, msgId)
    expect(res.status).toBe(404)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('grant_not_found')
  })

  it('rejects a malformed selector (not <name>@<ULID>)', async () => {
    const msgId = newMessageId()
    seedRouteWithBlankGrant(msgId)
    const res = await finalize('not-a-valid-selector', msgId)
    expect(res.status).toBe(400)
  })

  it('requires x-hangar-instance', async () => {
    const msgId = newMessageId()
    seedRouteWithBlankGrant(msgId)
    const res = await finalize(`paneA@${newInstanceId()}`, msgId, { instance: null })
    expect(res.status).toBe(400)
  })
})
