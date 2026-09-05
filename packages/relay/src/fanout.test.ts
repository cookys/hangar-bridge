import { describe, it, expect, beforeEach } from 'vitest'
import { Fanout, type Subscriber } from './fanout.ts'
import type { Envelope } from '@hangar-bridge/shared'

const env = (id: string, to: string, from = 'alice'): Envelope => ({
  id: `msg_01HRK7Y000000000000000000${id.padStart(1, '0')}`, v: 2,
  team: 't1', from, to, in_reply_to: null, thread_root: null,
  kind: 'chat', content: 'x', meta: {},
  sent_at: new Date().toISOString(), delivered_at: null
})

function collectingSub(handle: string): Subscriber & { received: Envelope[] } {
  const received: Envelope[] = []
  return { handle, team_id: 't1', deliver: e => { received.push(e) }, received }
}

describe('Fanout', () => {
  let f: Fanout
  beforeEach(() => { f = new Fanout() })

  it('delivers DM to exactly the addressed recipient', () => {
    const alice = collectingSub('alice')
    const bob = collectingSub('bob')
    f.subscribe(alice); f.subscribe(bob)
    f.deliver(env('A', 'bob'))
    expect(alice.received).toHaveLength(0)
    expect(bob.received).toHaveLength(1)
  })

  it('delivers @team broadcast to all in the team except the sender', () => {
    const alice = collectingSub('alice')
    const bob = collectingSub('bob')
    const charlie = collectingSub('charlie')
    f.subscribe(alice); f.subscribe(bob); f.subscribe(charlie)
    f.deliver(env('A', '@team', 'alice'))
    expect(alice.received).toHaveLength(0)
    expect(bob.received).toHaveLength(1)
    expect(charlie.received).toHaveLength(1)
  })

  it('delivers to all of a human\'s sessions (fan-in)', () => {
    const bobLaptop = collectingSub('bob')
    const bobDesk = collectingSub('bob')
    f.subscribe(bobLaptop); f.subscribe(bobDesk)
    f.deliver(env('A', 'bob'))
    expect(bobLaptop.received).toHaveLength(1)
    expect(bobDesk.received).toHaveLength(1)
  })

  it('unsubscribe stops delivery to that subscriber only', () => {
    const bob1 = collectingSub('bob')
    const bob2 = collectingSub('bob')
    f.subscribe(bob1); f.subscribe(bob2)
    f.unsubscribe(bob1)
    f.deliver(env('A', 'bob'))
    expect(bob1.received).toHaveLength(0)
    expect(bob2.received).toHaveLength(1)
  })

  it('does not cross teams (sub on team t2 never sees t1 messages)', () => {
    const otherReceived: Envelope[] = []
    const other: Subscriber = {
      handle: 'bob', team_id: 't2', deliver: (e: Envelope) => otherReceived.push(e),
    }
    const bob = collectingSub('bob')
    f.subscribe(other); f.subscribe(bob)
    f.deliver(env('A', 'bob'))
    expect(bob.received).toHaveLength(1)
    expect(otherReceived).toHaveLength(0)
  })

  it('tracks online handles per team', () => {
    f.subscribe(collectingSub('alice'))
    f.subscribe(collectingSub('bob'))
    expect(new Set(f.onlineHandles('t1'))).toEqual(new Set(['alice', 'bob']))
  })

  // Subscribe-side ACL gate: the per-subscriber `accept` predicate (set by the
  // stream route from the authenticated handle's owned-set) decides delivery.
  const subjEnv = (subject: string | null, to = 'bob'): Envelope => ({ ...env('A', to), subject })

  it('skips a subscriber whose accept() rejects, delivers to one that accepts', () => {
    const bob = { ...collectingSub('bob'), accept: (e: Envelope) => e.subject === null || e.subject.startsWith('mple2') }
    f.subscribe(bob)
    f.deliver(subjEnv('mple2.x'))
    f.deliver(subjEnv('other.x'))
    expect(bob.received.map(e => e.subject)).toEqual(['mple2.x'])
  })

  it('deliver returns whether at least one subscriber accepted', () => {
    const bob = { ...collectingSub('bob'), accept: (e: Envelope) => e.subject !== 'no.x' }
    f.subscribe(bob)
    expect(f.deliver(subjEnv('ok.x'))).toBe(true)
    expect(f.deliver(subjEnv('no.x'))).toBe(false)
  })

  it('null-subject delivers even with no accept predicate (back-compat)', () => {
    const bob = collectingSub('bob')
    f.subscribe(bob)
    expect(f.deliver(subjEnv(null))).toBe(true)
    expect(bob.received).toHaveLength(1)
  })
})

