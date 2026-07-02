import { ulid } from 'ulid'
import type { Envelope, OutboundMessage } from '@hangar-bridge/shared'

export interface RelayClientOpts {
  relayUrl: string
  token: string
}

export interface PeerTransport {
  send(msg: OutboundMessage, opts?: { idempotency_key?: string }): Promise<Envelope>
  listPeers(): Promise<PeerSummary[]>
  setPresence(body: { summary: string; cwd?: string; branch?: string; repo?: string }): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
}

interface Injected { fetch?: typeof globalThis.fetch }

export interface PeerSummary {
  handle: string
  display_name: string
  online: boolean
  summary: string
  last_seen: string | null
  sessions: Array<{ label: string; cwd?: string; branch?: string; repo?: string }>
}

export class RelayClient implements PeerTransport {
  private fetchImpl: typeof globalThis.fetch

  constructor(private opts: RelayClientOpts, inj: Injected = {}) {
    this.fetchImpl = inj.fetch ?? globalThis.fetch
  }

  async send(msg: OutboundMessage, opts: { idempotency_key?: string } = {}): Promise<Envelope> {
    const idempotencyKey = (opts.idempotency_key ?? ulid()).toLowerCase()
    const res = await this.fetchImpl(new URL('/v1/messages', this.opts.relayUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.opts.token}`,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify(msg),
    })
    const text = await res.text()
    if (res.status !== 201) throw new Error(`send failed: ${res.status} ${text}`)
    return JSON.parse(text) as Envelope
  }

  async listPeers(): Promise<PeerSummary[]> {
    const res = await this.fetchImpl(new URL('/v1/peers', this.opts.relayUrl), {
      headers: { authorization: `Bearer ${this.opts.token}` },
    })
    if (res.status !== 200) throw new Error(`listPeers failed: ${res.status}`)
    return await res.json() as PeerSummary[]
  }

  async setPresence(body: { summary: string; cwd?: string; branch?: string; repo?: string }): Promise<void> {
    const res = await this.fetchImpl(new URL('/v1/presence', this.opts.relayUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${this.opts.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.status !== 200) throw new Error(`presence failed: ${res.status}`)
  }

  async start(): Promise<void> {
    // SSE transport client does not require an explicit start state machine.
    return undefined
  }

  async stop(): Promise<void> {
    // SSE transport client does not retain long-lived transport state.
    return undefined
  }
}
