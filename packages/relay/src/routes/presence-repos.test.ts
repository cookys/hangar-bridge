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
 * A switchboard courier serves several projects on one box. It publishes them
 * as `repos`, and a project-scoped send (`to_filter.repo`) must match it for
 * any of them — while a session publishing only `repo` keeps today's exact
 * match.
 */

interface Relay { url: string; server: ServerType; tokens: Record<string, string> }

async function startRelay(handles: string[]): Promise<Relay> {
  const db = openDatabase(':memory:')
  const tokens: Record<string, string> = {}
  seedPeers(db, handles.map(handle => {
    const raw = generateRawToken(); tokens[handle] = raw
    return { handle, secret_sha256_hex: hashToken(raw).toString('hex'), display_name: handle, subjects: { owned: [], interest: [] } }
  }))
  const app = buildApp({ db, store: new MessageStore(db), fanout: new Fanout(), presence: new PresenceRegistry(), claims: new ClaimStore(db), now: () => new Date() })
  const { server, port } = await new Promise<{ server: ServerType; port: number }>(resolve => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, info => resolve({ server: s, port: info.port }))
  })
  return { url: `http://127.0.0.1:${port}`, server, tokens }
}

const INST = '01HRK7Y000000000000000000C'
const auth = (relay: Relay, h: string) => ({ authorization: `Bearer ${relay.tokens[h]}`, 'content-type': 'application/json' })

async function openStream(relay: Relay, handle: string, instance: string) {
  const res = await fetch(`${relay.url}/v1/stream`, { headers: { ...auth(relay, handle), 'x-hangar-instance': instance, accept: 'text/event-stream' } })
  expect(res.status).toBe(200)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  return {
    async next(): Promise<string> {
      for (;;) {
        const i = buf.indexOf('event: message\n')
        if (i !== -1) { const end = buf.indexOf('\n\n', i); if (end !== -1) { const b = buf.slice(i, end); buf = buf.slice(end + 2); return b } }
        const { value, done } = await reader.read()
        if (done) return ''
        buf += decoder.decode(value, { stream: true })
      }
    },
    cancel: () => reader.cancel().catch(() => {}),
  }
}

async function send(relay: Relay, from: string, body: Record<string, unknown>) {
  const res = await fetch(`${relay.url}/v1/messages`, { method: 'POST', headers: { ...auth(relay, from), 'idempotency-key': String(Math.random()) }, body: JSON.stringify(body) })
  expect(res.status).toBe(201)
  return await res.json() as { matched?: number }
}

describe('presence repos — a courier that serves several projects', () => {
  let relay: Relay
  beforeEach(async () => { relay = await startRelay(['alice', 'courier']) })
  afterEach(async () => { await new Promise<void>(r => relay.server.close(() => r())) })

  it('matches to_filter.repo against any published repo, and shows repos in /v1/peers', async () => {
    const stream = await openStream(relay, 'courier', INST)
    await new Promise(r => setTimeout(r, 50))
    const pres = await fetch(`${relay.url}/v1/presence`, { method: 'POST', headers: auth(relay, 'courier'), body: JSON.stringify({ summary: 'switchboard', instance: INST, repos: ['revival.3d', 'wasm-yolo'] }) })
    expect(pres.status).toBe(200)

    let r = await send(relay, 'alice', { to: '@team', kind: 'chat', content: 'for-wasm', to_filter: { repo: 'wasm-yolo' } })
    expect(r.matched).toBe(1)
    expect(await stream.next()).toContain('for-wasm')

    r = await send(relay, 'alice', { to: '@team', kind: 'chat', content: 'for-other', to_filter: { repo: 'other' } })
    expect(r.matched).toBe(0)

    const peers = await (await fetch(`${relay.url}/v1/peers`, { headers: auth(relay, 'alice') })).json() as { handle: string; sessions: { repos?: string[] }[] }[]
    expect(peers.find(p => p.handle === 'courier')?.sessions[0]?.repos).toEqual(['revival.3d', 'wasm-yolo'])
    await stream.cancel()
  })

  it('rejects an oversized or malformed repos list', async () => {
    const bad = await fetch(`${relay.url}/v1/presence`, { method: 'POST', headers: auth(relay, 'courier'), body: JSON.stringify({ summary: 's', repos: 'revival.3d' }) })
    expect(bad.status).toBe(400)
    const big = await fetch(`${relay.url}/v1/presence`, { method: 'POST', headers: auth(relay, 'courier'), body: JSON.stringify({ summary: 's', repos: Array.from({ length: 65 }, (_, i) => `r${i}`) }) })
    expect(big.status).toBe(400)
  })
})
