import { describe, it, expect, beforeEach } from 'vitest'
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
