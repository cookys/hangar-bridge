import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type Db } from '../../src/db/db.ts'
import { MessageStore } from '../../src/messages/store.ts'
import { Fanout } from '../../src/fanout.ts'
import { PresenceRegistry } from '../../src/presence/registry.ts'
import { buildApp } from '../../src/app.ts'
import { seedPeerSecrets } from './_seed.ts'

// Read up to n SSE events (or until timeout). Short timeout for "must NOT arrive".
async function readEvents(stream: ReadableStream<Uint8Array>, n: number, timeoutMs = 1500): Promise<string[]> {
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

// Subscribe-side (receive-half) ACL: deliverable() ownership + interest gate, and the
// cold-start drain advancing past non-deliverable rows. Messages are planted via
// store.insert directly to bypass the publish gate (so we can stage non-owned rows).
describe('GET /v1/stream — subject ACL (receive half)', () => {
  let db: Db
  let store: MessageStore
  let app: ReturnType<typeof buildApp>
  let tokBob: string
  const own = (handle: string, owned: string[], interest: string[] = []) =>
    db.prepare('UPDATE human SET subjects=? WHERE handle=?').run(JSON.stringify({ owned, interest }), handle)

  beforeEach(() => {
    db = openDatabase(':memory:')
    const peers = seedPeerSecrets(db, ['alice', 'bob'])
    tokBob = peers.bob!.token
    store = new MessageStore(db)
    app = buildApp({ db, store, fanout: new Fanout(), presence: new PresenceRegistry(), now: () => new Date() })
  })

  const openBob = (headers: Record<string, string> = {}) =>
    app.request('/v1/stream', { headers: { authorization: `Bearer ${tokBob}`, ...headers } })

  it('an owner receives a subjected message on cold-start', async () => {
    own('bob', ['mple2'])
    store.insert('hangar', 'alice', { to: 'bob', subject: 'mple2.command', kind: 'task_dispatch', content: 'go' })
    const res = await openBob()
    const events = await readEvents(res.body!, 1)
    expect(events.some(e => e.includes('"subject":"mple2.command"'))).toBe(true)
  })

  it('a NON-owner does not receive a subjected message (gate drops it; null-subject still flows)', async () => {
    // bob owns nothing → mple2.x is non-deliverable; a null-subject control must still arrive.
    store.insert('hangar', 'alice', { to: 'bob', subject: 'mple2.secret', kind: 'task_dispatch', content: 'leak' })
    store.insert('hangar', 'alice', { to: 'bob', kind: 'chat', content: 'ok-control' })
    const res = await openBob()
    const events = await readEvents(res.body!, 2)
    expect(events.some(e => e.includes('ok-control'))).toBe(true)
    expect(events.some(e => e.includes('mple2.secret') || e.includes('leak'))).toBe(false)
  })

  it('interest narrows within owned namespace (status> matches, command does not)', async () => {
    own('bob', ['mple2'])
    store.insert('hangar', 'alice', { to: 'bob', subject: 'mple2.command', kind: 'task_dispatch', content: 'cmd' })
    store.insert('hangar', 'alice', { to: 'bob', subject: 'mple2.status.beat', kind: 'task_dispatch', content: 'beat' })
    const res = await openBob({ 'x-hangar-subjects': 'mple2.status>' })
    const events = await readEvents(res.body!, 2)
    expect(events.some(e => e.includes('"content":"beat"'))).toBe(true)
    expect(events.some(e => e.includes('"content":"cmd"'))).toBe(false)
  })

  it('cold-start drain reaches a deliverable row sitting BEHIND non-deliverable ones (B3)', async () => {
    own('bob', ['mple2'], [])            // owns mple2; interest empty = all owned + null
    own('bob', ['mple2'], ['mple2.keep>']) // narrow so mple2.skip.* are owned-but-filtered (non-deliverable)
    for (let i = 0; i < 5; i++) {
      store.insert('hangar', 'alice', { to: 'bob', subject: `mple2.skip.n${i}`, kind: 'task_dispatch', content: `skip${i}` })
    }
    store.insert('hangar', 'alice', { to: 'bob', subject: 'mple2.keep.x', kind: 'task_dispatch', content: 'KEEP' })
    const res = await openBob({ 'x-hangar-subjects': 'mple2.keep>' })
    const events = await readEvents(res.body!, 1)
    expect(events.some(e => e.includes('"content":"KEEP"'))).toBe(true)
    expect(events.some(e => e.includes('skip'))).toBe(false)
  })
})
