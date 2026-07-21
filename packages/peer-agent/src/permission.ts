import { TEAM_BROADCAST_HANDLE } from '@hangar-bridge/shared'

export interface PermissionTrackerOpts { ttlMs: number }

interface Entry {
  msg_id: string
  expires_at: number
  sender_handle: string
}

export class PermissionTracker {
  private map = new Map<string, Entry>()

  constructor(private opts: PermissionTrackerOpts) {}

  recordIncoming(request_id: string, msg_id: string, sender_handle = ''): void {
    this.map.set(request_id.toLowerCase(), {
      msg_id, sender_handle, expires_at: Date.now() + this.opts.ttlMs
    })
    this.gc()
  }

  msgIdFor(request_id: string): string | undefined {
    const key = request_id.toLowerCase()
    const v = this.map.get(key)
    if (!v) return undefined
    if (v.expires_at < Date.now()) { this.map.delete(key); return undefined }
    return v.msg_id
  }

  senderFor(request_id: string): string | undefined {
    return this.map.get(request_id.toLowerCase())?.sender_handle
  }

  private gc(): void {
    const now = Date.now()
    for (const [k, v] of this.map) if (v.expires_at < now) this.map.delete(k)
  }
}

export interface PermissionOutboundTrackerOpts { ttlMs: number }

interface OutEntry {
  /** target -> outbound permission_request envelope id; null until send is confirmed */
  targets: Map<string, string | null>
  expires_at: number
}

/**
 * OUTBOUND permission relay authorization (SEC-M1). Records, per relayed request_id,
 * the exact set of peer handles we forwarded the request to. The inbound verdict path
 * consults this so a `permission_verdict` is only applied when its `from` is a peer we
 * actually asked — upgrading the verdict trust model from secrecy-based (anyone who
 * knows the 5-letter request_id can approve) to authorization-based.
 *
 * Threat closed: with the request_id live on the wire (worst case: `ask_team` broadcasts
 * it to the whole roster), a compromised peer that was NOT the routing target could
 * otherwise race a `permission_verdict{behavior:allow}` and win first-answer-wins,
 * auto-approving a tool call before the local human answers. Now such a verdict is
 * dropped unless the sender is in the relay-target set.
 *
 * `@team` in the target set authorizes any sender that already passed the roster
 * SenderGate — that IS the `ask_team` trust model (the operator opted to trust the whole
 * team); it does not weaken the specific-peer / thread-participant cases this closes.
 */
export class PermissionOutboundTracker {
  private map = new Map<string, OutEntry>()

  constructor(private opts: PermissionOutboundTrackerOpts) {}

  recordRelay(request_id: string, targets: string[]): void {
    const key = request_id.toLowerCase()
    const now = Date.now()
    // Short request IDs can be reused. A newly observed request REPLACES prior
    // authority; unioning would let an old responder authorize the new prompt.
    this.map.set(key, {
      targets: new Map(targets.map(target => [target, null])),
      expires_at: now + this.opts.ttlMs,
    })
    this.gc()
  }

  /** Bind a recorded target to the exact outbound request envelope it received. */
  confirm(request_id: string, target: string, envelope_id: string): void {
    const v = this.map.get(request_id.toLowerCase())
    if (!v || !v.targets.has(target)) return
    v.targets.set(target, envelope_id)
  }

  /**
   * Revoke one target from a request_id's authorized set — called when the outbound
   * send to that peer FAILED, so the "authorize only peers we actually relayed to"
   * invariant holds (a peer we recorded-before-send but never reached must not be able
   * to apply a later verdict). If the set becomes empty (all sends failed) the entry is
   * dropped entirely → any subsequent verdict for that request_id is fail-closed dropped.
   */
  revoke(request_id: string, target: string): void {
    const key = request_id.toLowerCase()
    const v = this.map.get(key)
    if (!v) return
    v.targets.delete(target)
    if (v.targets.size === 0) this.map.delete(key)
  }

  /** True iff we relayed this request_id AND `from` is one of the peers we relayed to. */
  isAuthorizedResponder(request_id: string, from: string, inReplyTo: string | null): boolean {
    const key = request_id.toLowerCase()
    const v = this.map.get(key)
    if (!v) return false
    if (v.expires_at < Date.now()) { this.map.delete(key); return false }
    if (!inReplyTo) return false
    const direct = v.targets.get(from)
    const broadcast = v.targets.get(TEAM_BROADCAST_HANDLE)
    return direct === inReplyTo || broadcast === inReplyTo
  }

  /** Consume terminal authority after Claude accepted the first valid verdict. */
  consume(request_id: string): void {
    this.map.delete(request_id.toLowerCase())
  }

  private gc(): void {
    const now = Date.now()
    for (const [k, v] of this.map) if (v.expires_at < now) this.map.delete(k)
  }
}
