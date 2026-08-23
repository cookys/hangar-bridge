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

export class HealthState {
  constructor(private readonly check: DeafCheckResult) {}

  isDeaf(): boolean {
    return this.check.state === 'deaf'
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
