import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DispatchTracker } from './correlation.ts'

describe('DispatchTracker', () => {
  let t: DispatchTracker
  beforeEach(() => { t = new DispatchTracker({ ttlMs: 1000 }) })

  it('records a dispatch and lets the result side recover msg_id + peer', () => {
    t.recordOutgoing('01HR0000000000000000000099', 'msg_01HR0000000000000000000001', 'alice')
    expect(t.msgIdFor('01HR0000000000000000000099')).toBe('msg_01HR0000000000000000000001')
    expect(t.peerFor('01HR0000000000000000000099')).toBe('alice')
    expect(t.has('01HR0000000000000000000099')).toBe(true)
  })

  it('drops entries after ttl', async () => {
    const t2 = new DispatchTracker({ ttlMs: 10 })
    t2.recordOutgoing('cid1', 'msg_x', 'alice')
    expect(t2.has('cid1')).toBe(true)
    await new Promise(r => setTimeout(r, 30))
    expect(t2.msgIdFor('cid1')).toBeUndefined()
    expect(t2.peerFor('cid1')).toBeUndefined()
    expect(t2.has('cid1')).toBe(false)
  })

  it('returns undefined for unknown correlation_id (orphan task_result)', () => {
    expect(t.msgIdFor('never-dispatched')).toBeUndefined()
    expect(t.peerFor('never-dispatched')).toBeUndefined()
    expect(t.has('never-dispatched')).toBe(false)
  })

  it('shares correlation_id across fanout — single dispatch envelope to @team keeps one entry', () => {
    // The relay fans out to @team server-side; peer-agent emits ONE OutboundMessage
    // with one msg_id. Tracker records that single dispatch.
    t.recordOutgoing('cidteam', 'msg_team_01', '@team')
    expect(t.peerFor('cidteam')).toBe('@team')
    expect(t.size()).toBe(1)
  })

  it('survives multiple dispatches and gc batches expired entries', async () => {
    const t2 = new DispatchTracker({ ttlMs: 20 })
    t2.recordOutgoing('a', 'msg_a', 'alice')
    t2.recordOutgoing('b', 'msg_b', 'bob')
    expect(t2.size()).toBe(2)
    await new Promise(r => setTimeout(r, 40))
    t2.recordOutgoing('c', 'msg_c', 'carol') // triggers gc
    expect(t2.size()).toBe(1)
    expect(t2.has('a')).toBe(false)
    expect(t2.has('b')).toBe(false)
    expect(t2.has('c')).toBe(true)
  })
})

describe('DispatchTracker — durable persistence (survives restart)', () => {
  let dir = ''
  let statePath = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hangar-dispatch-'))
    statePath = join(dir, 'dispatch-state.json')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('a matching task_result still correlates after a simulated restart', () => {
    const cid = '01HR0000000000000000000099'
    const msgId = 'msg_01HR0000000000000000000001'

    // Register a dispatch on the pre-restart instance.
    const before = new DispatchTracker({ ttlMs: 30 * 60_000, persistPath: statePath })
    before.recordOutgoing(cid, msgId, 'alice')
    expect(existsSync(statePath)).toBe(true)

    // Simulate a relay/peer-agent restart: a brand-new tracker reloads from disk.
    const after = new DispatchTracker({ ttlMs: 30 * 60_000, persistPath: statePath })
    // This is exactly what inbound.ts checks when a late task_result arrives.
    expect(after.has(cid)).toBe(true)
    expect(after.msgIdFor(cid)).toBe(msgId)
    expect(after.peerFor(cid)).toBe('alice')
  })

  it('persists every live entry and reloads them all', () => {
    const before = new DispatchTracker({ ttlMs: 30 * 60_000, persistPath: statePath })
    before.recordOutgoing('01HR0000000000000000000001', 'msg_a', 'alice')
    before.recordOutgoing('01HR0000000000000000000002', 'msg_b', '@team')

    const after = new DispatchTracker({ ttlMs: 30 * 60_000, persistPath: statePath })
    expect(after.size()).toBe(2)
    expect(after.peerFor('01HR0000000000000000000002')).toBe('@team')
  })

  it('does NOT reload entries that expired while the process was down', async () => {
    const before = new DispatchTracker({ ttlMs: 10, persistPath: statePath })
    before.recordOutgoing('cid-short', 'msg_x', 'alice')
    await new Promise(r => setTimeout(r, 30))

    const after = new DispatchTracker({ ttlMs: 10, persistPath: statePath })
    expect(after.has('cid-short')).toBe(false)
    expect(after.size()).toBe(0)
  })

  it('starts empty (no throw) when the state file is corrupt, and preserves the bad file (PERSIST-m1)', () => {
    writeFileSync(statePath, 'not json {{{')
    const t = new DispatchTracker({ ttlMs: 1000, persistPath: statePath })
    expect(t.size()).toBe(0)
    // The corrupt file is preserved (renamed) for forensics, not silently overwritten.
    const corrupt = readdirSync(dir).filter(f => f.startsWith('dispatch-state.json.corrupt-'))
    expect(corrupt).toHaveLength(1)
    expect(readFileSync(join(dir, corrupt[0]!), 'utf8')).toBe('not json {{{')
    // and recovers — a subsequent write is well-formed JSON at the canonical path
    t.recordOutgoing('cid-new', 'msg_n', 'bob')
    expect(JSON.parse(readFileSync(statePath, 'utf8'))['cid-new'].peer_handle).toBe('bob')
  })

  it('creates a missing parent dir so durability works even before init ran', () => {
    // peer-agent started before `init`, or ~/.config/hangar-bridge/ was deleted:
    // the state path lives under a nested dir that does NOT exist yet.
    const nested = join(dir, 'does', 'not', 'exist', 'yet', 'dispatch-state.json')
    expect(existsSync(join(dir, 'does'))).toBe(false)

    const before = new DispatchTracker({ ttlMs: 30 * 60_000, persistPath: nested })
    before.recordOutgoing('01HR0000000000000000000042', 'msg_z', 'alice')
    // The dir was created and the state actually landed on disk (not silently in-memory).
    expect(existsSync(nested)).toBe(true)

    // And it survives a restart — proves durability holds when the dir was absent.
    const after = new DispatchTracker({ ttlMs: 30 * 60_000, persistPath: nested })
    expect(after.has('01HR0000000000000000000042')).toBe(true)
    expect(after.peerFor('01HR0000000000000000000042')).toBe('alice')
  })

  it('is backward-compatible: no persistPath ⇒ pure in-memory, no file written', () => {
    const t = new DispatchTracker({ ttlMs: 1000 })
    t.recordOutgoing('cid', 'msg', 'alice')
    expect(existsSync(statePath)).toBe(false)
    expect(t.has('cid')).toBe(true)
  })
})
