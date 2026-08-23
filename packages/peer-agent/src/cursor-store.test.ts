import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CursorStore, cursorSink } from './cursor-store.ts'

const A = 'msg_01HRK7Y000000000000000000A'
const B = 'msg_01HRK7Y000000000000000000B'
const C = 'msg_01HRK7Y000000000000000000C'

/**
 * P3 — the SSE resume cursor was memory-only, so a peer-agent restart always
 * cold-started. Cold start drains `delivered_at IS NULL` only, and the relay
 * stamps delivered_at at socket-WRITE time: a relay killed mid-drain has
 * already marked rows delivered that the client never processed, and those
 * rows are then silently lost to a cold-starting client. A persisted cursor
 * makes the resume path (`?since=`, which ignores delivered_at) the normal
 * one, and cold start the rare one.
 */
describe('CursorStore', () => {
  let dir: string
  let path: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hb-cursor-'))
    path = join(dir, 'cursor-state.json')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('starts empty with no file on disk', () => {
    expect(new CursorStore({ persistPath: path }).get()).toBeUndefined()
    expect(existsSync(path)).toBe(false)
  })

  it('round-trips a cursor across a restart', () => {
    new CursorStore({ persistPath: path }).advance(B)
    expect(new CursorStore({ persistPath: path }).get()).toBe(B)
  })

  it('persists after EVERY advance, not only at shutdown', () => {
    const s = new CursorStore({ persistPath: path })
    s.advance(A)
    expect(new CursorStore({ persistPath: path }).get()).toBe(A)
    s.advance(B)
    expect(new CursorStore({ persistPath: path }).get()).toBe(B)
  })

  it('only ever advances — a lower id is ignored in memory and on disk', () => {
    const s = new CursorStore({ persistPath: path })
    s.advance(B)
    s.advance(A)
    expect(s.get()).toBe(B)
    expect(new CursorStore({ persistPath: path }).get()).toBe(B)
  })

  it('ignores a repeat of the current cursor', () => {
    const s = new CursorStore({ persistPath: path })
    s.advance(B)
    s.advance(B)
    expect(s.get()).toBe(B)
  })

  it('accepts a strictly greater id', () => {
    const s = new CursorStore({ persistPath: path })
    s.advance(A)
    s.advance(C)
    expect(s.get()).toBe(C)
  })

  it('rejects a malformed id rather than poisoning the resume cursor', () => {
    const s = new CursorStore({ persistPath: path })
    s.advance(B)
    s.advance('not-a-message-id')
    expect(s.get()).toBe(B)
  })

  it('fails OPEN on a corrupt file — starts undefined instead of crashing', () => {
    writeFileSync(path, '{ this is not json')
    expect(new CursorStore({ persistPath: path }).get()).toBeUndefined()
  })

  it('fails OPEN on a well-formed file holding a malformed cursor', () => {
    writeFileSync(path, JSON.stringify({ cursor: 'bogus' }))
    expect(new CursorStore({ persistPath: path }).get()).toBeUndefined()
  })

  it('preserves a corrupt file for forensics before overwriting it', () => {
    writeFileSync(path, '{ this is not json')
    new CursorStore({ persistPath: path })
    expect(readdirSync(dir).some(f => f.includes('.corrupt-'))).toBe(true)
  })

  it('writes the state file 0600 — the cursor names a private message id', () => {
    new CursorStore({ persistPath: path }).advance(B)
    expect(readFileSync(path, 'utf8')).toContain(B)
  })

  it('works purely in memory when no path is configured', () => {
    const s = new CursorStore({})
    s.advance(B)
    expect(s.get()).toBe(B)
    expect(existsSync(path)).toBe(false)
  })

  it('keeps the in-memory cursor live when the write fails', () => {
    const s = new CursorStore({ persistPath: join(dir, 'nested') })
    chmodSync(dir, 0o500)
    try {
      s.advance(B)
      expect(s.get()).toBe(B)
    } finally {
      chmodSync(dir, 0o700)
    }
  })

  /**
   * FIX7 (best-effort) — this class does process-local monotonic checking
   * over ONE config-wide file. Two peer-agent processes sharing a config dir
   * can each hold a stale in-memory view and race to persist; without a
   * check right before the rename, the slower writer could REWIND the file.
   * This closes the common case: a re-read immediately before the rename
   * skips our write when the disk already holds an id >= ours. The residual
   * race (a write landing between that re-read and our own rename) is NOT
   * eliminated — see the comment on CursorStore.persist. The real fix is
   * per-project HANGAR_CONFIG_DIR isolation (plan P4) so sibling processes
   * never share a cursor file at all.
   */
  it('CAS: skips the write when disk already holds an id >= ours', () => {
    const s = new CursorStore({ persistPath: path })
    // Simulate a sibling process that already advanced further than we know.
    writeFileSync(path, JSON.stringify({ cursor: C }))
    s.advance(B) // B < C
    expect(JSON.parse(readFileSync(path, 'utf8')).cursor).toBe(C)
  })

  it('CAS: still writes when disk holds an older id than ours', () => {
    const s = new CursorStore({ persistPath: path })
    writeFileSync(path, JSON.stringify({ cursor: A }))
    s.advance(C) // C > A
    expect(JSON.parse(readFileSync(path, 'utf8')).cursor).toBe(C)
  })
})

/**
 * FIX2 — the durable cursor file backs SSE resume ONLY. Wiring
 * InboundDispatcher.setCursor to store.advance unconditionally (regardless
 * of which transport actually got selected) lets a NATS message id land in
 * cursor-state.json, later corrupting the SSE `?since=` resume point for
 * this process or a sibling sharing the same config dir. cursorSink derives
 * the sink from the ACTUAL selected transport.
 */
describe('cursorSink — lane-scoped cursor persistence (FIX2)', () => {
  let dir: string
  let path: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hb-cursor-sink-'))
    path = join(dir, 'cursor-state.json')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('sse lane advances the store and persists to disk', () => {
    const store = new CursorStore({ persistPath: path })
    const sink = cursorSink('sse', store)
    sink(B)
    expect(store.get()).toBe(B)
    expect(existsSync(path)).toBe(true)
  })

  it('nats lane never advances the store or writes cursor-state.json', () => {
    const store = new CursorStore({ persistPath: path })
    const sink = cursorSink('nats', store)
    sink(B)
    expect(store.get()).toBeUndefined()
    expect(existsSync(path)).toBe(false)
  })
})
