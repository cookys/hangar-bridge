import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type Db } from '../../src/db/db.ts'
import { MessageStore } from '../../src/messages/store.ts'
import { Fanout } from '../../src/fanout.ts'
import { PresenceRegistry } from '../../src/presence/registry.ts'
import { buildApp } from '../../src/app.ts'
import { seedPeerSecrets } from './_seed.ts'
import { ClaimStore } from '../../src/claims/store.ts'

const INST_A = '01HRK7Y0000000000000000000'
const INST_B = '01HRK7Y0000000000000000001'

/**
 * REPLY_ROUTING_SPEC.md §6 address rules — flag-gated refusals (§6.1-6.3),
 * §7 thread continuation (NOT flag-controlled), and §6.5 reserved addresses
 * (NOT flag-controlled, already enforced by the shared schema).
 */
describe('address rules (REPLY_ROUTING_SPEC.md §6, §7)', () => {
  let db: Db
  let store: MessageStore
  let fanout: Fanout
  let onApp: ReturnType<typeof buildApp>
  let offApp: ReturnType<typeof buildApp>
  let tok: Record<string, string>

  beforeEach(() => {
    db = openDatabase(':memory:')
    const peers = seedPeerSecrets(db, ['alice', 'bob'])
    tok = { alice: peers.alice!.token, bob: peers.bob!.token }
    store = new MessageStore(db)
    fanout = new Fanout()
    const deps = { db, store, fanout, presence: new PresenceRegistry(), claims: new ClaimStore(db), now: () => new Date() }
    onApp = buildApp({ ...deps, addressRules: 'on' })
    offApp = buildApp({ ...deps, addressRules: 'off' })
  })

  async function post(app: ReturnType<typeof buildApp>, who: string, body: unknown, headers: Record<string, string> = {}) {
    return app.request('/v1/messages', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok[who]}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  }

  describe('flag off: byte-identical to today', () => {
    it('in_reply_to on chat still works (legacy reply path)', async () => {
      const root = await (await post(offApp, 'alice', { to: 'bob', kind: 'chat', content: 'root' })).json() as { id: string }
      const res = await post(offApp, 'bob', { to: 'alice', kind: 'chat', content: 'reply', in_reply_to: root.id })
      expect(res.status).toBe(201)
    })

    it('chat to a bare handle with no all_sessions still works', async () => {
      const res = await post(offApp, 'alice', { to: 'bob', kind: 'chat', content: 'x' }, { 'x-hangar-instance': INST_A })
      expect(res.status).toBe(201)
    })

    it('bare-handle task_dispatch still works', async () => {
      const res = await post(offApp, 'alice', { to: 'bob', kind: 'task_dispatch', content: 'run' }, { 'x-hangar-instance': INST_A })
      expect(res.status).toBe(201)
    })

    it('a user-authored send with no x-hangar-instance still works', async () => {
      const res = await post(offApp, 'alice', { to: 'bob', kind: 'chat', content: 'x' })
      expect(res.status).toBe(201)
    })
  })

  describe('flag on: §6.1-6.3 refusals', () => {
    it('use_reply_verb: in_reply_to on a user-authored kind -> 400', async () => {
      const root = await (await post(onApp, 'alice', { to: 'bob', kind: 'chat', content: 'root', all_sessions: true }, { 'x-hangar-instance': INST_A })).json() as { id: string }
      const res = await post(onApp, 'bob', { to: 'alice', kind: 'chat', content: 'reply', in_reply_to: root.id, all_sessions: true }, { 'x-hangar-instance': INST_B })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string; retryable: boolean }
      expect(body.error).toBe('use_reply_verb')
      expect(body.retryable).toBe(false)
    })

    it('sender_instance_required: no x-hangar-instance on a user-authored kind -> 400', async () => {
      const res = await post(onApp, 'alice', { to: 'bob', kind: 'chat', content: 'x', all_sessions: true })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string; retryable: boolean }
      expect(body.error).toBe('sender_instance_required')
      expect(body.retryable).toBe(false)
    })

    it('handle_needs_all_sessions: bare-handle chat without all_sessions -> 400 with live_instances', async () => {
      fanout.subscribe({ handle: 'bob', team_id: 'hangar', instance: INST_B, deliver: () => {} })
      const res = await post(onApp, 'alice', { to: 'bob', kind: 'chat', content: 'x' }, { 'x-hangar-instance': INST_A })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string; retryable: boolean; live_instances: string[] }
      expect(body.error).toBe('handle_needs_all_sessions')
      expect(body.retryable).toBe(false)
      expect(body.live_instances).toEqual([INST_B])
    })

    it('bare-handle chat WITH all_sessions:true is accepted', async () => {
      const res = await post(onApp, 'alice', { to: 'bob', kind: 'chat', content: 'x', all_sessions: true }, { 'x-hangar-instance': INST_A })
      expect(res.status).toBe(201)
    })

    it('§6.3: own handle follows §6.1 unchanged (bare send to self also needs all_sessions)', async () => {
      const res = await post(onApp, 'alice', { to: 'alice', kind: 'chat', content: 'note to self' }, { 'x-hangar-instance': INST_A })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('handle_needs_all_sessions')
    })

    it('dispatch_needs_instance: bare-handle task_dispatch -> 400', async () => {
      const res = await post(onApp, 'alice', { to: 'bob', kind: 'task_dispatch', content: 'run' }, { 'x-hangar-instance': INST_A })
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string; retryable: boolean }
      expect(body.error).toBe('dispatch_needs_instance')
      expect(body.retryable).toBe(false)
    })

    it('task_dispatch WITH to_filter.instance is accepted', async () => {
      const res = await post(onApp, 'alice', {
        to: 'bob', kind: 'task_dispatch', content: 'run', to_filter: { instance: INST_B },
      }, { 'x-hangar-instance': INST_A })
      expect(res.status).toBe(201)
    })

    it('§6.4: protocol kinds are exempt from the flag-on refusals', async () => {
      const dispatch = await post(onApp, 'alice', {
        to: 'bob', kind: 'task_dispatch', content: 'run', to_filter: { instance: INST_B },
      }, { 'x-hangar-instance': INST_A })
      // matched:0 (nobody subscribed) leaves no durable row/route, but the
      // schema still requires in_reply_to to REFERENCE something for
      // permission_verdict/task_result — presence_update needs neither and
      // is the cleanest exemption check.
      expect(dispatch.status).toBe(201)
      const res = await post(onApp, 'alice', { to: '@team', kind: 'presence_update', content: '{}' })
      expect(res.status).toBe(201)
    })
  })

  describe('§7 thread continuation (NOT flag-controlled)', () => {
    it('not_in_thread: an unknown thread_root -> 403, regardless of the flag', async () => {
      const resOn = await post(onApp, 'alice', { to: 'bob', kind: 'chat', content: 'x', thread_root: 'msg_00000000000000000000000000', all_sessions: true }, { 'x-hangar-instance': INST_A })
      expect(resOn.status).toBe(403)
      const bodyOn = await resOn.json() as { error: string; retryable: boolean }
      expect(bodyOn.error).toBe('not_in_thread')
      expect(bodyOn.retryable).toBe(false)

      const resOff = await post(offApp, 'alice', { to: 'bob', kind: 'chat', content: 'x', thread_root: 'msg_00000000000000000000000000' })
      expect(resOff.status).toBe(403)
      expect((await resOff.json() as { error: string }).error).toBe('not_in_thread')
    })

    it('the SENDER of the named route may continue it for a new audience', async () => {
      const root = await (await post(offApp, 'alice', { to: 'bob', kind: 'chat', content: 'root' }, { 'x-hangar-instance': INST_A })).json() as { id: string }
      const res = await post(offApp, 'alice', {
        to: 'bob', kind: 'chat', content: 'continuing', thread_root: root.id,
      }, { 'x-hangar-instance': INST_A })
      expect(res.status).toBe(201)
      const body = await res.json() as { thread_root: string | null }
      expect(body.thread_root).toBe(root.id)
    })

    it('a GRANTED recipient of the named route may continue it for a different audience', async () => {
      fanout.subscribe({ handle: 'bob', team_id: 'hangar', instance: INST_B, deliver: () => {} })
      const root = await (await post(offApp, 'alice', { to: 'bob', kind: 'chat', content: 'root' }, { 'x-hangar-instance': INST_A })).json() as { id: string }
      // bob received it live (granted). bob may now continue the thread.
      const res = await post(offApp, 'bob', {
        to: 'alice', kind: 'chat', content: 'continuing', thread_root: root.id,
      }, { 'x-hangar-instance': INST_B })
      expect(res.status).toBe(201)
      const body = await res.json() as { thread_root: string | null }
      expect(body.thread_root).toBe(root.id)
    })

    it('a THIRD PARTY that neither sent nor was granted the route -> 403 not_in_thread', async () => {
      const root = await (await post(offApp, 'alice', { to: 'bob', kind: 'chat', content: 'root' }, { 'x-hangar-instance': INST_A })).json() as { id: string }
      // bob was never online, so bob has no grant either — but this asserts
      // the negative for a handle that is neither sender nor recipient.
      const res = await post(offApp, 'bob', {
        to: 'alice', kind: 'chat', content: 'trying', thread_root: root.id,
      }, { 'x-hangar-instance': INST_B })
      expect(res.status).toBe(403)
      expect((await res.json() as { error: string }).error).toBe('not_in_thread')
    })
  })

  describe('§6.5 reserved addresses (NOT flag-controlled, from the shared schema)', () => {
    it('reserved_address (@mailbox:) is rejected with the flag off', async () => {
      const res = await post(offApp, 'alice', { to: '@mailbox:bob', kind: 'chat', content: 'x' })
      expect(res.status).toBe(400)
    })

    it('reserved_address (@mailbox:) is rejected with the flag on', async () => {
      const res = await post(onApp, 'alice', { to: '@mailbox:bob', kind: 'chat', content: 'x' })
      expect(res.status).toBe(400)
    })

    it('reserved_instance (to_filter.instance = ~cli) is rejected with the flag off', async () => {
      const res = await post(offApp, 'alice', { to: 'bob', kind: 'chat', content: 'x', to_filter: { instance: '~cli' } })
      expect(res.status).toBe(400)
    })

    it('reserved_instance (to_filter.instance = ~cli) is rejected with the flag on', async () => {
      const res = await post(onApp, 'alice', { to: 'bob', kind: 'chat', content: 'x', to_filter: { instance: '~cli' } })
      expect(res.status).toBe(400)
    })
  })
})
