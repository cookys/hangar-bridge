import { describe, it, expect, beforeEach } from 'vitest'
import { InboundDispatcher } from './inbound.ts'
import { SenderGate } from './gate.ts'
import { DispatchTracker } from './correlation.ts'
import type { Envelope } from '@hangar-bridge/shared'

const envelope = (overrides: Partial<Envelope> = {}): Envelope => ({
  id: 'msg_01HRK7Y0000000000000000000', v: 2, team: 't1',
  from: 'alice', to: 'bob', in_reply_to: null, thread_root: null,
  kind: 'chat', content: 'hi', meta: {},
  sent_at: '2026-04-17T00:00:00.000Z', delivered_at: null,
  ...overrides
})

describe('InboundDispatcher', () => {
  let sent: { method: string; params: Record<string, unknown> }[]
  let d: InboundDispatcher
  beforeEach(() => {
    sent = []
    d = new InboundDispatcher({
      gate: new SenderGate(['alice','bob']),
      emit: n => { sent.push(n) },
      setCursor: () => { /* no-op */ },
    })
  })

  it('emits a claude/channel notification for a chat from known peer', () => {
    d.handle(envelope())
    expect(sent).toHaveLength(1)
    expect(sent[0]!.method).toBe('notifications/claude/channel')
  })

  it('drops messages from unknown peers', () => {
    d.handle(envelope({ from: 'mallory' }))
    expect(sent).toHaveLength(0)
  })

  it('maps kind=permission_request to correct method', () => {
    d.handle(envelope({
      kind: 'permission_request',
      meta: { request_id: 'abcde', tool_name: 'Bash', input_preview: 'ls', requester: 'alice' }
    }))
    expect(sent[0]!.method).toBe('notifications/claude/channel/permission_request')
  })

  it('maps kind=permission_verdict to correct method', () => {
    d.handle(envelope({
      kind: 'permission_verdict',
      in_reply_to: 'msg_01HRK7Y0000000000000000001',
      meta: { request_id: 'abcde', behavior: 'allow' }
    }))
    expect(sent[0]!.method).toBe('notifications/claude/channel/permission')
  })

  it('updates cursor on each accepted message', () => {
    const cursors: string[] = []
    const d2 = new InboundDispatcher({
      gate: new SenderGate(['alice']),
      emit: () => { /* no-op */ },
      setCursor: id => cursors.push(id),
    })
    d2.handle(envelope({ id: 'msg_01HRK7Y0000000000000000001' }))
    d2.handle(envelope({ id: 'msg_01HRK7Y0000000000000000002', from: 'alice' }))
    expect(cursors[cursors.length - 1]).toBe('msg_01HRK7Y0000000000000000002')
  })

  it('still advances cursor when emit throws (error is logged, not propagated)', () => {
    const cursors: string[] = []
    const d3 = new InboundDispatcher({
      gate: new SenderGate(['alice']),
      emit: () => { throw new Error('mcp server detached') },
      setCursor: id => cursors.push(id),
    })
    // Should not throw — handle swallows the emit error after logging it.
    expect(() => d3.handle(envelope({ id: 'msg_01HRK7Y0000000000000000099' }))).not.toThrow()
    expect(cursors).toEqual(['msg_01HRK7Y0000000000000000099'])
  })

  it('tolerates non-Error thrown from emit (String coercion branch)', () => {
    const d4 = new InboundDispatcher({
      gate: new SenderGate(['alice']),
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      emit: () => { throw 'string reason' },
      setCursor: () => { /* no-op */ },
    })
    expect(() => d4.handle(envelope())).not.toThrow()
  })

  it('matches incoming task_result against DispatchTracker and emits notification', () => {
    const tracker = new DispatchTracker({ ttlMs: 60_000 })
    tracker.recordOutgoing('01HR0000000000000000000ABC', 'msg_01HRK7Y0000000000000000DSP', 'alice')
    const d5 = new InboundDispatcher({
      gate: new SenderGate(['alice']),
      emit: n => { sent.push(n) },
      setCursor: () => { /* no-op */ },
      dispatchTracker: tracker,
    })
    d5.handle(envelope({
      kind: 'task_result',
      in_reply_to: 'msg_01HRK7Y0000000000000000DSP',
      content: 'done',
      meta: { correlation_id: '01HR0000000000000000000ABC' },
    }))
    expect(sent).toHaveLength(1)
    expect(sent[0]!.method).toBe('notifications/claude/channel')
    expect((sent[0]!.params as { correlation_id?: string }).correlation_id).toBe('01HR0000000000000000000ABC')
  })

  it('still emits task_result with unknown correlation_id (orphan — flagged, not dropped)', () => {
    const tracker = new DispatchTracker({ ttlMs: 60_000 })
    const d6 = new InboundDispatcher({
      gate: new SenderGate(['alice']),
      emit: n => { sent.push(n) },
      setCursor: () => { /* no-op */ },
      dispatchTracker: tracker,
    })
    d6.handle(envelope({
      kind: 'task_result',
      in_reply_to: 'msg_01HRK7Y0000000000000000ORP',
      content: 'orphan reply',
      meta: { correlation_id: '01HR000000000000UNKNOWNCID' },
    }))
    expect(sent).toHaveLength(1)
    expect(sent[0]!.method).toBe('notifications/claude/channel')
  })
})
