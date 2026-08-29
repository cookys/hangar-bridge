import {
  EnvelopeSchema,
  newMessageId,
  OutboundMessageSchema,
  TEAM_BROADCAST_HANDLE,
  type Envelope,
  type OutboundMessage,
} from '@hangar-bridge/shared'
import { connect, nkeyAuthenticator, type NatsConnection } from '@nats-io/transport-node'
import { jetstream, type JetStreamClient } from '@nats-io/jetstream'
import { checkDeliver, checkPublish, type RosterMap } from './subject-acl.ts'
import { buildFleetSubject, parseFleetSubject } from './fleet-subject.ts'
import { openTaskDedup, correlationIdOf, type TaskDedup } from './task-dedup.ts'
import { createPresenceTracker, type PresenceTracker } from './presence-tracker.ts'
import { logJson } from './logger.ts'
import type { PeerTransport } from './outbound.ts'
import type { NatsInstanceGuard } from './nats-instance-lock.ts'
import type { InboundDeliveryResult } from './inbound.ts'

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
  /** Process attribution; observability only, never authorization or routing. */
  instance?: string
  natsUrl: string
  nkeySeed: string
  roster: RosterMap
  onEnvelope: (env: Envelope) => InboundDeliveryResult | Promise<InboundDeliveryResult>
  onAuthError: () => void
  instanceGuard: NatsInstanceGuard
  inboxPrefix?: string
  reconnectBaseMs?: number
  connector?: (opts: ConnectOpts) => Promise<NatsConnection>
  jsFactory?: (nc: NatsConnection) => JetStreamClient
  dedup?: TaskDedup
  dedupFactory?: (nc: NatsConnection, selfHandle: string) => Promise<TaskDedup>
  auditWriter: (record: NatsAuditRecord) => void
  /** Presence: heartbeat TTL (ms) and interval (ms); injectable clock for tests. */
  presenceTtlMs?: number
  heartbeatMs?: number
  now?: () => number
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
  redelivered?: boolean
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

export interface NatsAuditRecord {
  at: string
  sender: string
  subject: string | null
  reason: string
  envelope_id: string
  kind: Envelope['kind']
  disposition: 'drop' | 'term'
}

/** Canonicalize identity/addressing from the authenticated wire subject. */
export function checkInbound(
  wireSubject: string,
  envelope: Envelope,
  localHandle: string,
): Envelope | null {
  const parsed = parseFleetSubject(wireSubject)
  if (!parsed) return null
  if (parsed.recipient !== localHandle && parsed.recipient !== TEAM_RECIPIENT_TOKEN) return null
  if (parsed.recipient === TEAM_RECIPIENT_TOKEN && parsed.sender === localHandle) return null
  if (parsed.recipient === TEAM_RECIPIENT_TOKEN && !TEAM_LANE_ALLOWED_KINDS.has(parsed.kind)) return null
  if (envelope.kind !== parsed.kind) return null
  const to = parsed.recipient === TEAM_RECIPIENT_TOKEN ? TEAM_BROADCAST_HANDLE : parsed.recipient
  if (envelope.to !== to) return null
  return { ...envelope, from: parsed.sender }
}

export class NatsTransport implements PeerTransport {
  readonly capabilities = { teamTaskFanout: false, teamPermissionFanout: false } as const
  private nc: NatsConnection | undefined
  private stopped = false
  private connected = false
  private statusTask: Promise<void> | undefined
  private jetstreamTask: Promise<void> | undefined
  private dedupTask: Promise<void> | undefined
  private jetstreamIterator: AsyncIterator<JetStreamTaskMessage> | undefined
  private jetstreamMessages: JetStreamTaskIterable | undefined
  private js: JetStreamClient | undefined
  private dedup: TaskDedup | undefined
  private readonly presence: PresenceTracker
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private subscriptions: NatsSubscription[] = []
  private decoder = new TextDecoder()
  private encoder = new TextEncoder()
  private jetstreamStopSignal: Promise<void> = Promise.resolve()
  private jetstreamStopSignalResolver: (() => void) | undefined
  private readonly outboundByIdempotency = new Map<string, { envelope: Envelope; fingerprint: string }>()

  constructor(private readonly opts: NatsTransportOpts) {
    this.presence = createPresenceTracker(opts.presenceTtlMs ?? 90_000)
  }

  private nowMs(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }

