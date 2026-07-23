import { describe, it, expect, beforeEach } from 'vitest'
import { InboundDispatcher } from './inbound.ts'
import { createPresenceTracker } from './presence-tracker.ts'
import { SenderGate } from './gate.ts'
import { DispatchTracker } from './correlation.ts'
import { PermissionOutboundTracker } from './permission.ts'
import { ApprovalRouter } from './approval-routing.ts'
import { makeOutboundPermissionHandler } from './permission-relay.ts'
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

  it('emits a claude/channel notification for a chat from known peer', async () => {
    await expect(d.handle(envelope())).resolves.toBe('delivered')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.method).toBe('notifications/claude/channel')
  })

  it('drops messages from unknown peers', async () => {
    await expect(d.handle(envelope({ from: 'mallory' }))).resolves.toBe('rejected')
    expect(sent).toHaveLength(0)
  })

  it('accepts only the exact previously delivered envelope for msg_id dedup', async () => {
    await expect(d.handle(envelope())).resolves.toBe('delivered')
    await expect(d.handle(envelope())).resolves.toBe('already-delivered')
    await expect(d.handle(envelope({ content: 'same id, different payload' }))).resolves.toBe('rejected')
    expect(sent).toHaveLength(1)
  })

  it('maps kind=permission_request to correct method', async () => {
    await d.handle(envelope({
      kind: 'permission_request',
      meta: { request_id: 'abcde', tool_name: 'Bash', input_preview: 'ls', requester: 'alice' }
    }))
    expect(sent[0]!.method).toBe('notifications/claude/channel/permission_request')
  })

  it('applies a permission_verdict ONLY from a peer we relayed the request to (SEC-M1)', async () => {
    const outbound = new PermissionOutboundTracker({ ttlMs: 60_000 })
    outbound.recordRelay('abcde', ['alice']) // we asked alice
    const d5 = new InboundDispatcher({
      gate: new SenderGate(['alice', 'bob']),
      emit: n => { sent.push(n) },
      setCursor: () => { /* no-op */ },
      permissionOutboundTracker: outbound,
    })
    outbound.confirm('abcde', 'alice', 'msg_01HRK7Y0000000000000000001')
    await d5.handle(envelope({
      from: 'alice',
      kind: 'permission_verdict',
      in_reply_to: 'msg_01HRK7Y0000000000000000001',
      meta: { request_id: 'abcde', behavior: 'allow' }
    }))
    expect(sent).toHaveLength(1)
    expect(sent[0]!.method).toBe('notifications/claude/channel/permission')
  })

  it('DROPS a permission_verdict from a peer we did NOT ask (compromised-peer snipe) (SEC-M1)', async () => {
    const outbound = new PermissionOutboundTracker({ ttlMs: 60_000 })
    outbound.recordRelay('abcde', ['alice']) // we asked alice, NOT bob
    const cursors: string[] = []
    const d5 = new InboundDispatcher({
      gate: new SenderGate(['alice', 'bob']), // bob is on the roster (passes SenderGate)
      emit: n => { sent.push(n) },
      setCursor: id => cursors.push(id),
      permissionOutboundTracker: outbound,
    })
    // bob races an allow verdict for a request that was only relayed to alice.
    outbound.confirm('abcde', 'alice', 'msg_01HRK7Y0000000000000000001')
    await d5.handle(envelope({
      id: 'msg_01HRK7Y00000000000000000BB',
      from: 'bob',
      kind: 'permission_verdict',
      in_reply_to: 'msg_01HRK7Y0000000000000000001',
      meta: { request_id: 'abcde', behavior: 'allow' }
    }))
    expect(sent).toHaveLength(0)                               // never applied
    expect(cursors).toEqual(['msg_01HRK7Y00000000000000000BB']) // but cursor advances
  })

  it('DROPS a permission_verdict when no outbound tracker exists (we never asked → fail-closed) (SEC-M1)', async () => {
    await d.handle(envelope({
      from: 'alice',
      kind: 'permission_verdict',
      in_reply_to: 'msg_01HRK7Y0000000000000000001',
      meta: { request_id: 'abcde', behavior: 'allow' }
    }))
    expect(sent).toHaveLength(0)
  })

  it('end-to-end: a peer whose outbound relay send FAILED cannot apply a verdict (SEC-M1)', async () => {
    // Shared tracker across the outbound relay and the inbound dispatcher — as wired in
    // index.ts. The relay to bob fails, so bob's authorization is revoked; his verdict
    // must then be dropped inbound.
    const tracker = new PermissionOutboundTracker({ ttlMs: 60_000 })
    const relay = makeOutboundPermissionHandler({
      client: { send: async () => { throw new Error('relay down') } },
      approvalRouter: new ApprovalRouter({ routing: 'ask_specific_peer:bob' }),
      selfHandle: 'alice',
      ttlMs: 60_000,
      outboundTracker: tracker,
    })
    await relay({ request_id: 'abcde', tool_name: 'Bash', description: 'x', input_preview: 'x' })

    const d5 = new InboundDispatcher({
      gate: new SenderGate(['alice', 'bob']),
      emit: n => { sent.push(n) },
      setCursor: () => { /* no-op */ },
      permissionOutboundTracker: tracker,
    })
    await d5.handle(envelope({
      from: 'bob',
      kind: 'permission_verdict',
      in_reply_to: 'msg_01HRK7Y0000000000000000001',
      meta: { request_id: 'abcde', behavior: 'allow' }
    }))
    expect(sent).toHaveLength(0) // never applied — send failed, authorization revoked
  })

  it('authorizes any roster responder when the request was relayed to @team (SEC-M1)', async () => {
    const outbound = new PermissionOutboundTracker({ ttlMs: 60_000 })
    outbound.recordRelay('abcde', ['@team'])
    const d5 = new InboundDispatcher({
      gate: new SenderGate(['alice', 'bob']),
      emit: n => { sent.push(n) },
      setCursor: () => { /* no-op */ },
      permissionOutboundTracker: outbound,
    })
    outbound.confirm('abcde', '@team', 'msg_01HRK7Y0000000000000000001')
    await d5.handle(envelope({
      from: 'bob',
      kind: 'permission_verdict',
      in_reply_to: 'msg_01HRK7Y0000000000000000001',
      meta: { request_id: 'abcde', behavior: 'allow' }
    }))
    expect(sent).toHaveLength(1)
    expect(sent[0]!.method).toBe('notifications/claude/channel/permission')
  })

  it('updates cursor on each accepted message', async () => {
    const cursors: string[] = []
    const d2 = new InboundDispatcher({
      gate: new SenderGate(['alice']),
      emit: () => { /* no-op */ },
      setCursor: id => cursors.push(id),
    })
    await d2.handle(envelope({ id: 'msg_01HRK7Y0000000000000000001' }))
    await d2.handle(envelope({ id: 'msg_01HRK7Y0000000000000000002', from: 'alice' }))
    expect(cursors[cursors.length - 1]).toBe('msg_01HRK7Y0000000000000000002')
  })

  it('rejects and leaves cursor unchanged when MCP delivery fails', async () => {
    const cursors: string[] = []
    const d3 = new InboundDispatcher({
      gate: new SenderGate(['alice']),
      emit: () => { throw new Error('mcp server detached') },
      setCursor: id => cursors.push(id),
    })
    await expect(d3.handle(envelope({ id: 'msg_01HRK7Y0000000000000000099' })))
      .rejects.toThrow('mcp server detached')
    expect(cursors).toEqual([])
  })

  it('propagates a non-Error delivery rejection after logging it', async () => {
    const d4 = new InboundDispatcher({
      gate: new SenderGate(['alice']),
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      emit: () => { throw 'string reason' },
      setCursor: () => { /* no-op */ },
    })
    await expect(d4.handle(envelope())).rejects.toBe('string reason')
  })

  it('matches incoming task_result against DispatchTracker and emits notification', async () => {
    const tracker = new DispatchTracker({ ttlMs: 60_000 })
    tracker.recordOutgoing('01HR0000000000000000000ABC', 'msg_01HRK7Y0000000000000000DSP', 'alice')
    const d5 = new InboundDispatcher({
      gate: new SenderGate(['alice']),
      emit: n => { sent.push(n) },
      setCursor: () => { /* no-op */ },
      dispatchTracker: tracker,
    })
    await d5.handle(envelope({
      kind: 'task_result',
      in_reply_to: 'msg_01HRK7Y0000000000000000DSP',
      content: 'done',
      meta: { correlation_id: '01HR0000000000000000000ABC' },
    }))
    expect(sent).toHaveLength(1)
    expect(sent[0]!.method).toBe('notifications/claude/channel')
    expect((sent[0]!.params as { correlation_id?: string }).correlation_id).toBe('01HR0000000000000000000ABC')
  })

  it('drops a task_result whose correlation belongs to a different peer', async () => {
    const tracker = new DispatchTracker({ ttlMs: 60_000 })
    tracker.recordOutgoing('01HR0000000000000000000ABC', 'msg_01HRK7Y0000000000000000DSP', 'alice')
    const cursors: string[] = []
    const d5 = new InboundDispatcher({
      gate: new SenderGate(['alice', 'bob']),
      emit: n => { sent.push(n) },
      setCursor: id => cursors.push(id),
      dispatchTracker: tracker,
    })
    const result = await d5.handle(envelope({
      id: 'msg_01HRK7Y00000000000000000BC',
      from: 'bob',
      kind: 'task_result',
      in_reply_to: 'msg_01HRK7Y0000000000000000DSP',
      content: 'forged result',
      meta: { correlation_id: '01HR0000000000000000000ABC' },
    }))
    expect(result).toBe('rejected')
    expect(sent).toHaveLength(0)
    expect(cursors).toEqual(['msg_01HRK7Y00000000000000000BC'])
  })

  it('still emits task_result with unknown correlation_id (orphan — flagged, not dropped)', async () => {
    const tracker = new DispatchTracker({ ttlMs: 60_000 })
    const d6 = new InboundDispatcher({
      gate: new SenderGate(['alice']),
      emit: n => { sent.push(n) },
      setCursor: () => { /* no-op */ },
      dispatchTracker: tracker,
    })
    await d6.handle(envelope({
      kind: 'task_result',
      in_reply_to: 'msg_01HRK7Y0000000000000000ORP',
      content: 'orphan reply',
      meta: { correlation_id: '01HR000000000000UNKNOWNCID' },
    }))
    expect(sent).toHaveLength(1)
    expect(sent[0]!.method).toBe('notifications/claude/channel')
  })

  it('swallows a presence_update heartbeat WITHOUT emitting (AC7 — no MCP-host wake)', async () => {
    const cursors: string[] = []
    const d7 = new InboundDispatcher({
      gate: new SenderGate(['alice', 'bob']),
      emit: n => { sent.push(n) },
      setCursor: id => { cursors.push(id) },
    })
    await expect(d7.handle(envelope({ kind: 'presence_update', content: '(connected)' })))
      .resolves.toBe('delivered')
    expect(sent).toHaveLength(0)            // never emitted as a channel notification
    expect(cursors).toEqual(['msg_01HRK7Y0000000000000000000']) // cursor still advances
  })

  it('records the presence heartbeat against the sender via the tracker + injected clock', async () => {
    const tracker = createPresenceTracker(90_000)
    const d8 = new InboundDispatcher({
      gate: new SenderGate(['alice', 'bob']),
      emit: n => { sent.push(n) },
      setCursor: () => { /* no-op */ },
      presenceTracker: tracker,
      now: () => 1_000,
    })
    await d8.handle(envelope({ from: 'alice', kind: 'presence_update' }))
    expect(tracker.lastSeen('alice')).toBe(1_000)
    expect(tracker.isOnline('alice', 1_000)).toBe(true)
    expect(sent).toHaveLength(0)
  })

  it('gate still drops a presence_update from an unknown peer (not tracked, not emitted)', async () => {
    const tracker = createPresenceTracker(90_000)
    const d9 = new InboundDispatcher({
      gate: new SenderGate(['alice', 'bob']),
      emit: n => { sent.push(n) },
      setCursor: () => { /* no-op */ },
      presenceTracker: tracker,
      now: () => 1_000,
    })
    await expect(d9.handle(envelope({ from: 'mallory', kind: 'presence_update' })))
      .resolves.toBe('rejected')
    expect(tracker.lastSeen('mallory')).toBeNull()
    expect(sent).toHaveLength(0)
  })

  it('presence_update is tracked regardless of subject-interest narrowing', async () => {
    const tracker = createPresenceTracker(90_000)
    const d10 = new InboundDispatcher({
      gate: new SenderGate(['alice', 'bob']),
      emit: n => { sent.push(n) },
      setCursor: () => { /* no-op */ },
      interest: ['mple2.command'],           // a subject-interest that would drop non-matching chat
      presenceTracker: tracker,
      now: () => 1_000,
    })
    // subject does NOT match interest, yet liveness must still be recorded and swallowed
    await expect(d10.handle(envelope({ from: 'alice', kind: 'presence_update', subject: 'other.ns' })))
      .resolves.toBe('delivered')
    expect(tracker.lastSeen('alice')).toBe(1_000)
    expect(sent).toHaveLength(0)
  })
})
