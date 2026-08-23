import { ulid } from 'ulid'
import type { Envelope, OutboundMessage } from '@hangar-bridge/shared'

export interface RelayClientOpts {
  relayUrl: string
  token: string
  /** Optional per-request deadline, used by the NATS claim-compatibility probe. */
  requestTimeoutMs?: number
}

/**
 * What a peer reports about itself on connect, on every heartbeat, and on an
 * explicit set_summary. `instance` keys the relay's presence row per process
 * (P2 §2.1); `delivery_state` and `caps` are observability/telemetry bits.
 */
export interface PresenceReport {
  summary: string
  cwd?: string
  branch?: string
  repo?: string
  worktree?: string
  instance?: string
  delivery_state?: 'unverified' | 'verified' | 'deaf'
  caps?: string
}

export interface PeerTransport {
  readonly capabilities?: {
    teamTaskFanout: boolean
    teamPermissionFanout: boolean
  }
  send(msg: OutboundMessage, opts?: { idempotency_key?: string }): Promise<Envelope>
  listPeers(): Promise<PeerSummary[]>
  setPresence(body: PresenceReport): Promise<void>
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

export interface Claim {
  team_id: string
  claim_key: string
  owner_handle: string
  owner_label: string | null
  note: string | null
  created_at: string
  expires_at: string
}

export type ClaimAcquireResult =
  | { ok: true; claim: Claim; renewed: boolean }
  | { ok: false; conflict: { owner: string; expires_at: string } }

export interface ClaimClient {
  claim(body: { key: string; ttl_seconds?: number; note?: string }): Promise<ClaimAcquireResult>
  listClaims(): Promise<Claim[]>
  releaseClaim(key: string): Promise<{ ok: true; released: boolean } | { ok: false; owner: string }>
}

export class RelayClient implements PeerTransport, ClaimClient {
  readonly capabilities = { teamTaskFanout: true, teamPermissionFanout: true } as const
  private fetchImpl: typeof globalThis.fetch

  constructor(private opts: RelayClientOpts, inj: Injected = {}) {
    this.fetchImpl = inj.fetch ?? globalThis.fetch
  }

  private async request(url: URL, init: RequestInit): Promise<Response> {
    const timeout = this.opts.requestTimeoutMs
    return await this.fetchImpl(url, {
      ...init,
      ...(timeout && timeout > 0 ? { signal: AbortSignal.timeout(timeout) } : {}),
    })
  }

  async send(msg: OutboundMessage, opts: { idempotency_key?: string } = {}): Promise<Envelope> {
    const idempotencyKey = (opts.idempotency_key ?? ulid()).toLowerCase()
    const res = await this.request(new URL('/v1/messages', this.opts.relayUrl), {
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
    const res = await this.request(new URL('/v1/peers', this.opts.relayUrl), {
      headers: { authorization: `Bearer ${this.opts.token}` },
    })
    if (res.status !== 200) throw new Error(`listPeers failed: ${res.status}`)
    return await res.json() as PeerSummary[]
  }

  async setPresence(body: PresenceReport): Promise<void> {
    const res = await this.request(new URL('/v1/presence', this.opts.relayUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${this.opts.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.status !== 200) throw new Error(`presence failed: ${res.status}`)
  }

  private authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.opts.token}`, 'content-type': 'application/json' }
  }

  /** Acquire (or renew) a cooperative asset claim. 201 ⇒ ok; 409 ⇒ conflict. */
  async claim(body: { key: string; ttl_seconds?: number; note?: string }): Promise<ClaimAcquireResult> {
    const res = await this.request(new URL('/v1/claim', this.opts.relayUrl), {
      method: 'POST', headers: this.authHeaders(), body: JSON.stringify(body),
    })
    const text = await res.text()
    if (res.status === 201) {
      const j = JSON.parse(text) as { claim: Claim; renewed: boolean }
      return { ok: true, claim: j.claim, renewed: j.renewed }
    }
    if (res.status === 409) {
      const j = JSON.parse(text) as { owner: string; expires_at: string }
      return { ok: false, conflict: { owner: j.owner, expires_at: j.expires_at } }
    }
    throw new Error(`claim failed: ${res.status} ${text}`)
  }

  async listClaims(): Promise<Claim[]> {
    const res = await this.request(new URL('/v1/claims', this.opts.relayUrl), {
      headers: { authorization: `Bearer ${this.opts.token}` },
    })
    if (res.status !== 200) throw new Error(`listClaims failed: ${res.status}`)
    return await res.json() as Claim[]
  }

  /**
   * Release a claim (owner-only). 200 ⇒ {released}; 409 ⇒ held by another live owner.
   * Uses POST /v1/claim/release (not DELETE-with-body): a request body on POST is
   * universally sent/parsed, whereas DELETE bodies are dropped by some proxies/clients.
   */
  async releaseClaim(key: string): Promise<{ ok: true; released: boolean } | { ok: false; owner: string }> {
    const res = await this.request(new URL('/v1/claim/release', this.opts.relayUrl), {
      method: 'POST', headers: this.authHeaders(), body: JSON.stringify({ key }),
    })
    const text = await res.text()
    if (res.status === 200) return { ok: true, released: (JSON.parse(text) as { released: boolean }).released }
    if (res.status === 409) return { ok: false, owner: (JSON.parse(text) as { owner: string }).owner }
    throw new Error(`releaseClaim failed: ${res.status} ${text}`)
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
