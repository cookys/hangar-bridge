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

export class HealthState {
  constructor(private readonly check: DeafCheckResult) {}

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
}
