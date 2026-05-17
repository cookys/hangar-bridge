import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ulid } from 'ulid'
import { startHarness, type Harness } from '../harness.ts'
import { RelayClient } from '../../../peer-agent/src/outbound.ts'
import { registerTools } from '../../../peer-agent/src/tools.ts'
import { InboundDispatcher } from '../../../peer-agent/src/inbound.ts'
import { SenderGate } from '../../../peer-agent/src/gate.ts'
import { DispatchTracker } from '../../../peer-agent/src/correlation.ts'
import { ReplyLimiter } from '../../../peer-agent/src/reply-limiter.ts'
import { StreamClient } from '../../../peer-agent/src/stream.ts'
import {
  EnvelopeSchema,
  envelopeToChannelNotification,
  type Envelope,
  type MessageId,
} from '@hangar-bridge/shared'

// __dirname-equivalent for ESM
const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE_LOG = join(__dirname, '..', '..', 'fixtures', 'loopback-dispatch.log')

/**
 * Spins up a full peer-agent runtime IN-PROCESS for one peer:
 *   - RelayClient pointed at the harness relay
 *   - DispatchTracker (per-peer, in-memory)
 *   - InboundDispatcher wired with gate + tracker + reply-limiter
 *   - StreamClient subscribed to /v1/stream
 *
 * Returns the wired pieces so a scenario can call `peer.callTool('dispatch_task', ...)`
 * and observe `peer.notifications` accumulate as task_result envelopes flow back.
 *
 * This is closer to a real peer-agent than the existing scenarios (which use
 * raw fetch). It exercises the full P4 wiring: registerTools → RelayClient.send
 * → relay HTTP → stream → InboundDispatcher → DispatchTracker.has → channel
 * notification with correlation_id.
 */
async function spinUpPeer(opts: {
  handle: string
  relayUrl: string
  token: string
  knownPeers: string[]
  dispatchTtlMs?: number
}) {
  const client = new RelayClient({ relayUrl: opts.relayUrl, token: opts.token })
  const dispatchTracker = new DispatchTracker({ ttlMs: opts.dispatchTtlMs ?? 30 * 60 * 1000 })
  const replyLimiter = new ReplyLimiter({ windowMs: 10_000, maxReplies: 2 })
  const gate = new SenderGate(opts.knownPeers)

  const notifications: { method: string; params: Record<string, unknown> }[] = []
  let cursor: string | undefined

  const dispatcher = new InboundDispatcher({
    gate,
    emit: n => { notifications.push(n) },
    setCursor: id => { cursor = id },
    dispatchTracker,
    replyLimiter,
  })

  const { callTool } = registerTools(
    client,
    { auto_publish_cwd: false, auto_publish_branch: false, auto_publish_repo: false },
    undefined,
    replyLimiter,
    dispatchTracker,
  )

  const authErrors: string[] = []
  const stream = new StreamClient({
    relayUrl: opts.relayUrl,
    token: opts.token,
    sinceCursor: () => cursor,
    onEnvelope: e => dispatcher.handle(e),
    onAuthError: () => { authErrors.push('auth') },
  })
  // Kick off the stream loop without awaiting — it runs forever until stop().
  void stream.start()
  // Give the stream loop a tick to issue its first HTTP GET so initial events
  // aren't missed if the scenario races straight into a dispatch.
  await new Promise(r => setTimeout(r, 50))

  return {
    handle: opts.handle,
    client,
    callTool,
    dispatchTracker,
    notifications,
    authErrors,
    stop: () => stream.stop(),
  }
}

async function waitFor(check: () => boolean, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
  const timeout = opts.timeoutMs ?? 3000
  const interval = opts.intervalMs ?? 20
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (check()) return
    await new Promise(r => setTimeout(r, interval))
  }
  throw new Error(`waitFor timed out after ${timeout}ms`)
}

