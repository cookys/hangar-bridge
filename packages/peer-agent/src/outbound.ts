import { ulid } from 'ulid'
import type { Envelope, OutboundMessage } from '@hangar-bridge/shared'

export interface RelayClientOpts {
  relayUrl: string
  token: string
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

export class RelayClient {
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

  private authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.opts.token}`, 'content-type': 'application/json' }
  }

  /** Acquire (or renew) a cooperative asset claim. 201 ⇒ ok; 409 ⇒ conflict. */
  async claim(body: { key: string; ttl_seconds?: number; note?: string }): Promise<ClaimAcquireResult> {
    const res = await this.fetchImpl(new URL('/v1/claim', this.opts.relayUrl), {
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
    const res = await this.fetchImpl(new URL('/v1/claims', this.opts.relayUrl), {
      headers: { authorization: `Bearer ${this.opts.token}` },
    })
    if (res.status !== 200) throw new Error(`listClaims failed: ${res.status}`)
    return await res.json() as Claim[]
  }

  /** Release a claim (owner-only). 200 ⇒ {released}; 409 ⇒ held by another live owner. */
  async releaseClaim(key: string): Promise<{ ok: true; released: boolean } | { ok: false; owner: string }> {
    const res = await this.fetchImpl(new URL('/v1/claim', this.opts.relayUrl), {
      method: 'DELETE', headers: this.authHeaders(), body: JSON.stringify({ key }),
    })
    const text = await res.text()
    if (res.status === 200) return { ok: true, released: (JSON.parse(text) as { released: boolean }).released }
    if (res.status === 409) return { ok: false, owner: (JSON.parse(text) as { owner: string }).owner }
    throw new Error(`releaseClaim failed: ${res.status} ${text}`)
  }
}
