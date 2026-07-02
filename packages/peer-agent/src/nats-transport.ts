import { ulid } from 'ulid'
import { EnvelopeSchema, TEAM_BROADCAST_HANDLE, type Envelope, type OutboundMessage } from '@hangar-bridge/shared'
import { connect, nkeyAuthenticator, type NatsConnection } from '@nats-io/transport-node'
import { jetstream, type JetStreamClient } from '@nats-io/jetstream'
import { checkDeliver, checkPublish, type RosterMap } from './subject-acl.ts'
import { buildFleetSubject, deriveFrom, parseFleetSubject } from './fleet-subject.ts'
import { openTaskDedup, correlationIdOf, type TaskDedup } from './task-dedup.ts'
import { logJson } from './logger.ts'
import type { PeerTransport } from './outbound.ts'

interface NatsSubscription {
  [Symbol.asyncIterator](): AsyncIterator<{ subject: string; data: Uint8Array }>
  unsubscribe: () => void
}

interface StatusEvent {
  type: 'disconnect' | 'reconnect' | 'update' | 'ldm' | 'error'
  error?: unknown
}

type ConnectOpts = Parameters<typeof connect>[0]

interface NatsTransportOpts {
  selfHandle: string
  natsUrl: string
  nkeySeed: string
  roster: RosterMap
  onEnvelope: (env: Envelope) => void
  onAuthError: () => void
  inboxPrefix?: string
  reconnectBaseMs?: number
  outboxCap?: number
  onOverflow?: (dropped: number) => void
  connector?: (opts: ConnectOpts) => Promise<NatsConnection>
  jsFactory?: (nc: NatsConnection) => JetStreamClient
  dedup?: TaskDedup
}

interface OutboxEntry {
  subject: string
  payload: Uint8Array
}

interface ParsedIncomingMessage {
  subject: string
  data: Uint8Array
}

interface JetStreamTaskMessage {
  subject: string
  data: Uint8Array
  ack: () => Promise<void> | void
  nak: () => Promise<void> | void
  term: () => Promise<void> | void
}

interface JetStreamTaskIterable extends AsyncIterable<JetStreamTaskMessage> {
  return?: () => Promise<void> | void
  stop?: () => Promise<void> | void
  close?: () => Promise<void> | void
}

const TEAM_RECIPIENT_TOKEN = 'team'
const TEAM_LANE_ALLOWED_KINDS = new Set(['chat', 'presence_update'])
const TASK_MESSAGE_KINDS = new Set<Envelope['kind']>(['task_dispatch', 'task_result'])
const TASK_STREAM = 'HANGAR_TASKS'

export class NatsTransport implements PeerTransport {
  private nc: NatsConnection | undefined
  private stopped = false
  private connected = false
  private outbox: OutboxEntry[] = []
  private statusTask: Promise<void> | undefined
  private jetstreamTask: Promise<void> | undefined
  private jetstreamIterator: AsyncIterator<JetStreamTaskMessage> | undefined
  private jetstreamMessages: JetStreamTaskIterable | undefined
  private js: JetStreamClient | undefined
  private dedup: TaskDedup | undefined
  private subscriptions: NatsSubscription[] = []
  private decoder = new TextDecoder()
  private encoder = new TextEncoder()
  private jetstreamStopSignal: Promise<void> = Promise.resolve()
  private jetstreamStopSignalResolver: (() => void) | undefined

  constructor(private readonly opts: NatsTransportOpts) {}

  get outboxDepth(): number {
    return this.outbox.length
  }

  async start(): Promise<void> {
    this.stopped = false
    this.resetJetstreamStopSignal()
    const connector = this.opts.connector ?? connect
    const connectOpts: ConnectOpts = {
      servers: this.opts.natsUrl,
      authenticator: nkeyAuthenticator(this.encoder.encode(this.opts.nkeySeed)),
      inboxPrefix: this.opts.inboxPrefix ?? `_INBOX.${this.opts.selfHandle}`,
      maxReconnectAttempts: -1,
      reconnectTimeWait: this.opts.reconnectBaseMs ?? 500,
    }
    try {
      this.nc = await connector(connectOpts)
    } catch (err) {
      this.connected = false
      if (this.isAuthError(err)) this.opts.onAuthError()
      throw err
    }

    this.connected = true
    this.js = (this.opts.jsFactory ?? jetstream)(this.nc)
    // Permanent dedup is OPTIONAL infra and its KV-open must NEVER block/slow the
    // task-consume startup: a missing/ungranted bucket makes `kvm.open` deadline for
    // seconds. So open it in the BACKGROUND (bounded) — the consume loop uses it once
    // ready and, until then / if it never opens, relies on JetStream's own ~2-minute
    // Nats-Msg-Id window. Not silent: an unavailable bucket is logged.
    if (this.opts.dedup) {
      this.dedup = this.opts.dedup
    } else {
      void this.openDedupBounded()
        .then(d => { this.dedup = d })
        .catch(() => { logJson('warn', 'peer.nats.dedup_unavailable', { handle: this.opts.selfHandle }) })
    }
    this.statusTask = this.watchStatus()
    this.subscribe(`fleet.*.to.${this.opts.selfHandle}.>`)
    this.subscribe(`fleet.*.to.${TEAM_RECIPIENT_TOKEN}.>`)
    this.jetstreamTask = this.consumeTaskStream()
    await this.flushOutbox()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.signalJetstreamStop()
    const jetstreamTask = this.jetstreamTask
    this.subscriptions.forEach(sub => sub.unsubscribe())
    this.subscriptions = []
    this.jetstreamTask = undefined
    await this.stopJetstreamMessages()
    this.jetstreamIterator = undefined
    this.jetstreamMessages = undefined
    if (jetstreamTask) await jetstreamTask.catch(() => {})
    if (this.nc) await this.nc.drain()
    this.connected = false
  }

