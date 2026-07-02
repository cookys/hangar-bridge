import { describe, it, expect } from 'vitest'
import type { OutboundMessage } from '@hangar-bridge/shared'
import { ApprovalRouter } from './approval-routing.ts'
import { PermissionOutboundTracker } from './permission.ts'
import {
  buildOutboundPermissionRequest,
  makeOutboundPermissionHandler,
  OutboundPermissionRequestNotificationSchema,
  type OutboundPermissionRequestParams,
} from './permission-relay.ts'

const PARAMS: OutboundPermissionRequestParams = {
  request_id: 'abcde',
  tool_name: 'Bash',
  description: 'rm -rf dist/',
  input_preview: '{"command":"rm -rf dist/"}',
}

function fakeClient() {
  const sent: OutboundMessage[] = []
  return {
    sent,
    client: { send: async (m: OutboundMessage) => { sent.push(m); return {} as never } },
  }
}

describe('buildOutboundPermissionRequest', () => {
  it('produces a permission_request envelope with the L3-scenario meta shape', () => {
    const env = buildOutboundPermissionRequest(PARAMS, 'bob', 'alice', '2026-07-02T00:00:00.000Z')
    expect(env.kind).toBe('permission_request')
    expect(env.to).toBe('bob')
    expect(env.subject).toBeNull()
    expect(env.content).toBe('rm -rf dist/') // description carries into the peer's prompt
    expect(env.meta).toEqual({
      request_id: 'abcde',
      tool_name: 'Bash',
      input_preview: '{"command":"rm -rf dist/"}',
      expires_at: '2026-07-02T00:00:00.000Z',
      requester: 'alice',
    })
  })

  it('lowercases the request_id (phone autocorrect defense) and omits requester when self unknown', () => {
    const env = buildOutboundPermissionRequest({ ...PARAMS, request_id: 'ABCDE' }, 'bob', '', 'x')
    expect(env.meta!.request_id).toBe('abcde')
    expect(env.meta!.requester).toBeUndefined()
  })
})

describe('makeOutboundPermissionHandler — routing gate', () => {
  it('never_relay ⇒ relays to nobody (local dialog stays the sole authority)', async () => {
    const { sent, client } = fakeClient()
    const relay = makeOutboundPermissionHandler({
      client,
      approvalRouter: new ApprovalRouter({ routing: 'never_relay' }),
      selfHandle: 'alice',
      ttlMs: 60_000,
    })
    const { relayedTo } = await relay(PARAMS)
    expect(relayedTo).toEqual([])
    expect(sent).toHaveLength(0)
  })

  it('ask_specific_peer relays the request to that peer', async () => {
    const { sent, client } = fakeClient()
    const relay = makeOutboundPermissionHandler({
      client,
      approvalRouter: new ApprovalRouter({ routing: 'ask_specific_peer:bob' }),
      selfHandle: 'alice',
      ttlMs: 60_000,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    })
    const { relayedTo } = await relay(PARAMS)
    expect(relayedTo).toEqual(['bob'])
    expect(sent).toHaveLength(1)
    expect(sent[0]!.kind).toBe('permission_request')
    expect(sent[0]!.to).toBe('bob')
    expect(sent[0]!.meta!.expires_at).toBe('2026-07-02T00:01:00.000Z')
  })

  it('ask_specific_peer:<self> refuses to relay to itself', async () => {
    const { sent, client } = fakeClient()
    const relay = makeOutboundPermissionHandler({
      client,
      approvalRouter: new ApprovalRouter({ routing: 'ask_specific_peer:alice' }),
      selfHandle: 'alice',
      ttlMs: 60_000,
    })
    const { relayedTo } = await relay(PARAMS)
    expect(relayedTo).toEqual([])
    expect(sent).toHaveLength(0)
  })

  it('ask_thread_participants relays to the most-recent DM partner', async () => {
    const { sent, client } = fakeClient()
    const router = new ApprovalRouter({ routing: 'ask_thread_participants' })
    router.recordDm('carol')
    const relay = makeOutboundPermissionHandler({
      client, approvalRouter: router, selfHandle: 'alice', ttlMs: 60_000,
    })
    const { relayedTo } = await relay(PARAMS)
    expect(relayedTo).toEqual(['carol'])
    expect(sent[0]!.to).toBe('carol')
  })

  it('ask_team fans the request out via @team', async () => {
    const { sent, client } = fakeClient()
    const relay = makeOutboundPermissionHandler({
      client,
      approvalRouter: new ApprovalRouter({ routing: 'ask_team' }),
      selfHandle: 'alice',
      ttlMs: 60_000,
    })
    const { relayedTo } = await relay(PARAMS)
    expect(relayedTo).toEqual(['@team'])
    expect(sent[0]!.to).toBe('@team')
    expect(sent[0]!.subject).toBeNull()
  })

  it('SEC-M2: empty selfHandle fails CLOSED (cannot exclude self → relays to nobody)', async () => {
    const { sent, client } = fakeClient()
    const relay = makeOutboundPermissionHandler({
      client,
      approvalRouter: new ApprovalRouter({ routing: 'ask_specific_peer:bob' }),
      selfHandle: '', // unknown self
      ttlMs: 60_000,
    })
    const { relayedTo } = await relay(PARAMS)
    expect(relayedTo).toEqual([])
    expect(sent).toHaveLength(0)
  })

  it('a failed send is swallowed (no throw) and excluded from relayedTo', async () => {
    const relay = makeOutboundPermissionHandler({
      client: { send: async () => { throw new Error('relay down') } },
      approvalRouter: new ApprovalRouter({ routing: 'ask_specific_peer:bob' }),
      selfHandle: 'alice',
      ttlMs: 60_000,
    })
    const { relayedTo } = await relay(PARAMS) // must not reject
    expect(relayedTo).toEqual([])
  })

  it('SEC-M1: records the relay-target set on the outbound tracker BEFORE sending', async () => {
    const { client } = fakeClient()
    const tracker = new PermissionOutboundTracker({ ttlMs: 60_000 })
    const relay = makeOutboundPermissionHandler({
      client,
      approvalRouter: new ApprovalRouter({ routing: 'ask_specific_peer:bob' }),
      selfHandle: 'alice',
      ttlMs: 60_000,
      outboundTracker: tracker,
    })
    await relay(PARAMS)
    // The exact responder set is now authorized; a non-target peer is not.
    expect(tracker.isAuthorizedResponder('abcde', 'bob')).toBe(true)
    expect(tracker.isAuthorizedResponder('abcde', 'mallory')).toBe(false)
  })
})

describe('OutboundPermissionRequestNotificationSchema', () => {
  it('carries the client→server method literal so setNotificationHandler can route it', () => {
    // getMethodLiteral in the MCP SDK reads schema.shape.method — must be a literal.
    expect(OutboundPermissionRequestNotificationSchema.shape.method.value)
      .toBe('notifications/claude/channel/permission_request')
  })

  it('parses a well-formed permission_request notification', () => {
    const parsed = OutboundPermissionRequestNotificationSchema.parse({
      method: 'notifications/claude/channel/permission_request',
      params: PARAMS,
    })
    expect(parsed.params.request_id).toBe('abcde')
  })
})
