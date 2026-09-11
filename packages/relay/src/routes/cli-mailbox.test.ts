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
 * REPLY_ROUTING_SPEC.md §6.5 / §8.2: a shell outside any pane sends with
 * `x-hangar-instance: ~cli`, the operator mailbox identity. A reply to such a
 * send must take the mailbox branch (durable, `@mailbox:<handle>`, pulled with
 * GET /v1/inbox) — never the session branch, which fans out to an instance that
 * was never a subscriber and reports `matched: 0 / sender_state: offline` to a
 * replier who then believes the reply was delivered.
 *
 * Third field reproduction 2026-09-12 (hangar BACKLOG "A reply to an
 * `ephemeral` peer message always lands on nobody"): dotfiles `fleet send`
 * stamped a per-host ULID because /v1/messages rejected `~cli`.
 */

interface Relay { url: string; server: ServerType; tokens: Record<string, string> }

async function startRelay(handles: string[]): Promise<Relay> {
  const db = openDatabase(':memory:')
  const tokens: Record<string, string> = {}
  seedPeers(db, handles.map(handle => {
    const raw = generateRawToken(); tokens[handle] = raw
    return { handle, secret_sha256_hex: hashToken(raw).toString('hex'), display_name: handle, subjects: { owned: [], interest: [] } }
  }))
  const app = buildApp({
    db, store: new MessageStore(db), fanout: new Fanout(), presence: new PresenceRegistry(),
    claims: new ClaimStore(db), now: () => new Date(), addressRules: 'on',
  })
  const { server, port } = await new Promise<{ server: ServerType; port: number }>(resolve => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, info => resolve({ server: s, port: info.port }))
  })
  return { url: `http://127.0.0.1:${port}`, server, tokens }
}

const BOB_INST = '01HRK7Y000000000000000000B'
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

describe('~cli sender → reply lands in the operator mailbox (§8.2)', () => {
  let relay: Relay
  beforeEach(async () => { relay = await startRelay(['alice', 'bob']) })
  afterEach(async () => { await new Promise<void>(r => relay.server.close(() => r())) })

  it('POST /v1/messages accepts x-hangar-instance: ~cli and the reply is durable in GET /v1/inbox', async () => {
    const bob = await openStream(relay, 'bob', BOB_INST)
    await new Promise(r => setTimeout(r, 50))
    try {

    // alice's shell (no pane) sends to bob's one live session. No return
    // selector: `~none` is the "pane attach failed, one-way" case (§8.1) and
    // would tombstone the route as parent_unaddressable; the mailbox case is
    // identity `~cli` with no selector at all (§8.2).
    const sendRes = await fetch(`${relay.url}/v1/messages`, {
      method: 'POST',
      headers: { ...auth(relay, 'alice'), 'idempotency-key': 'k1', 'x-hangar-instance': '~cli' },
      body: JSON.stringify({ to: 'bob', kind: 'chat', content: 'from a shell', to_filter: { instance: BOB_INST } }),
    })
    expect(sendRes.status).toBe(201)
    const sent = await sendRes.json() as { id: string; matched: number; meta: Record<string, string> }
    expect(sent.matched).toBe(1)
    expect(sent.meta['sender_instance']).toBe('~cli')

    const frame = await bob.next()
    expect(frame).toContain('from a shell')
    const msgId = (frame.match(/"id":"(msg_[0-9A-HJKMNP-TV-Z]{26})"/) ?? [])[1]!
    expect(msgId).toBe(sent.id)

    // bob replies from his session. Mailbox branch: nothing live, one durable mailbox row.
    const replyRes = await fetch(`${relay.url}/v1/replies`, {
      method: 'POST',
      headers: { ...auth(relay, 'bob'), 'idempotency-key': 'r1', 'x-hangar-instance': BOB_INST },
      body: JSON.stringify({ in_reply_to: msgId, content: 'back to your shell' }),
    })
    expect(replyRes.status).toBe(200)
    const reply = await replyRes.json() as { to: string; live: string[]; durable: string[]; matched: number; sender_state?: string }
    expect(reply.to).toBe('@mailbox:alice')
    expect(reply.live).toEqual([])
    expect(reply.durable).toEqual(['alice~cli'])
    expect(reply.sender_state).toBeUndefined()

    // alice's shell pulls it.
    const inboxRes = await fetch(`${relay.url}/v1/inbox`, { headers: auth(relay, 'alice') })
    expect(inboxRes.status).toBe(200)
    const inbox = await inboxRes.json() as { messages: Array<{ content: string; to: string }> }
    expect(inbox.messages.map(m => m.content)).toEqual(['back to your shell'])
    } finally {
      bob.cancel()
    }
  })

  it('~cli is never a valid to_filter.instance (§6.5 reserved_instance)', async () => {
    const res = await fetch(`${relay.url}/v1/messages`, {
      method: 'POST',
      headers: { ...auth(relay, 'alice'), 'idempotency-key': 'k2', 'x-hangar-instance': BOB_INST },
      body: JSON.stringify({ to: 'bob', kind: 'chat', content: 'x', to_filter: { instance: '~cli' } }),
    })
    expect(res.status).toBe(400)
  })

  it('GET /v1/messages (poll) accepts ~cli as the poller instance under address rules', async () => {
    const res = await fetch(`${relay.url}/v1/messages?limit=5`, { headers: { ...auth(relay, 'alice'), 'x-hangar-instance': '~cli' } })
    expect(res.status).toBe(200)
  })
})
