/**
 * Per-(team, handle, effectiveLabel) SSE connection refcount (plan §2.1, R5).
 *
 * The presence row for a key is removed only when the LAST connection holding
 * that key closes. This covers the reconnect race in which a peer-agent's new
 * SSE connection is already established while the previous socket's cleanup
 * has not yet run: the late cleanup decrements to 1, not to 0, so the live
 * session's presence row survives.
 *
 * Deliberately in-memory and non-durable: it mirrors live sockets on THIS relay
 * process, and a relay restart drops every SSE connection anyway.
 */
export class ConnectionRegistry {
  private counts = new Map<string, number>()

  private static key(team: string, handle: string, label: string): string {
    // NUL separator: it cannot appear in a handle, a token label, or a ULID,
    // so the composite key is unambiguous however those parts are spelled.
    return `${team}\u0000${handle}\u0000${label}`
  }

  acquire(team: string, handle: string, label: string): void {
    const k = ConnectionRegistry.key(team, handle, label)
    this.counts.set(k, (this.counts.get(k) ?? 0) + 1)
  }

  /** Returns true iff this release closed the LAST connection for the key. */
  release(team: string, handle: string, label: string): boolean {
    const k = ConnectionRegistry.key(team, handle, label)
    const n = this.counts.get(k)
    if (n === undefined) return false
    if (n <= 1) {
      this.counts.delete(k)
      return true
    }
    this.counts.set(k, n - 1)
    return false
  }

  count(team: string, handle: string, label: string): number {
    return this.counts.get(ConnectionRegistry.key(team, handle, label)) ?? 0
  }

  size(): number {
    return this.counts.size
  }
}
