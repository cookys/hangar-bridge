import type { OutboundMessage } from '@hangar-bridge/shared'
import type { DeafCheckResult } from './deaf-check.ts'

/**
 * Persistent process health state (P0 deaf-immunity).
 *
 * Deafness is stamped onto EVERY presence summary via decorateSummary —
 * connect, 30s heartbeat, and explicit set_summary all flow through the
 * same relayClient.setPresence wrapper, so the marker cannot be overwritten
 * by a later heartbeat the way a one-shot set_summary would be.
 */
const DEAF_PREFIX = 'DEAF(inbound-dropped): '

/**
 * The three-valued presence bit (P2 §2.6). `unverified` is the honest
 * default for a session whose inbound rendering we cannot observe.
 */
export type DeliveryState = 'unverified' | 'verified' | 'deaf'

/** Agent Call receipts do not prove model observation, so Channel health is irrelevant. */
export function resolveFinalMileHealth(
  kind: 'claude-channel' | 'agent-call',
  checkChannel: () => DeafCheckResult,
): DeafCheckResult {
  if (kind === 'agent-call') {
    return { state: 'skip', reason: 'agent-call final-mile has no model-observation health probe' }
  }
  return checkChannel()
}

/** Only a positive observation is recovery; unknown/skip must preserve prior evidence. */
export function shouldClearPersistedDeafState(check: DeafCheckResult): boolean {
  return check.state === 'verified'
}

/**
 * Decorate every transport's outbound payload at the shared send boundary.
 * Health keys are process-observed state and therefore override caller meta.
 */
export function withOutboundHealth(
  message: OutboundMessage,
  health: HealthState,
): OutboundMessage {
  const marker = health.outboundMeta()
  if (Object.keys(marker).length === 0) return message
  return { ...message, meta: { ...(message.meta ?? {}), ...marker } }
}

export class HealthState {
  /**
   * @param deafSinceMs first moment this process knew it was deaf. Persisted by the
   *   caller across restarts (deaf-check runs at startup only), because a receiver
   *   treats "deaf for two months" very differently from "deaf for five minutes":
   *   the former makes every claim of not having received something worthless.
   */
  constructor(
    private readonly check: DeafCheckResult,
    private readonly deafSinceMs?: number,
  ) {}

  isDeaf(): boolean {
    return this.check.state === 'deaf'
  }

  /**
   * Map the startup check onto the presence bit. `skip` — non-Claude harness,
   * unreadable /proc, unknown mcp key — becomes `unverified`, never `deaf`:
   * the check's fail-open discipline must not turn into a false alarm on the
   * fleet dashboard.
   */
  deliveryState(): DeliveryState {
    if (this.check.state === 'deaf') return 'deaf'
    if (this.check.state === 'verified') return 'verified'
    return 'unverified'
  }

  reason(): string {
    return this.check.reason
  }

  decorateSummary(summary: string): string {
    if (!this.isDeaf()) return summary
    if (summary.startsWith(DEAF_PREFIX)) return summary
    return DEAF_PREFIX + summary
  }

  /**
   * Meta keys attached to EVERY outbound message while deaf (P4'c).
   *
   * Marker, not a hard stop: a deaf session's send path still works, and refusing
   * to send would kill the one beacon that lets the fleet learn it is deaf at all —
   * the exact failure that let this box run deaf for two months. Ruling: mark, and
   * let the receiver discount.
   *
   * These ride as META because the subject-routing spec renders meta into the
   * <channel> envelope the receiver actually reads. A warning the receiver has to
   * query for is no warning — and this needs no change to the <channel> tag shape.
   *
   * Semantics for the receiver: this sender's statements about ITSELF stay
   * trustworthy (it can see itself); its statements about CONVERSATION HISTORY do
   * not (its inbound context has holes). Every "that wasn't me" in the 8/22 thread
   * was sincere and wrong for exactly this reason.
   */
  outboundMeta(): Record<string, string> {
    if (!this.isDeaf()) return {}
    const meta: Record<string, string> = { sender_health: 'deaf' }
    // Corrupt or hostile persisted state must never suppress the only outbound
    // beacon a deaf process still has. Keep the health marker and omit only the
    // unusable timestamp.
    if (
      this.deafSinceMs !== undefined
      && Number.isFinite(this.deafSinceMs)
      && this.deafSinceMs >= 0
      && this.deafSinceMs <= 8_640_000_000_000_000
    ) {
      meta['deaf_since'] = new Date(this.deafSinceMs).toISOString()
    }
    return meta
  }
}
