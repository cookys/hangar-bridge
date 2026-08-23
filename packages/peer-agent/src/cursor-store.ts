import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { isValidMessageId } from '@hangar-bridge/shared'
import { logJson } from './logger.ts'

export interface CursorStoreOpts {
  /**
   * Disk backing for the SSE resume cursor. Omit for a purely in-memory
   * cursor (the pre-P3 behavior, still used by tests).
   */
  persistPath?: string
}

interface CursorFile { cursor?: unknown }

/**
 * Durable SSE resume cursor (P3).
 *
 * Without this the cursor lived only in memory, so every peer-agent restart
 * cold-started. Cold start drains `delivered_at IS NULL` rows only — and the
 * relay stamps `delivered_at` at socket-WRITE time, before the client has
 * necessarily processed anything. A relay killed mid-drain therefore leaves
 * rows marked delivered that no one consumed, and a cold-starting client never
 * sees them. Persisting the cursor makes `?since=` (which ignores
 * delivered_at) the normal resume path and cold start the rare one.
 *
 * Follows the DispatchTracker persistence contract: monotonic advance,
 * write-after-advance with an atomic temp+rename, fail-open on load.
 */
export class CursorStore {
  private cursor: string | undefined

  constructor(private readonly opts: CursorStoreOpts) {
    if (opts.persistPath) this.load()
  }

  get(): string | undefined {
    return this.cursor
  }

  /**
   * Move the cursor forward. STRICTLY monotonic: a lower or equal id, or a
   * malformed one, is ignored rather than rewinding the resume point — a
   * rewind would replay already-processed messages into Claude's context, and
   * a malformed value would make the next `?since=` request 400 and strand the
   * peer on the cold-start path forever.
   */
  advance(id: string): void {
    if (!isValidMessageId(id)) {
      logJson('warn', 'peer.cursor.invalid', { id })
      return
    }
    if (this.cursor !== undefined && id <= this.cursor) return
    this.cursor = id
    this.persist()
  }

  private load(): void {
    const path = this.opts.persistPath!
    if (!existsSync(path)) return
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as CursorFile
      const c = raw?.cursor
      // Fail OPEN: an unreadable cursor must degrade to a cold start, never
      // crash the peer-agent and take the whole Claude Code session with it.
      if (typeof c === 'string' && isValidMessageId(c)) this.cursor = c
      else logJson('warn', 'peer.cursor.load_invalid', { path })
    } catch (err) {
      logJson('warn', 'peer.cursor.load_error', {
        path, err: String(err instanceof Error ? err.message : err),
      })
      // Preserve the evidence BEFORE the next persist overwrites it.
      try { renameSync(path, `${path}.corrupt-${Date.now()}`) } catch { /* best-effort */ }
    }
  }

  private persist(): void {
    const path = this.opts.persistPath
    if (!path) return
    // Per-process unique temp name so two peer-agents sharing a config dir
    // cannot collide on a fixed `${path}.tmp` mid-rename.
    const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(tmp, JSON.stringify({ cursor: this.cursor }), { mode: 0o600 })
      renameSync(tmp, path)
    } catch (err) {
      // Best-effort durability: a write failure must never break the live
      // in-memory cursor or the inbound delivery that triggered it.
      logJson('warn', 'peer.cursor.persist_error', {
        path, err: String(err instanceof Error ? err.message : err),
      })
      try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* best-effort */ }
    }
  }
}
