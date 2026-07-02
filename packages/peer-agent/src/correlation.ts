import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { logJson } from './logger.ts'

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
    } catch (err) {
      // PERSIST-m1: don't fail silently — a corrupt/unreadable state file is a real
      // signal. Preserve the bad file (rename, best-effort) BEFORE the next persist
      // overwrites it, so the evidence survives for forensics, then start empty.
      logJson('warn', 'peer.dispatch_state.load_error', {
        path, err: String(err instanceof Error ? err.message : err),
      })
      try { renameSync(path, `${path}.corrupt-${Date.now()}`) } catch { /* best-effort */ }
    }
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
    // PERSIST-M1: per-process unique temp name (pid + random) so two peer-agents that
    // happen to share a config dir can't collide on a fixed `${path}.tmp` mid-rename.
    // (Sharing a config dir is itself an anti-pattern — project isolation gives each a
    // distinct dir — but the temp name must not be the thing that corrupts a write.)
    const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    try {
      const obj: Record<string, Entry> = {}
      for (const [k, v] of this.map) obj[k] = v
      writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 })
      renameSync(tmp, path)
    } catch (err) {
      // Best-effort durability: a write failure must not break the live in-memory
      // tracker or the dispatch that triggered it — but no longer swallow it silently.
      logJson('warn', 'peer.dispatch_state.persist_error', {
        path, err: String(err instanceof Error ? err.message : err),
      })
      // Don't leak the temp file if write succeeded but rename failed (unique names
      // would otherwise accumulate orphaned .tmp files over repeated failures).
      try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* best-effort */ }
    }
  }
}
