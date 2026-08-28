import type { Envelope } from '@hangar-bridge/shared'
import { TEAM_BROADCAST_HANDLE, envelopeToChannelNotification, matchesInterest } from '@hangar-bridge/shared'
import { SenderGate } from './gate.ts'
import type { PermissionTracker, PermissionOutboundTracker } from './permission.ts'
import type { DispatchTracker } from './correlation.ts'
import type { ReplyLimiter } from './reply-limiter.ts'
import type { PresenceTracker } from './presence-tracker.ts'
import { logJson } from './logger.ts'

export interface InboundDispatcherOpts {
  gate: SenderGate
  emit: (
    notification: { method: string; params: Record<string, unknown> },
    envelope: Envelope,
  ) => void | Promise<void>
  setCursor: (id: string) => void
  // Local interest narrowing (exact or trailing '>'). FAIL-OPEN relative to the
  // relay (M5): only narrows by interest, NEVER drops on ownership — the relay's
  // gate is authoritative, so local config drift must not lose owned-and-delivered
  // traffic. Empty ⇒ no local narrowing.
  interest?: string[] | undefined
  permissionTracker?: PermissionTracker | undefined
  dispatchTracker?: DispatchTracker | undefined
  // SEC-M1: authorizes inbound permission_verdicts against the outbound relay-target
  // set. A verdict whose `from` is not a peer we relayed the request to is DROPPED
  // (never applied) — closes the compromised-peer verdict-snipe under first-answer-wins.
  permissionOutboundTracker?: PermissionOutboundTracker | undefined
  replyLimiter?: ReplyLimiter | undefined
  // AC7 (SSE/relay lane): records presence_update heartbeats as liveness so they are
  // swallowed instead of emitted to the MCP host. The NATS lane intercepts presence at
  // the wire layer (nats-transport.ts) and never reaches this dispatcher; the SSE lane
  // routes every envelope here, so the parity guard lives in handle(). Optional: when
  // absent, presence is still swallowed (never emitted), just not locally tracked.
  presenceTracker?: PresenceTracker | undefined
  // Injectable clock for the presence heartbeat timestamp (tests). Defaults to Date.now.
  now?: (() => number) | undefined
}

/**
 * Result of passing one authenticated envelope through the application dispatcher.
 *
 * JetStream uses this distinction as a durability boundary: only `delivered` or
 * `already-delivered` may create the permanent correlation completion marker.
 * A deterministic security/policy rejection is terminal for that wire message,
 * but must not consume the correlation that a legitimate peer may still answer.
 */
export type InboundDeliveryResult = 'delivered' | 'already-delivered' | 'rejected'

const SEEN_CAP = 4096

function deliveryFingerprint(e: Envelope): string {
  // `delivered_at` is intentionally excluded: the relay may stamp it between a
  // live event and backlog replay of the same stored envelope. Every producer-
  // controlled or routing-relevant field is included, with meta keys sorted so
  // semantically identical JSON cannot differ only by object-key order.
  const meta = Object.entries(e.meta).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify([
    e.v, e.team, e.from, e.to, e.subject, e.in_reply_to, e.thread_root,
    e.kind, e.content, meta, e.sent_at,
  ])
}

export class InboundDispatcher {
  private seen = new Map<string, string>()
  constructor(private opts: InboundDispatcherOpts) {}

