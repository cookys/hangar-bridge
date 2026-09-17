import { describe, it, expect, beforeEach } from 'vitest'
import { PresenceRegistry } from './registry.ts'

describe('PresenceRegistry', () => {
  let p: PresenceRegistry
  beforeEach(() => { p = new PresenceRegistry(() => new Date('2026-01-01T00:00:00Z')) })

  it('records and reads back presence', () => {
    p.set('t1', 'alice', 'laptop', { summary: 'grinding auth', cwd: '/src', branch: 'main', repo: 'x' })
    const snap = p.get('t1', 'alice')
    expect(snap?.summary).toBe('grinding auth')
    expect(snap?.sessions[0]).toMatchObject({ label: 'laptop', branch: 'main' })
  })

  it('merges multiple sessions for one human', () => {
    p.set('t1', 'alice', 'laptop', { summary: 'A', cwd: '/', branch: 'main', repo: 'r' })
    p.set('t1', 'alice', 'desktop', { summary: 'A', cwd: '/', branch: 'dev', repo: 'r' })
    expect(p.get('t1', 'alice')?.sessions).toHaveLength(2)
  })

  it('remove drops a session', () => {
    p.set('t1', 'alice', 'laptop', { summary: 'A', cwd: '/', branch: 'main', repo: 'r' })
    p.remove('t1', 'alice', 'laptop')
    expect(p.get('t1', 'alice')).toBeUndefined()
  })

  // F-P3-1 (fleet-comms cockpit P3, cuda 2026-09-16): two peer-agents sharing
  // one handle each POST their own summary; the cockpit's own summary was
  // getting overwritten by a sibling peer-agent's "(connected)" because only
  // ONE handle-level summary existed. Fixed by carrying summary PER SESSION.
  it('carries a distinct summary per session, not just one handle-level summary', () => {
    p.set('t1', 'alice', 'laptop', { summary: 'laptop: building X' })
    p.set('t1', 'alice', 'cockpit', { summary: 'cockpit: 3 peers (a,b,c)' })
    const snap = p.get('t1', 'alice')!
    const byLabel = Object.fromEntries(snap.sessions.map(s => [s.label, s.summary]))
    expect(byLabel['laptop']).toBe('laptop: building X')
    expect(byLabel['cockpit']).toBe('cockpit: 3 peers (a,b,c)')
  })

  it('handle-level summary is the most recently written NON-EMPTY session summary', () => {
    p.set('t1', 'alice', 'laptop', { summary: 'first' })
    p.set('t1', 'alice', 'cockpit', { summary: 'second — newer' })
    expect(p.get('t1', 'alice')?.summary).toBe('second — newer')
  })

  it('an empty session summary does not clobber a sibling\'s non-empty summary at handle level', () => {
    p.set('t1', 'alice', 'laptop', { summary: 'has content' })
    p.set('t1', 'alice', 'cockpit', { summary: '' }) // heartbeat with nothing to report, written LATER
    expect(p.get('t1', 'alice')?.summary).toBe('has content')
  })

  it('listTeam returns all humans with their summaries', () => {
    p.set('t1', 'alice', 'laptop', { summary: 'A', cwd: '/', branch: 'm', repo: 'r' })
    p.set('t1', 'bob',   'laptop', { summary: 'B', cwd: '/', branch: 'm', repo: 'r' })
    const list = p.listTeam('t1')
    expect(list.map(h => h.handle).sort()).toEqual(['alice','bob'])
  })
})

describe('PresenceRegistry — TTL / eviction', () => {
  let clock: number
  const now = () => new Date(clock)
  const TTL = 90_000
  let p: PresenceRegistry
  beforeEach(() => { clock = Date.parse('2026-01-01T00:00:00Z'); p = new PresenceRegistry(now, TTL) })

  it('get returns a session within the TTL window', () => {
    p.set('t1', 'alice', 'laptop', { summary: 'A' })
    clock += TTL - 1
    expect(p.get('t1', 'alice')?.summary).toBe('A')
  })

  it('get evicts a session older than the TTL and returns undefined', () => {
    p.set('t1', 'alice', 'laptop', { summary: 'A' })
    clock += TTL + 1
    expect(p.get('t1', 'alice')).toBeUndefined()
    // handle bucket is pruned so listTeam does not resurrect it
    expect(p.listTeam('t1')).toEqual([])
  })

  it('a heartbeat (re-set) refreshes last_seen and keeps the session live', () => {
    p.set('t1', 'alice', 'laptop', { summary: 'A' })
    clock += TTL - 10
    p.set('t1', 'alice', 'laptop', { summary: 'A' }) // heartbeat
    clock += TTL - 10                                 // still within TTL of the heartbeat
    expect(p.get('t1', 'alice')?.summary).toBe('A')
  })

  it('prunes only the expired session of a multi-session handle', () => {
    p.set('t1', 'alice', 'old', { summary: 'A' })
    clock += TTL - 5
    p.set('t1', 'alice', 'fresh', { summary: 'A' })   // newer session
    clock += 10                                        // 'old' now expired, 'fresh' still live
    const snap = p.get('t1', 'alice')
    expect(snap?.sessions.map(s => s.label)).toEqual(['fresh'])
  })

  it('listTeam drops fully-expired handles but keeps live ones', () => {
    p.set('t1', 'alice', 'laptop', { summary: 'A' })
    clock += TTL + 1
    p.set('t1', 'bob', 'laptop', { summary: 'B' })    // bob set after alice expired
    expect(p.listTeam('t1').map(h => h.handle)).toEqual(['bob'])
  })

  it('defaults ttlMs to PRESENCE_TTL_MS when omitted', () => {
    const q = new PresenceRegistry(now) // default TTL
    q.set('t1', 'alice', 'laptop', { summary: 'A' })
    clock += 89_000
    expect(q.get('t1', 'alice')?.summary).toBe('A')
    clock += 2_000 // now > 90s
    expect(q.get('t1', 'alice')).toBeUndefined()
  })
})
