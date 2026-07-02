/**
 * Presence (AC7): the periodic `presence_update` HEARTBEAT is the source of truth for
 * whether a peer is online. `$SYS` CONNECT/DISCONNECT events are OPTIONAL accelerants —
 * a low-latency hint that a peer just arrived/left — but they never override the
 * heartbeat TTL: a peer whose heartbeat has gone stale is offline EVEN IF the last
 * `$SYS` event was CONNECT. With `$SYS` suppressed entirely, presence still works from
 * heartbeats alone.
 */
export interface PresenceTracker {
  /** A received presence_update heartbeat from `handle` at time `at` (ms). */
  onHeartbeat(handle: string, at: number): void
  /** $SYS CONNECT accelerant — optimistic online hint, still TTL-bounded. */
  onSysConnect(handle: string, at: number): void
  /** $SYS DISCONNECT accelerant — immediate offline hint. */
  onSysDisconnect(handle: string, at: number): void
  /** Authoritative online verdict at `now` (ms): heartbeat-within-TTL, or a fresh CONNECT. */
  isOnline(handle: string, now: number): boolean
  /** Last heartbeat time (ms) or null — the SoT timestamp, ignoring $SYS. */
  lastSeen(handle: string): number | null
}

interface PeerPresence {
  lastHeartbeat: number | null
  lastConnect: number | null
  lastDisconnect: number | null
}

export function createPresenceTracker(ttlMs: number): PresenceTracker {
  const peers = new Map<string, PeerPresence>()
  const get = (h: string): PeerPresence => {
    let p = peers.get(h)
    if (!p) { p = { lastHeartbeat: null, lastConnect: null, lastDisconnect: null }; peers.set(h, p) }
    return p
  }
  return {
    onHeartbeat(handle, at) { get(handle).lastHeartbeat = at },
    onSysConnect(handle, at) { get(handle).lastConnect = at },
    onSysDisconnect(handle, at) { get(handle).lastDisconnect = at },
    lastSeen(handle) { return peers.get(handle)?.lastHeartbeat ?? null },
    isOnline(handle, now) {
      const p = peers.get(handle)
      if (!p) return false
      // An explicit DISCONNECT that is the most recent signal wins immediately.
      const hb = p.lastHeartbeat ?? -Infinity
      const conn = p.lastConnect ?? -Infinity
      if (p.lastDisconnect !== null && p.lastDisconnect >= hb && p.lastDisconnect >= conn) return false
      // Heartbeat is the SoT; a fresh CONNECT is an accelerant, itself TTL-bounded so a
      // CONNECT with no follow-up heartbeat expires (stale TTL overrides cached CONNECT).
      const heartbeatFresh = p.lastHeartbeat !== null && now - p.lastHeartbeat <= ttlMs
      const connectFresh = p.lastConnect !== null && now - p.lastConnect <= ttlMs
      return heartbeatFresh || connectFresh
    },
  }
}