  async send(msg: OutboundMessage, opts: { idempotency_key?: string } = {}): Promise<Envelope> {
    if (msg.to === TEAM_BROADCAST_HANDLE && !TEAM_LANE_ALLOWED_KINDS.has(msg.kind)) {
      throw new Error(`publish to ${TEAM_BROADCAST_HANDLE} requires kind chat|presence_update`)
    }

    const now = new Date().toISOString()
    const envelope: Envelope = {
      id: `msg_${ulid()}`,
      v: 2,
      team: 'hangar',
      from: this.opts.selfHandle,
      to: msg.to,
      subject: msg.subject ?? null,
      in_reply_to: msg.in_reply_to ?? null,
      thread_root: null,
      kind: msg.kind,
      content: msg.content,
      meta: msg.meta ?? {},
      sent_at: now,
      delivered_at: null,
    }

    const publishCheck = checkPublish(envelope, this.opts.roster)
    if (!publishCheck.ok) throw new Error(`publish denied: ${publishCheck.reason}`)

    const wireSubject = buildFleetSubject(
      this.opts.selfHandle,
      msg.to === TEAM_BROADCAST_HANDLE ? TEAM_RECIPIENT_TOKEN : msg.to,
      msg.kind,
    )
    const payload = this.encoder.encode(JSON.stringify(envelope))
    if (TASK_MESSAGE_KINDS.has(msg.kind)) {
      await this.publishJetstream(wireSubject, payload)
    } else {
      await this.publishCore(wireSubject, payload)
    }

    return envelope
  }

  async listPeers(): Promise<Array<{ handle: string; display_name: string; online: boolean; summary: string; last_seen: string | null; sessions: Array<{ label: string; cwd?: string; branch?: string; repo?: string }> }>> {
    return Object.entries(this.opts.roster).map(([handle, value]) => ({
      handle,
      display_name: handle,
      online: false,
      summary: '',
      last_seen: null,
      sessions: [],
    }))
  }

  async setPresence(_body: { summary: string; cwd?: string; branch?: string; repo?: string }): Promise<void> {
    return undefined
  }

  private enqueueOutbox(subject: string, payload: Uint8Array): void {
    const cap = this.opts.outboxCap ?? 1000
    if (this.outbox.length >= cap) {
      this.outbox.shift()
      if (this.opts.onOverflow) this.opts.onOverflow(1)
    }
    this.outbox.push({ subject, payload })
  }

  private isTaskSubject(subject: string): boolean {
    const parsed = parseFleetSubject(subject)
    return parsed !== null && TASK_MESSAGE_KINDS.has(parsed.kind)
  }

  private async publishCore(subject: string, payload: Uint8Array): Promise<boolean> {
    if (!this.connected || !this.nc) {
      this.enqueueOutbox(subject, payload)
      return false
    }

    try {
      this.nc.publish(subject, payload)
      return true
    } catch {
      this.enqueueOutbox(subject, payload)
      return false
    }
  }

  private async publishJetstream(subject: string, payload: Uint8Array): Promise<boolean> {
    if (!this.connected || !this.nc || !this.js) {
      this.enqueueOutbox(subject, payload)
      return false
    }

    try {
      await this.js.publish(subject, payload)
      return true
    } catch {
      this.enqueueOutbox(subject, payload)
      return false
    }
  }

  private async publishCoreForFlush(subject: string, payload: Uint8Array): Promise<boolean> {
    if (!this.nc) return false
    try {
      this.nc.publish(subject, payload)
      return true
    } catch {
      return false
    }
  }

