import { describe, it, expect } from 'vitest'
import { Fanout, type Subscriber } from './fanout.ts'
import type { Envelope } from '@hangar-bridge/shared'

/**
 * P4'b — a direct message must not come back to its own sender.
 *
 * The @team branch already skips the sending handle; the direct branch did
 * not, so on a box where several sessions share one handle, addressing that
 * handle delivered the message to the sender's own SSE stream as well.
 * Observed live 2026-08-24 by the cuda peer: a reply it addressed to `cuda`
 * (its own box) arrived back in the very session that sent it.
 */
const env = (o: Partial<Envelope> = {}): Envelope => ({
  id: 'msg_01HRK7Y0000000000000000000', v: 2, team: 't1',
  from: 'cuda', to: 'cuda', in_reply_to: null, thread_root: null,
  kind: 'chat', content: 'hi', meta: {}, subject: null,
  sent_at: '2026-08-24T00:00:00.000Z', delivered_at: null, ...o,
})

const sub = (handle: string, sink: Envelope[], instance?: string): Subscriber => ({
  handle, team_id: 't1', instance, deliver: e => { sink.push(e) },
})

describe('Fanout self-delivery', () => {
  it('does not echo a direct message back to the SENDING INSTANCE', () => {
    const f = new Fanout()
    const mine: Envelope[] = []
    f.subscribe(sub('cuda', mine, 'inst-A'))
    const e = env({ from: 'cuda', to: 'cuda', meta: { sender_instance: 'inst-A' } })
    expect(f.deliver(e)).toBe(false)
    expect(mine).toHaveLength(0)
  })

  it('DOES reach a sibling session on the same handle — the sender intended that', () => {
    // cuda 2026-08-24 addressed its own handle to reach a sibling session on the
    // same box. Excluding the whole handle would have delivered to nobody, which
    // is worse than the echo. Only the sending instance is skipped.
    const f = new Fanout()
    const mine: Envelope[] = []
    const sibling: Envelope[] = []
    f.subscribe(sub('cuda', mine, 'inst-A'))
    f.subscribe(sub('cuda', sibling, 'inst-B'))
    const e = env({ from: 'cuda', to: 'cuda', meta: { sender_instance: 'inst-A' } })
    expect(f.deliver(e)).toBe(true)
    expect(mine).toHaveLength(0)
    expect(sibling).toHaveLength(1)
  })

  it('legacy: no sender_instance in meta ⇒ exactly the current behaviour', () => {
    const f = new Fanout()
    const mine: Envelope[] = []
    f.subscribe(sub('cuda', mine))
    expect(f.deliver(env({ from: 'cuda', to: 'cuda' }))).toBe(true)
    expect(mine).toHaveLength(1)
  })

  it('still delivers a direct message addressed to a DIFFERENT handle', () => {
    const f = new Fanout()
    const mine: Envelope[] = []
    const theirs: Envelope[] = []
    f.subscribe(sub('cuda', mine))
    f.subscribe(sub('gentoo', theirs))
    expect(f.deliver(env({ from: 'cuda', to: 'gentoo' }))).toBe(true)
    expect(mine).toHaveLength(0)
    expect(theirs).toHaveLength(1)
  })

  it('keeps delivering to every sibling session under the RECIPIENT handle', () => {
    // Sibling fan-out is by design (claims arbitrate); only the SENDER is excluded.
    const f = new Fanout()
    const a: Envelope[] = []; const b: Envelope[] = []
    f.subscribe(sub('gentoo', a))
    f.subscribe(sub('gentoo', b))
    expect(f.deliver(env({ from: 'cuda', to: 'gentoo' }))).toBe(true)
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
  })

  // gen-3 F5 residual: when the sender is the handle's ONLY subscriber, deliver()
  // returns false, so the publish route would leave the row undelivered and a later
  // cold start on that handle would drain the sender its own old message back.
  // Ruling (plan P4'b): a self-excluded-only delivery counts as delivered.
  it('reports self-exclusion distinctly from "nobody was listening"', () => {
    const f = new Fanout()
    const mine: Envelope[] = []
    f.subscribe(sub('cuda', mine, 'inst-A'))
    const e = env({ from: 'cuda', to: 'cuda', meta: { sender_instance: 'inst-A' } })
    expect(f.deliverDetailed(e)).toEqual({ delivered: false, selfExcluded: true })
    // and a genuinely absent recipient is NOT self-exclusion
    expect(f.deliverDetailed(env({ from: 'cuda', to: 'nobody' })))
      .toEqual({ delivered: false, selfExcluded: false })
  })

  it('@team behaviour is unchanged — sender excluded, everyone else served', () => {
    const f = new Fanout()
    const me: Envelope[] = []; const other: Envelope[] = []
    f.subscribe(sub('cuda', me))
    f.subscribe(sub('gentoo', other))
    expect(f.deliver(env({ from: 'cuda', to: '@team' }))).toBe(true)
    expect(me).toHaveLength(0)
    expect(other).toHaveLength(1)
  })
})