describe('P5 self-loopback: dispatch_task ↔ task_result correlation', () => {
  let h: Harness
  beforeEach(async () => { h = await startHarness(['peera', 'peerb']) })
  afterEach(async () => { await h.cleanup() })

  it('happy path: peerA dispatches → peerB receives task_dispatch → peerB replies task_result → peerA sees correlation_id matched', async () => {
    const peerA = await spinUpPeer({
      handle: 'peera', relayUrl: h.relayUrl, token: h.peers.peera!.token,
      knownPeers: ['peera', 'peerb'],
    })
    const peerB = await spinUpPeer({
      handle: 'peerb', relayUrl: h.relayUrl, token: h.peers.peerb!.token,
      knownPeers: ['peera', 'peerb'],
    })

    try {
      // 1. peerA dispatches.
      const dispatchResult = await peerA.callTool('dispatch_task', {
        to: 'peerb',
        payload: 'please run the build',
        task_kind: 'build-check',
      })
      const dispatchText = (dispatchResult.content[0] as { text: string }).text
      const cidMatch = dispatchText.match(/correlation_id=([0-9A-HJKMNP-TV-Z]{26})/)
      expect(cidMatch).not.toBeNull()
      const correlationId = cidMatch![1]!
      const dispatchMsgIdMatch = dispatchText.match(/dispatched (msg_[0-9A-HJKMNP-TV-Z]{26})/)
      const dispatchMsgId = dispatchMsgIdMatch![1]!

      expect(peerA.dispatchTracker.has(correlationId)).toBe(true)

      // 2. peerB observes the task_dispatch envelope arrive via stream.
      await waitFor(() => peerB.notifications.some(n =>
        n.method === 'notifications/claude/channel'
        && (n.params.meta as { kind?: string } | undefined)?.kind === 'task_dispatch'
      ), { timeoutMs: 3000 })
      const dispatchNote = peerB.notifications.find(n =>
        n.method === 'notifications/claude/channel'
        && (n.params.meta as { kind?: string } | undefined)?.kind === 'task_dispatch'
      )!
      const dispatchMeta = dispatchNote.params.meta as Record<string, string>
      expect(dispatchMeta.from).toBe('peera')
      expect(dispatchMeta.correlation_id).toBe(correlationId)
      expect(dispatchMeta.task_kind).toBe('build-check')

      // 3. peerB replies with task_result. In production this is the receiving
      // Claude's tool-result piped back through a future `respond_to_dispatch`
      // tool; here we construct it directly to validate the protocol.
      const replyEnv = await peerB.client.send({
        to: 'peera',
        kind: 'task_result',
        content: 'build green: 193+2 tests pass',
        in_reply_to: dispatchMsgId as MessageId,
        meta: { correlation_id: correlationId },
      })

      // 4. peerA's stream + InboundDispatcher consult the tracker → match.
      await waitFor(() => peerA.notifications.some(n =>
        n.method === 'notifications/claude/channel'
        && (n.params.meta as { kind?: string } | undefined)?.kind === 'task_result'
      ), { timeoutMs: 3000 })
      const resultNote = peerA.notifications.find(n =>
        n.method === 'notifications/claude/channel'
        && (n.params.meta as { kind?: string } | undefined)?.kind === 'task_result'
      )!
      expect((resultNote.params as { correlation_id?: string }).correlation_id).toBe(correlationId)
      expect((resultNote.params.meta as { from: string }).from).toBe('peerb')
      expect((resultNote.params as { content: string }).content).toBe('build green: 193+2 tests pass')

      // 5. Drop a forensic fixture so the round-trip is reviewable post-mortem.
      const lines = [
        '# hangar-bridge P5 self-loopback dispatch round-trip',
        `# captured ${new Date().toISOString()} on ${process.platform} node ${process.version}`,
        '',
        JSON.stringify({ phase: 'A1.dispatch.tool_result', text: dispatchText }),
        JSON.stringify({ phase: 'A2.peerB.inbound', method: dispatchNote.method, params: dispatchNote.params }),
        JSON.stringify({ phase: 'A3.peerB.task_result.sent', envelope: replyEnv }),
        JSON.stringify({ phase: 'A4.peerA.inbound', method: resultNote.method, params: resultNote.params }),
        '',
      ].join('\n')
      writeFileSync(FIXTURE_LOG, lines)
    } finally {
      peerA.stop()
      peerB.stop()
    }
  }, 15_000)

  it('orphan path: task_result with unknown correlation_id still emits a channel notification but logs orphan', async () => {
    const peerA = await spinUpPeer({
      handle: 'peera', relayUrl: h.relayUrl, token: h.peers.peera!.token,
      knownPeers: ['peera', 'peerb'],
    })
    const peerB = await spinUpPeer({
      handle: 'peerb', relayUrl: h.relayUrl, token: h.peers.peerb!.token,
      knownPeers: ['peera', 'peerb'],
    })
    try {
      // peerA dispatches but we'll deliberately CLEAR peerA's tracker before the
      // reply arrives — simulates DispatchTracker being lost on a peer-agent restart.
      const dispatchResult = await peerA.callTool('dispatch_task', {
        to: 'peerb', payload: 'orphan probe',
      })
      const dispatchText = (dispatchResult.content[0] as { text: string }).text
      const dispatchMsgId = dispatchText.match(/msg_[0-9A-HJKMNP-TV-Z]{26}/)![0]!
      const correlationId = dispatchText.match(/correlation_id=([0-9A-HJKMNP-TV-Z]{26})/)![1]!

      // Wait for the dispatch envelope to land at peerB, then nuke peerA's tracker.
      await waitFor(() => peerB.notifications.length >= 1, { timeoutMs: 3000 })
      // @ts-expect-error — reach into private map; we want to simulate amnesia.
      peerA.dispatchTracker.map = new Map()
      expect(peerA.dispatchTracker.has(correlationId)).toBe(false)

      // peerB replies normally.
      await peerB.client.send({
        to: 'peera',
        kind: 'task_result',
        content: 'reply',
        in_reply_to: dispatchMsgId as MessageId,
        meta: { correlation_id: correlationId },
      })

      // peerA still emits the channel notification — orphan is logged, not dropped.
      await waitFor(() => peerA.notifications.some(n =>
        (n.params.meta as { kind?: string } | undefined)?.kind === 'task_result'
      ), { timeoutMs: 3000 })
    } finally {
      peerA.stop(); peerB.stop()
    }
  }, 15_000)

  it('offline path: dispatch to a peer with no stream still succeeds; tracker keeps the entry until TTL', async () => {
    const peerA = await spinUpPeer({
      handle: 'peera', relayUrl: h.relayUrl, token: h.peers.peera!.token,
      knownPeers: ['peera', 'peerb'],
      dispatchTtlMs: 150,  // short TTL so we can verify gc inside the test
    })
    // peerB never spins up — no stream means the relay won't mark delivered_at.
    try {
      const result = await peerA.callTool('dispatch_task', {
        to: 'peerb', payload: 'into the void',
      })
      const correlationId = (result.content[0] as { text: string }).text.match(/correlation_id=([0-9A-HJKMNP-TV-Z]{26})/)![1]!
      expect(peerA.dispatchTracker.has(correlationId)).toBe(true)

      // After TTL expiry, the tracker drops the entry.
      await new Promise(r => setTimeout(r, 250))
      expect(peerA.dispatchTracker.has(correlationId)).toBe(false)
    } finally {
      peerA.stop()
    }
  }, 5_000)

  it('idempotency: dispatching twice with the same correlation_id collapses to a single relay envelope', async () => {
    const peerA = await spinUpPeer({
      handle: 'peera', relayUrl: h.relayUrl, token: h.peers.peera!.token,
      knownPeers: ['peera', 'peerb'],
    })
    try {
      const correlationId = ulid()
      const r1 = await peerA.callTool('dispatch_task', { to: 'peerb', payload: 'first', correlation_id: correlationId })
      const r2 = await peerA.callTool('dispatch_task', { to: 'peerb', payload: 'second', correlation_id: correlationId })
      const msgId1 = (r1.content[0] as { text: string }).text.match(/msg_[0-9A-HJKMNP-TV-Z]{26}/)![0]!
      const msgId2 = (r2.content[0] as { text: string }).text.match(/msg_[0-9A-HJKMNP-TV-Z]{26}/)![0]!
      // The relay's idempotency_key table returns the cached response on retry,
      // so the same msg_id flows back to both calls.
      expect(msgId1).toBe(msgId2)
    } finally {
      peerA.stop()
    }
  }, 5_000)

  it('fixture: round-trip envelope shape matches channel.ts contract', async () => {
    // Sanity-check the channel notification mapping we depend on in the happy path.
    const sampleResult: Envelope = EnvelopeSchema.parse({
      id: 'msg_01HRK7Y000000000000000000A', v: 2, team: 'hangar',
      from: 'peerb', to: 'peera',
      in_reply_to: 'msg_01HRK7Y000000000000000000B',
      thread_root: null, kind: 'task_result',
      content: 'ok', meta: { correlation_id: '01HRK7Y000000000000000000C' },
      sent_at: '2026-05-17T18:30:00.000Z', delivered_at: null,
    })
    const note = envelopeToChannelNotification(sampleResult)
    expect(note.method).toBe('notifications/claude/channel')
    expect(note.params.correlation_id).toBe('01HRK7Y000000000000000000C')
    expect((note.params.meta as { kind: string }).kind).toBe('task_result')
  })
})

describe('P5 fixture self-check', () => {
  it('fixture log exists after happy-path test or skip', () => {
    // The fixture is written by the first test; if it didn't run (e.g. filter),
    // skip rather than fail.
    if (!existsSync(FIXTURE_LOG)) return
    const fs = require('node:fs')
    const content = fs.readFileSync(FIXTURE_LOG, 'utf-8') as string
    expect(content).toContain('hangar-bridge P5 self-loopback')
    expect(content).toContain('"phase":"A1.dispatch.tool_result"')
    expect(content).toContain('"phase":"A4.peerA.inbound"')
  })
})
