import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import type { BacklogEvent, BacklogEndEvent, Envelope } from '@hangar-bridge/shared'
import { StreamClient } from './stream.ts'
import { CursorStore, mergeBacklog, reconcileBacklog, type PendingBacklog } from './cursor-store.ts'
import { mergeInboxPage } from './inbox-spool.ts'
import {
  backlogToChannelNotification, backlogToSyntheticEnvelope, renderBacklogSummary, shouldClearBacklog,
} from './backlog-butler.ts'
import { ConfigSchema as PeerConfigSchema } from './config.ts'

// Plan docs/plans/2026-09-15-replay-butler.md §2.4–§2.5, §4 T8–T12, T14b, T17, T18, T20.

const ID = (n: string) => `msg_01HRK7Y000000000000000000${n}` as const

const envelope = (id: string, kind: Envelope['kind'] = 'chat'): Envelope => ({
  id: ID(id), v: 2,
  team: 'hangar', from: 'alice', to: 'bob', subject: null,
  in_reply_to: null, thread_root: null, kind, content: `body ${id}`, meta: {},
  sent_at: '2026-01-01T00:00:00.000Z', delivered_at: null,
})

const backlog = (over: Partial<BacklogEvent> = {}): BacklogEvent => ({
  pending: 137, pending_capped: false, oldest: ID('1'), newest: ID('Z'), resume_since: ID('0'),
  by_sender: { aimax395: 90, cuda: 40, '@team': 7 }, replayed_exempt: 2, ...over,
})

const sseMessage = (e: Envelope) => `event: message\ndata: ${JSON.stringify(e)}\n\n`
const sseBacklog = (b: BacklogEvent) => `event: backlog\ndata: ${JSON.stringify(b)}\n\n`
const sseBacklogEnd = (b: BacklogEndEvent) => `event: backlog_end\ndata: ${JSON.stringify(b)}\n\n`

interface FakeRelay { server: Server; url: string; urls: string[]; close: () => Promise<void> }

function startRelay(onConnection: (write: (s: string) => void, end: () => void, n: number) => void): Promise<FakeRelay> {
  const relay = { urls: [] as string[] } as FakeRelay
  let n = 0
  relay.server = createServer((req, res) => {
    n++
    relay.urls.push(req.url ?? '')
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write(': hello\n\n')
    onConnection(s => { res.write(s) }, () => res.end(), n)
  })
  return new Promise(resolve => {
    relay.server.listen(0, '127.0.0.1', () => {
      const { port } = relay.server.address() as AddressInfo
      relay.url = `http://127.0.0.1:${port}`
      relay.close = () => new Promise(r => { relay.server.closeAllConnections(); relay.server.close(() => r()) })
      resolve(relay)
    })
  })
}

const settle = (ms = 40) => new Promise(r => setTimeout(r, ms))
// Wait for a condition instead of a fixed delay: the loopback tests were
// flaky under a full `pnpm -r test:ci` load with fixed settles.
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond() && Date.now() < deadline) await settle(10)
}

