import { describe, it, expect, beforeEach } from 'vitest'
import { newMessageId } from '@hangar-bridge/shared'
import { openDatabase, type Db } from '../../src/db/db.ts'
import { MessageStore } from '../../src/messages/store.ts'
import { Fanout } from '../../src/fanout.ts'
import { PresenceRegistry } from '../../src/presence/registry.ts'
import { ClaimStore } from '../../src/claims/store.ts'
import { buildApp } from '../../src/app.ts'
import { seedPeerSecrets } from './_seed.ts'

async function readNEvents(stream: ReadableStream<Uint8Array>, n: number, timeoutMs = 300): Promise<string[]> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const events: string[] = []
  let buf = ''
  const deadline = Date.now() + timeoutMs
  while (events.length < n && Date.now() < deadline) {
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
    events.push(...parts.filter(p => p.trim().length > 0))
  }
  try { await reader.cancel() } catch { /* ignore */ }
  return events
}

describe('legacy mode wire compatibility', () => {
  let db: Db
  let store: MessageStore
  let app: ReturnType<typeof buildApp>
  let tok: Record<string, string>

  beforeEach(() => {
    db = openDatabase(':memory:')
    const peers = seedPeerSecrets(db, ['alice', 'bob'])
    tok = { alice: peers.alice!.token, bob: peers.bob!.token }
    store = new MessageStore(db)
    app = buildApp({
      db, store, fanout: new Fanout(), presence: new PresenceRegistry(),
      claims: new ClaimStore(db), now: () => new Date(),
    })
  })

  const headers = (who: string, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${tok[who]}`,
    'content-type': 'application/json',
    ...extra,
  })

  it('inbox and poll envelopes do not expose group', async () => {
    const mailboxId = newMessageId()
    db.prepare(`
      INSERT INTO message(id,v,team_id,from_handle,to_handle,thread_root,kind,content,meta_json,sent_at,delivered_at)
      VALUES (?,2,'hangar','bob','@mailbox:alice',?,'chat','mail','{}','2026-09-01T00:00:00.000Z',NULL)
    `).run(mailboxId, mailboxId)

    await app.request('/v1/messages', {
      method: 'POST',
      headers: headers('alice'),
      body: JSON.stringify({ to: 'bob', kind: 'chat', content: 'poll me' }),
    })

    const inbox = await (await app.request('/v1/inbox', { headers: headers('alice') })).json() as { messages: Array<Record<string, unknown>> }
    expect(inbox.messages).toHaveLength(1)
    expect('group' in inbox.messages[0]!).toBe(false)

    const poll = await (await app.request('/v1/messages', { headers: headers('bob') })).json() as { messages: Array<Record<string, unknown>> }
    expect(poll.messages).toHaveLength(1)
    expect('group' in poll.messages[0]!).toBe(false)
  })

  it('presence without summary is a validation error', async () => {
    const res = await app.request('/v1/presence', {
      method: 'POST',
      headers: headers('alice'),
      body: JSON.stringify({ repo: 'hangar-bridge' }),
    })
    expect(res.status).toBe(400)
  })

  it('cold-start stream does not replay a sender its own queued broadcast', async () => {
    const instance = '01HRK7Y0000000000000000000'
    await app.request('/v1/messages', {
      method: 'POST',
      headers: headers('alice', { 'x-hangar-instance': instance }),
      body: JSON.stringify({ to: '@team', kind: 'chat', content: 'self broadcast' }),
    })

    const streamRes = await app.request('/v1/stream', {
      headers: headers('alice', { 'x-hangar-instance': instance }),
    })
    expect(streamRes.status).toBe(200)
    const events = await readNEvents(streamRes.body!, 1)
    expect(events.some(e => e.includes('event: message'))).toBe(false)
  })
})
