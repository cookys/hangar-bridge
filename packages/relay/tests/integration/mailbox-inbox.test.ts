import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type Db } from '../../src/db/db.ts'
import { MessageStore } from '../../src/messages/store.ts'
import { Fanout } from '../../src/fanout.ts'
import { PresenceRegistry } from '../../src/presence/registry.ts'
import { buildApp } from '../../src/app.ts'
import { seedPeerSecrets } from './_seed.ts'
import { ClaimStore } from '../../src/claims/store.ts'
import { newMessageId } from '@hangar-bridge/shared'

/**
 * REPLY_ROUTING_SPEC.md §8.2 — GET /v1/inbox, the operator mailbox pull path.
 * Read-only: never stamps delivered_at, never deletes; the client cursor
 * (`since`/`last_id`) is the only progress marker.
 */
describe('GET /v1/inbox (REPLY_ROUTING_SPEC.md §8.2)', () => {
  let db: Db
  let store: MessageStore
  let app: ReturnType<typeof buildApp>
  let tok: Record<string, string>

  beforeEach(() => {
    db = openDatabase(':memory:')
    const peers = seedPeerSecrets(db, ['alice', 'bob'])
    tok = { alice: peers.alice!.token, bob: peers.bob!.token }
    store = new MessageStore(db)
    const deps = {
      db, store, fanout: new Fanout(), presence: new PresenceRegistry(),
      claims: new ClaimStore(db), now: () => new Date(),
    }
    app = buildApp(deps)
  })

  function seedMailboxRow(handle: string, sentAt: string) {
    const id = newMessageId()
    db.prepare(`
      INSERT INTO message(id,v,team_id,from_handle,to_handle,thread_root,kind,content,meta_json,sent_at,delivered_at)
      VALUES (?,2,'hangar','bob',?,?,'chat','hi','{}',?,NULL)
    `).run(id, `@mailbox:${handle}`, id, sentAt)
    return id
  }

  async function getInbox(who: string, qs = '') {
    return app.request(`/v1/inbox${qs}`, { headers: { authorization: `Bearer ${tok[who]}` } })
  }

  it('returns only this bearer\'s own mailbox rows, ascending by id', async () => {
    const a1 = seedMailboxRow('alice', '2026-09-01T00:00:00.000Z')
    const a2 = seedMailboxRow('alice', '2026-09-01T00:00:01.000Z')
    seedMailboxRow('bob', '2026-09-01T00:00:02.000Z') // a different handle's own mailbox row
    const res = await getInbox('alice')
    expect(res.status).toBe(200)
    const body = await res.json() as { messages: Array<{ id: string }>; last_id: string | null; has_more: boolean }
    expect(body.messages.map(m => m.id)).toEqual([a1, a2])
    expect(body.last_id).toBe(a2)
    expect(body.has_more).toBe(false)
  })

  it('empty mailbox: last_id is null, has_more is false', async () => {
    const res = await getInbox('alice')
    expect(res.status).toBe(200)
    const body = await res.json() as { messages: unknown[]; last_id: string | null; has_more: boolean }
    expect(body.messages).toEqual([])
    expect(body.last_id).toBeNull()
    expect(body.has_more).toBe(false)
  })

  it('paginates with since + limit; has_more reflects a real look-ahead', async () => {
    const ids = [0, 1, 2].map(i => seedMailboxRow('alice', `2026-09-01T00:00:0${i}.000Z`))
    const page1 = await (await getInbox('alice', '?limit=2')).json() as { messages: Array<{ id: string }>; last_id: string; has_more: boolean }
    expect(page1.messages.map(m => m.id)).toEqual([ids[0], ids[1]])
    expect(page1.has_more).toBe(true)
    expect(page1.last_id).toBe(ids[1])

    const page2 = await (await getInbox('alice', `?since=${page1.last_id}&limit=2`)).json() as { messages: Array<{ id: string }>; last_id: string; has_more: boolean }
    expect(page2.messages.map(m => m.id)).toEqual([ids[2]])
    expect(page2.has_more).toBe(false)
  })

  it('never stamps delivered_at and is idempotent (peek twice, same result)', async () => {
    const id = seedMailboxRow('alice', '2026-09-01T00:00:00.000Z')
    await getInbox('alice')
    const row = db.prepare('SELECT delivered_at FROM message WHERE id=?').get(id) as { delivered_at: string | null }
    expect(row.delivered_at).toBeNull()
    const again = await (await getInbox('alice')).json() as { messages: Array<{ id: string }> }
    expect(again.messages.map(m => m.id)).toEqual([id])
  })

  it('rejects an invalid since / out-of-range limit', async () => {
    expect((await getInbox('alice', '?since=not-a-msg-id')).status).toBe(400)
    expect((await getInbox('alice', '?limit=0')).status).toBe(400)
    expect((await getInbox('alice', '?limit=501')).status).toBe(400)
  })
})