  async start(): Promise<void> {
    this.stopped = false
    this.resetJetstreamStopSignal()
    if (!Object.prototype.hasOwnProperty.call(this.opts.roster, this.opts.selfHandle)) {
      throw new Error(`self handle is absent from NATS roster: ${this.opts.selfHandle}`)
    }
    this.opts.instanceGuard.acquire()
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
      this.opts.instanceGuard.release()
      if (this.isAuthError(err)) this.opts.onAuthError()
      throw err
    }

    this.connected = true
    this.js = (this.opts.jsFactory ?? jetstream)(this.nc)
    if (this.opts.dedup) {
      this.dedup = this.opts.dedup
    } else {
      // Chats/presence may start immediately, but the durable consumer below stays
      // closed until this required permanent-dedup authority is ready. Retry forever
      // with bounded backoff; never process a task through a temporary fail-open lane.
      this.dedupTask = this.openDedupUntilReady()
    }
    this.statusTask = this.watchStatus()
    this.subscribe(`fleet.*.to.${this.opts.selfHandle}.>`)
    this.subscribe(`fleet.*.to.${TEAM_RECIPIENT_TOKEN}.>`)
    this.jetstreamTask = this.consumeTaskStream()
    // Publish immediately so a freshly started peer does not appear offline for one
    // full heartbeat interval, then keep the heartbeat alive on the normal cadence.
    await this.emitHeartbeat()
    const heartbeatMs = this.opts.heartbeatMs ?? 30_000
    this.heartbeatTimer = setInterval(() => { void this.emitHeartbeat() }, heartbeatMs)
    this.heartbeatTimer.unref?.()
  }

  async stop(): Promise<void> {
    this.stopped = true
    // Lifecycle shutdown exits immediately after calling stop(); release the process
    // lock before the first await so a clean parent exit never leaves a live lock.
    this.opts.instanceGuard.release()
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = undefined }
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
    this.dedupTask = undefined
  }

  async send(msg: OutboundMessage, opts: { idempotency_key?: string } = {}): Promise<Envelope> {
    const parsedMessage = OutboundMessageSchema.parse(msg)
    const meta = { ...(parsedMessage.meta ?? {}) }
    delete meta['instance']
    delete meta['sender_instance']
    delete meta['session_id']
    delete meta['attribution_status']
    if (this.opts.instance) {
      // NATS has no relay POST chokepoint. Stamp at the trusted harness-adapter
      // boundary instead, after stripping caller/model-controlled reserved meta.
      // A process sharing this handle's NKey is still in the same trust class;
      // these fields remain observability-only.
      meta['instance'] = this.opts.instance
      meta['sender_instance'] = this.opts.instance
      meta['attribution_status'] = 'adapter-stamped'
    } else {
      meta['attribution_status'] = 'unverifiable'
    }
    parsedMessage.meta = meta
    if (parsedMessage.to === TEAM_BROADCAST_HANDLE && !TEAM_LANE_ALLOWED_KINDS.has(parsedMessage.kind)) {
      throw new Error(`publish to ${TEAM_BROADCAST_HANDLE} requires kind chat|presence_update`)
    }
    if (
      parsedMessage.to !== TEAM_BROADCAST_HANDLE
      && !Object.prototype.hasOwnProperty.call(this.opts.roster, parsedMessage.to)
    ) {
      throw new Error(`unknown roster recipient: ${parsedMessage.to}`)
    }

    const isTask = TASK_MESSAGE_KINDS.has(parsedMessage.kind)
    const requestedIdempotencyKey = opts.idempotency_key?.trim().toLowerCase()
    const fingerprint = JSON.stringify(parsedMessage)
    let envelope: Envelope
    let idempotencyKey: string
    const cached = isTask && requestedIdempotencyKey
      ? this.outboundByIdempotency.get(requestedIdempotencyKey)
      : undefined
    if (cached) {
      if (cached.fingerprint !== fingerprint) {
        throw new Error(`idempotency key reused with a different task payload: ${requestedIdempotencyKey}`)
      }
      envelope = cached.envelope
      idempotencyKey = requestedIdempotencyKey!
    } else {
      envelope = EnvelopeSchema.parse({
        id: newMessageId(),
        v: 2,
        team: 'hangar',
        from: this.opts.selfHandle,
        to: parsedMessage.to,
        subject: parsedMessage.subject,
        in_reply_to: parsedMessage.in_reply_to ?? null,
        thread_root: null,
        kind: parsedMessage.kind,
        content: parsedMessage.content,
        meta: parsedMessage.meta ?? {},
        sent_at: new Date().toISOString(),
        delivered_at: null,
      })
      idempotencyKey = requestedIdempotencyKey || envelope.id.toLowerCase()
      if (isTask && requestedIdempotencyKey) {
        if (this.outboundByIdempotency.size >= 4096) {
          const oldest = this.outboundByIdempotency.keys().next().value
          if (oldest !== undefined) this.outboundByIdempotency.delete(oldest)
        }
        this.outboundByIdempotency.set(requestedIdempotencyKey, { envelope, fingerprint })
      }
    }

    const publishCheck = checkPublish(envelope, this.opts.roster)
    if (!publishCheck.ok) throw new Error(`publish denied: ${publishCheck.reason}`)

    const wireSubject = buildFleetSubject(
      this.opts.selfHandle,
      parsedMessage.to === TEAM_BROADCAST_HANDLE ? TEAM_RECIPIENT_TOKEN : parsedMessage.to,
      parsedMessage.kind,
    )
    const payload = this.encoder.encode(JSON.stringify(envelope))
    const published = isTask
      ? await this.publishJetstream(wireSubject, payload, idempotencyKey)
      : await this.publishCore(wireSubject, payload)
    if (!published) {
      throw new Error('publish failed: NATS transport is not connected or did not confirm the publish')
    }

    return envelope
  }

  async listPeers(): Promise<Array<{ handle: string; display_name: string; online: boolean; summary: string; last_seen: string | null; sessions: Array<{ label: string; cwd?: string; branch?: string; repo?: string }> }>> {
    const now = this.nowMs()
    return Object.keys(this.opts.roster).map(handle => {
      const seen = this.presence.lastSeen(handle)
      return {
        handle,
        display_name: this.opts.roster[handle]?.display_name ?? handle,
        // AC7: online derived from the heartbeat SoT (a peer's own handle is never "online" to itself).
        online: handle === this.opts.selfHandle ? false : this.presence.isOnline(handle, now),
        summary: '',
        last_seen: seen === null ? null : new Date(seen).toISOString(),
        sessions: [],
      }
    })
  }

  async setPresence(body: { summary: string; cwd?: string; branch?: string; repo?: string }): Promise<void> {
    // Publishing a presence_update to the team lane IS this peer's heartbeat.
    const meta: Record<string, string> = { summary: body.summary }
    if (body.cwd) meta.cwd = body.cwd
    if (body.branch) meta.branch = body.branch
    if (body.repo) meta.repo = body.repo
    await this.send({ to: TEAM_BROADCAST_HANDLE, kind: 'presence_update', subject: null, content: body.summary, meta })
  }

  /** Emit this peer's own presence_update heartbeat (best-effort; failure is not queued). */
  private async emitHeartbeat(): Promise<void> {
    try {
      await this.send({ to: TEAM_BROADCAST_HANDLE, kind: 'presence_update', subject: null, content: '', meta: {} })
    } catch {
      // send() reports connection/publish failure explicitly; a heartbeat miss is non-fatal
      // because the TTL-based presence view will age this peer offline.
    }
  }

  private async publishCore(subject: string, payload: Uint8Array): Promise<boolean> {
    if (!this.connected || !this.nc) return false

    try {
      this.nc.publish(subject, payload)
      // Core NATS has no per-message puback. A flush is the server round-trip that
      // proves everything published before it left the client reconnect buffer.
      await this.nc.flush()
      return true
    } catch {
      return false
    }
  }

  private async publishJetstream(subject: string, payload: Uint8Array, msgID: string): Promise<boolean> {
    if (!this.connected || !this.nc || !this.js) return false

    try {
      await this.js.publish(subject, payload, { msgID })
      return true
    } catch {
      return false
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
            break
          case 'update':
          case 'ldm':
            break
          case 'error': {
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
        const publishCheck = checkPublish(envelope, this.opts.roster)
        if (!publishCheck.ok) {
          this.auditDenial(envelope, publishCheck.reason, 'drop')
          continue
        }
        if (!checkDeliver(envelope, this.opts.selfHandle, this.opts.roster)) continue
        // AC7: a presence_update IS the heartbeat — record it against the anti-spoof
        // authenticated sender (wire subject), the presence source-of-truth.
        if (envelope.kind === 'presence_update') {
          this.presence.onHeartbeat(parsed.sender, this.nowMs())
          continue
        }
        try {
          await this.opts.onEnvelope(envelope)
        } catch (err) {
          // Core NATS is at-most-once. Keep the subscription alive and make the loss
          // explicit; unlike JetStream there is no message to NAK for redelivery.
          logJson('error', 'peer.nats.core_delivery_failed', {
            msg_id: envelope.id,
            err: String(err instanceof Error ? err.message : err),
          })
        }
      }
    } catch {
      if (this.stopped) return
      // NATS iterators can terminate when subscriptions are drained.
    }
  }

  private async consumeTaskStream(): Promise<void> {
    const retryMs = 250
    while (!this.stopped) {
      if (!this.connected || !this.js || !this.nc || !this.dedup) {
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

          const publishCheck = checkPublish(envelope, this.opts.roster)
          if (!publishCheck.ok) {
            if (this.auditDenial(envelope, publishCheck.reason, 'term')) {
              await this.termIfPossible(msg)
            } else {
              await Promise.resolve(msg.nak())
            }
            continue
          }

          if (!checkDeliver(envelope, this.opts.selfHandle, this.opts.roster)) {
            await this.termIfPossible(msg)
            continue
          }

          // AC5 permanent dedup: suppress a re-delivered/re-dispatched task even after
          // the JetStream Nats-Msg-Id window has expired. A dedup INFRA error must NOT
          // silently drop the task — leave it un-acked (nak) so it is retried.
          const correlationId = correlationIdOf(envelope.meta, envelope.id)
          try {
            if (await this.dedup.isCompleted(correlationId)) {
              await Promise.resolve(msg.ack())
              continue
            }
          } catch {
            await Promise.resolve(msg.nak())
            continue
          }

          try {
            const delivery = await this.opts.onEnvelope(envelope)
            if (delivery === 'rejected') {
              // This wire message is deterministically invalid for application state
              // (for example, a task_result from the wrong correlated peer). Terminate
              // it without consuming the correlation's permanent completion key.
              await this.termIfPossible(msg)
              continue
            }
            if (delivery !== 'delivered' && delivery !== 'already-delivered') {
              throw new Error(`invalid inbound delivery result: ${String(delivery)}`)
            }
            // Completion is recorded only after MCP accepted the notification. If
            // delivery fails or the process crashes first, JetStream redelivers. An
            // already-delivered result means MCP accepted this exact envelope before
            // a prior completion-marker write failed, so retry that marker safely.
            await this.dedup.markCompleted(correlationId, envelope.id)
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

  private async openDedupUntilReady(): Promise<void> {
    let retryMs = 250
    while (!this.stopped && !this.dedup) {
      try {
        this.dedup = await this.openDedupBounded()
        logJson('info', 'peer.nats.dedup_ready', { handle: this.opts.selfHandle })
        return
      } catch (err) {
        logJson('warn', 'peer.nats.dedup_unavailable', {
          handle: this.opts.selfHandle,
          retry_ms: retryMs,
          err: String(err instanceof Error ? err.message : err),
        })
      }
      await Promise.race([
        new Promise<void>(resolve => setTimeout(resolve, retryMs)),
        this.jetstreamStopSignal,
      ])
      retryMs = Math.min(retryMs * 2, 5_000)
    }
  }

  private async openDedupBounded(): Promise<TaskDedup> {
    if (!this.nc) throw new Error('NATS connection unavailable')
    const DEADLINE_MS = 1500
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        (this.opts.dedupFactory ?? openTaskDedup)(this.nc, this.opts.selfHandle),
        new Promise<never>((_, reject) => {
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
    let envelope: Envelope
    try {
      envelope = EnvelopeSchema.parse(JSON.parse(this.decoder.decode(msg.data)))
    } catch {
      return null
    }

    return checkInbound(msg.subject, envelope, this.opts.selfHandle)
  }

  private auditDenial(
    envelope: Envelope,
    reason: string,
    disposition: NatsAuditRecord['disposition'],
  ): boolean {
    const record: NatsAuditRecord = {
      at: new Date().toISOString(),
      sender: envelope.from,
      subject: envelope.subject,
      reason,
      envelope_id: envelope.id,
      kind: envelope.kind,
      disposition,
    }
    try {
      this.opts.auditWriter(record)
      logJson('warn', 'peer.nats.acl_denied', { ...record })
      return true
    } catch (err) {
      logJson('error', 'peer.nats.audit_write_failed', {
        ...record,
        err: String(err instanceof Error ? err.message : err),
      })
      return false
    }
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