  private async publishJetstreamForFlush(subject: string, payload: Uint8Array): Promise<boolean> {
    if (!this.nc || !this.js) return false
    try {
      await this.js.publish(subject, payload)
      return true
    } catch {
      return false
    }
  }

  private async flushOutbox(): Promise<void> {
    if (!this.nc || this.stopped || !this.connected) return
    // Durable-task completeness: flush JetStream task entries FIRST, so a stuck
    // core publish can never head-of-line-block queued task_dispatch/task_result
    // even when JetStream itself is available (separate tiers, tasks prioritised).
    const pending = this.outbox
    this.outbox = []
    const tasks = pending.filter(e => this.isTaskSubject(e.subject))
    const core = pending.filter(e => !this.isTaskSubject(e.subject))
    for (const group of [tasks, core]) {
      for (let i = 0; i < group.length; i++) {
        const entry = group[i]!
        if (this.stopped || !this.connected) { this.outbox.push(...group.slice(i)); break }
        const flushed = this.isTaskSubject(entry.subject)
          ? await this.publishJetstreamForFlush(entry.subject, entry.payload)
          : await this.publishCoreForFlush(entry.subject, entry.payload)
        if (!flushed) {
          this.connected = false
          this.outbox.push(...group.slice(i))
          break
        }
      }
    }
  }

  private async watchStatus(): Promise<void> {
    if (!this.nc) return
    try {
      for await (const status of this.nc.status()) {
        if (this.stopped) break
        const event = status as StatusEvent
        switch (event.type) {
          case 'disconnect':
            this.connected = false
            break
          case 'reconnect':
            this.connected = true
            await this.flushOutbox()
            break
          case 'update':
          case 'ldm':
            this.connected = true
            break
          case 'error': {
            this.connected = false
            if (this.isAuthError(event.error)) this.opts.onAuthError()
            break
          }
          default:
            break
        }
      }
    } catch {
      this.connected = false
    }
  }

  private subscribe(subject: string): void {
    if (!this.nc) return
    const sub = this.nc.subscribe(subject) as unknown as NatsSubscription
    this.subscriptions.push(sub)
    void this.consume(subject, sub)
  }

  private async consume(_subjectFilter: string, sub: NatsSubscription): Promise<void> {
    try {
      for await (const msg of sub) {
        if (this.stopped) break
        const parsed = parseFleetSubject(msg.subject)
        if (!parsed) continue
        if (TASK_MESSAGE_KINDS.has(parsed.kind)) continue
        if (parsed.recipient !== this.opts.selfHandle && parsed.recipient !== TEAM_RECIPIENT_TOKEN) continue
        if (parsed.recipient === TEAM_RECIPIENT_TOKEN && parsed.sender === this.opts.selfHandle) continue
        if (parsed.recipient === TEAM_RECIPIENT_TOKEN && !TEAM_LANE_ALLOWED_KINDS.has(parsed.kind)) continue

        const envelope = this.parseInboundEnvelope(msg)
        if (!envelope) continue
        if (!checkDeliver(envelope, this.opts.selfHandle, this.opts.roster)) continue
        this.opts.onEnvelope(envelope)
      }
    } catch {
      if (this.stopped) return
      // NATS iterators can terminate when subscriptions are drained.
    }
  }