describe('Fanout — narrowed broadcast reaches siblings on the sender host', () => {
  // One handle per host means "everyone working on project X" would otherwise
  // skip every session on the sender's own machine — and a sibling in the same
  // project is the most likely collaborator of all.
  const filtered = (from: string, senderInstance?: string): Envelope => ({
    id: 'msg_01HRK7Y0000000000000000001', v: 2, team: 't1', from, to: '@team',
    in_reply_to: null, thread_root: null, kind: 'chat', content: 'x',
    meta: senderInstance ? { sender_instance: senderInstance } : {},
    to_filter: { repo: 'hangar' },
    sent_at: new Date().toISOString(), delivered_at: null,
  })

  const subWithInstance = (handle: string, instance?: string) => {
    const received: Envelope[] = []
    return { handle, team_id: 't1', instance, deliver: (e: Envelope) => { received.push(e) }, received }
  }

  it('delivers to a sibling under the sender handle, but not back to the sender', () => {
    const f = new Fanout()
    const me = subWithInstance('alice', 'inst-me')
    const sibling = subWithInstance('alice', 'inst-sibling')
    const other = subWithInstance('bob', 'inst-bob')
    f.subscribe(me); f.subscribe(sibling); f.subscribe(other)
    f.deliver(filtered('alice', 'inst-me'))
    expect(me.received).toHaveLength(0)        // never hear yourself
    expect(sibling.received).toHaveLength(1)   // the point of the change
    expect(other.received).toHaveLength(1)
  })

  it('still skips the whole sending handle for an UNqualified broadcast', () => {
    const f = new Fanout()
    const me = subWithInstance('alice', 'inst-me')
    const sibling = subWithInstance('alice', 'inst-sibling')
    f.subscribe(me); f.subscribe(sibling)
    f.deliver(env('A', '@team', 'alice'))
    expect(me.received).toHaveLength(0)
    expect(sibling.received).toHaveLength(0)
  })

  it('keeps the old behaviour when the sender publishes no instance (legacy peer)', () => {
    // Without an instance there is no way to tell the sender apart from its
    // siblings, so excluding the handle is the only safe option.
    const f = new Fanout()
    const me = subWithInstance('alice')
    const sibling = subWithInstance('alice', 'inst-sibling')
    f.subscribe(me); f.subscribe(sibling)
    f.deliver(filtered('alice'))
    expect(me.received).toHaveLength(0)
    expect(sibling.received).toHaveLength(0)
  })
})

/**
 * One process, one stream. A client that reconnects without closing its
 * previous connection (a delivery error threw out of the read loop with the
 * body still open) used to leave one subscriber per generation in the set, and
 * a single message then fanned out to all of them — 6 → 10 copies watched on
 * one instance, 2026-09-02.
 */
describe('Fanout — superseded instances', () => {
  let f: Fanout
  beforeEach(() => { f = new Fanout() })

  function instanceSub(handle: string, instance: string) {
    const s = collectingSub(handle) as Subscriber & { received: Envelope[]; closed: number }
    s.instance = instance
    s.closed = 0
    s.close = () => { s.closed++ }
    return s
  }

  it('evicts and closes earlier subscribers of the same instance, keeps siblings', () => {
    const gen1 = instanceSub('bob', 'I1')
    const gen2 = instanceSub('bob', 'I1')
    const sibling = instanceSub('bob', 'I2')
    f.subscribe(gen1); f.subscribe(sibling); f.subscribe(gen2)
    expect(f.evictSuperseded(gen2)).toBe(1)
    expect(gen1.closed).toBe(1)
    expect(sibling.closed).toBe(0)
    f.deliver(env('A', 'bob'))
    expect(gen1.received).toHaveLength(0)
    expect(gen2.received).toHaveLength(1)
    expect(sibling.received).toHaveLength(1)
  })

  it('leaves legacy subscribers (no instance) alone', () => {
    const legacy = collectingSub('bob')
    const gen = instanceSub('bob', 'I1')
    f.subscribe(legacy); f.subscribe(gen)
    expect(f.evictSuperseded(gen)).toBe(0)
    expect(f.evictSuperseded(legacy)).toBe(0)
    f.deliver(env('A', 'bob'))
    expect(legacy.received).toHaveLength(1)
    expect(gen.received).toHaveLength(1)
  })

  it('survives a close() that throws and still evicts', () => {
    const gen1 = instanceSub('bob', 'I1')
    gen1.close = () => { throw new Error('socket already gone') }
    const gen2 = instanceSub('bob', 'I1')
    f.subscribe(gen1); f.subscribe(gen2)
    expect(f.evictSuperseded(gen2)).toBe(1)
    f.deliver(env('A', 'bob'))
    expect(gen1.received).toHaveLength(0)
    expect(gen2.received).toHaveLength(1)
  })

  it('reports live subscriber counts per instance (0 is unreachable, >1 is a leak)', () => {
    f.subscribe(instanceSub('bob', 'I1'))
    f.subscribe(instanceSub('bob', 'I1'))
    f.subscribe(instanceSub('bob', 'I2'))
    f.subscribe(collectingSub('bob'))
    const counts = f.instanceCounts('t1', 'bob')
    expect(counts.get('I1')).toBe(2)
    expect(counts.get('I2')).toBe(1)
    expect(counts.get('')).toBe(1)
    expect(f.instanceCounts('t1', 'nobody').size).toBe(0)
  })
})

