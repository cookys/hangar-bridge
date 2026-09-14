import { describe, it, expect, beforeEach } from 'vitest'
import { HANGAR_TEAM_ID, newMessageId, type Envelope } from '@hangar-bridge/shared'
import { openDatabase, type Db } from '../../src/db/db.ts'
import { MessageStore } from '../../src/messages/store.ts'
import { Fanout } from '../../src/fanout.ts'
import { PresenceRegistry } from '../../src/presence/registry.ts'
import { buildApp } from '../../src/app.ts'
import { seedPeerSecrets } from './_seed.ts'
import { ClaimStore } from '../../src/claims/store.ts'

// Plan docs/plans/2026-09-15-replay-butler.md §2.1–§2.3, §4 T1–T7, T13–T16, T19.
//
// A reconnecting (or freshly enrolled) session used to get every backlog row
// pushed one `message` event at a time. With `?replay_max=N` the relay counts
// the population it would have replayed (P), and when |P ∩ chat| > N it sends
// ONE `backlog` summary, then every non-chat row, then `backlog_end`; the chat
// rows stay in the durable buffer for `poll_inbox`. Absent `replay_max` ⇒ the
// pre-butler event sequence, byte for byte.

const SINCE0 = 'msg_00000000000000000000000000'
const INST = '01HRK7Y0000000000000000000'

interface SseEvent { event: string; data: string }

function parseEvents(blocks: string[]): SseEvent[] {
  return blocks.map(block => {
    let event = 'message'
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
    return { event, data: data.join('\n') }
  })
}

async function readEvents(stream: ReadableStream<Uint8Array>, n: number, timeoutMs = 2000): Promise<SseEvent[]> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const blocks: string[] = []
  let buf = ''
  const deadline = Date.now() + timeoutMs
  while (blocks.length < n && Date.now() < deadline) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const timeoutPromise = new Promise<{ value: undefined; done: true }>(resolve =>
      setTimeout(() => resolve({ value: undefined, done: true }), remaining)
    )
    const { value, done } = await Promise.race([reader.read(), timeoutPromise])
    if (done) break
    buf += decoder.decode(value)
    const parts = buf.split('\n\n')
    buf = parts.pop() ?? ''
    blocks.push(...parts.filter(p => p.trim().length > 0))
  }
  try { await reader.cancel() } catch { /* ignore */ }
  return parseEvents(blocks).filter(e => e.event !== 'ping')
}

