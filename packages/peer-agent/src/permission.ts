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

interface OutEntry { targets: Set<string>; expires_at: number }

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
    const existing = this.map.get(key)
    if (existing && existing.expires_at >= now) {
      for (const t of targets) existing.targets.add(t)
      existing.expires_at = now + this.opts.ttlMs
    } else {
      this.map.set(key, { targets: new Set(targets), expires_at: now + this.opts.ttlMs })
    }
    this.gc()
  }

  /** True iff we relayed this request_id AND `from` is one of the peers we relayed to. */
  isAuthorizedResponder(request_id: string, from: string): boolean {
    const key = request_id.toLowerCase()
    const v = this.map.get(key)
    if (!v) return false
    if (v.expires_at < Date.now()) { this.map.delete(key); return false }
    return v.targets.has(TEAM_BROADCAST_HANDLE) || v.targets.has(from)
  }

  private gc(): void {
    const now = Date.now()
    for (const [k, v] of this.map) if (v.expires_at < now) this.map.delete(k)
  }
}
