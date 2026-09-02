import type { Envelope } from '@hangar-bridge/shared'
import { TEAM_BROADCAST_HANDLE } from '@hangar-bridge/shared'

export interface Subscriber {
  handle: string
  team_id: string
  /**
   * Relay-authoritative per-process instance for this SSE connection (from the
   * x-hangar-instance header). Used to exclude the sender from its own direct
   * message, and — via the stream route's `accept` gate — to honour a
   * `to_filter.instance` narrowing WITHIN an already-authorized audience. It is
   * still never an authorization principal: narrowing only shrinks the set a
   * handle's bearer already reaches (sibling processes under one bearer are
   * mutually trusted), so instance-addressing crosses no trust boundary. Absent
   * on legacy clients (which therefore fail an instance filter fail-closed).
   */
  instance?: string | undefined
  // Per-subscriber gate (ownership + interest), set by the stream route from the
  // authenticated handle's owned-set. When present and it returns false, the
  // envelope is NOT delivered to this subscriber. Absent ⇒ accept all (back-compat).
  accept?: (e: Envelope) => boolean
  deliver: (e: Envelope) => void
  /**
   * Asked to end this connection because the same instance opened a newer one.
   * Set by the stream route; a subscriber without it is simply dropped from
   * the set (its socket, if any, keeps running until its own cleanup).
   */
  close?: () => void
}

export interface MatchedSub {
  handle: string
  instance?: string | undefined
}

/** The same subscriber set minus one instance — used to self-exclude the
 *  sending session from its own narrowed broadcast without excluding the
 *  siblings that share its handle. */
function filterOutInstance(set: Set<Subscriber>, instance: string): Set<Subscriber> {
  const out = new Set<Subscriber>()
  for (const sub of set) if (sub.instance !== instance) out.add(sub)
  return out
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
  deliverDetailed(e: Envelope): { delivered: boolean; selfExcluded: boolean; matched: MatchedSub[] } {
    const byHandle = this.subs.get(e.team)
    const matched: MatchedSub[] = []
    if (!byHandle) return { delivered: false, selfExcluded: false, matched }
    const senderInstance = e.meta['sender_instance']
    let selfExcluded = false
    // ONE collection path for @team and direct (unified so @team can also report a
    // matched count for to_filter{repo}). Per-subscriber `accept` carries BOTH the
    // subject-ownership gate AND the to_filter presence match (set by the stream
    // route, which has the presence registry); fanout stays presence-agnostic.
    const deliverToSet = (handle: string, set: Set<Subscriber>): void => {
      for (const sub of set) {
        // Per-instance self-exclusion (direct only; @team already skips e.from's
        // whole handle). Legacy (either side lacks an instance) keeps old behaviour.
        if (e.from === e.to && senderInstance !== undefined && sub.instance === senderInstance) {
          selfExcluded = true
          continue
        }
        if (sub.accept && !sub.accept(e)) continue
        sub.deliver(e)
        matched.push({ handle, instance: sub.instance })
      }
    }
    if (e.to === TEAM_BROADCAST_HANDLE) {
      for (const [handle, set] of byHandle) {
        // Skipping the sender's whole handle is right for an unqualified
        // broadcast: you do not need your own announcement echoed back, and the
        // sessions beside you are not its audience.
        //
        // It is wrong for a NARROWED one. This fleet runs one handle per host,
        // so "everyone working on project X" would silently exclude every
        // sibling session on the sender's own machine — and a sibling in the
        // same project is the single most likely collaborator. Narrow to
        // per-instance there, exactly as the direct branch already does, so the
        // sender still does not hear itself.
        if (handle === e.from) {
          if (e.to_filter == null) continue
          if (senderInstance === undefined) continue   // legacy peer: keep old behaviour
          deliverToSet(handle, filterOutInstance(set, senderInstance))
          selfExcluded = true
          continue
        }
        deliverToSet(handle, set)
      }
    } else {
      const set = byHandle.get(e.to)
      if (set) deliverToSet(e.to, set)
    }
    return { delivered: matched.length > 0, selfExcluded, matched }
  }

  /**
   * One process, one stream. When an instance opens a new SSE connection, any
   * earlier subscriber it still holds is superseded: evict it from the set and
   * ask it to close. Without this a client that reconnected without closing
   * (a delivery error threw out of the read loop with the body still open)
   * accumulated one subscriber per reconnect, and every message then fanned
   * out to all of them — 6 → 7 → 8 → 10 copies watched on one instance,
   * 2026-09-02. Called by the stream route AFTER it has acquired its own
   * presence refcount, so evicting the old connection cannot drop the row.
   * Legacy subscribers (no instance) cannot be told apart and are left alone.
   * Returns the number evicted.
   */
  evictSuperseded(sub: Subscriber): number {
    if (sub.instance === undefined) return 0
    const set = this.subs.get(sub.team_id)?.get(sub.handle)
    if (!set) return 0
    let evicted = 0
    for (const other of Array.from(set)) {
      if (other === sub || other.instance !== sub.instance) continue
      set.delete(other)
      evicted++
      try { other.close?.() } catch { /* a closing stream must not break the new one */ }
    }
    return evicted
  }

  /** Live subscriber count per instance for one handle (legacy subs are keyed ''). */
  instanceCounts(team_id: string, handle: string): Map<string, number> {
    const out = new Map<string, number>()
    const set = this.subs.get(team_id)?.get(handle)
    if (!set) return out
    for (const sub of set) {
      const k = sub.instance ?? ''
      out.set(k, (out.get(k) ?? 0) + 1)
    }
    return out
  }

  onlineHandles(team_id: string): string[] {
    return Array.from(this.subs.get(team_id)?.keys() ?? [])
  }

  isOnline(team_id: string, handle: string): boolean {
    return (this.subs.get(team_id)?.get(handle)?.size ?? 0) > 0
  }
}
