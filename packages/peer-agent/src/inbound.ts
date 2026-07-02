import type { Envelope } from '@hangar-bridge/shared'
import { envelopeToChannelNotification, matchesInterest } from '@hangar-bridge/shared'
import { SenderGate } from './gate.ts'
import type { PermissionTracker } from './permission.ts'
import type { DispatchTracker } from './correlation.ts'
import type { ReplyLimiter } from './reply-limiter.ts'
import { logJson } from './logger.ts'

export interface InboundDispatcherOpts {
  gate: SenderGate
  emit: (notification: { method: string; params: Record<string, unknown> }) => void
  setCursor: (id: string) => void
  // Local interest narrowing (exact or trailing '>'). FAIL-OPEN relative to the
  // relay (M5): only narrows by interest, NEVER drops on ownership — the relay's
  // gate is authoritative, so local config drift must not lose owned-and-delivered
  // traffic. Empty ⇒ no local narrowing.
  interest?: string[] | undefined
  permissionTracker?: PermissionTracker | undefined
  dispatchTracker?: DispatchTracker | undefined
  replyLimiter?: ReplyLimiter | undefined
}

const SEEN_CAP = 4096

export class InboundDispatcher {
  private seen = new Set<string>()
  constructor(private opts: InboundDispatcherOpts) {}

  handle(e: Envelope): void {
    logJson('info', 'peer.inbound.received', { from: e.from, kind: e.kind, msg_id: e.id })
    if (!this.opts.gate.accept(e.from)) {
      logJson('warn', 'peer.inbound.sender_gate_drop', { from: e.from, msg_id: e.id })
      return
    }
    // Dedupe by msg_id (covers the subscribe/backlog connect-window): advance the
    // cursor past a re-seen envelope but do NOT re-inject it into context.
    if (this.seen.has(e.id)) {
      this.opts.setCursor(e.id)
      return
    }
    // Local interest narrowing (fail-open: interest only, never ownership).
    const interest = this.opts.interest
    if (e.subject !== null && interest && interest.length > 0 && !matchesInterest(e.subject, interest)) {
      this.opts.setCursor(e.id)
      return
    }
    if (e.kind === 'permission_request' && this.opts.permissionTracker) {
      const rid = e.meta.request_id ?? ''
      if (rid) this.opts.permissionTracker.recordIncoming(rid, e.id, e.from)
    }
    if (e.kind === 'task_result' && this.opts.dispatchTracker) {
      const cid = e.meta.correlation_id ?? ''
      if (!cid || !this.opts.dispatchTracker.has(cid)) {
        // Orphan task_result — the dispatch TTL expired, or the peer is replying without
        // a known correlation_id. (A relay/peer-agent restart no longer orphans a live
        // correlation: DispatchTracker is now disk-backed — see correlation.ts persistPath.)
        // Still emit the notification (caller sees it) but flag for forensics.
        logJson('warn', 'peer.inbound.dispatch_orphan', { from: e.from, msg_id: e.id, correlation_id: cid })
      } else {
        logJson('info', 'peer.inbound.dispatch_matched', { from: e.from, msg_id: e.id, correlation_id: cid })
      }
    }
    this.opts.replyLimiter?.recordInbound(e.from)
    const notification = envelopeToChannelNotification(e)
    try {
      this.opts.emit(notification)
      logJson('info', 'peer.inbound.emitted', { method: notification.method, msg_id: e.id })
    } catch (err) {
      logJson('error', 'peer.inbound.emit_error', {
        method: notification.method,
        msg_id: e.id,
        err: String(err instanceof Error ? err.message : err),
      })
    }
    // Bounded FIFO eviction (Set preserves insertion order): drop the oldest id, not
    // the whole set — a wholesale clear could re-inject a just-evicted id on replay.
    if (this.seen.size >= SEEN_CAP) {
      const oldest = this.seen.values().next().value
      if (oldest !== undefined) this.seen.delete(oldest)
    }
    this.seen.add(e.id)
    this.opts.setCursor(e.id)
  }
}
