import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type Db } from '../../src/db/db.ts'
import { MessageStore } from '../../src/messages/store.ts'
import { Fanout } from '../../src/fanout.ts'
import { PresenceRegistry } from '../../src/presence/registry.ts'
import { buildApp } from '../../src/app.ts'
import { seedPeerSecrets } from './_seed.ts'
import { ClaimStore } from '../../src/claims/store.ts'

/**
 * P2 §2.4 — GET /v1/messages, the durable PULL path.
 *
 * MCP server notifications are rendered by exactly one client (Claude Code);
 * every other harness in the fleet sees nothing pushed at all. A read-only,
 * cursored peek at the same durable buffer is the ONE correctness path that
 * works everywhere — and it is also how a busy Claude turn drains its inbox
 * without waiting for the next idle moment.
 *
 * Read-only is the load-bearing property: this endpoint must never stamp
 * delivered_at, or a peek would consume the cold-start backlog the SSE
 * connection depends on.
 */
describe('GET /v1/messages (poll_inbox)', () => {
  let db: Db
  let app: ReturnType<typeof buildApp>
  let onApp: ReturnType<typeof buildApp>
  let store: MessageStore
  let tok: Record<string, string>

  beforeEach(() => {
    db = openDatabase(':memory:')
    const peers = seedPeerSecrets(db, ['alice', 'bob', 'carol'])
    tok = { alice: peers.alice!.token, bob: peers.bob!.token, carol: peers.carol!.token }
    store = new MessageStore(db)
    const deps = {
      db, store, fanout: new Fanout(), presence: new PresenceRegistry(),
      claims: new ClaimStore(db), now: () => new Date(),
    }
    app = buildApp(deps)
    onApp = buildApp({ ...deps, addressRules: 'on' })
  })

  const get = (who: string, qs = '', headers: Record<string, string> = {}) =>
    app.request(`/v1/messages${qs}`, { headers: { authorization: `Bearer ${tok[who]}`, ...headers } })

  const body = async (res: Response): Promise<any> => await res.json()

  it('401 without auth', async () => {
    expect((await app.request('/v1/messages')).status).toBe(401)
  })

  it('returns messages addressed to the caller, oldest first', async () => {
    for (const n of ['1', '2', '3']) {
      store.insert('hangar', 'alice', { to: 'bob', kind: 'chat', content: n })
    }
    const j = await body(await get('bob'))
    expect(j.messages.map((m: any) => m.content)).toEqual(['1', '2', '3'])
    expect(j.next_cursor).toBe(j.messages[2].id)
  })

  it('does NOT return messages addressed to somebody else', async () => {
    store.insert('hangar', 'alice', { to: 'carol', kind: 'chat', content: 'private' })
    const j = await body(await get('bob'))
    expect(j.messages).toHaveLength(0)
    expect(j.next_cursor).toBeNull()
  })

  it('returns @team messages from OTHERS but not the caller\'s own broadcast', async () => {
    store.insert('hangar', 'alice', { to: '@team', kind: 'chat', content: 'from alice' })
    store.insert('hangar', 'bob', { to: '@team', kind: 'chat', content: 'from bob' })
    const j = await body(await get('bob'))
    expect(j.messages.map((m: any) => m.content)).toEqual(['from alice'])
  })

  it('honors the since cursor (strictly greater than)', async () => {
    const a = store.insert('hangar', 'alice', { to: 'bob', kind: 'chat', content: '1' })
    const b = store.insert('hangar', 'alice', { to: 'bob', kind: 'chat', content: '2' })
    const j = await body(await get('bob', `?since=${a.id}`))
    expect(j.messages.map((m: any) => m.content)).toEqual(['2'])
    expect(j.next_cursor).toBe(b.id)
  })

  it('rejects a malformed since cursor', async () => {
    expect((await get('bob', '?since=nonsense')).status).toBe(400)
  })

  it('honors limit and reports a cursor that resumes exactly where it stopped', async () => {
    for (const n of ['1', '2', '3', '4']) {
      store.insert('hangar', 'alice', { to: 'bob', kind: 'chat', content: n })
    }
    const first = await body(await get('bob', '?limit=2'))
    expect(first.messages.map((m: any) => m.content)).toEqual(['1', '2'])
    const second = await body(await get('bob', `?since=${first.next_cursor}&limit=2`))
    expect(second.messages.map((m: any) => m.content)).toEqual(['3', '4'])
  })

  it('rejects a non-numeric or out-of-range limit', async () => {
    expect((await get('bob', '?limit=0')).status).toBe(400)
    expect((await get('bob', '?limit=abc')).status).toBe(400)
    expect((await get('bob', '?limit=100000')).status).toBe(400)
  })

  it('NEVER marks a peeked message delivered', async () => {
    const m = store.insert('hangar', 'alice', { to: 'bob', kind: 'chat', content: 'x' })
    await get('bob')
    const row = db.prepare('SELECT delivered_at FROM message WHERE id=?').get(m.id) as any
    expect(row.delivered_at).toBeNull()
  })

  it('is idempotent — polling twice returns the same rows', async () => {
    store.insert('hangar', 'alice', { to: 'bob', kind: 'chat', content: 'x' })
    const one = await body(await get('bob'))
    const two = await body(await get('bob'))
    expect(two.messages.map((m: any) => m.id)).toEqual(one.messages.map((m: any) => m.id))
  })

  it('applies the subject ACL — a non-owner never sees a subjected message', async () => {
    // bob owns nothing (seed grants an empty owned set), so a subjected row is
    // fail-closed for him exactly as it is on the SSE gate.
    db.prepare(
      "INSERT INTO message(id,v,team_id,from_handle,to_handle,subject,in_reply_to,thread_root,kind,content,meta_json,sent_at,delivered_at) " +
      "VALUES ('msg_01HRK7Y000000000000000000A',2,'hangar','alice','bob','mple2.cmd',NULL,NULL,'chat','gated','{}','2026-01-01T00:00:00.000Z',NULL)"
    ).run()
    const j = await body(await get('bob'))
    expect(j.messages).toHaveLength(0)
  })

  // §4: poll_inbox grants `(msg_id, handle, poller instance)` before
  // responding, same as every other presentation path.
  describe('§4 / item 7 — instance-scoped grant on poll', () => {
    const INST = '01HRK7Y0000000000000000000'

    it('writes a grant for the poller instance before responding', async () => {
      const sent = await app.request('/v1/messages', {
        method: 'POST',
        headers: { authorization: `Bearer ${tok.alice}`, 'content-type': 'application/json' },
        body: JSON.stringify({ to: 'bob', kind: 'chat', content: 'hi' }),
      })
      const sentBody = await sent.json() as { id: string }
      expect(store.hasGrant(sentBody.id, 'bob', INST)).toBe(false)

      const res = await get('bob', '', { 'x-hangar-instance': INST })
      expect(res.status).toBe(200)
      expect(store.hasGrant(sentBody.id, 'bob', INST)).toBe(true)
    })

    it('flag off + no instance header: presents the message, tagged attribution_status: unverifiable', async () => {
      store.insert('hangar', 'alice', { to: 'bob', kind: 'chat', content: 'x' })
      const j = await body(await get('bob'))
      expect(j.messages).toHaveLength(1)
      expect(j.messages[0].meta.attribution_status).toBe('unverifiable')
    })

    it('flag on + no instance header: 400 instance_required', async () => {
      const res = await onApp.request('/v1/messages', { headers: { authorization: `Bearer ${tok.bob}` } })
      expect(res.status).toBe(400)
      const j = await res.json() as { error: string; retryable: boolean }
      expect(j.error).toBe('instance_required')
      expect(j.retryable).toBe(false)
    })

    it('flag on + instance header present: 200, no refusal', async () => {
      const res = await onApp.request('/v1/messages', {
        headers: { authorization: `Bearer ${tok.bob}`, 'x-hangar-instance': INST },
      })
      expect(res.status).toBe(200)
    })
  })
})
