import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Envelope } from '@hangar-bridge/shared'
import { StreamClient } from './stream.ts'

/**
 * StreamClient against a real (loopback) SSE server, because both bugs it
 * guards against are socket-level facts a mocked fetch cannot show:
 *
 *   - a reconnect after a delivery error must CLOSE the previous connection;
 *     the old code replaced the AbortController without aborting it, so the
 *     relay kept one subscriber per generation and fanned every message out
 *     to all of them (twgs-revival, 2026-09-02: 6 → 10 copies);
 *   - an envelope the final mile keeps refusing must eventually be skipped,
 *     not replayed forever at the reconnect backoff.
 */

const envelope = (id: string): Envelope => ({
  id: `msg_01HRK7Y000000000000000000${id}`, v: 2,
  team: 'hangar', from: 'alice', to: 'bob', subject: null,
  in_reply_to: null, thread_root: null, kind: 'chat', content: `body ${id}`, meta: {},
  sent_at: '2026-01-01T00:00:00.000Z', delivered_at: null,
})

const sse = (e: Envelope) => `event: message\ndata: ${JSON.stringify(e)}\n\n`

interface FakeRelay {
  server: Server
  url: string
  /** connections currently open, and the most ever open at once */
  open: number
  maxOpen: number
  connections: number
  close: () => Promise<void>
}

function startRelay(onConnection: (write: (s: string) => void, n: number) => void): Promise<FakeRelay> {
  const relay = { open: 0, maxOpen: 0, connections: 0 } as FakeRelay
  relay.server = createServer((req, res) => {
    relay.connections++
    relay.open++
    relay.maxOpen = Math.max(relay.maxOpen, relay.open)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write(': hello\n\n')
    req.on('close', () => { relay.open-- })
    onConnection(s => { res.write(s) }, relay.connections)
  })
  return new Promise(resolve => {
    relay.server.listen(0, '127.0.0.1', () => {
      const { port } = relay.server.address() as AddressInfo
      relay.url = `http://127.0.0.1:${port}`
      relay.close = () => new Promise(r => { relay.server.closeAllConnections(); relay.server.close(() => r()) })
      resolve(relay)
    })
  })
}

const settle = (ms = 30) => new Promise(r => setTimeout(r, ms))

describe('StreamClient (loopback SSE)', () => {
  let relay: FakeRelay
  let client: StreamClient | null = null
  afterEach(async () => { client?.stop(); await relay.close() })
  beforeEach(() => { client = null })

  it('closes the previous connection before reconnecting after a delivery error', async () => {
    // Every connection replays A (the relay would, since the cursor did not advance).
    relay = await startRelay(write => { write(sse(envelope('A'))) })
    let failures = 0
    client = new StreamClient({
      relayUrl: relay.url, token: 't',
      sinceCursor: () => undefined,
      onEnvelope: async () => { failures++; throw new Error('final mile refused') },
      onAuthError: () => {},
      maxDeliveryAttempts: 0,               // unbounded: we are testing the socket, not the cap
      wait: () => settle(40),               // give the server time to observe the close
    })
    void client.start()
    // wait until at least three generations have connected
    for (let i = 0; i < 50 && relay.connections < 3; i++) await settle(20)
    expect(relay.connections).toBeGreaterThanOrEqual(3)
    expect(failures).toBeGreaterThanOrEqual(3)
    // At most a brief overlap while the server observes the abort — never a
    // generation per reconnect.
    expect(relay.maxOpen).toBeLessThanOrEqual(2)
    // The whole point: stopping the client leaves NOTHING open. Before the fix
    // only the latest generation was aborted; the earlier ones stayed
    // established until garbage collection, i.e. `open` would stay ≥ 2 here.
    client.stop(); client = null
    for (let i = 0; i < 50 && relay.open > 0; i++) await settle(20)
    expect(relay.open).toBe(0)
  })

  it('gives up on an envelope after maxDeliveryAttempts and continues with the next', async () => {
    // Each connection replays A then sends B — as the relay does when the
    // cursor never advanced past A.
    relay = await startRelay(write => { write(sse(envelope('A'))); write(sse(envelope('B'))) })
    const delivered: string[] = []
    const gaveUp: string[] = []
    client = new StreamClient({
      relayUrl: relay.url, token: 't',
      sinceCursor: () => undefined,
      onEnvelope: async e => {
        if (e.id.endsWith('A')) throw new Error('final mile refused')
        delivered.push(e.id)
      },
      onAuthError: () => {},
      onGiveUp: e => { gaveUp.push(e.id) },
      maxDeliveryAttempts: 3,
      wait: () => settle(10),
    })
    void client.start()
    for (let i = 0; i < 100 && delivered.length === 0; i++) await settle(20)
    expect(gaveUp).toEqual([envelope('A').id])
    expect(delivered).toEqual([envelope('B').id])
    // Three attempts = three connections; B arrived on the third, no fourth reconnect needed.
    expect(relay.connections).toBe(3)
    expect(relay.maxOpen).toBe(1)
  })

  it('a give-up observer that throws does not break the stream', async () => {
    relay = await startRelay(write => { write(sse(envelope('A'))); write(sse(envelope('B'))) })
    const delivered: string[] = []
    client = new StreamClient({
      relayUrl: relay.url, token: 't',
      sinceCursor: () => undefined,
      onEnvelope: async e => { if (e.id.endsWith('A')) throw new Error('nope'); delivered.push(e.id) },
      onAuthError: () => {},
      onGiveUp: () => { throw new Error('observer bug') },
      maxDeliveryAttempts: 1,
      wait: () => settle(10),
    })
    void client.start()
    for (let i = 0; i < 100 && delivered.length === 0; i++) await settle(20)
    expect(delivered).toEqual([envelope('B').id])
    expect(relay.connections).toBe(1)
  })
})
