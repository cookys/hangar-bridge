export interface DispatchTrackerOpts { ttlMs: number }

interface Entry {
  dispatch_msg_id: string
  peer_handle: string
  dispatched_at: number
  expires_at: number
}

export class DispatchTracker {
  private map = new Map<string, Entry>()

  constructor(private opts: DispatchTrackerOpts) {}

  recordOutgoing(correlation_id: string, dispatch_msg_id: string, peer_handle: string): void {
    const now = Date.now()
    this.map.set(correlation_id, {
      dispatch_msg_id,
      peer_handle,
      dispatched_at: now,
      expires_at: now + this.opts.ttlMs,
    })
    this.gc()
  }

  msgIdFor(correlation_id: string): string | undefined {
    const v = this.map.get(correlation_id)
    if (!v) return undefined
    if (v.expires_at < Date.now()) { this.map.delete(correlation_id); return undefined }
    return v.dispatch_msg_id
  }

  peerFor(correlation_id: string): string | undefined {
    const v = this.map.get(correlation_id)
    if (!v) return undefined
    if (v.expires_at < Date.now()) { this.map.delete(correlation_id); return undefined }
    return v.peer_handle
  }

  has(correlation_id: string): boolean {
    return this.msgIdFor(correlation_id) !== undefined
  }

  size(): number {
    this.gc()
    return this.map.size
  }

  private gc(): void {
    const now = Date.now()
    for (const [k, v] of this.map) if (v.expires_at < now) this.map.delete(k)
  }
}