describe('StreamClient — backlog events (T8, T10, T11, T14b)', () => {
  let relay: FakeRelay
  let client: StreamClient | null = null
  afterEach(async () => { client?.stop(); await relay.close() })

  it('T11 replayMax omitted/0 → no replay_max on the URL; set → replay_max=N', async () => {
    relay = await startRelay(() => { /* hold open */ })
    client = new StreamClient({
      relayUrl: relay.url, token: 't', sinceCursor: () => ID('0'),
      onEnvelope: async () => {}, onAuthError: () => {},
    })
    void client.start()
    await waitFor(() => relay.urls.length >= 1)
    expect(relay.urls[0]).not.toContain('replay_max')
    client.stop()
    client = new StreamClient({
      relayUrl: relay.url, token: 't', sinceCursor: () => ID('0'), replayMax: 10,
      onEnvelope: async () => {}, onAuthError: () => {},
    })
    void client.start()
    await waitFor(() => relay.urls.length >= 2)
    expect(relay.urls[1]).toContain('replay_max=10')
    expect(relay.urls[1]).toContain(`since=${ID('0')}`)
  })

  it('T8/T10 backlog → onBacklog once, exempt rows → onEnvelope, backlog_end → onBacklogEnd; order preserved', async () => {
    const seq: string[] = []
    relay = await startRelay((write, _end, n) => {
      if (n > 1) return
      write(sseBacklog(backlog()))
      write(sseMessage(envelope('A', 'permission_request')))
      write(sseMessage(envelope('B', 'task_dispatch')))
      write(sseBacklogEnd({ newest: ID('Z') }))
    })
    client = new StreamClient({
      relayUrl: relay.url, token: 't', sinceCursor: () => ID('0'), replayMax: 10,
      onBacklog: async b => { seq.push(`backlog:${b.pending}`) },
      onEnvelope: async e => { seq.push(`msg:${e.id}`) },
      onBacklogEnd: b => { seq.push(`end:${b.newest}`) },
      onAuthError: () => {},
    })
    void client.start()
    await waitFor(() => seq.length >= 4)
    expect(seq).toEqual(['backlog:137', `msg:${ID('A')}`, `msg:${ID('B')}`, `end:${ID('Z')}`])
  })

  it('T14b a stream that drops before backlog_end never fires onBacklogEnd', async () => {
    const seq: string[] = []
    relay = await startRelay((write, end, n) => {
      if (n > 1) return
      write(sseBacklog(backlog()))
      write(sseMessage(envelope('A', 'permission_request')))
      end()
    })
    client = new StreamClient({
      relayUrl: relay.url, token: 't', sinceCursor: () => ID('0'), replayMax: 10,
      onBacklog: async b => { seq.push(`backlog:${b.pending}`) },
      onEnvelope: async e => { seq.push(`msg:${e.id}`) },
      onBacklogEnd: b => { seq.push(`end:${b.newest}`) },
      onAuthError: () => {}, wait: () => settle(200),
    })
    void client.start()
    await waitFor(() => seq.length >= 2)
    await settle(60) // give a (wrong) backlog_end a chance to show up
    expect(seq).toEqual(['backlog:137', `msg:${ID('A')}`])
  })

  it('T8b a malformed backlog payload is logged and skipped, not thrown', async () => {
    const seq: string[] = []
    relay = await startRelay((write, _end, n) => {
      if (n > 1) return
      write('event: backlog\ndata: {"pending":"lots"}\n\n')
      write(sseMessage(envelope('A')))
    })
    client = new StreamClient({
      relayUrl: relay.url, token: 't', sinceCursor: () => ID('0'), replayMax: 10,
      onBacklog: async () => { seq.push('backlog') },
      onEnvelope: async e => { seq.push(`msg:${e.id}`) },
      onAuthError: () => {},
    })
    void client.start()
    await waitFor(() => seq.length >= 1)
    await settle(30)
    expect(seq).toEqual([`msg:${ID('A')}`])
  })
})

