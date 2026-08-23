import { describe, it, expect, vi } from 'vitest'
import { registerTools, TOOL_DESCRIPTOR_POLL_INBOX, resolveInboxClient } from './tools.ts'
import { RelayClient } from './outbound.ts'
import type { PeerTransport } from './outbound.ts'

const presence = { auto_publish_cwd: false, auto_publish_branch: false, auto_publish_repo: false }

const envelope = (id: string, content: string) => ({
  id, v: 2, team: 'hangar', from: 'alice', to: 'bob', subject: null,
  in_reply_to: null, thread_root: null, kind: 'chat', content, meta: {},
  sent_at: '2026-01-01T00:00:00.000Z', delivered_at: null,
})

/**
 * P2 §2.4 — poll_inbox is the durable PULL path.
 *
 * Only Claude Code renders MCP server notifications; every other harness in
 * the fleet is push-blind, and even Claude cannot be interrupted mid-turn.
 * A cursored, read-only peek is the one path that works for all of them.
 */
describe('poll_inbox tool', () => {
  const stubClient = (): PeerTransport => ({
    send: vi.fn(), listPeers: vi.fn(), setPresence: vi.fn(),
    start: vi.fn(), stop: vi.fn(),
  } as unknown as PeerTransport)

  it('advertises a since cursor and returns the next one', async () => {
    const pollInbox = vi.fn(async () => ({
      messages: [envelope('msg_01HRK7Y000000000000000000A', 'hi')],
      next_cursor: 'msg_01HRK7Y000000000000000000A',
    }))
    const client = Object.assign(stubClient(), { pollInbox })
    const { callTool } = registerTools(client, presence)
    const r = await callTool('poll_inbox', {})
    expect(pollInbox).toHaveBeenCalledWith({})
    const text = (r.content as any[])[0].text as string
    expect(text).toContain('hi')
    expect(text).toContain('msg_01HRK7Y000000000000000000A')
  })

  it('passes the caller-supplied cursor and limit through', async () => {
    const pollInbox = vi.fn(async () => ({ messages: [], next_cursor: null }))
    const client = Object.assign(stubClient(), { pollInbox })
    const { callTool } = registerTools(client, presence)
    await callTool('poll_inbox', { since: 'msg_01HRK7Y000000000000000000A', limit: 10 })
    expect(pollInbox).toHaveBeenCalledWith({ since: 'msg_01HRK7Y000000000000000000A', limit: 10 })
  })

  it('rejects a malformed cursor before making a request', async () => {
    const pollInbox = vi.fn(async () => ({ messages: [], next_cursor: null }))
    const client = Object.assign(stubClient(), { pollInbox })
    const { callTool } = registerTools(client, presence)
    await expect(callTool('poll_inbox', { since: 'nope' })).rejects.toThrow()
    expect(pollInbox).not.toHaveBeenCalled()
  })

  it('reports an empty inbox as such rather than an error', async () => {
    const pollInbox = vi.fn(async () => ({ messages: [], next_cursor: null }))
    const client = Object.assign(stubClient(), { pollInbox })
    const { callTool } = registerTools(client, presence)
    const r = await callTool('poll_inbox', {})
    expect(r.isError).toBeFalsy()
    expect(String((r.content as any[])[0].text)).toMatch(/no (new )?messages/i)
  })

  it('is unavailable when the transport cannot serve a durable inbox', async () => {
    const { callTool } = registerTools(stubClient(), presence)
    await expect(callTool('poll_inbox', {})).rejects.toThrow(/unavailable/i)
  })

  it('resolveInboxClient prefers an explicitly supplied client', () => {
    const explicit = { pollInbox: vi.fn() } as any
    expect(resolveInboxClient(stubClient(), explicit)).toBe(explicit)
    expect(resolveInboxClient(stubClient(), undefined)).toBeUndefined()
  })

  it('the descriptor documents the cursor contract', () => {
    const text = TOOL_DESCRIPTOR_POLL_INBOX.description
      + JSON.stringify(TOOL_DESCRIPTOR_POLL_INBOX.inputSchema)
    expect(text).toContain('since')
    expect(TOOL_DESCRIPTOR_POLL_INBOX.name).toBe('poll_inbox')
  })
})

describe('RelayClient.pollInbox', () => {
  it('GETs /v1/messages with the cursor and limit as query params', async () => {
    const calls: string[] = []
    const fakeFetch = vi.fn(async (url: string | URL) => {
      calls.push(String(url))
      return new Response(JSON.stringify({ messages: [], next_cursor: null }), { status: 200 })
    })
    const c = new RelayClient({ relayUrl: 'https://x', token: 'tok' }, { fetch: fakeFetch as any })
    await c.pollInbox({ since: 'msg_01HRK7Y000000000000000000A', limit: 5 })
    expect(calls[0]).toBe('https://x/v1/messages?since=msg_01HRK7Y000000000000000000A&limit=5')
  })

  it('omits the query string entirely on a cold poll', async () => {
    const calls: string[] = []
    const fakeFetch = vi.fn(async (url: string | URL) => {
      calls.push(String(url))
      return new Response(JSON.stringify({ messages: [], next_cursor: null }), { status: 200 })
    })
    const c = new RelayClient({ relayUrl: 'https://x', token: 'tok' }, { fetch: fakeFetch as any })
    await c.pollInbox({})
    expect(calls[0]).toBe('https://x/v1/messages')
  })

  it('throws on a non-200', async () => {
    const fakeFetch = vi.fn(async () => new Response('nope', { status: 500 }))
    const c = new RelayClient({ relayUrl: 'https://x', token: 'tok' }, { fetch: fakeFetch as any })
    await expect(c.pollInbox({})).rejects.toThrow(/pollInbox failed/)
  })
})
