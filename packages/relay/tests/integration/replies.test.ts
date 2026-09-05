import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type Db } from '../../src/db/db.ts'
import { MessageStore, type ReplyRouteInput } from '../../src/messages/store.ts'
import { Fanout } from '../../src/fanout.ts'
import { PresenceRegistry } from '../../src/presence/registry.ts'
import { buildApp } from '../../src/app.ts'
import { seedPeerSecrets } from './_seed.ts'
import { ClaimStore } from '../../src/claims/store.ts'
import { newMessageId, newInstanceId, RESERVED_CLI_INSTANCE } from '@hangar-bridge/shared'
import { idemPollConfig, canonicalJson, computeIdemKeyHash, computeRequestDigest } from '../../src/routes/replies.ts'

const ALICE_INST = newInstanceId()
const BOB_INST = newInstanceId()

describe('POST /v1/replies (REPLY_ROUTING_SPEC.md §3.1, §5.1, §5.2, §5.4, §9)', () => {
  let db: Db
  let store: MessageStore
  let fanout: Fanout
  let app: ReturnType<typeof buildApp>
  let tok: Record<string, string>
  let nowMs: number
  let keySeq: number

  beforeEach(() => {
    db = openDatabase(':memory:')
    const peers = seedPeerSecrets(db, ['alice', 'bob', 'carol'])
    tok = { alice: peers.alice!.token, bob: peers.bob!.token, carol: peers.carol!.token }
    store = new MessageStore(db)
    fanout = new Fanout()
    nowMs = Date.parse('2026-09-05T12:00:00.000Z')
    const deps = {
      db, store, fanout, presence: new PresenceRegistry(),
      claims: new ClaimStore(db), now: () => new Date(nowMs),
    }
    app = buildApp(deps)
    idemPollConfig.intervalMs = 5
    idemPollConfig.timeoutMs = 60
    keySeq = 0
  })

  function nextKey(): string {
    keySeq += 1
    return `key-${keySeq}-${Math.random().toString(36).slice(2)}`
  }

  function seedRoute(overrides: Partial<ReplyRouteInput> = {}): string {
    const id = overrides.msg_id ?? newMessageId()
    store.insertRoute({
      msg_id: id, team_id: 'hangar', from_handle: 'alice', sender_instance: ALICE_INST,
      to_handle: 'bob', thread_root: id, created_at: new Date(nowMs).toISOString(),
      ...overrides,
    })
    return id
  }

  async function replyAs(
    who: string, body: unknown, headers: Record<string, string> = {}
  ): Promise<Response> {
    return app.request('/v1/replies', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tok[who]}`, 'content-type': 'application/json',
        'idempotency-key': nextKey(), ...headers,
      },
      body: JSON.stringify(body),
    })
  }

  // ---------------------------------------------------------------------
  // JCS canonical serializer (§3.1)
  // ---------------------------------------------------------------------
  describe('canonicalJson (RFC 8785 subset)', () => {
    it('sorts object keys', () => {
      expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    })
    it('omits undefined-valued keys', () => {
      expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
    })
    it('emits no whitespace', () => {
      expect(canonicalJson({ a: [1, 2], b: 'x' })).toBe('{"a":[1,2],"b":"x"}')
    })
    it('is deterministic regardless of input key order', () => {
      expect(canonicalJson({ z: 1, a: { d: 1, c: 2 } })).toBe(canonicalJson({ a: { c: 2, d: 1 }, z: 1 }))
    })
  })

  it('computeIdemKeyHash / computeRequestDigest are deterministic and key-scoped', () => {
    const h1 = computeIdemKeyHash('hangar', 'bob', 'abc')
    const h2 = computeIdemKeyHash('hangar', 'bob', 'abc')
    const h3 = computeIdemKeyHash('hangar', 'carol', 'abc')
    expect(h1.equals(h2)).toBe(true)
    expect(h1.equals(h3)).toBe(false)
    const d1 = computeRequestDigest({ in_reply_to: 'msg_x', content: 'hi', meta: {} })
    const d2 = computeRequestDigest({ in_reply_to: 'msg_x', content: 'hi', meta: {} })
    const d3 = computeRequestDigest({ in_reply_to: 'msg_x', content: 'bye', meta: {} })
    expect(d1.equals(d2)).toBe(true)
    expect(d1.equals(d3)).toBe(false)
  })

  // ---------------------------------------------------------------------
  // Request shape (item 1)
  // ---------------------------------------------------------------------
  describe('request shape', () => {
    it('rejects to/to_filter/fleet_wide/all_sessions/subject (zod strict)', async () => {
      const parentId = seedRoute()
      const res = await replyAs('bob', { in_reply_to: parentId, content: 'hi', to: 'alice' }, { 'x-hangar-instance': BOB_INST })
      expect(res.status).toBe(400)
    })

    it('requires the Idempotency-Key header', async () => {
      const parentId = seedRoute()
      const res = await app.request('/v1/replies', {
        method: 'POST',
        headers: { authorization: `Bearer ${tok.bob}`, 'content-type': 'application/json', 'x-hangar-instance': BOB_INST },
        body: JSON.stringify({ in_reply_to: parentId, content: 'hi' }),
      })
      expect(res.status).toBe(400)
      expect((await res.json() as { error: string }).error).toBe('idempotency_key_required')
    })

    it('rejects a malformed Idempotency-Key', async () => {
      const parentId = seedRoute()
      const res = await replyAs('bob', { in_reply_to: parentId, content: 'hi' }, { 'x-hangar-instance': BOB_INST, 'idempotency-key': 'has a space' })
      expect(res.status).toBe(400)
      expect((await res.json() as { error: string }).error).toBe('idempotency_key_invalid')
    })
  })

  // ---------------------------------------------------------------------
  // Idempotency state machine (item 1, acceptance)
  // ---------------------------------------------------------------------
  describe('idempotency', () => {
    it('same key replay returns the same result; no second route, no second limiter count', async () => {
      const parentId = seedRoute()
      store.insertGrants(parentId, [{ handle: 'bob', instance: BOB_INST, selector: '' }])
      const key = nextKey()
      const res1 = await replyAs('bob', { in_reply_to: parentId, content: 'hi' }, { 'x-hangar-instance': BOB_INST, 'idempotency-key': key })
      expect(res1.status).toBe(200)
      const body1 = await res1.json() as { id: string }
      const routeCount1 = (db.prepare('SELECT COUNT(*) AS n FROM reply_route').get() as { n: number }).n

      const res2 = await replyAs('bob', { in_reply_to: parentId, content: 'hi' }, { 'x-hangar-instance': BOB_INST, 'idempotency-key': key })
      expect(res2.status).toBe(200)
      const body2 = await res2.json() as { id: string }
      expect(body2).toEqual(body1)
      const routeCount2 = (db.prepare('SELECT COUNT(*) AS n FROM reply_route').get() as { n: number }).n
      expect(routeCount2).toBe(routeCount1)

      const limiterRow = db.prepare("SELECT count FROM reply_limiter WHERE handle='bob'").get() as { count: number }
      expect(limiterRow.count).toBe(1)
    })

    it('same key, different request_digest -> 422 idempotency_mismatch', async () => {
      const parentId = seedRoute()
      store.insertGrants(parentId, [{ handle: 'bob', instance: BOB_INST, selector: '' }])
      const key = nextKey()
      await replyAs('bob', { in_reply_to: parentId, content: 'hi' }, { 'x-hangar-instance': BOB_INST, 'idempotency-key': key })
      const res2 = await replyAs('bob', { in_reply_to: parentId, content: 'a different message' }, { 'x-hangar-instance': BOB_INST, 'idempotency-key': key })
      expect(res2.status).toBe(422)
      const body = await res2.json() as { error: string; retry_with_new_key: boolean }
      expect(body.error).toBe('idempotency_mismatch')
      expect(body.retry_with_new_key).toBe(true)
    })

    it('two concurrent requests with one key: exactly one proceeds, the other 409 or replays', async () => {
      const parentId = seedRoute()
      store.insertGrants(parentId, [{ handle: 'bob', instance: BOB_INST, selector: '' }])
      const key = nextKey()
      const [r1, r2] = await Promise.all([
        replyAs('bob', { in_reply_to: parentId, content: 'hi' }, { 'x-hangar-instance': BOB_INST, 'idempotency-key': key }),
        replyAs('bob', { in_reply_to: parentId, content: 'hi' }, { 'x-hangar-instance': BOB_INST, 'idempotency-key': key }),
      ])
      const statuses = [r1.status, r2.status].sort()
      // Either both succeeded (one proceeded, one replayed the committed/final
      // result) or the loser got 409 while it was still pending.
      expect(statuses[0] === 200 || statuses[0] === 409).toBe(true)
      expect(statuses.includes(200)).toBe(true)

      const routeCount = (db.prepare('SELECT COUNT(*) AS n FROM reply_route').get() as { n: number }).n
      // The parent route plus at most ONE new reply route.
      expect(routeCount).toBeLessThanOrEqual(2)
      const limiterRow = db.prepare("SELECT count FROM reply_limiter WHERE handle='bob'").get() as { count: number } | undefined
      expect(limiterRow?.count ?? 0).toBeLessThanOrEqual(1)
    })

    it('stale pending (>60s) is taken over by one CAS; the old holder\'s writes are fenced out', async () => {
      const parentId = seedRoute()
      store.insertGrants(parentId, [{ handle: 'bob', instance: BOB_INST, selector: '' }])
      const key = nextKey()
      const oldLease = newInstanceId()
      const digest = computeRequestDigest({ in_reply_to: parentId, content: 'hi', meta: {} })
      const keyHash = computeIdemKeyHash('hangar', 'bob', key)
      const staleReservedAt = new Date(nowMs - 61_000).toISOString()
      db.prepare(`
        INSERT INTO reply_idem(key_hash, request_digest, state, lease, reserved_at)
        VALUES (?, ?, 'pending', ?, ?)
      `).run(keyHash, digest, oldLease, staleReservedAt)

      const res = await replyAs('bob', { in_reply_to: parentId, content: 'hi' }, { 'x-hangar-instance': BOB_INST, 'idempotency-key': key })
      expect(res.status).toBe(200)

      const row = db.prepare('SELECT lease, state FROM reply_idem WHERE key_hash=?').get(keyHash) as { lease: string; state: string }
      expect(row.lease).not.toBe(oldLease)
      expect(row.state).toBe('final')

      // The old (forged) holder's lease can no longer write anything.
      const fencedAttempt = db.prepare(`
        UPDATE reply_idem SET state='error', result_status=500, result_json='{}' WHERE key_hash=? AND lease=?
      `).run(keyHash, oldLease)
      expect(fencedAttempt.changes).toBe(0)
    })

    it('an error row past error_until is re-executed', async () => {
      const parentId = seedRoute()
      const key = nextKey()
      const digest = computeRequestDigest({ in_reply_to: parentId, content: 'hi', meta: {} })
      const keyHash = computeIdemKeyHash('hangar', 'bob', key)
      db.prepare(`
        INSERT INTO reply_idem(key_hash, request_digest, state, lease, reserved_at, result_status, result_json, error_until)
        VALUES (?, ?, 'error', ?, ?, 403, '{"error":"not_a_recipient","retryable":false}', ?)
      `).run(keyHash, digest, newInstanceId(), new Date(nowMs - 5000).toISOString(), new Date(nowMs - 1000).toISOString())
      // Now grant bob so re-execution can actually succeed.
      store.insertGrants(parentId, [{ handle: 'bob', instance: BOB_INST, selector: '' }])

      const res = await replyAs('bob', { in_reply_to: parentId, content: 'hi' }, { 'x-hangar-instance': BOB_INST, 'idempotency-key': key })
      expect(res.status).toBe(200)
    })

    it('an error row NOT past error_until (or with no error_until) replays the stored refusal', async () => {
      const parentId = seedRoute()
      const key = nextKey()
      const digest = computeRequestDigest({ in_reply_to: parentId, content: 'hi', meta: {} })
      const keyHash = computeIdemKeyHash('hangar', 'bob', key)
      db.prepare(`
        INSERT INTO reply_idem(key_hash, request_digest, state, lease, reserved_at, result_status, result_json, error_until)
        VALUES (?, ?, 'error', ?, ?, 403, '{"error":"not_a_recipient","retryable":false}', NULL)
      `).run(keyHash, digest, newInstanceId(), new Date(nowMs - 5000).toISOString())

      const res = await replyAs('bob', { in_reply_to: parentId, content: 'hi' }, { 'x-hangar-instance': BOB_INST, 'idempotency-key': key })
      expect(res.status).toBe(403)
      expect((await res.json() as { error: string }).error).toBe('not_a_recipient')
    })
  })

  // ---------------------------------------------------------------------
  // Refusals (item 2, acceptance: 5 refusals)
  // ---------------------------------------------------------------------
  describe('refusals', () => {
    it('unknown_parent: no route for in_reply_to', async () => {
      const res = await replyAs('bob', { in_reply_to: newMessageId(), content: 'hi' }, { 'x-hangar-instance': BOB_INST })
      expect(res.status).toBe(404)
      const body = await res.json() as { error: string; retryable: boolean; retry_with_new_key: boolean }
      expect(body.error).toBe('unknown_parent')
      expect(body.retryable).toBe(false)
      expect(body.retry_with_new_key).toBe(true)
    })

    it('unknown_parent: expired route', async () => {
      const parentId = seedRoute({ expires_at: new Date(nowMs - 1000).toISOString() })
      store.insertGrants(parentId, [{ handle: 'bob', instance: BOB_INST, selector: '' }])
      const res = await replyAs('bob', { in_reply_to: parentId, content: 'hi' }, { 'x-hangar-instance': BOB_INST })
      expect(res.status).toBe(404)
      expect((await res.json() as { error: string }).error).toBe('unknown_parent')
    })

    it('not_a_recipient: replier has no grant on the route', async () => {
      const parentId = seedRoute()
      // No grant for carol.
      const res = await replyAs('carol', { in_reply_to: parentId, content: 'hi' }, { 'x-hangar-instance': newInstanceId() })
      expect(res.status).toBe(403)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('not_a_recipient')
    })

    it('legacy_unreplyable: backfilled row that carried a to_filter', async () => {
      const parentId = seedRoute({ legacy_width: 'unreplyable' })
      const res = await replyAs('bob', { in_reply_to: parentId, content: 'hi' }, { 'x-hangar-instance': BOB_INST })
      expect(res.status).toBe(403)
      const body = await res.json() as { error: string }
      expect(body.error).toBe('legacy_unreplyable')
    })

    it('parent_unaddressable: sender_instance NULL -> 410 + tombstone', async () => {
      const parentId = seedRoute({ sender_instance: null })
      store.insertGrants(parentId, [{ handle: 'bob', instance: BOB_INST, selector: '' }])
      const res = await replyAs('bob', { in_reply_to: parentId, content: 'hi' }, { 'x-hangar-instance': BOB_INST })
      expect(res.status).toBe(410)
      const body = await res.json() as { error: string; retry_with_new_key: boolean }
      expect(body.error).toBe('parent_unaddressable')
      expect(body.retry_with_new_key).toBe(true)
      const route = store.getRoute(parentId)
      expect(route?.unaddressable_at).not.toBeNull()
    })

    it('parent_unaddressable: return_selector = ~none -> 410 + tombstone', async () => {
      const parentId = seedRoute({ return_selector: '~none' })
      store.insertGrants(parentId, [{ handle: 'bob', instance: BOB_INST, selector: '' }])
      const res = await replyAs('bob', { in_reply_to: parentId, content: 'hi' }, { 'x-hangar-instance': BOB_INST })
      expect(res.status).toBe(410)
      expect(store.getRoute(parentId)?.unaddressable_at).not.toBeNull()
    })

    it('parent_unaddressable: from_handle disabled -> 410 + tombstone', async () => {
      const parentId = seedRoute()
      store.insertGrants(parentId, [{ handle: 'bob', instance: BOB_INST, selector: '' }])
      db.prepare("UPDATE human SET disabled_at=? WHERE team_id='hangar' AND handle='alice'").run(new Date(nowMs).toISOString())
      const res = await replyAs('bob', { in_reply_to: parentId, content: 'hi' }, { 'x-hangar-instance': BOB_INST })
      expect(res.status).toBe(410)
      expect(store.getRoute(parentId)?.unaddressable_at).not.toBeNull()
    })

    it('reply_storm: exceeding the limiter -> 429 with retry_after_s, and the row carries error_until', async () => {
      const parentId = seedRoute()
      store.insertGrants(parentId, [{ handle: 'bob', instance: BOB_INST, selector: '' }])
      // Exhaust the window (10 per 10 min) directly against the SAME thread_root.
      for (let i = 0; i < 10; i++) {
        db.prepare(`
          INSERT INTO reply_limiter(thread_root, handle, window_start, count) VALUES (?, 'bob', ?, 10)
          ON CONFLICT(thread_root, handle, window_start) DO UPDATE SET count = 10
        `).run(parentId, new Date(Math.floor(nowMs / 600_000) * 600_000).toISOString())
      }
      const key = nextKey()
      const res = await replyAs('bob', { in_reply_to: parentId, content: 'hi' }, { 'x-hangar-instance': BOB_INST, 'idempotency-key': key })
      expect(res.status).toBe(429)
      const body = await res.json() as { error: string; retry_after_s: number; retry_with_new_key: boolean }
      expect(body.error).toBe('reply_storm')
      expect(typeof body.retry_after_s).toBe('number')
      expect(body.retry_with_new_key).toBe(true)

      const keyHash = computeIdemKeyHash('hangar', 'bob', key)
      const row = db.prepare('SELECT state, error_until FROM reply_idem WHERE key_hash=?').get(keyHash) as { state: string; error_until: string | null }
      expect(row.state).toBe('error')
      expect(row.error_until).not.toBeNull()
    })
  })

  // ---------------------------------------------------------------------
  // Session branch delivery + legacy width (item 3)
  // ---------------------------------------------------------------------
  describe('session branch', () => {
    it('a live recipient: sender_state live, matched > 0', async () => {
      const parentId = seedRoute()
      store.insertGrants(parentId, [{ handle: 'bob', instance: BOB_INST, selector: '' }])
      fanout.subscribe({ handle: 'alice', team_id: 'hangar', instance: ALICE_INST, deliver: () => {} })
      const res = await replyAs('bob', { in_reply_to: parentId, content: 'hi' }, { 'x-hangar-instance': BOB_INST })
      expect(res.status).toBe(200)
      const body = await res.json() as { sender_state: string; matched: number; live: string[]; durable: string[] }
      expect(body.sender_state).toBe('live')
      expect(body.matched).toBe(1)
      expect(body.live).toEqual([`alice#${ALICE_INST}`])
      expect(body.durable).toEqual([])
    })

    it('zero live match: sender_state offline, matched 0, route still written', async () => {
      const parentId = seedRoute()
      store.insertGrants(parentId, [{ handle: 'bob', instance: BOB_INST, selector: '' }])
      const res = await replyAs('bob', { in_reply_to: parentId, content: 'hi' }, { 'x-hangar-instance': BOB_INST })
      expect(res.status).toBe(200)
      const body = await res.json() as { sender_state: string; matched: number; id: string }
      expect(body.sender_state).toBe('offline')
      expect(body.matched).toBe(0)
      expect(store.getRoute(body.id)).not.toBeNull()
    })

    it('legacy_parent: true is reported for a backfilled route', async () => {
      const parentId = seedRoute({ legacy_width: 'handle' })
      const res = await replyAs('bob', { in_reply_to: parentId, content: 'hi' }, { 'x-hangar-instance': BOB_INST })
      expect(res.status).toBe(200)
      const body = await res.json() as { legacy_parent?: boolean }
      expect(body.legacy_parent).toBe(true)
    })

    it('legacy width "team-not-sender": any handle except from_handle may reply', async () => {
      const parentId = seedRoute({ to_handle: '@team', legacy_width: 'team-not-sender' })
      const resCarol = await replyAs('carol', { in_reply_to: parentId, content: 'hi' }, { 'x-hangar-instance': newInstanceId() })
      expect(resCarol.status).toBe(200)
      const resAlice = await replyAs('alice', { in_reply_to: parentId, content: 'hi' }, { 'x-hangar-instance': ALICE_INST })
      expect(resAlice.status).toBe(403)
    })

    it('resolves the parent by correlation_id alias', async () => {
      const correlationId = newMessageId()
      const parentId = seedRoute({ correlation_id: correlationId })
      store.insertGrants(parentId, [{ handle: 'bob', instance: BOB_INST, selector: '' }])
      const res = await replyAs('bob', { in_reply_to: correlationId, content: 'hi' }, { 'x-hangar-instance': BOB_INST })
      expect(res.status).toBe(200)
    })

    it('the reply\'s own route copies the parent thread_root verbatim', async () => {
      const root = newMessageId()
      const parentId = seedRoute({ thread_root: root })
      store.insertGrants(parentId, [{ handle: 'bob', instance: BOB_INST, selector: '' }])
      const res = await replyAs('bob', { in_reply_to: parentId, content: 'hi' }, { 'x-hangar-instance': BOB_INST })
      const body = await res.json() as { id: string }
      const newRoute = store.getRoute(body.id)
      expect(newRoute?.thread_root).toBe(root)
    })
  })

  // ---------------------------------------------------------------------
  // Mailbox branch + round trip (item 3, item 4 integration)
  // ---------------------------------------------------------------------
  describe('mailbox branch', () => {
    it('a reply to a ~cli parent lands in @mailbox: and is durable', async () => {
      const parentId = seedRoute({ sender_instance: RESERVED_CLI_INSTANCE })
      store.insertGrants(parentId, [{ handle: 'bob', instance: BOB_INST, selector: '' }])
      const res = await replyAs('bob', { in_reply_to: parentId, content: 'hi from bob' }, { 'x-hangar-instance': BOB_INST })
      expect(res.status).toBe(200)
      const body = await res.json() as { live: string[]; durable: string[]; matched: number; to: string }
      expect(body.live).toEqual([])
      expect(body.durable).toEqual(['alice~cli'])
      expect(body.matched).toBe(0)
      expect(body.to).toBe('@mailbox:alice')

      const row = db.prepare("SELECT to_handle FROM message WHERE to_handle='@mailbox:alice'").get() as { to_handle: string } | undefined
      expect(row).toBeDefined()
    })

    it('full round trip: reply -> GET /v1/inbox pages it -> a ~cli replier can answer it', async () => {
      const parentId = seedRoute({ sender_instance: RESERVED_CLI_INSTANCE })
      store.insertGrants(parentId, [{ handle: 'bob', instance: BOB_INST, selector: '' }])
      const replyRes = await replyAs('bob', { in_reply_to: parentId, content: 'answering the mailbox parent' }, { 'x-hangar-instance': BOB_INST })
      expect(replyRes.status).toBe(200)
      const replyBody = await replyRes.json() as { id: string }

      const inboxRes = await app.request('/v1/inbox', { headers: { authorization: `Bearer ${tok.alice}` } })
      expect(inboxRes.status).toBe(200)
      const inboxBody = await inboxRes.json() as { messages: Array<{ id: string; content: string }>; last_id: string; has_more: boolean }
      expect(inboxBody.messages.map(m => m.id)).toContain(replyBody.id)
      expect(inboxBody.last_id).toBe(replyBody.id)
      expect(inboxBody.has_more).toBe(false)

      // The mailbox reply's own grant lets the mailbox OWNER (alice, as '~cli')
      // answer it back: (reply id, alice, '~cli', '').
      expect(store.hasGrant(replyBody.id, 'alice', RESERVED_CLI_INSTANCE, '')).toBe(true)

      // alice (a ~cli caller under her own bearer) can now answer that reply.
      const answerRes = await replyAs('alice', { in_reply_to: replyBody.id, content: 'thanks bob' }, { 'x-hangar-instance': RESERVED_CLI_INSTANCE })
      expect(answerRes.status).toBe(200)
    })

    it('reply_storm on the mailbox branch: 429, no message row, idem row carries error_until', async () => {
      const parentId = seedRoute({ sender_instance: RESERVED_CLI_INSTANCE })
      store.insertGrants(parentId, [{ handle: 'bob', instance: BOB_INST, selector: '' }])
      db.prepare(`
        INSERT INTO reply_limiter(thread_root, handle, window_start, count) VALUES (?, 'bob', ?, 10)
      `).run(parentId, new Date(Math.floor(nowMs / 600_000) * 600_000).toISOString())
      const key = nextKey()
      const res = await replyAs('bob', { in_reply_to: parentId, content: 'hi' }, { 'x-hangar-instance': BOB_INST, 'idempotency-key': key })
      expect(res.status).toBe(429)
      const body = await res.json() as { error: string; retry_after_s: number }
      expect(body.error).toBe('reply_storm')
      expect(typeof body.retry_after_s).toBe('number')
      const mailboxRow = db.prepare("SELECT 1 AS x FROM message WHERE to_handle='@mailbox:alice'").get()
      expect(mailboxRow).toBeUndefined()
    })
  })

  // ---------------------------------------------------------------------
  // Header validation + additional branch coverage
  // ---------------------------------------------------------------------
  describe('headers and remaining branches', () => {
    it('rejects a malformed x-hangar-instance header', async () => {
      const parentId = seedRoute()
      const res = await replyAs('bob', { in_reply_to: parentId, content: 'hi' }, { 'x-hangar-instance': 'not-a-valid-ulid' })
      expect(res.status).toBe(400)
      expect((await res.json() as { error: string }).error).toBe('invalid_instance_header')
    })

    it('rejects a malformed x-hangar-return-selector header', async () => {
      const parentId = seedRoute()
      const res = await replyAs('bob', { in_reply_to: parentId, content: 'hi' }, { 'x-hangar-instance': BOB_INST, 'x-hangar-return-selector': 'not-a-selector' })
      expect(res.status).toBe(400)
      expect((await res.json() as { error: string }).error).toBe('invalid_return_selector')
    })

    it('legacy repo width: a session presenting that repo may reply; one that does not may not', async () => {
      const parentId = seedRoute({ to_handle: '@team', legacy_width: 'repo:hangar-bridge' })
      const bobLabel = 'bob-tok'
      db.prepare("UPDATE token SET label=? WHERE human_id=(SELECT id FROM human WHERE handle='bob')").run(bobLabel)
      const presence = new PresenceRegistry(() => new Date(nowMs))
      presence.set('hangar', 'bob', `${bobLabel}#${BOB_INST}`, { summary: '', instance: BOB_INST, repo: 'hangar-bridge', delivery_state: 'unverified' })
      const deps = { db, store, fanout, presence, claims: new ClaimStore(db), now: () => new Date(nowMs) }
      const localApp = buildApp(deps)
      const res = await localApp.request('/v1/replies', {
        method: 'POST',
        headers: { authorization: `Bearer ${tok.bob}`, 'content-type': 'application/json', 'idempotency-key': nextKey(), 'x-hangar-instance': BOB_INST },
        body: JSON.stringify({ in_reply_to: parentId, content: 'on topic' }),
      })
      expect(res.status).toBe(200)

      const res2 = await localApp.request('/v1/replies', {
        method: 'POST',
        headers: { authorization: `Bearer ${tok.carol}`, 'content-type': 'application/json', 'idempotency-key': nextKey(), 'x-hangar-instance': newInstanceId() },
        body: JSON.stringify({ in_reply_to: parentId, content: 'off topic' }),
      })
      expect(res2.status).toBe(403)
      expect((await res2.json() as { error: string }).error).toBe('not_a_recipient')
    })

    it('a selector-scoped grant (courier pane) requires the presented selector to match', async () => {
      const parentId = seedRoute()
      const selector = `paneA@${newInstanceId()}`
      store.insertGrants(parentId, [{ handle: 'bob', instance: BOB_INST, selector }])
      const wrongSelector = await replyAs('bob', { in_reply_to: parentId, content: 'hi' }, { 'x-hangar-instance': BOB_INST })
      expect(wrongSelector.status).toBe(403)
      const rightSelector = await replyAs('bob', { in_reply_to: parentId, content: 'hi' }, { 'x-hangar-instance': BOB_INST, 'x-hangar-return-selector': selector })
      expect(rightSelector.status).toBe(200)
    })

    it('reply_in_progress: a genuinely live pending row (not stale) times out the poller with 409', async () => {
      const parentId = seedRoute()
      store.insertGrants(parentId, [{ handle: 'bob', instance: BOB_INST, selector: '' }])
      const key = nextKey()
      const digest = computeRequestDigest({ in_reply_to: parentId, content: 'hi', meta: {} })
      const keyHash = computeIdemKeyHash('hangar', 'bob', key)
      db.prepare(`
        INSERT INTO reply_idem(key_hash, request_digest, state, lease, reserved_at)
        VALUES (?, ?, 'pending', ?, ?)
      `).run(keyHash, digest, newInstanceId(), new Date(nowMs).toISOString())

      const res = await replyAs('bob', { in_reply_to: parentId, content: 'hi' }, { 'x-hangar-instance': BOB_INST, 'idempotency-key': key })
      expect(res.status).toBe(409)
      expect((await res.json() as { error: string }).error).toBe('reply_in_progress')
    })

    it('replaying a still-committed (not yet final) row reports fanout: unknown', async () => {
      const parentId = seedRoute()
      store.insertGrants(parentId, [{ handle: 'bob', instance: BOB_INST, selector: '' }])
      const key = nextKey()
      const digest = computeRequestDigest({ in_reply_to: parentId, content: 'hi', meta: {} })
      const keyHash = computeIdemKeyHash('hangar', 'bob', key)
      db.prepare(`
        INSERT INTO reply_idem(key_hash, request_digest, state, lease, reserved_at, result_status, result_json)
        VALUES (?, ?, 'committed', ?, ?, 200, '{"id":"msg_x","matched":0}')
      `).run(keyHash, digest, newInstanceId(), new Date(nowMs).toISOString())

      const res = await replyAs('bob', { in_reply_to: parentId, content: 'hi' }, { 'x-hangar-instance': BOB_INST, 'idempotency-key': key })
      expect(res.status).toBe(200)
      const body = await res.json() as { fanout: string }
      expect(body.fanout).toBe('unknown')
    })
  })
})
