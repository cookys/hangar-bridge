import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchMock = vi.fn()
vi.mock('undici', () => ({ fetch: (...args: unknown[]) => fetchMock(...args) }))

const { StreamClient } = await import('./stream.ts')

/**
 * P2 §2.1 — the instance id must reach the relay on the SSE connection too,
 * not only on POST /v1/presence: the relay's cleanup path derives the presence
 * row key from THIS header, and it must match what the presence write used.
 *
 * It must also be CONSTANT across reconnects. A per-connection id would make
 * the relay's refcount count every reconnect as a fresh instance, so the
 * refcount could never aggregate and dead rows would pile up.
 */
describe('StreamClient — x-hangar-instance', () => {
  beforeEach(() => { fetchMock.mockReset() })

  const headersOf = (call: number): Record<string, string> =>
    (fetchMock.mock.calls[call]![1] as { headers: Record<string, string> }).headers

  it('sends the instance id as a header on connect', async () => {
    fetchMock.mockResolvedValue({ status: 500, body: null })
    const c = new StreamClient({
      relayUrl: 'http://relay', token: 'tok', instanceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      sinceCursor: () => undefined, onEnvelope: () => {}, onAuthError: () => {},
      reconnectBaseMs: 1, reconnectMaxMs: 1,
    })
    const run = c.start()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    c.stop()
    await run
    expect(headersOf(0)['x-hangar-instance']).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV')
  })

  it('sends the SAME instance id on every reconnect', async () => {
    fetchMock.mockResolvedValue({ status: 500, body: null })
    const c = new StreamClient({
      relayUrl: 'http://relay', token: 'tok', instanceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      sinceCursor: () => undefined, onEnvelope: () => {}, onAuthError: () => {},
      reconnectBaseMs: 1, reconnectMaxMs: 1,
    })
    const run = c.start()
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3))
    c.stop()
    await run
    const seen = fetchMock.mock.calls.map((_, i) => headersOf(i)['x-hangar-instance'])
    expect(new Set(seen)).toEqual(new Set(['01ARZ3NDEKTSV4RRFFQ69G5FAV']))
  })

  it('omits the header entirely when no instance is configured (legacy client)', async () => {
    fetchMock.mockResolvedValue({ status: 500, body: null })
    const c = new StreamClient({
      relayUrl: 'http://relay', token: 'tok',
      sinceCursor: () => undefined, onEnvelope: () => {}, onAuthError: () => {},
      reconnectBaseMs: 1, reconnectMaxMs: 1,
    })
    const run = c.start()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    c.stop()
    await run
    expect(headersOf(0)['x-hangar-instance']).toBeUndefined()
  })

  it('backs off repeated delivery failures instead of resetting on every successful open', async () => {
    const delays: number[] = []
    const envelope = {
      id: 'msg_01M1938S9B9RJD7MHG6K6J4R7Z', v: 2, team: 'hangar',
      from: 'alice', to: 'bob', subject: null, in_reply_to: null, thread_root: null,
      kind: 'chat', content: 'retry me', meta: {},
      sent_at: '2026-08-30T10:26:01.940Z', delivered_at: null,
    }
    fetchMock.mockImplementation(() => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`event: message\ndata: ${JSON.stringify(envelope)}\n\n`))
          controller.close()
        },
      })
      return Promise.resolve({ status: 200, body })
    })
    let c: InstanceType<typeof StreamClient>
    c = new StreamClient({
      relayUrl: 'http://relay', token: 'tok', sinceCursor: () => undefined,
      onEnvelope: () => { throw new Error('target_offline') }, onAuthError: () => {},
      reconnectBaseMs: 20, reconnectMaxMs: 80,
      wait: async ms => { delays.push(ms); if (delays.length >= 3) c.stop() },
    })
    await c.start()
    expect(delays).toEqual([20, 40, 80])
  })

  it('resets stale failures after a stable connection ending in clean EOF', async () => {
    let now = 0
    let opens = 0
    const delays: number[] = []
    fetchMock.mockImplementation(() => {
      opens += 1
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close()
        },
      })
      return Promise.resolve({ status: 200, body })
    })
    let c: InstanceType<typeof StreamClient>
    c = new StreamClient({
      relayUrl: 'http://relay', token: 'tok', sinceCursor: () => undefined,
      onEnvelope: () => {}, onAuthError: () => {},
      now: () => {
        const value = now
        if (opens === 3) now += 31_000
        return value
      },
      reconnectBaseMs: 20, reconnectMaxMs: 80, stableConnectionMs: 30_000,
      wait: async ms => { delays.push(ms); if (delays.length >= 3) c.stop() },
    })
    await c.start()
    expect(delays).toEqual([20, 40, 20])
  })

  it('stop interrupts a production reconnect wait', async () => {
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    fetchMock.mockResolvedValue({ status: 500, body: null })
    const c = new StreamClient({
      relayUrl: 'http://relay', token: 'tok', sinceCursor: () => undefined,
      onEnvelope: () => {}, onAuthError: () => {}, reconnectBaseMs: 30_000,
    })
    const run = c.start()
    await vi.waitFor(() => expect(
      timeoutSpy.mock.calls.some(([, ms]) => ms === 30_000),
    ).toBe(true))
    c.stop()
    await expect(run).resolves.toBeUndefined()
    timeoutSpy.mockRestore()
  })
})