describe('CursorStore — pendingBacklog persistence (T12, T20)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'butler-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('T12 persists the backlog beside the cursor and survives a restart', () => {
    const path = join(dir, 'cursor-state.json')
    const a = new CursorStore({ persistPath: path })
    a.advance(ID('5'))
    a.setBacklog({ count: 137, since: ID('0'), newest: ID('Z'), at: '2026-09-15T00:00:00.000Z' })
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { cursor: string; backlog: PendingBacklog }
    expect(raw.cursor).toBe(ID('5'))
    expect(raw.backlog.count).toBe(137)
    const b = new CursorStore({ persistPath: path })
    expect(b.get()).toBe(ID('5'))
    expect(b.getBacklog()).toEqual(raw.backlog)
    b.clearBacklog()
    expect(b.getBacklog()).toBeUndefined()
    expect((JSON.parse(readFileSync(path, 'utf8')) as { backlog?: unknown }).backlog).toBeUndefined()
  })

  it('T12e equal cursor on disk: the reminder write is not skipped (the pre-fix early return)', () => {
    const path = join(dir, 'cursor-state.json')
    writeFileSync(path, JSON.stringify({ cursor: ID('5') }))
    const s = new CursorStore({ persistPath: path })
    s.advance(ID('5'))                                  // equal cursor
    s.setBacklog({ count: 3, since: ID('4'), newest: ID('9'), at: 'ours' })
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { cursor: string; backlog: PendingBacklog }
    expect(raw.cursor).toBe(ID('5'))
    expect(raw.backlog).toEqual({ count: 3, since: ID('4'), newest: ID('9'), at: 'ours' })
  })

  it('T12f sibling ahead on disk: their cursor is kept and the reminders reconcile (overlap → wider window, larger count)', () => {
    const path = join(dir, 'cursor-state.json')
    const mine = new CursorStore({ persistPath: path })
    mine.advance(ID('3'))
    // A sibling process races ahead and persists its own reminder.
    writeFileSync(path, JSON.stringify({ cursor: ID('8'), backlog: { count: 2, since: ID('2'), newest: ID('8'), at: 'sib' } }))
    mine.setBacklog({ count: 5, since: ID('3'), newest: ID('6'), at: 'ours' })
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { cursor: string; backlog: PendingBacklog }
    expect(raw.cursor).toBe(ID('8'))                     // never rewound
    // 2..8 (theirs) overlaps 3..6 (ours): same rows may be in both → not summed.
    expect(raw.backlog).toEqual({ count: 5, since: ID('2'), newest: ID('8'), at: 'ours' })
    // A reminder ours already covers is not double-counted on a later write.
    mine.setBacklog({ count: 7, since: ID('2'), newest: ID('9'), at: 'ours2' })
    const again = JSON.parse(readFileSync(path, 'utf8')) as { backlog: PendingBacklog }
    expect(again.backlog.count).toBe(7)
  })

  it('T12g sibling ahead with a malformed reminder on disk: ours survives unmerged', () => {
    const path = join(dir, 'cursor-state.json')
    const mine = new CursorStore({ persistPath: path })
    mine.advance(ID('3'))
    writeFileSync(path, JSON.stringify({ cursor: ID('8'), backlog: { count: 'x' } }))
    mine.setBacklog({ count: 5, since: ID('3'), newest: ID('6'), at: 'ours' })
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { cursor: string; backlog: PendingBacklog }
    expect(raw.cursor).toBe(ID('8'))
    expect(raw.backlog).toEqual({ count: 5, since: ID('3'), newest: ID('6'), at: 'ours' })
  })

  it('T12h overlapping sibling window is reconciled (wider window, larger count), not summed', () => {
    const theirs: PendingBacklog = { count: 6, since: ID('2'), newest: ID('7'), at: 'sib' }
    const ours: PendingBacklog = { count: 4, since: ID('5'), newest: ID('9'), at: 'ours' }
    expect(reconcileBacklog(theirs, ours)).toEqual({ count: 6, since: ID('2'), newest: ID('9'), at: 'ours' })
    // Disjoint windows are two batches.
    expect(reconcileBacklog({ count: 2, since: ID('1'), newest: ID('2'), at: 's' }, ours).count).toBe(6)
  })

  it('T12b a malformed backlog on disk is dropped while the cursor still loads', () => {
    const path = join(dir, 'cursor-state.json')
    writeFileSync(path, JSON.stringify({ cursor: ID('5'), backlog: { count: 'x' } }))
    const s = new CursorStore({ persistPath: path })
    expect(s.get()).toBe(ID('5'))
    expect(s.getBacklog()).toBeUndefined()
  })

  it('T20 mergeBacklog: since = min, newest = new, count summed', () => {
    const first: PendingBacklog = { count: 10, since: ID('3'), newest: ID('9'), at: 't1' }
    const merged = mergeBacklog(first, { count: 5, since: ID('9'), newest: ID('K'), at: 't2' })
    expect(merged).toEqual({ count: 15, since: ID('3'), newest: ID('K'), at: 't2' })
    const back = mergeBacklog(merged, { count: 1, since: ID('1'), newest: ID('M'), at: 't3' })
    expect(back.since).toBe(ID('1'))
    expect(mergeBacklog(undefined, first)).toEqual(first)
  })

  it('T20b shouldClearBacklog: only a poll from <= since that reaches >= newest clears', () => {
    const b: PendingBacklog = { count: 10, since: ID('3'), newest: ID('9'), at: 't' }
    expect(shouldClearBacklog(b, { since: ID('3'), nextCursor: ID('9') })).toBe(true)
    expect(shouldClearBacklog(b, { since: ID('1'), nextCursor: ID('Z') })).toBe(true)
    expect(shouldClearBacklog(b, { since: undefined, nextCursor: ID('9') })).toBe(true)  // poll from the start
    expect(shouldClearBacklog(b, { since: ID('5'), nextCursor: ID('Z') })).toBe(false) // started past since
    expect(shouldClearBacklog(b, { since: ID('3'), nextCursor: ID('8') })).toBe(false) // stopped short
    expect(shouldClearBacklog(b, { since: ID('3'), nextCursor: null })).toBe(false)
  })
})