  private async consumeTaskStream(): Promise<void> {
    const retryMs = 250
    while (!this.stopped) {
      if (!this.connected || !this.js || !this.nc) {
        await new Promise<void>(resolve => setTimeout(resolve, retryMs))
        continue
      }

      let iterator: AsyncIterator<JetStreamTaskMessage> | undefined
      try {
        const consumer = await this.awaitJetstreamConsumer(this.js.consumers.get(TASK_STREAM, this.opts.selfHandle))
        const messages = (await this.awaitJetstreamMessages(consumer.consume())) as JetStreamTaskIterable
        this.jetstreamMessages = messages
        // Teardown race: if stop() fired before we acquired the consumer, its
        // stopJetstreamMessages() ran against an undefined handle — close the
        // freshly-acquired iterable now so the consumer isn't leaked.
        if (this.stopped) { await this.stopJetstreamMessages(); this.jetstreamMessages = undefined; return }
        iterator = messages[Symbol.asyncIterator]()
      } catch (error) {
        if (this.stopped) return
        if (this.isAuthError(error)) this.opts.onAuthError()
        await new Promise<void>(resolve => setTimeout(resolve, retryMs))
        continue
      }

      if (!iterator) continue
      this.jetstreamIterator = iterator
      try {
        while (!this.stopped) {
          const next = await Promise.race<IteratorResult<JetStreamTaskMessage>>([
            iterator.next(),
            this.jetstreamStopSignal.then(() => ({ value: undefined as never, done: true })),
          ])
          if (next.done) break
          const msg = next.value

          if (this.stopped) break

          const parsed = parseFleetSubject(msg.subject)
          if (!parsed || !TASK_MESSAGE_KINDS.has(parsed.kind) || parsed.recipient !== this.opts.selfHandle) {
            await this.termIfPossible(msg)
            continue
          }

          const envelope = this.parseInboundEnvelope(msg)
          if (!envelope) {
            await this.termIfPossible(msg)
            continue
          }

          if (!checkDeliver(envelope, this.opts.selfHandle, this.opts.roster)) {
            await this.termIfPossible(msg)
            continue
          }

          // AC5 permanent dedup: suppress a re-delivered/re-dispatched task even after
          // the JetStream Nats-Msg-Id window has expired. A dedup INFRA error must NOT
          // silently drop the task — leave it un-acked (nak) so it is retried.
          if (this.dedup) {
            let duplicate: boolean
            try {
              duplicate = await this.dedup.seen(correlationIdOf(envelope.meta, envelope.id))
            } catch {
              await Promise.resolve(msg.nak())
              continue
            }
            if (duplicate) {
              await Promise.resolve(msg.ack()) // already processed ⇒ remove from WorkQueue, skip delivery
              continue
            }
          }

          try {
            this.opts.onEnvelope(envelope)
            await Promise.resolve(msg.ack())
          } catch {
            await Promise.resolve(msg.nak())
          }
        }
      } catch {
        if (this.stopped) return
        await new Promise<void>(resolve => setTimeout(resolve, retryMs))
      } finally {
        if (this.jetstreamIterator === iterator) this.jetstreamIterator = undefined
      }

      if (!this.stopped) await new Promise<void>(resolve => setTimeout(resolve, retryMs))
    }
  }

  private resetJetstreamStopSignal(): void {
    this.jetstreamStopSignal = new Promise<void>(resolve => {
      this.jetstreamStopSignalResolver = resolve
    })
  }

  private signalJetstreamStop(): void {
    if (this.jetstreamStopSignalResolver) {
      this.jetstreamStopSignalResolver()
      this.jetstreamStopSignalResolver = undefined
    }
  }

  private async openDedupBounded(): Promise<TaskDedup | undefined> {
    if (!this.nc) return undefined
    const DEADLINE_MS = 1500
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        openTaskDedup(this.nc, this.opts.selfHandle),
        new Promise<undefined>((_, reject) => {
          timer = setTimeout(() => reject(new Error('dedup open timeout')), DEADLINE_MS)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async stopJetstreamMessages(): Promise<void> {
    if (!this.jetstreamMessages) return
    const source = this.jetstreamMessages as JetStreamTaskIterable & { return?: () => unknown; stop?: () => unknown; close?: () => unknown }
    const methods: Array<(() => unknown) | undefined> = [source.stop, source.close, source.return]
    for (const method of methods) {
      if (typeof method !== 'function') continue
      await Promise.race([
        Promise.resolve(method.call(source)).then(() => {}, () => {}),
        new Promise(resolve => setTimeout(resolve, 50)),
      ])
      break
    }
  }

  private awaitJetstreamConsumer<T>(promise: Promise<T>): Promise<T> {
    return Promise.race<T>([
      promise,
      this.jetstreamStopSignal.then<T>(() => {
        throw new Error('stopping')
      }),
    ])
  }

  private awaitJetstreamMessages<T>(promise: Promise<T>): Promise<T> {
    return this.awaitJetstreamConsumer(promise)
  }

  private parseInboundEnvelope(msg: ParsedIncomingMessage): Envelope | null {
    const parsed = parseFleetSubject(msg.subject)
    if (!parsed) return null

    const from = deriveFrom(msg.subject)
    if (!from) return null

    let envelope: Envelope
    try {
      envelope = EnvelopeSchema.parse(JSON.parse(this.decoder.decode(msg.data)))
    } catch {
      return null
    }

    if (envelope.kind !== parsed.kind) return null
    const to = parsed.recipient === TEAM_RECIPIENT_TOKEN ? TEAM_BROADCAST_HANDLE : parsed.recipient
    if (envelope.to !== to) return null
    if (to === TEAM_BROADCAST_HANDLE && envelope.subject !== null) return null

    return { ...envelope, from }
  }

  private async termIfPossible(message: JetStreamTaskMessage): Promise<void> {
    try {
      await Promise.resolve(message.term())
    } catch {
      // keep message eligible for terminal handling by caller in this process
    }
  }

  private isAuthError(err: unknown): boolean {
    if (err === undefined || err === null) return false
    const msg = err instanceof Error ? err.message : String(err)
    const m = msg.toLowerCase()
    return m.includes('authorization') || m.includes('authenticate') || m.includes('auth') || m.includes('nkey')
  }
}