describe('GET /v1/stream?replay_max — replay butler', () => {
  let db: Db
  let store: MessageStore
  let fanout: Fanout
  let app: ReturnType<typeof buildApp>
  let tok: { alice: string; bob: string; carol: string }

  const post = (from: 'alice' | 'carol', body: Record<string, unknown>) =>
    app.request('/v1/messages', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok[from]}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  const chatToBob = async (n: number, from: 'alice' | 'carol' = 'alice') => {
    const ids: string[] = []
    for (let i = 0; i < n; i++) {
      const res = await post(from, { to: 'bob', kind: 'chat', content: `c${i}` })
      ids.push(((await res.json()) as { id: string }).id)
    }
    return ids
  }

  const open = (query: string, headers: Record<string, string> = {}) =>
    app.request(`/v1/stream${query}`, { headers: { authorization: `Bearer ${tok.bob}`, ...headers } })

  beforeEach(() => {
    db = openDatabase(':memory:')
    const peers = seedPeerSecrets(db, ['alice', 'bob', 'carol'])
    tok = { alice: peers.alice!.token, bob: peers.bob!.token, carol: peers.carol!.token }
    store = new MessageStore(db)
    fanout = new Fanout()
    app = buildApp({ db, store, fanout, presence: new PresenceRegistry(), claims: new ClaimStore(db), now: () => new Date() })
  })

  // T1 — absent replay_max ⇒ today's behavior, no backlog event even for a big backlog.
  it('T1 replay_max absent: 50 rows replay as 50 message events and no backlog event', async () => {
    await chatToBob(50)
    const res = await open(`?since=${SINCE0}`)
    const events = await readEvents(res.body!, 50)
    expect(events.filter(e => e.event === 'message')).toHaveLength(50)
    expect(events.some(e => e.event === 'backlog')).toBe(false)
  })

  // T2 — at or under the threshold nothing changes.
  it('T2 replay_max=10 with 7 pending: 7 message events, no backlog event', async () => {
    await chatToBob(7)
    const res = await open(`?since=${SINCE0}&replay_max=10`)
    const events = await readEvents(res.body!, 7)
    expect(events.filter(e => e.event === 'message')).toHaveLength(7)
    expect(events.some(e => e.event === 'backlog' || e.event === 'backlog_end')).toBe(false)
  })

  // T3 — over the threshold: exactly one backlog, zero chat message events,
  // then backlog_end; skipped rows are neither delivered-stamped nor granted.
  it('T3 replay_max=10 with 11 pending: one backlog + backlog_end, no message events, rows untouched', async () => {
    const ids = await chatToBob(11)
    const res = await open(`?since=${SINCE0}&replay_max=10`, { 'x-hangar-instance': INST })
    const events = await readEvents(res.body!, 2)
    expect(events.map(e => e.event)).toEqual(['backlog', 'backlog_end'])
    const summary = JSON.parse(events[0]!.data) as Record<string, unknown>
    expect(summary.pending).toBe(11)
    expect(summary.pending_capped).toBe(false)
    expect(summary.oldest).toBe(ids[0])
    expect(summary.newest).toBe(ids[10])
    expect(summary.resume_since).toBe(SINCE0)
    expect(summary.by_sender).toEqual({ alice: 11 })
    expect(summary.replayed_exempt).toBe(0)
    expect(JSON.parse(events[1]!.data)).toEqual({ newest: ids[10] })
    for (const id of ids) {
      const row = db.prepare('SELECT delivered_at FROM message WHERE id=?').get(id) as { delivered_at: string | null }
      expect(row.delivered_at).toBeNull()
      expect(store.hasGrant(id, 'bob', INST)).toBe(false)
    }
  })

  // T4 — after the summary, a live message flows as usual.
  it('T4 a message posted after the summary arrives live as a message event', async () => {
    await chatToBob(11)
    const res = await open(`?since=${SINCE0}&replay_max=10`)
    const reader = res.body!
    const first = await readEventsNoCancel(reader, 2)
    expect(first.events.map(e => e.event)).toEqual(['backlog', 'backlog_end'])
    await post('alice', { to: 'bob', kind: 'chat', content: 'live' })
    const next = await readEventsNoCancel(reader, 1, first.state)
    expect(next.events).toHaveLength(1)
    expect(next.events[0]!.event).toBe('message')
    expect(next.events[0]!.data).toContain('"content":"live"')
    await next.state.reader.cancel()
  })

  // T5 — cold start (no since): population is the pending-only drain; rows
  // already stamped for another recipient are not in it; resume_since is "".
  it('T5 cold start counts only never-delivered rows and reports resume_since ""', async () => {
    // 20 @team broadcasts from alice; stamp 8 of them as delivered (to anyone).
    const ids: string[] = []
    for (let i = 0; i < 20; i++) {
      const res = await post('alice', { to: '@team', kind: 'chat', content: `b${i}` })
      ids.push(((await res.json()) as { id: string }).id)
    }
    for (const id of ids.slice(0, 8)) store.markDelivered(id)
    const res = await open('?replay_max=10')
    const events = await readEvents(res.body!, 2)
    expect(events.map(e => e.event)).toEqual(['backlog', 'backlog_end'])
    const summary = JSON.parse(events[0]!.data) as Record<string, unknown>
    expect(summary.pending).toBe(12)
    expect(summary.by_sender).toEqual({ '@team': 12 })
    expect(summary.resume_since).toBe('')
    expect(summary.oldest).toBe(ids[8])
    expect(summary.newest).toBe(ids[19])
  })

  // T6 — population identity: pending + replayed_exempt equals the number of
  // message events the same connection emits without replay_max.
  it('T6 pending + replayed_exempt == message events of the un-butlered replay', async () => {
    await chatToBob(12)
    store.insert(HANGAR_TEAM_ID, 'alice', { to: 'bob', kind: 'permission_request', content: 'may I?' })
    // A message bob's own instance sent is self-excluded from both paths.
    store.insert(HANGAR_TEAM_ID, 'bob', { to: 'bob', kind: 'chat', content: 'self', meta: { sender_instance: INST } })
    const plain = await open(`?since=${SINCE0}`, { 'x-hangar-instance': INST })
    const plainEvents = await readEvents(plain.body!, 13)
    const plainCount = plainEvents.filter(e => e.event === 'message').length
    expect(plainCount).toBe(13)

    const butlered = await open(`?since=${SINCE0}&replay_max=10`, { 'x-hangar-instance': INST })
    const events = await readEvents(butlered.body!, 3)
    const summary = JSON.parse(events[0]!.data) as { pending: number; replayed_exempt: number }
    expect(summary.pending + summary.replayed_exempt).toBe(plainCount)
  })

  // T14 — non-chat rows are always replayed, in id order, between backlog and backlog_end.
  it('T14 non-chat rows replay one by one between backlog and backlog_end', async () => {
    await chatToBob(20)
    const pr = store.insert(HANGAR_TEAM_ID, 'alice', { to: 'bob', kind: 'permission_request', content: 'p' })
    const td = store.insert(HANGAR_TEAM_ID, 'alice', {
      to: 'bob', kind: 'task_dispatch', content: 'do', meta: { correlation_id: 'c1' }, to_filter: { instance: INST },
    })
    const res = await open(`?since=${SINCE0}&replay_max=10`, { 'x-hangar-instance': INST })
    const events = await readEvents(res.body!, 4)
    expect(events.map(e => e.event)).toEqual(['backlog', 'message', 'message', 'backlog_end'])
    const summary = JSON.parse(events[0]!.data) as Record<string, unknown>
    expect(summary.pending).toBe(20)
    expect(summary.replayed_exempt).toBe(2)
    expect((JSON.parse(events[1]!.data) as Envelope).id).toBe(pr.id)
    expect((JSON.parse(events[2]!.data) as Envelope).id).toBe(td.id)
    expect((JSON.parse(events[3]!.data) as { newest: string }).newest).toBe(td.id)
    // The exempt rows were presented (delivered-stamped); the summarized chat rows were not.
    for (const id of [pr.id, td.id]) {
      const row = db.prepare('SELECT delivered_at FROM message WHERE id=?').get(id) as { delivered_at: string | null }
      expect(row.delivered_at).not.toBeNull()
    }
    const chatRow = db.prepare("SELECT delivered_at FROM message WHERE kind='chat' AND to_handle='bob' LIMIT 1").get() as { delivered_at: string | null }
    expect(chatRow.delivered_at).toBeNull()
  })

  // T13 — high watermark: a live envelope whose id is at or below H is dropped
  // after the summary (it is already counted, readable via poll); above H flows.
  it('T13 live envelopes with id <= newest are dropped after the summary; newer ones flow', async () => {
    const ids = await chatToBob(11)
    const res = await open(`?since=${SINCE0}&replay_max=10`)
    const first = await readEventsNoCancel(res.body!, 2)
    const H = (JSON.parse(first.events[1]!.data) as { newest: string }).newest
    expect(H).toBe(ids[10])
    // Re-deliver a counted row through the live path (simulates the connect-window race).
    const stale = store.fetchSince(HANGAR_TEAM_ID, 'bob', SINCE0)[3]!
    fanout.deliver(stale)
    const fresh = store.insert(HANGAR_TEAM_ID, 'alice', { to: 'bob', kind: 'chat', content: 'fresh' })
    fanout.deliver(fresh)
    const next = await readEventsNoCancel(res.body!, 1, first.state)
    expect(next.events).toHaveLength(1)
    expect((JSON.parse(next.events[0]!.data) as Envelope).id).toBe(fresh.id)
    await next.state.reader.cancel()
  })

  // T15 — invalid replay_max is refused before any stream is opened.
  it.each(['abc', '0', '1001', '-1', '1.5'])('T15 replay_max=%s → 400 invalid_replay_max', async v => {
    const res = await open(`?replay_max=${v}`)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('invalid_replay_max')
  })

  // T16 — the scan is capped at 10 000 rows: pending_capped, newest = 10 000th row.
  it('T16 10 001 pending rows → pending=10000, pending_capped=true, newest=row 10000; exactly 10 000 → false', async () => {
    const ids: string[] = []
    const insert = db.transaction((n: number) => {
      for (let i = 0; i < n; i++) {
        const e = store.buildEnvelope(HANGAR_TEAM_ID, 'alice', { to: 'bob', kind: 'chat', content: 'x' })
        store.persist(e)
        ids.push(e.id)
      }
    })
    insert(10_001)
    const res = await open(`?since=${SINCE0}&replay_max=10`)
    const events = await readEvents(res.body!, 2, 10_000)
    const summary = JSON.parse(events[0]!.data) as Record<string, unknown>
    expect(summary.pending).toBe(10_000)
    expect(summary.pending_capped).toBe(true)
    expect(summary.newest).toBe(ids[9_999])

    // Exactly 10 000 (resume just past the first row) → not capped.
    const res2 = await open(`?since=${ids[0]}&replay_max=10`)
    const events2 = await readEvents(res2.body!, 2, 10_000)
    const summary2 = JSON.parse(events2[0]!.data) as Record<string, unknown>
    expect(summary2.pending).toBe(10_000)
    expect(summary2.pending_capped).toBe(false)
  }, 60_000)

  // T19 — by_sender caps at 20 keys, the rest fold into "…"; @team rows count
  // under "@team" only; resume_since echoes the since the connection carried.
  it('T19 by_sender folds the 21st sender into "…" and @team rows into "@team"', async () => {
    // 21 distinct senders are more handles than the seed helper wants; use the
    // store directly with synthetic handles so the count logic is what is tested.
    for (let s = 0; s < 21; s++) {
      db.prepare("INSERT INTO human(id,team_id,handle,display_name,subjects,created_at,last_active_at) VALUES (?,?,?,?,?,?,?)")
        .run(`h_s${s}`, HANGAR_TEAM_ID, `s${s}`, `s${s}`, '[]', new Date().toISOString(), new Date().toISOString())
      store.insert(HANGAR_TEAM_ID, `s${s}`, { to: 'bob', kind: 'chat', content: 'x' })
    }
    await post('alice', { to: '@team', kind: 'chat', content: 'all' })
    await post('carol', { to: '@team', kind: 'chat', content: 'all2' })
    const res = await open(`?since=${SINCE0}&replay_max=10`)
    const events = await readEvents(res.body!, 2)
    const summary = JSON.parse(events[0]!.data) as { pending: number; by_sender: Record<string, number>; resume_since: string }
    expect(summary.pending).toBe(23)
    expect(summary.resume_since).toBe(SINCE0)
    const keys = Object.keys(summary.by_sender)
    expect(keys).toHaveLength(21) // 20 named + "…"
    expect(keys).toContain('…')
    expect(summary.by_sender['@team']).toBe(2)
    expect(Object.values(summary.by_sender).reduce((a, b) => a + b, 0)).toBe(23)
  })
})

