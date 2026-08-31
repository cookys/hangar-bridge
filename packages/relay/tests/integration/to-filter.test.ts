import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type Db } from '../../src/db/db.ts'
import { MessageStore } from '../../src/messages/store.ts'
import { Fanout } from '../../src/fanout.ts'
import { PresenceRegistry } from '../../src/presence/registry.ts'
import { buildApp } from '../../src/app.ts'
import { seedPeerSecrets } from './_seed.ts'
import { ClaimStore } from '../../src/claims/store.ts'

// Read up to n SSE message events (or until timeout). Short timeout for "must NOT arrive".
async function readEvents(stream: ReadableStream<Uint8Array>, n: number, timeoutMs = 1200): Promise<string[]> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const events: string[] = []
  let buf = ''
  const deadline = Date.now() + timeoutMs
  while (events.length < n && Date.now() < deadline) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const t = new Promise<{ value: undefined; done: true }>(res => setTimeout(() => res({ value: undefined, done: true }), remaining))
    const { value, done } = await Promise.race([reader.read(), t])
    if (done) break
    buf += decoder.decode(value)
    const parts = buf.split('\n\n')
    buf = parts.pop() ?? ''
    events.push(...parts.filter(p => p.includes('event: message')))
  }
  try { await reader.cancel() } catch { /* ignore */ }
  return events
}

const settle = () => new Promise(r => setTimeout(r, 120)) // let streamSSE subscribe before publish

const INST_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const INST_B = '01ARZ3NDEKTSV4RRFFQ69G5FB0'

// to_filter: relay-side presence-narrowed delivery. Every scenario asserts BOTH the
// match receiving AND the non-match receiving NOTHING, so a dead gate can't pass.
describe('to_filter (presence-narrowed addressing)', () => {
  let db: Db
  let store: MessageStore
  let app: ReturnType<typeof buildApp>
  let tok: Record<string, string>

  beforeEach(() => {
    db = openDatabase(':memory:')
    const peers = seedPeerSecrets(db, ['alice', 'bob', 'carol'])
    tok = { alice: peers.alice!.token, bob: peers.bob!.token, carol: peers.carol!.token }
    store = new MessageStore(db)
    app = buildApp({ db, store, fanout: new Fanout(), presence: new PresenceRegistry(), claims: new ClaimStore(db), now: () => new Date() })
  })

  const openStream = (handle: string, instance?: string) =>
    app.request('/v1/stream', {
      headers: { authorization: `Bearer ${tok[handle]}`, ...(instance ? { 'x-hangar-instance': instance } : {}) },
    })

  const setPresence = (handle: string, instance: string, body: Record<string, unknown>) =>
    app.request('/v1/presence', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok[handle]}`, 'content-type': 'application/json' },
      body: JSON.stringify({ summary: '(t)', instance, ...body }),
    })

  const publish = (from: string, body: Record<string, unknown>, instance?: string) =>
    app.request('/v1/messages', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tok[from]}`, 'content-type': 'application/json',
        ...(instance ? { 'x-hangar-instance': instance } : {}),
      },
      body: JSON.stringify(body),
    })

  it('instance filter: only the targeted session receives; the sibling gets nothing', async () => {
    const a = await openStream('bob', INST_A)
    const b = await openStream('bob', INST_B)
    await settle()
    const res = await publish('alice', { to: 'bob', kind: 'chat', content: 'for-A', to_filter: { instance: INST_A } })
    expect(res.status).toBe(201)
    const body = await res.json() as { matched: number; matched_sessions: Array<{ handle: string; instance?: string }> }
    expect(body.matched).toBe(1)
    expect(body.matched_sessions).toEqual([{ handle: 'bob', instance: INST_A }])
    const [aEv, bEv] = await Promise.all([readEvents(a.body!, 1), readEvents(b.body!, 1, 600)])
    expect(aEv.some(e => e.includes('for-A'))).toBe(true)
    expect(bEv.some(e => e.includes('for-A'))).toBe(false)
  })

  it('instance filter with no matching session reports matched:0', async () => {
    await openStream('bob', INST_B)
    const res = await publish('alice', { to: 'bob', kind: 'chat', content: 'ghost', to_filter: { instance: INST_A } })
    const body = await res.json() as { matched: number }
    expect(body.matched).toBe(0)
  })

  it('repo filter over @team: reaches only sessions in that repo, across handles', async () => {
    const pb = await setPresence('bob', INST_A, { repo: 'llm-playground' })
    expect(pb.status).toBe(200)
    await setPresence('carol', INST_B, { repo: 'other-repo' })
    const bobS = await openStream('bob', INST_A)
    const carolS = await openStream('carol', INST_B)
    await settle()
    const res = await publish('alice', { to: '@team', kind: 'chat', content: 'lp-only', to_filter: { repo: 'llm-playground' } })
    const body = await res.json() as { matched: number }
    expect(body.matched).toBe(1)
    // setPresence broadcasts presence_update to @team, so read several events and filter by content.
    const [bobEv, carolEv] = await Promise.all([readEvents(bobS.body!, 5, 1200), readEvents(carolS.body!, 5, 800)])
    expect(bobEv.some(e => e.includes('lp-only'))).toBe(true)
    expect(carolEv.some(e => e.includes('lp-only'))).toBe(false)
  })

  it('directed chat is NOT persisted (a later poll_inbox cannot see it)', async () => {
    await openStream('bob', INST_A)
    await settle()
    await publish('alice', { to: 'bob', kind: 'chat', content: 'ephemeral-chat', to_filter: { instance: INST_A } })
    // Any sibling under bob peeking the durable buffer must not find it.
    const peek = await app.request('/v1/messages', { headers: { authorization: `Bearer ${tok.bob}` } })
    const { messages } = await peek.json() as { messages: Array<{ content: string }> }
    expect(messages.some(m => m.content === 'ephemeral-chat')).toBe(false)
  })

  it('directed task_dispatch{instance} IS persisted when delivered (reply chain works)', async () => {
    await openStream('bob', INST_A)
    await settle()
    const res = await publish('alice', { to: 'bob', kind: 'task_dispatch', content: 'do-x', to_filter: { instance: INST_A } })
    const body = await res.json() as { id: string; matched: number }
    expect(body.matched).toBe(1)
    const peek = await app.request('/v1/messages', { headers: { authorization: `Bearer ${tok.bob}` } })
    const { messages } = await peek.json() as { messages: Array<{ id: string; content: string }> }
    expect(messages.some(m => m.content === 'do-x')).toBe(true)
    // The stored row is a valid in_reply_to parent (reply does not 400).
    const reply = await publish('bob', { to: 'alice', kind: 'task_result', content: 'done', in_reply_to: body.id })
    expect(reply.status).toBe(201)
  })

  it('directed task_dispatch{instance} with no match leaves NO row (no zombie / double-exec)', async () => {
    const res = await publish('alice', { to: 'bob', kind: 'task_dispatch', content: 'orphan', to_filter: { instance: INST_A } })
    const body = await res.json() as { matched: number }
    expect(body.matched).toBe(0)
    const peek = await app.request('/v1/messages', { headers: { authorization: `Bearer ${tok.bob}` } })
    const { messages } = await peek.json() as { messages: Array<{ content: string }> }
    expect(messages.some(m => m.content === 'orphan')).toBe(false)
  })
})
