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
})