describe('GET /v1/messages pending_after — poll-side butler', () => {
  let db: Db
  let store: MessageStore
  let app: ReturnType<typeof buildApp>
  let tok: { alice: string; bob: string }

  beforeEach(() => {
    db = openDatabase(':memory:')
    const peers = seedPeerSecrets(db, ['alice', 'bob'])
    tok = { alice: peers.alice!.token, bob: peers.bob!.token }
    store = new MessageStore(db)
    app = buildApp({ db, store, fanout: new Fanout(), presence: new PresenceRegistry(), claims: new ClaimStore(db), now: () => new Date() })
  })

  // T7 — pending_after counts pollable rows beyond next_cursor.
  it('T7 30 pollable rows, limit 10 → 10 messages, pending_after 20, pending_capped false', async () => {
    for (let i = 0; i < 30; i++) store.insert(HANGAR_TEAM_ID, 'alice', { to: 'bob', kind: 'chat', content: `m${i}` })
    const res = await app.request(`/v1/messages?since=${SINCE0}&limit=10`, {
      headers: { authorization: `Bearer ${tok.bob}`, 'x-hangar-instance': INST },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { messages: unknown[]; pending_after: number; pending_capped: boolean }
    expect(body.messages).toHaveLength(10)
    expect(body.pending_after).toBe(20)
    expect(body.pending_capped).toBe(false)
  })

  it('T7b pending_after is 0 on the last page', async () => {
    for (let i = 0; i < 3; i++) store.insert(HANGAR_TEAM_ID, 'alice', { to: 'bob', kind: 'chat', content: `m${i}` })
    const res = await app.request(`/v1/messages?since=${SINCE0}&limit=10`, {
      headers: { authorization: `Bearer ${tok.bob}`, 'x-hangar-instance': INST },
    })
    const body = await res.json() as { pending_after: number }
    expect(body.pending_after).toBe(0)
  })
})

// Read events without cancelling the reader so a later read can continue the
// same stream (T4/T13 need "summary, then live").
interface ReadState { reader: ReadableStreamDefaultReader<Uint8Array>; buf: string }
async function readEventsNoCancel(
  stream: ReadableStream<Uint8Array>, n: number, state?: ReadState, timeoutMs = 2000,
): Promise<{ events: SseEvent[]; state: ReadState }> {
  const st = state ?? { reader: stream.getReader(), buf: '' }
  const decoder = new TextDecoder()
  const blocks: string[] = []
  const deadline = Date.now() + timeoutMs
  while (blocks.length < n && Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const timeoutPromise = new Promise<{ value: undefined; done: true }>(resolve =>
      setTimeout(() => resolve({ value: undefined, done: true }), remaining)
    )
    const { value, done } = await Promise.race([st.reader.read(), timeoutPromise])
    if (done) break
    st.buf += decoder.decode(value)
    const parts = st.buf.split('\n\n')
    st.buf = parts.pop() ?? ''
    blocks.push(...parts.filter(p => p.trim().length > 0))
  }
  return { events: parseEvents(blocks).filter(e => e.event !== 'ping'), state: st }
}

// keep the import used even when a test is filtered out
void newMessageId
