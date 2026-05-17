import { describe, it, expect, vi } from 'vitest'
import { registerTools } from './tools.ts'
import { DispatchTracker } from './correlation.ts'
import { ReplyLimiter } from './reply-limiter.ts'
import type { RelayClient } from './outbound.ts'

describe('registerTools', () => {
  it('send_to_peer calls RelayClient.send', async () => {
    const send = vi.fn(async () => ({
      id: 'msg_01HRK7Y000000000000000000A', v: 2, team: 't1', from: 'a', to: 'bob',
      in_reply_to: null, thread_root: null, kind: 'chat', content: 'hi', meta: {},
      sent_at: '2026-01-01T00:00:00.000Z', delivered_at: null,
    }))
    const client = { send, listPeers: vi.fn(async () => []), setPresence: vi.fn() } as unknown as RelayClient
    const { callTool } = registerTools(client, { auto_publish_cwd: false, auto_publish_branch: false, auto_publish_repo: false })
    const result = await callTool('send_to_peer', { to: 'bob', content: 'hi' })
    expect(send).toHaveBeenCalledWith({ to: 'bob', kind: 'chat', content: 'hi', meta: {} })
    expect((result.content[0] as any).text).toContain('msg_')
  })

  it('list_peers returns snapshot', async () => {
    const client = { send: vi.fn(), listPeers: vi.fn(async () => [{ handle: 'alice', online: true }]),
                     setPresence: vi.fn() } as unknown as RelayClient
    const { callTool } = registerTools(client, { auto_publish_cwd: false, auto_publish_branch: false, auto_publish_repo: false })
    const result = await callTool('list_peers', {})
    expect((result.content[0] as any).text).toContain('alice')
  })

  it('set_summary posts presence', async () => {
    const setPresence = vi.fn(async () => { /* no-op */ })
    const client = { send: vi.fn(), listPeers: vi.fn(async () => []),
                     setPresence } as unknown as RelayClient
    const { callTool } = registerTools(client, { auto_publish_cwd: false, auto_publish_branch: false, auto_publish_repo: false })
    await callTool('set_summary', { summary: 'hacking' })
    expect(setPresence).toHaveBeenCalledWith({ summary: 'hacking' })
  })
})

