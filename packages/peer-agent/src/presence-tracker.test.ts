import { describe, it, expect } from 'vitest'
import { createPresenceTracker } from './presence-tracker.ts'

const TTL = 30_000

describe('presence-tracker (AC7: heartbeat SoT, $SYS accelerant)', () => {
  it('heartbeat-only path marks a peer online, then offline once TTL lapses ($SYS suppressed)', () => {
    const t = createPresenceTracker(TTL)
    t.onHeartbeat('beta', 1_000)
    expect(t.isOnline('beta', 1_000)).toBe(true)
    expect(t.isOnline('beta', 1_000 + TTL)).toBe(true)     // exactly at TTL boundary
    expect(t.isOnline('beta', 1_000 + TTL + 1)).toBe(false) // lapsed
    expect(t.lastSeen('beta')).toBe(1_000)
  })

  it('a stale heartbeat forces OFFLINE even if the last $SYS event was CONNECT (TTL overrides accelerant)', () => {
    const t = createPresenceTracker(TTL)
    t.onHeartbeat('beta', 1_000)
    t.onSysConnect('beta', 2_000) // cached CONNECT
    // Long after both: heartbeat stale AND connect stale ⇒ offline. The cached CONNECT
    // does NOT keep it online past the heartbeat TTL.
    expect(t.isOnline('beta', 2_000 + TTL + 1)).toBe(false)
  })

  it('a fresh $SYS CONNECT is a low-latency accelerant before the first heartbeat arrives', () => {
    const t = createPresenceTracker(TTL)
    t.onSysConnect('beta', 5_000) // connected, no heartbeat yet
    expect(t.isOnline('beta', 5_100)).toBe(true)           // online immediately via accelerant
    expect(t.isOnline('beta', 5_000 + TTL + 1)).toBe(false) // but the accelerant is TTL-bounded
    expect(t.lastSeen('beta')).toBeNull()                   // SoT timestamp ignores $SYS
  })

  it('$SYS DISCONNECT (most recent signal) immediately marks offline', () => {
    const t = createPresenceTracker(TTL)
    t.onHeartbeat('beta', 1_000)
    t.onSysDisconnect('beta', 1_500)
    expect(t.isOnline('beta', 1_600)).toBe(false) // disconnect wins over a still-fresh heartbeat
  })

  it('a heartbeat AFTER a disconnect brings the peer back online (re-join)', () => {
    const t = createPresenceTracker(TTL)
    t.onSysDisconnect('beta', 1_500)
    t.onHeartbeat('beta', 2_000)
    expect(t.isOnline('beta', 2_100)).toBe(true)
  })

  it('an unknown handle is offline', () => {
    const t = createPresenceTracker(TTL)
    expect(t.isOnline('nobody', 1_000)).toBe(false)
    expect(t.lastSeen('nobody')).toBeNull()
  })
})
