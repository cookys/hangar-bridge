import { describe, it, expect } from 'vitest'
import { ConnectionRegistry } from './connections.ts'

/**
 * P2 §2.1 — per-(label, instance) connection refcount.
 *
 * A single process may hold more than one SSE connection at a time (an old
 * socket that has not finished tearing down while the reconnect already
 * opened a new one). Removing the presence row on the FIRST close would then
 * blank a live session. The row is removed only when the LAST connection for
 * that exact key closes.
 */
describe('ConnectionRegistry', () => {
  it('reports last-release for a single connection', () => {
    const r = new ConnectionRegistry()
    r.acquire('t', 'alice', 'lap#A')
    expect(r.release('t', 'alice', 'lap#A')).toBe(true)
  })

  it('only reports last-release when the final connection closes', () => {
    const r = new ConnectionRegistry()
    r.acquire('t', 'alice', 'lap#A')
    r.acquire('t', 'alice', 'lap#A')
    expect(r.release('t', 'alice', 'lap#A')).toBe(false)
    expect(r.release('t', 'alice', 'lap#A')).toBe(true)
  })

  it('covers the reconnect race: new connection opens before the old one closes', () => {
    const r = new ConnectionRegistry()
    r.acquire('t', 'alice', 'lap#A')   // original
    r.acquire('t', 'alice', 'lap#A')   // reconnect, overlapping
    // the ORIGINAL socket's cleanup now runs late — must NOT remove presence
    expect(r.release('t', 'alice', 'lap#A')).toBe(false)
    expect(r.count('t', 'alice', 'lap#A')).toBe(1)
  })

  it('keeps two instances of one token label independent', () => {
    const r = new ConnectionRegistry()
    r.acquire('t', 'alice', 'lap#A')
    r.acquire('t', 'alice', 'lap#B')
    expect(r.release('t', 'alice', 'lap#A')).toBe(true)
    expect(r.count('t', 'alice', 'lap#B')).toBe(1)
  })

  it('keeps a legacy (no-instance) key independent of an instance key', () => {
    const r = new ConnectionRegistry()
    r.acquire('t', 'alice', 'lap')
    r.acquire('t', 'alice', 'lap#A')
    expect(r.release('t', 'alice', 'lap')).toBe(true)
    expect(r.count('t', 'alice', 'lap#A')).toBe(1)
  })

  it('keeps two handles independent', () => {
    const r = new ConnectionRegistry()
    r.acquire('t', 'alice', 'lap')
    r.acquire('t', 'bob', 'lap')
    expect(r.release('t', 'alice', 'lap')).toBe(true)
    expect(r.count('t', 'bob', 'lap')).toBe(1)
  })

  it('keeps two teams independent', () => {
    const r = new ConnectionRegistry()
    r.acquire('t1', 'alice', 'lap')
    r.acquire('t2', 'alice', 'lap')
    expect(r.release('t1', 'alice', 'lap')).toBe(true)
    expect(r.count('t2', 'alice', 'lap')).toBe(1)
  })

  it('is safe to release an unknown key (never goes negative, never claims last)', () => {
    const r = new ConnectionRegistry()
    expect(r.release('t', 'alice', 'lap')).toBe(false)
    expect(r.count('t', 'alice', 'lap')).toBe(0)
  })

  it('drops the key entirely once the count reaches zero (no unbounded growth)', () => {
    const r = new ConnectionRegistry()
    r.acquire('t', 'alice', 'lap')
    r.release('t', 'alice', 'lap')
    expect(r.size()).toBe(0)
  })
})
