import { ulid } from 'ulid'
import { EnvelopeSchema, TEAM_BROADCAST_HANDLE, type Envelope, type OutboundMessage } from '@hangar-bridge/shared'
import { connect, nkeyAuthenticator, type NatsConnection } from '@nats-io/transport-node'
import { checkDeliver, checkPublish, type RosterMap } from './subject-acl.ts'
import { buildFleetSubject, deriveFrom, parseFleetSubject } from './fleet-subject.ts'
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
}

interface OutboxEntry {
  subject: string
  payload: Uint8Array
}

const TEAM_RECIPIENT_TOKEN = 'team'
const TEAM_LANE_ALLOWED_KINDS = new Set(['chat', 'presence_update'])

export class NatsTransport implements PeerTransport {
  private nc: NatsConnection | undefined
  private stopped = false
  private connected = false
  private outbox: OutboxEntry[] = []
  private statusTask: Promise<void> | undefined
  private subscriptions: NatsSubscription[] = []
  private decoder = new TextDecoder()
  private encoder = new TextEncoder()

  constructor(private readonly opts: NatsTransportOpts) {}

  get outboxDepth(): number {
    return this.outbox.length
  }

  async start(): Promise<void> {
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
    this.statusTask = this.watchStatus()
    this.subscribe(`fleet.*.to.${this.opts.selfHandle}.>`)
    this.subscribe(`fleet.*.to.${TEAM_RECIPIENT_TOKEN}.>`)
    await this.flushOutbox()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.subscriptions.forEach(sub => sub.unsubscribe())
    this.subscriptions = []
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
    if (!this.connected || !this.nc) {
      this.enqueueOutbox(wireSubject, payload)
      return envelope
    }

    try {
      this.nc.publish(wireSubject, payload)
    } catch {
      this.enqueueOutbox(wireSubject, payload)
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

  private async flushOutbox(): Promise<void> {
    if (!this.nc || this.stopped || !this.connected) return
    while (this.outbox.length > 0 && this.connected && !this.stopped) {
      const entry = this.outbox.shift()
      if (entry === undefined) break
      try {
        this.nc.publish(entry.subject, entry.payload)
      } catch {
        this.outbox.unshift(entry)
        this.connected = false
        break
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
        if (parsed.recipient !== this.opts.selfHandle && parsed.recipient !== TEAM_RECIPIENT_TOKEN) continue
        if (parsed.recipient === TEAM_RECIPIENT_TOKEN && parsed.sender === this.opts.selfHandle) continue
        if (parsed.recipient === TEAM_RECIPIENT_TOKEN && !TEAM_LANE_ALLOWED_KINDS.has(parsed.kind)) continue

        const from = deriveFrom(msg.subject)
        if (!from) continue

        let env: Envelope
        try {
          env = EnvelopeSchema.parse(JSON.parse(this.decoder.decode(msg.data)))
        } catch {
          continue
        }

        if (env.kind !== parsed.kind) continue
        const to = parsed.recipient === TEAM_RECIPIENT_TOKEN ? TEAM_BROADCAST_HANDLE : parsed.recipient
        if (env.to !== to) continue
        if (to === TEAM_BROADCAST_HANDLE && env.subject !== null) continue
        const derived: Envelope = { ...env, from, to }
        if (!checkDeliver(derived, this.opts.selfHandle, this.opts.roster)) continue
        this.opts.onEnvelope(derived)
      }
    } catch {
      if (this.stopped) return
      // NATS iterators can terminate when subscriptions are drained.
    }
  }

  private isAuthError(err: unknown): boolean {
    if (err === undefined || err === null) return false
    const msg = err instanceof Error ? err.message : String(err)
    const m = msg.toLowerCase()
    return m.includes('authorization') || m.includes('authenticate') || m.includes('auth') || m.includes('nkey')
  }
}
