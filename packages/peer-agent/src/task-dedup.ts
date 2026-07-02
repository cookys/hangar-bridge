import { Kvm } from '@nats-io/kv'
import { jetstream } from '@nats-io/jetstream'
import type { NatsConnection } from '@nats-io/transport-node'

/**
 * Permanent task dedup (AC5): the JetStream `Nats-Msg-Id` dedup window is only ~2
 * minutes, so a peer that crashes and re-dispatches a task after being offline for
 * hours would duplicate it. A KV entry keyed by (own-handle, correlation-id) gives
 * PERMANENT dedup that outlives the window.
 *
 * AC9: correctness rests on KV key EXISTENCE (atomic create) — never a TTL/expiry.
 * The dedup path uses create/get only, never `watch()`, so the default history=1
 * missed-revision gap does not apply. There is no lease/holder key, so no CAS
 * stale-holder reclaim is needed.
 */
export interface TaskDedup {
  /** Returns true if `correlationId` was ALREADY seen (duplicate), false if newly recorded. */
  seen(correlationId: string): Promise<boolean>
}

export const DEDUP_BUCKET = 'HANGAR_DEDUP'
const EMPTY = new Uint8Array()

/** KV keys allow `[-/_=.a-zA-Z0-9]`; map anything else to `_` so an odd correlation id can't break the key. */
export function dedupKey(selfHandle: string, correlationId: string): string {
  const safeId = correlationId.replace(/[^-/_=.a-zA-Z0-9]/g, '_')
  return `${selfHandle}.${safeId}`
}

/**
 * A KV `create` rejects when the key already exists. In nats.js v3 that surfaces as a
 * JetStream API error for the underlying expected-last-subject-sequence=0 precondition
 * ("wrong last sequence"), or a KeyExists-flavoured error. Match those signatures ONLY;
 * any other rejection is a real infra error and MUST propagate (never swallowed as dup).
 */
export function isAlreadyExists(err: unknown): boolean {
  // Verified live (nats-server 2.14.3, nats.js v3): kv.create on an existing key rejects
  // with a JetStreamApiError { code: 10071, message: "wrong last sequence: N" } — the
  // expected-last-subject-sequence=0 precondition failing because the key already exists.
  const e = err as { code?: unknown; api_error?: { err_code?: number } }
  if (e?.code === 10071 || e?.api_error?.err_code === 10071) return true
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return (
    msg.includes('wrong last sequence') ||
    msg.includes('key exists') ||
    msg.includes('already exists')
  )
}

export interface KvLike {
  create(key: string, value: Uint8Array): Promise<number>
}
export interface KvmLike {
  open(bucket: string): Promise<KvLike>
}

/** Injectable factory seam so unit tests can supply a fake Kvm without a live server. */
export async function openTaskDedup(
  nc: NatsConnection,
  selfHandle: string,
  opts: { bucket?: string; kvm?: KvmLike } = {},
): Promise<TaskDedup> {
  const bucket = opts.bucket ?? DEDUP_BUCKET
  // Bound the JetStream API timeout so opening a MISSING/ungranted bucket fails fast
  // (~1s) instead of hanging on the default multi-second deadline and leaving a
  // dangling promise. Dedup is best-effort infra; a slow open must not stall startup.
  const kvm = opts.kvm ?? (new Kvm(jetstream(nc, { timeout: 1000 })) as unknown as KvmLike)
  const kv = await kvm.open(bucket)
  return {
    async seen(correlationId: string): Promise<boolean> {
      const key = dedupKey(selfHandle, correlationId)
      try {
        await kv.create(key, EMPTY)
        return false // newly created ⇒ first sighting
      } catch (err) {
        if (isAlreadyExists(err)) return true // key present ⇒ duplicate
        throw err // real infra error ⇒ propagate (caller must NOT silently drop the task)
      }
    },
  }
}

/** The dedup identity of a task envelope: its correlation id if present, else its message id. */
export function correlationIdOf(meta: Record<string, string> | undefined, envelopeId: string): string {
  return meta?.correlation_id ?? envelopeId
}
