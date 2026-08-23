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
      // Best-effort CAS: this class does process-local monotonic checking only,
      // over ONE config-wide file. Two peer-agent processes sharing a config dir
      // (e.g. two Claude Code sessions in the same worktree) can each advance
      // their own in-memory cursor independently and then race to persist —
      // without this check, the slower writer's rename could REWIND the file
      // to an older id than a faster sibling already wrote. Re-reading right
      // before the rename closes the common case, but a tiny window remains
      // between this read and our own rename (the other process could persist
      // in between); that residual race is NOT eliminated here. The real fix
      // is per-project HANGAR_CONFIG_DIR isolation (plan P4) so sibling
      // processes never share a cursor file at all.
      if (existsSync(path)) {
        try {
          const raw = JSON.parse(readFileSync(path, 'utf8')) as CursorFile
          const onDisk = raw?.cursor
          if (
            typeof onDisk === 'string' && isValidMessageId(onDisk)
            && this.cursor !== undefined && onDisk >= this.cursor
          ) {
            try { unlinkSync(tmp) } catch { /* best-effort */ }
            return
          }
        } catch { /* unreadable/corrupt on-disk file: fall through and write ours */ }
      }
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

/**
 * Lane-scoped sink for InboundDispatcher.setCursor.
 *
 * The durable cursor file backs SSE's `?since=` resume ONLY — the NATS lane
 * has no such resume protocol (JetStream/WorkQueue own their own delivery
 * state). Wiring `store.advance` unconditionally, regardless of which
 * transport is actually selected, lets a NATS message id land in
 * cursor-state.json; if that peer-agent later reconnects over SSE (or a
 * sibling process on the same config dir does), the SSE stream would resume
 * from a foreign, non-SSE cursor value and corrupt delivery. Only the SSE
 * lane may advance the store; the NATS lane gets a no-op sink.
 */
export function cursorSink(
  transport: 'sse' | 'nats',
  store: Pick<CursorStore, 'advance'>,
): (id: string) => void {
  if (transport !== 'sse') return () => { /* NATS lane: no durable SSE cursor to advance */ }
  return id => store.advance(id)
}
