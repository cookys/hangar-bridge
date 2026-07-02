import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'

export interface DispatchTrackerOpts {
  ttlMs: number
  /**
   * Optional path to a JSON file backing the correlation store. When set, in-flight
   * {correlation_id → dispatch_msg_id, peer} correlations survive a peer-agent
   * restart: the map is loaded from disk on construction (dropping already-expired
   * entries) and re-persisted on every mutation. Without it the tracker is purely
   * in-memory (legacy behaviour) — a restart between dispatch and its late
   * task_result would orphan the result (inbound.ts logs `dispatch_orphan`).
   *
   * The peer-agent has no SQLite dependency (only the relay does), so a small atomic
   * JSON file is the right disk-backed store here.
   */
  persistPath?: string
}

interface Entry {
  dispatch_msg_id: string
  peer_handle: string
  dispatched_at: number
  expires_at: number
}

export class DispatchTracker {
  private map = new Map<string, Entry>()

  constructor(private opts: DispatchTrackerOpts) {
    if (opts.persistPath) this.load()
  }

  recordOutgoing(correlation_id: string, dispatch_msg_id: string, peer_handle: string): void {
    const now = Date.now()
    this.map.set(correlation_id, {
      dispatch_msg_id,
      peer_handle,
      dispatched_at: now,
      expires_at: now + this.opts.ttlMs,
    })
    this.gc()
    this.persist()
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

  /**
   * Load correlations from disk, discarding any that already expired. Best-effort:
   * a missing/corrupt/unreadable file starts an empty tracker (same fallback posture
   * as config loading) rather than crashing the peer-agent on startup.
   */
  private load(): void {
    const path = this.opts.persistPath!
    if (!existsSync(path)) return
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Entry>
      const now = Date.now()
      for (const [k, v] of Object.entries(raw)) {
        if (
          v && typeof v.dispatch_msg_id === 'string' && typeof v.peer_handle === 'string'
          && typeof v.expires_at === 'number' && v.expires_at >= now
        ) {
          this.map.set(k, v)
        }
      }
    } catch { /* corrupt/unreadable → start empty */ }
  }

  /**
   * Atomically persist the live map (write temp + rename) so a crash mid-write can
   * never leave a truncated JSON file. Best-effort: a write failure is swallowed —
   * durability is a nice-to-have and must not break the live in-memory correlation
   * or the dispatch tool call that triggered it.
   */
  private persist(): void {
    const path = this.opts.persistPath
    if (!path) return
    try {
      const obj: Record<string, Entry> = {}
      for (const [k, v] of this.map) obj[k] = v
      const tmp = `${path}.tmp`
      writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 })
      renameSync(tmp, path)
    } catch { /* best-effort durability */ }
  }
}