/**
 * REPLY_ROUTING_SPEC.md §3.2 step 4: the send transaction takes a matched
 * SNAPSHOT before it commits (routes + grants), then fanout delivers to
 * exactly that frozen set — never a fresh match — so a session that
 * subscribed between snapshot and fanout is not delivered to live (it has
 * no grant; a durable row reaches it on drain instead).
 */
describe('Fanout — frozen snapshot delivery', () => {
  let f: Fanout
  beforeEach(() => { f = new Fanout() })

  it('snapshot() returns exactly the set deliverDetailed would deliver to right now, without sending', () => {
    const bob = collectingSub('bob')
    const charlie = collectingSub('charlie')
    f.subscribe(bob); f.subscribe(charlie)
    const e = env('A', '@team', 'alice')

    const snap = f.snapshot(e)

    expect([...snap].sort((a, b) => a.handle.localeCompare(b.handle))).toEqual([
      { handle: 'bob', instance: undefined },
      { handle: 'charlie', instance: undefined },
    ])
    expect(bob.received).toHaveLength(0)
    expect(charlie.received).toHaveLength(0)
  })

  it('snapshot() respects self-exclusion, same as a live delivery would', () => {
    const cuda = { handle: 'cuda', team_id: 't1', instance: 'inst-A', deliver: () => {} }
    f.subscribe(cuda)
    const e = { ...env('A', 'cuda', 'cuda'), meta: { sender_instance: 'inst-A' } }
    expect(f.snapshot(e)).toEqual([])
  })

  it('deliverDetailed(e, snapshot) delivers to a subscriber present in the snapshot', () => {
    const bob = collectingSub('bob')
    f.subscribe(bob)
    const e = env('A', 'bob')
    const snap = f.snapshot(e)
    const result = f.deliverDetailed(e, snap)
    expect(result).toEqual({ delivered: true, selfExcluded: false, matched: [{ handle: 'bob', instance: undefined }] })
    expect(bob.received).toHaveLength(1)
  })

  it('a late subscriber (joined after the snapshot was taken) receives nothing from a frozen delivery', () => {
    const e = env('A', 'bob')
    const snap = f.snapshot(e)   // nobody subscribed yet — snapshot is empty
    expect(snap).toHaveLength(0)
    const bob = collectingSub('bob')
    f.subscribe(bob)             // joins strictly after the snapshot
    const result = f.deliverDetailed(e, snap)
    expect(result).toEqual({ delivered: false, selfExcluded: false, matched: [] })
    expect(bob.received).toHaveLength(0)
  })

  it('a departed subscriber (unsubscribed after the snapshot) is tolerated, not delivered to', () => {
    const bob = collectingSub('bob')
    f.subscribe(bob)
    const e = env('A', 'bob')
    const snap = f.snapshot(e)
    f.unsubscribe(bob)
    let result: ReturnType<Fanout['deliverDetailed']> | undefined
    expect(() => { result = f.deliverDetailed(e, snap) }).not.toThrow()
    expect(result).toEqual({ delivered: false, selfExcluded: false, matched: [] })
    expect(bob.received).toHaveLength(0)
  })

  it('a frozen delivery to a multi-instance handle only reaches instances present in the snapshot', () => {
    const bobA = collectingSub('bob'); bobA.instance = 'I1'
    const bobB = collectingSub('bob'); bobB.instance = 'I2'
    f.subscribe(bobA)
    const e = env('A', 'bob')
    const snap = f.snapshot(e)   // only I1 present at snapshot time
    f.subscribe(bobB)            // I2 joins after
    f.deliverDetailed(e, snap)
    expect(bobA.received).toHaveLength(1)
    expect(bobB.received).toHaveLength(0)
  })

  it('the snapshot membership key does not collide across a handle/instance boundary shift', () => {
    // Without a join-point separator, handle 'ab' + instance 'c' and handle
    // 'a' + instance 'bc' would both concatenate to 'abc'. A frozen snapshot
    // naming only the first must never also deliver to the second.
    const abInstC = collectingSub('ab'); abInstC.instance = 'c'
    const aInstBc = collectingSub('a'); aInstBc.instance = 'bc'
    f.subscribe(abInstC)
    f.subscribe(aInstBc)
    const e = env('A', '@team', 'zzz')

    const fullSnapshot = f.snapshot(e)
    expect([...fullSnapshot].sort((x, y) => x.handle.localeCompare(y.handle))).toEqual([
      { handle: 'a', instance: 'bc' },
      { handle: 'ab', instance: 'c' },
    ])

    // Freeze delivery to ONLY the {handle:'ab', instance:'c'} entry.
    const narrowedSnapshot = fullSnapshot.filter(m => m.handle === 'ab')
    f.deliverDetailed(e, narrowedSnapshot)
    expect(abInstC.received).toHaveLength(1)
    expect(aInstBc.received).toHaveLength(0)
  })
})