describe('backlog-butler — synthetic summary (T9, T17)', () => {
  it('T9 the channel notification carries the summary, the resume hint and no msg_id', () => {
    const n = backlogToChannelNotification(backlog())
    expect(n.method).toBe('notifications/claude/channel')
    const params = n.params as { content: string; meta: Record<string, unknown> }
    expect(params.content).toContain('137')
    expect(params.content).toContain(ID('1'))
    expect(params.content).toContain(`poll_inbox since=${ID('0')}`)
    expect(params.content).toContain('aimax395')
    expect(params.content).toMatch(/not a message|不是一封訊息/i)
    expect(params.meta.synthetic).toBe('backlog')
    expect(params.meta.msg_id).toBeUndefined()
    expect(params.meta.source).toBe('hangar-bridge')
  })

  it('T9b sender handles are rendered as text, never as channel markup', () => {
    const text = renderBacklogSummary(backlog({ by_sender: { '<channel from="x">': 1 } }))
    expect(text).not.toContain('<channel')
  })

  it('T9c a capped summary says so and a cold start says to poll from the beginning', () => {
    const text = renderBacklogSummary(backlog({ pending: 10_000, pending_capped: true, resume_since: '' }))
    expect(text).toMatch(/10000\+|at least 10000|more than 10000/)
    expect(text).toContain('poll_inbox')
    expect(text).not.toContain('since=msg_')
  })

  it('T17 the courier envelope is self-addressed chat with synthetic/reply markers and a local id', () => {
    const e = backlogToSyntheticEnvelope(backlog(), 'cuda-chatgpt')
    expect(e.from).toBe('cuda-chatgpt')
    expect(e.to).toBe('cuda-chatgpt')
    expect(e.kind).toBe('chat')
    expect(e.id).toMatch(/^msg_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(e.meta.synthetic).toBe('backlog')
    expect(e.meta.reply).toBe('none')
    expect(e.content).toMatch(/not a message|不是一封訊息/i)
    expect(e.content).toContain('137')
  })
})

describe('mergeInboxPage — pending passthrough (T18)', () => {
  const m = (id: string) => ({ id: ID(id) })
  it('T18 pending fields pass through, and rows cut by the merge are added to pending_after', () => {
    const page = { messages: [m('1'), m('2'), m('3')], next_cursor: ID('3'), pending_after: 5, pending_capped: false }
    const merged = mergeInboxPage(page, [m('4'), m('5'), m('6')], { limit: 4 })
    expect(merged.messages.map(x => x.id)).toEqual([ID('1'), ID('2'), ID('3'), ID('4')])
    expect(merged.next_cursor).toBe(ID('4'))
    expect(merged.pending_after).toBe(7)
    expect(merged.pending_capped).toBe(false)
  })
  it('T18b nothing cut → pending_after unchanged; capped passes through', () => {
    const page = { messages: [m('1')], next_cursor: ID('1'), pending_after: 10_000, pending_capped: true }
    const merged = mergeInboxPage(page, [m('2')], { limit: 10 })
    expect(merged.pending_after).toBe(10_000)
    expect(merged.pending_capped).toBe(true)
  })
  it('T18c a relay page without the fields (old relay) yields undefined, not NaN', () => {
    const merged = mergeInboxPage({ messages: [m('1')], next_cursor: ID('1') }, [m('2'), m('3')], { limit: 1 })
    expect(merged.pending_after).toBeUndefined()
  })
})

describe('config — inbox.replay_threshold', () => {
  const base = { relay_url: 'http://127.0.0.1:1', token_path: '/dev/null' }
  it('defaults to 10, accepts 0..1000, rejects the rest', () => {
    expect(PeerConfigSchema.parse(base).inbox.replay_threshold).toBe(10)
    expect(PeerConfigSchema.parse({ ...base, inbox: { replay_threshold: 0 } }).inbox.replay_threshold).toBe(0)
    expect(PeerConfigSchema.parse({ ...base, inbox: { replay_threshold: 1000 } }).inbox.replay_threshold).toBe(1000)
    expect(() => PeerConfigSchema.parse({ ...base, inbox: { replay_threshold: 1001 } })).toThrow()
    expect(() => PeerConfigSchema.parse({ ...base, inbox: { replay_threshold: 2.5 } })).toThrow()
  })
})

import { vi } from 'vitest'
import { registerTools } from './tools.ts'
import type { RelayClient } from './outbound.ts'
import { HealthState } from './health-state.ts'

describe('poll_inbox — butler header and reminder clearing (T12c, §2.5)', () => {
  const presence = { auto_publish_cwd: false, auto_publish_branch: false, auto_publish_repo: false }
  const baseClient = () => ({
    send: vi.fn(async () => ({ id: ID('S') })),
    listPeers: vi.fn(async () => []),
    setPresence: vi.fn(async () => {}),
    reply: vi.fn(async () => ({ id: ID('R') })),
  })

  it('prints how much is still waiting past the page (and + when capped)', async () => {
    const pollInbox = vi.fn(async () => ({ messages: [], next_cursor: ID('9'), pending_after: 42, pending_capped: true }))
    const client = { ...baseClient(), pollInbox } as unknown as RelayClient
    const { callTool } = registerTools(client, presence, undefined, undefined, undefined, undefined, { pollInbox })
    const r = await callTool('poll_inbox', {})
    expect((r.content[0] as { text: string }).text).toContain('42+ more waiting after next_cursor')
  })

  it('says nothing about pending against an old relay (field absent)', async () => {
    const pollInbox = vi.fn(async () => ({ messages: [], next_cursor: null }))
    const client = { ...baseClient(), pollInbox } as unknown as RelayClient
    const { callTool } = registerTools(client, presence, undefined, undefined, undefined, undefined, { pollInbox })
    const r = await callTool('poll_inbox', {})
    expect((r.content[0] as { text: string }).text).not.toContain('more waiting')
  })

  it('clears the reminder only when the poll started at/before since and reached newest', async () => {
    const reminder: PendingBacklog = { count: 3, since: ID('3'), newest: ID('9'), at: 't' }
    let stored: PendingBacklog | undefined = reminder
    const butler = { getBacklog: () => stored, clearBacklog: () => { stored = undefined } }
    const pollInbox = vi.fn(async (o: { since?: string }) => ({
      messages: [], next_cursor: o.since === ID('5') ? ID('Z') : ID('8'),
    }))
    const client = { ...baseClient(), pollInbox } as unknown as RelayClient
    const { callTool } = registerTools(
      client, presence, undefined, undefined, undefined, undefined, { pollInbox }, undefined, undefined, undefined, butler,
    )
    await callTool('poll_inbox', { since: ID('5') })   // started past since → keep
    expect(stored).toBeDefined()
    await callTool('poll_inbox', { since: ID('3') })   // stopped at 8 < 9 → keep
    expect(stored).toBeDefined()
    pollInbox.mockImplementationOnce(async () => ({ messages: [], next_cursor: ID('9') }))
    await callTool('poll_inbox', { since: ID('3') })   // reached newest → clear
    expect(stored).toBeUndefined()
  })
})

describe('HealthState — backlog suffix on the presence summary (T12d)', () => {
  it('stamps [backlog:N] once, re-stamps idempotently, and removes it at 0', () => {
    const h = new HealthState({ state: 'verified', reason: 'ok' })
    h.setBacklog(137)
    const once = h.decorateSummary('(connected)')
    expect(once).toBe('(connected) [backlog:137]')
    expect(h.decorateSummary(once)).toBe('(connected) [backlog:137]')
    h.setBacklog(5)
    expect(h.decorateSummary(once)).toBe('(connected) [backlog:5]')
    h.setBacklog(0)
    expect(h.decorateSummary('(connected) [backlog:5]')).toBe('(connected)')
  })
})