describe('registerTools — dispatch_task', () => {
  const mkClient = (msgId = 'msg_01HRK7Y00000000000000000ZZ') => {
    const send = vi.fn(async (msg: any) => ({
      id: msgId, v: 2, team: 'hangar', from: 'self', to: msg.to,
      in_reply_to: null, thread_root: null, kind: msg.kind, content: msg.content,
      meta: msg.meta ?? {}, sent_at: '2026-01-01T00:00:00.000Z', delivered_at: null,
    }))
    const client = { send, listPeers: vi.fn(async () => []), setPresence: vi.fn() } as unknown as RelayClient
    return { client, send }
  }
  const presence = { auto_publish_cwd: false, auto_publish_branch: false, auto_publish_repo: false }

  it('emits task_dispatch envelope with auto-generated correlation_id and records in tracker', async () => {
    const { client, send } = mkClient()
    const tracker = new DispatchTracker({ ttlMs: 60_000 })
    const { callTool } = registerTools(client, presence, undefined, undefined, tracker)
    const result = await callTool('dispatch_task', { to: 'alice', payload: 'please run the build' })
    const callArgs = send.mock.calls[0]
    const msg = callArgs![0] as any
    const opts = callArgs![1] as any
    expect(msg.kind).toBe('task_dispatch')
    expect(msg.to).toBe('alice')
    expect(msg.content).toBe('please run the build')
    expect(msg.meta.correlation_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(opts.idempotency_key).toBe(msg.meta.correlation_id)
    expect(tracker.has(msg.meta.correlation_id)).toBe(true)
    expect(tracker.peerFor(msg.meta.correlation_id)).toBe('alice')
    expect((result.content[0] as any).text).toContain('dispatched msg_')
  })

  it('honors caller-supplied correlation_id', async () => {
    const { client, send } = mkClient()
    const tracker = new DispatchTracker({ ttlMs: 60_000 })
    const { callTool } = registerTools(client, presence, undefined, undefined, tracker)
    const cid = '01HR0000000000000000000ABC'
    await callTool('dispatch_task', { to: 'bob', payload: 'task body', correlation_id: cid })
    const msg = send.mock.calls[0]![0] as any
    expect(msg.meta.correlation_id).toBe(cid.toUpperCase())
    expect(tracker.has(cid.toUpperCase())).toBe(true)
  })

  it('carries task_kind when provided', async () => {
    const { client, send } = mkClient()
    const tracker = new DispatchTracker({ ttlMs: 60_000 })
    const { callTool } = registerTools(client, presence, undefined, undefined, tracker)
    await callTool('dispatch_task', { to: 'alice', payload: 'p', task_kind: 'code-review' })
    const msg = send.mock.calls[0]![0] as any
    expect(msg.meta.task_kind).toBe('code-review')
  })

  it('K5: does NOT consult reply-limiter — task dispatches never throttle', async () => {
    const { client } = mkClient()
    const tracker = new DispatchTracker({ ttlMs: 60_000 })
    const limiter = new ReplyLimiter({ windowMs: 10_000, maxReplies: 2 })
    // Simulate a high-velocity inbound: alice just sent us 5 messages, then we try to dispatch 10 tasks to her.
    limiter.recordInbound('alice')
    // Saturate the outbound count past the maxReplies threshold using send_to_peer
    limiter.recordOutbound('alice')
    limiter.recordOutbound('alice')
    expect(limiter.canReplyTo('alice')).toBe(false) // would block send_to_peer
    // Spy on limiter to confirm dispatch_task does NOT call canReplyTo
    const canReplySpy = vi.spyOn(limiter, 'canReplyTo')
    const recordOutboundSpy = vi.spyOn(limiter, 'recordOutbound')
    const { callTool } = registerTools(client, presence, undefined, limiter, tracker)
    for (let i = 0; i < 10; i++) {
      await callTool('dispatch_task', { to: 'alice', payload: `task ${i}` })
    }
    expect(canReplySpy).not.toHaveBeenCalled()
    expect(recordOutboundSpy).not.toHaveBeenCalled()
    expect(tracker.size()).toBe(10)
  })

  it('supports @team fanout with a single shared correlation_id', async () => {
    const { client, send } = mkClient('msg_01HRK7Y00000000000000FAN01')
    const tracker = new DispatchTracker({ ttlMs: 60_000 })
    const { callTool } = registerTools(client, presence, undefined, undefined, tracker)
    await callTool('dispatch_task', { to: '@team', payload: 'all hands' })
    const msg = send.mock.calls[0]![0] as any
    expect(msg.to).toBe('@team')
    expect(msg.kind).toBe('task_dispatch')
    expect(tracker.peerFor(msg.meta.correlation_id)).toBe('@team')
  })

  it('errors when DispatchTracker is not wired', async () => {
    const { client } = mkClient()
    const { callTool } = registerTools(client, presence)
    const result = await callTool('dispatch_task', { to: 'alice', payload: 'x' })
      .catch(e => ({ content: [{ type: 'text', text: `error: ${e.message}` }], isError: true }))
    expect((result.content[0] as any).text).toMatch(/dispatch_task disabled/)
  })

  it('rejects invalid correlation_id format', async () => {
    const { client } = mkClient()
    const tracker = new DispatchTracker({ ttlMs: 60_000 })
    const { callTool } = registerTools(client, presence, undefined, undefined, tracker)
    await expect(callTool('dispatch_task', { to: 'alice', payload: 'x', correlation_id: 'not-a-ulid' })).rejects.toThrow()
  })
})
