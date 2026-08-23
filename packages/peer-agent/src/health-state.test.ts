import { describe, it, expect } from 'vitest'
import { HealthState } from './health-state.ts'
import type { DeafCheckResult } from './deaf-check.ts'

/**
 * P0: DEAF must be a persistent process health state applied by ONE builder
 * on every presence write — a one-shot set_summary would be overwritten by
 * the 30s heartbeat within a cycle (sol R9).
 */
describe('HealthState', () => {
  const deaf: DeafCheckResult = { state: 'deaf', reason: 'claude ancestor has no channels flag' }
  const ok: DeafCheckResult = { state: 'verified', reason: 'flag ok' }
  const skip: DeafCheckResult = { state: 'skip', reason: 'no claude ancestor' }

  it('prefixes every summary while deaf', () => {
    const h = new HealthState(deaf)
    expect(h.decorateSummary('(connected)')).toBe('DEAF(inbound-dropped): (connected)')
    expect(h.decorateSummary('working on X')).toBe('DEAF(inbound-dropped): working on X')
  })

  it('does not double-prefix an already-prefixed summary', () => {
    const h = new HealthState(deaf)
    const once = h.decorateSummary('(connected)')
    expect(h.decorateSummary(once)).toBe(once)
  })

  it('passes summaries through untouched when verified or skipped', () => {
    expect(new HealthState(ok).decorateSummary('(connected)')).toBe('(connected)')
    expect(new HealthState(skip).decorateSummary('(connected)')).toBe('(connected)')
  })

  it('exposes deafness for logging/exit decisions', () => {
    expect(new HealthState(deaf).isDeaf()).toBe(true)
    expect(new HealthState(ok).isDeaf()).toBe(false)
    expect(new HealthState(skip).isDeaf()).toBe(false)
  })
})
