import type { Envelope } from '@hangar-bridge/shared'
import { envelopeToChannelNotification } from '@hangar-bridge/shared'
import { SenderGate } from './gate.ts'
import type { PermissionTracker } from './permission.ts'
import type { DispatchTracker } from './correlation.ts'
import type { ReplyLimiter } from './reply-limiter.ts'
import { logJson } from './logger.ts'

export interface InboundDispatcherOpts {
  gate: SenderGate
  emit: (notification: { method: string; params: Record<string, unknown> }) => void
  setCursor: (id: string) => void
  permissionTracker?: PermissionTracker | undefined
  dispatchTracker?: DispatchTracker | undefined
  replyLimiter?: ReplyLimiter | undefined
}

export class InboundDispatcher {
  constructor(private opts: InboundDispatcherOpts) {}

  handle(e: Envelope): void {
    logJson('info', 'peer.inbound.received', { from: e.from, kind: e.kind, msg_id: e.id })
    if (!this.opts.gate.accept(e.from)) {
      logJson('warn', 'peer.inbound.sender_gate_drop', { from: e.from, msg_id: e.id })
      return
    }
    if (e.kind === 'permission_request' && this.opts.permissionTracker) {
      const rid = e.meta.request_id ?? ''
      if (rid) this.opts.permissionTracker.recordIncoming(rid, e.id, e.from)
    }
    if (e.kind === 'task_result' && this.opts.dispatchTracker) {
      const cid = e.meta.correlation_id ?? ''
      if (!cid || !this.opts.dispatchTracker.has(cid)) {
        // Orphan task_result — either DispatchTracker was lost on restart (in-memory only),
        // the dispatch TTL expired, or the peer is replying without a known correlation_id.
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
    this.opts.setCursor(e.id)
  }
}
