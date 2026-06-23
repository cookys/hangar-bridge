import type { Envelope } from '@hangar-bridge/shared'
import { TEAM_BROADCAST_HANDLE } from '@hangar-bridge/shared'

export interface Subscriber {
  handle: string
  team_id: string
  // Per-subscriber gate (ownership + interest), set by the stream route from the
  // authenticated handle's owned-set. When present and it returns false, the
  // envelope is NOT delivered to this subscriber. Absent ⇒ accept all (back-compat).
  accept?: (e: Envelope) => boolean
  deliver: (e: Envelope) => void
}

export class Fanout {
  // team_id -> handle -> Set<Subscriber>
  private subs = new Map<string, Map<string, Set<Subscriber>>>()

  subscribe(sub: Subscriber): void {
    let byHandle = this.subs.get(sub.team_id)
    if (!byHandle) {
      byHandle = new Map()
      this.subs.set(sub.team_id, byHandle)
    }
    let set = byHandle.get(sub.handle)
    if (!set) {
      set = new Set()
      byHandle.set(sub.handle, set)
    }
    set.add(sub)
  }

  unsubscribe(sub: Subscriber): void {
    const byHandle = this.subs.get(sub.team_id)
    if (!byHandle) return
    const set = byHandle.get(sub.handle)
    if (!set) return
    set.delete(sub)
    if (set.size === 0) byHandle.delete(sub.handle)
  }

  /**
   * Deliver to matching subscribers, consulting each subscriber's `accept` gate.
   * Returns true iff at least one subscriber accepted it (post-gate) — used by the
   * publish route to decide delivered-tracking for null-subject messages.
   */
  deliver(e: Envelope): boolean {
    const byHandle = this.subs.get(e.team)
    if (!byHandle) return false
    let delivered = false
    if (e.to === TEAM_BROADCAST_HANDLE) {
      for (const [handle, set] of byHandle) {
        if (handle === e.from) continue
        for (const sub of set) {
          if (sub.accept && !sub.accept(e)) continue
          sub.deliver(e)
          delivered = true
        }
      }
      return delivered
    }
    const set = byHandle.get(e.to)
    if (!set) return false
    for (const sub of set) {
      if (sub.accept && !sub.accept(e)) continue
      sub.deliver(e)
      delivered = true
    }
    return delivered
  }

  onlineHandles(team_id: string): string[] {
    return Array.from(this.subs.get(team_id)?.keys() ?? [])
  }

  isOnline(team_id: string, handle: string): boolean {
    return (this.subs.get(team_id)?.get(handle)?.size ?? 0) > 0
  }
}