  async handle(e: Envelope): Promise<InboundDeliveryResult> {
    logJson('info', 'peer.inbound.received', { from: e.from, kind: e.kind, msg_id: e.id })
    if (!this.opts.gate.accept(e.from)) {
      logJson('warn', 'peer.inbound.sender_gate_drop', { from: e.from, msg_id: e.id })
      return 'rejected'
    }
    // presence_update is a liveness heartbeat, not chat. Two things must happen and
    // neither may be dropped: record the beat against the gate-accepted (relay-
    // authenticated) sender, and swallow it WITHOUT emitting a channel notification.
    // Emitting wakes the MCP host every PRESENCE_HEARTBEAT_MS and floods the session
    // context with zero-information "(connected)" noise that crowds out real peer
    // traffic; presence is pull-shaped instead (list_peers queries /v1/peers live).
    // This mirrors the NATS lane, which records presence at the wire layer and never
    // forwards it here. Placed after the sender gate (unknown-peer presence is still
    // dropped) and before interest narrowing (liveness is subject-agnostic). Advance
    // the cursor so the heartbeat is not re-processed on replay.
    if (e.kind === 'presence_update') {
      this.opts.presenceTracker?.onHeartbeat(e.from, (this.opts.now ?? Date.now)())
      this.opts.setCursor(e.id)
      return 'delivered'
    }
    // Local interest narrowing (fail-open: interest only, never ownership).
    const interest = this.opts.interest
    if (e.subject !== null && interest && interest.length > 0 && !matchesInterest(e.subject, interest)) {
      this.opts.setCursor(e.id)
      return 'rejected'
    }
    // SEC-M1: a permission_verdict is a directive that (via first-answer-wins) can
    // auto-approve a local tool call. Authenticate the RESPONDER, not just the
    // request_id: only apply a verdict from a peer we actually relayed this request to.
    // Fail-closed: no tracker (relay disabled) ⇒ we never asked ⇒ every verdict is
    // unsolicited ⇒ drop. Advance the cursor so we don't re-process it, but do NOT emit.
    if (e.kind === 'permission_verdict') {
      const rid = e.meta.request_id ?? ''
      if (!this.opts.permissionOutboundTracker
          || !rid
          || !this.opts.permissionOutboundTracker.isAuthorizedResponder(rid, e.from, e.in_reply_to)) {
        logJson('warn', 'peer.inbound.permission_verdict_unauthorized', {
          from: e.from, msg_id: e.id, request_id: rid,
        })
        this.opts.setCursor(e.id)
        return 'rejected'
      }
      logJson('info', 'peer.inbound.permission_verdict_authorized', {
        from: e.from, msg_id: e.id, request_id: rid,
      })
    }
    if (e.kind === 'task_result' && this.opts.dispatchTracker) {
      const cid = e.meta.correlation_id ?? ''
      const expectedPeer = cid ? this.opts.dispatchTracker.peerFor(cid) : undefined
      if (expectedPeer && expectedPeer !== TEAM_BROADCAST_HANDLE && expectedPeer !== e.from) {
        logJson('warn', 'peer.inbound.dispatch_wrong_peer', {
          from: e.from,
          expected_from: expectedPeer,
          msg_id: e.id,
          correlation_id: cid,
        })
        this.opts.setCursor(e.id)
        return 'rejected'
      }
      if (!cid || !expectedPeer) {
        // Orphan task_result — the dispatch TTL expired, or the peer is replying without
        // a known correlation_id. (A relay/peer-agent restart no longer orphans a live
        // correlation: DispatchTracker is now disk-backed — see correlation.ts persistPath.)
        // Still emit the notification (caller sees it) but flag for forensics.
        logJson('warn', 'peer.inbound.dispatch_orphan', { from: e.from, msg_id: e.id, correlation_id: cid })
      } else {
        logJson('info', 'peer.inbound.dispatch_matched', { from: e.from, msg_id: e.id, correlation_id: cid })
      }
    }
    // Dedupe only after current security/policy validation. A msg_id alone is not
    // sufficient proof of prior delivery because authenticated peers choose their
    // own IDs and may collide deliberately. Only the exact stable envelope may use
    // `already-delivered` to retry a completion-marker write without re-emitting.
    const fingerprint = deliveryFingerprint(e)
    const priorFingerprint = this.seen.get(e.id)
    if (priorFingerprint !== undefined) {
      this.opts.setCursor(e.id)
      if (priorFingerprint !== fingerprint) {
        logJson('warn', 'peer.inbound.msg_id_collision', {
          from: e.from, kind: e.kind, msg_id: e.id,
        })
        return 'rejected'
      }
      return 'already-delivered'
    }
    if (e.kind === 'permission_request' && this.opts.permissionTracker) {
      const rid = e.meta.request_id ?? ''
      if (rid) this.opts.permissionTracker.recordIncoming(rid, e.id, e.from)
    }
    const notification = envelopeToChannelNotification(e)
    try {
      await this.opts.emit(notification, e)
      logJson('info', 'peer.inbound.emitted', { method: notification.method, msg_id: e.id })
    } catch (err) {
      logJson('error', 'peer.inbound.emit_error', {
        method: notification.method,
        msg_id: e.id,
        err: String(err instanceof Error ? err.message : err),
      })
      throw err
    }
    // Mutate terminal/anti-repeat state only after the MCP client accepted delivery.
    // A rejected notification must remain retryable by JetStream/SSE replay.
    if (e.kind === 'permission_verdict') {
      const rid = e.meta.request_id ?? ''
      if (rid) this.opts.permissionOutboundTracker?.consume(rid)
    }
    this.opts.replyLimiter?.recordInbound(e.from)
    // Bounded FIFO eviction (Set preserves insertion order): drop the oldest id, not
    // the whole set — a wholesale clear could re-inject a just-evicted id on replay.
    if (this.seen.size >= SEEN_CAP) {
      const oldest = this.seen.keys().next().value
      if (oldest !== undefined) this.seen.delete(oldest)
    }
    this.seen.set(e.id, fingerprint)
    this.opts.setCursor(e.id)
    return 'delivered'
  }
}
