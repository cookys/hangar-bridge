import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { serve, type ServerType } from '@hono/node-server'
import { openDatabase } from '../db/db.ts'
import { MessageStore } from '../messages/store.ts'
import { Fanout } from '../fanout.ts'
import { PresenceRegistry } from '../presence/registry.ts'
import { ClaimStore } from '../claims/store.ts'
import { buildApp } from '../app.ts'
import { generateRawToken, hashToken } from '../auth/hash.ts'
import { seedPeers } from '../auth/peers-file.ts'

/**
 * One process, one stream — at the HTTP level. A peer that opens a second SSE
 * connection with the same x-hangar-instance must end the first: the relay
 * closes it, a message posted afterwards reaches only the newer stream, and
 * /v1/peers reports one subscription for that instance. A different instance
 * under the same handle is a sibling and is left alone.
 */

interface Relay { url: string; server: ServerType; tokens: Record<string, string>; fanout: Fanout }

async function startRelay(handles: string[]): Promise<Relay> {
  const db = openDatabase(':memory:')
  const tokens: Record<string, string> = {}
  seedPeers(db, handles.map(handle => {
    const raw = generateRawToken()
    tokens[handle] = raw
    return { handle, secret_sha256_hex: hashToken(raw).toString('hex'), display_name: handle, subjects: { owned: [], interest: [] } }
  }))
  const fanout = new Fanout()
  const app = buildApp({
    db, store: new MessageStore(db), fanout, presence: new PresenceRegistry(),
    claims: new ClaimStore(db), now: () => new Date(),
  })
  const { server, port } = await new Promise<{ server: ServerType; port: number }>(resolve => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, info => resolve({ server: s, port: info.port }))
  })
  return { url: `http://127.0.0.1:${port}`, server, tokens, fanout }
}

const ULID_A = '01HRK7Y000000000000000000A'
const ULID_B = '01HRK7Y000000000000000000B'

async function openStream(relay: Relay, handle: string, instance: string) {
  const res = await fetch(`${relay.url}/v1/stream`, {
    headers: { authorization: `Bearer ${relay.tokens[handle]}`, 'x-hangar-instance': instance, accept: 'text/event-stream' },
  })
  expect(res.status).toBe(200)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  return {
    reader,
    /** read until a message event arrives, or the stream ends (returns null) */
    async nextMessage(): Promise<string | null> {
      for (;;) {
        const i = buf.indexOf('event: message\n')
        if (i !== -1) {
          const end = buf.indexOf('\n\n', i)
          if (end !== -1) { const block = buf.slice(i, end); buf = buf.slice(end + 2); return block }
        }
        const { value, done } = await reader.read()
        if (done) return null
        buf += decoder.decode(value, { stream: true })
      }
    },
    async ended(): Promise<boolean> {
      const { done } = await reader.read()
      return done
    },
    cancel: () => reader.cancel().catch(() => {}),
  }
}

async function post(relay: Relay, from: string, to: string, content: string) {
  const res = await fetch(`${relay.url}/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${relay.tokens[from]}`, 'content-type': 'application/json', 'idempotency-key': content },
    body: JSON.stringify({ to, kind: 'chat', content }),
  })
  expect(res.status).toBe(201)
  return await res.json() as { id: string }
}

async function peers(relay: Relay, as: string) {
  const res = await fetch(`${relay.url}/v1/peers`, { headers: { authorization: `Bearer ${relay.tokens[as]}` } })
  return await res.json() as { handle: string; subscribed: number; sessions: { instance?: string; subscriptions?: number }[] }[]
}

const settle = (ms = 50) => new Promise(r => setTimeout(r, ms))

describe('GET /v1/stream — a newer connection from the same instance supersedes the older', () => {
  let relay: Relay
  beforeEach(async () => { relay = await startRelay(['alice', 'bob']) })
  afterEach(async () => { await new Promise<void>(r => relay.server.close(() => r())) })

  it('ends the old stream, delivers once, and reports one subscription', async () => {
    const gen1 = await openStream(relay, 'bob', ULID_A)
    await settle()
    const gen2 = await openStream(relay, 'bob', ULID_A)
    await settle()
    // the superseded stream is closed by the relay
    expect(await gen1.ended()).toBe(true)
    // a message now reaches exactly one subscriber, not one per generation
    expect(relay.fanout.instanceCounts('hangar', 'bob').get(ULID_A)).toBe(1)
    await post(relay, 'alice', 'bob', 'after-supersede')
    expect(await gen2.nextMessage()).toContain('after-supersede')
    // and the relay says so
    await fetch(`${relay.url}/v1/presence`, {
      method: 'POST',
      headers: { authorization: `Bearer ${relay.tokens.bob}`, 'content-type': 'application/json' },
      body: JSON.stringify({ summary: 'here', instance: ULID_A }),
    })
    const bob = (await peers(relay, 'alice')).find(p => p.handle === 'bob')!
    expect(bob.subscribed).toBe(1)
    expect(bob.sessions.find(s => s.instance === ULID_A)?.subscriptions).toBe(1)
    await gen2.cancel()
  })

  it('leaves a sibling instance under the same handle connected', async () => {
    const sibling = await openStream(relay, 'bob', ULID_B)
    const gen1 = await openStream(relay, 'bob', ULID_A)
    await settle()
    const gen2 = await openStream(relay, 'bob', ULID_A)
    await settle()
    expect(await gen1.ended()).toBe(true)
    await post(relay, 'alice', 'bob', 'to-both')
    expect(await sibling.nextMessage()).toContain('to-both')
    expect(await gen2.nextMessage()).toContain('to-both')
    expect(relay.fanout.instanceCounts('hangar', 'bob').get(ULID_A)).toBe(1)
    expect(relay.fanout.instanceCounts('hangar', 'bob').get(ULID_B)).toBe(1)
    await sibling.cancel(); await gen2.cancel()
  })

  it('a session with presence but no stream shows subscriptions 0', async () => {
    await fetch(`${relay.url}/v1/presence`, {
      method: 'POST',
      headers: { authorization: `Bearer ${relay.tokens.bob}`, 'content-type': 'application/json' },
      body: JSON.stringify({ summary: 'ghost', instance: ULID_B }),
    })
    const bob = (await peers(relay, 'alice')).find(p => p.handle === 'bob')!
    expect(bob.subscribed).toBe(0)
    expect(bob.sessions.find(s => s.instance === ULID_B)?.subscriptions).toBe(0)
  })
})
