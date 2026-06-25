import { describe, it, expect, beforeEach } from 'vitest'
import { openDatabase, type Db } from '../../src/db/db.ts'
import { MessageStore } from '../../src/messages/store.ts'
import { Fanout } from '../../src/fanout.ts'
import { PresenceRegistry } from '../../src/presence/registry.ts'
import { buildApp } from '../../src/app.ts'
import { seedPeerSecrets } from './_seed.ts'

async function readNEvents(stream: ReadableStream<Uint8Array>, n: number, timeoutMs = 1000): Promise<string[]> {
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

describe('cross-project-isolation integration', () => {
  let db: Db
  let app: ReturnType<typeof buildApp>
  let tok: { boxA: string; boxB: string }

  beforeEach(() => {
    db = openDatabase(':memory:')
    // Seed the database with two handles: box-a and box-b
    const peers = seedPeerSecrets(db, ['box-a', 'box-b'])
    tok = { boxA: peers['box-a']!.token, boxB: peers['box-b']!.token }
    app = buildApp({
      db,
      store: new MessageStore(db),
      fanout: new Fanout(),
      presence: new PresenceRegistry(),
      now: () => new Date()
    })
  })

  it('delivers direct messages only to the targeted peer handle', async () => {
    // Open streams for both box-a and box-b
    const resA = await app.request('/v1/stream', { headers: { authorization: `Bearer ${tok.boxA}` } })
    const resB = await app.request('/v1/stream', { headers: { authorization: `Bearer ${tok.boxB}` } })
    expect(resA.status).toBe(200)
    expect(resB.status).toBe(200)

    // Send a message to box-a from box-b
    const postRes = await app.request('/v1/messages', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tok.boxB}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ to: 'box-a', kind: 'chat', content: 'hello box-a' })
    })
    expect(postRes.status).toBe(201)

    // Read events from box-a stream
    const eventsA = await readNEvents(resA.body!, 1)
    const msgA = eventsA.find(e => e.includes('event: message'))
    expect(msgA).toBeDefined()
    expect(msgA!).toContain('"from":"box-b"')
    expect(msgA!).toContain('"content":"hello box-a"')

    // Read events from box-b stream, ensuring no messages were delivered to box-b
    const eventsB = await readNEvents(resB.body!, 1, 300)
    const msgB = eventsB.find(e => e.includes('event: message'))
    expect(msgB).toBeUndefined()
  })
})
