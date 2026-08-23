import type { Envelope } from '@hangar-bridge/shared'
import { TEAM_BROADCAST_HANDLE } from '@hangar-bridge/shared'

export interface Subscriber {
  handle: string
  team_id: string
  /**
   * Relay-authoritative per-process instance for this SSE connection (from the
   * x-hangar-instance header). Used ONLY to exclude the sender from its own
   * direct message — it grants nobody the ability to ADDRESS an instance.
   * Positive `to_instance` routing stays with the NATS session-addressing
   * design (plan P4'b boundary marker). Absent on legacy clients.
   */
  instance?: string | undefined
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
    return this.deliverDetailed(e).delivered
  }

  /**
   * Direct-delivery with the self-exclusion outcome made visible.
   *
   * The @team branch has always skipped the sending handle; the direct branch
   * did not, so on a box where several sessions share one handle, addressing
   * that handle echoed the message back into the sending session (observed
   * live by the cuda peer, 2026-08-24). Excluding the whole HANDLE would be
   * worse than the echo — the sender's intent is to reach a sibling session,
   * and that would deliver to nobody. So the exclusion is per-INSTANCE.
   *
   * `selfExcluded` lets the publish route distinguish "everyone who could
   * receive it was the sender itself" from "nobody was listening": the former
   * must count as delivered, or a later cold start on this handle drains the
   * sender its own old message back.
   */
  deliverDetailed(e: Envelope): { delivered: boolean; selfExcluded: boolean } {
    const byHandle = this.subs.get(e.team)
    if (!byHandle) return { delivered: false, selfExcluded: false }
    if (e.to === TEAM_BROADCAST_HANDLE) return { delivered: this.deliver(e), selfExcluded: false }
    const set = byHandle.get(e.to)
    if (!set) return { delivered: false, selfExcluded: false }
    const senderInstance = e.meta['sender_instance']
    let delivered = false
    let selfExcluded = false
    for (const sub of set) {
      // Legacy (either side lacks an instance) keeps exactly the old behaviour.
      if (senderInstance !== undefined && sub.instance === senderInstance) {
        selfExcluded = true
        continue
      }
      if (sub.accept && !sub.accept(e)) continue
      sub.deliver(e)
      delivered = true
    }
    return { delivered, selfExcluded }
  }

  onlineHandles(team_id: string): string[] {
    return Array.from(this.subs.get(team_id)?.keys() ?? [])
  }

  isOnline(team_id: string, handle: string): boolean {
    return (this.subs.get(team_id)?.get(handle)?.size ?? 0) > 0
  }
}
