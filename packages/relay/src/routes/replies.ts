import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  HANGAR_TEAM_ID,
  EPHEMERAL_ROUTE_TTL_MS,
  MAX_CONTENT_BYTES,
  MetaSchema,
  RESERVED_META_KEYS,
  RESERVED_CLI_INSTANCE,
  REPLY_ERROR_HTTP_STATUS, REPLY_ERROR_RETRYABLE,
  EnvelopeSchema, PROTOCOL_VERSION,
  newMessageId, newInstanceId, isValidMessageId,
  type ReplyErrorCode, type Envelope,
} from '@hangar-bridge/shared'
import { bearerAuth, type AuthContext } from '../auth/middleware.ts'
import { rateLimit } from '../middleware/rate-limit.ts'
import { parseInstanceHeader } from '../presence/label.ts'
import type { Deps } from '../deps.ts'
import type { Db } from '../db/db.ts'
import type { ReplyRoute, ReplyRouteInput, ReplyGrantInput } from '../messages/store.ts'
import { ReplyLimiter } from '../reply-limiter.ts'
import { parseReturnSelectorHeader, grantsFromSnapshot, durableReport } from './messages.ts'

// ---------------------------------------------------------------------
// RFC 8785 (JCS) canonical JSON — small and local (no new dependency).
// Only the shapes this route actually produces need to round-trip: strings,
// plain objects (string -> string), and the `undefined` omission JSON.stringify
// already does. Sorted keys + no whitespace is the load-bearing property; leaf
// string encoding is delegated to JSON.stringify, which already matches JCS's
// escaping rules for the ASCII/control-character set this route ever sees.
// ---------------------------------------------------------------------
export function canonicalJson(value: unknown): string {
  if (value === undefined) throw new Error('canonicalJson: top-level undefined')
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number')
    return String(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort()
    const parts = keys.map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    return `{${parts.join(',')}}`
  }
  throw new Error(`canonicalJson: unsupported value type ${typeof value}`)
}

function lenPrefix(s: string): Buffer {
  const bytes = Buffer.from(s, 'utf8')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(bytes.length, 0)
  return Buffer.concat([len, bytes])
}

/** §3.1: `key_hash = sha256(lenprefix(team_id) ‖ lenprefix(handle) ‖ lenprefix(key))`. */
export function computeIdemKeyHash(team_id: string, handle: string, key: string): Buffer {
  return createHash('sha256')
    .update(Buffer.concat([lenPrefix(team_id), lenPrefix(handle), lenPrefix(key)]))
    .digest()
}

/** §3.1: `request_digest = sha256(JCS({in_reply_to, content, meta}))`. */
export function computeRequestDigest(payload: { in_reply_to: string; content: string; meta: Record<string, string> }): Buffer {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest()
}

const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9_-]{1,64}$/
const STALE_PENDING_MS = 60_000

/**
 * Poll cadence for a `pending` idempotency row (§5.1 step 1: "poll every
 * 250 ms up to 10 s"). Exported as a mutable config object (not a constant)
 * so integration tests can shrink it to a few ms — a real 10 s wait per test
 * would be untenable, and there is no other allowed path (deps.ts is out of
 * scope for this deliverable) to inject it.
 */
export const idemPollConfig = { intervalMs: 250, timeoutMs: 10_000 }

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

interface IdemRow {
  key_hash: Buffer
  request_digest: Buffer
  state: 'pending' | 'committed' | 'final' | 'error'
  lease: string
  reserved_at: string
  result_status: number | null
  result_json: string | null
  error_until: string | null
}

function getIdemRow(db: Db, keyHash: Buffer): IdemRow | undefined {
  return db.prepare('SELECT * FROM reply_idem WHERE key_hash=?').get(keyHash) as IdemRow | undefined
}

/** One fenced write: only applies if `lease` still matches. Returns rows changed (0 or 1). */
function fencedIdemUpdate(
  db: Db, keyHash: Buffer, lease: string,
  fields: { state: 'committed' | 'final' | 'error'; result_status: number; result_json: string; error_until: string | null }
): number {
  const info = db.prepare(`
    UPDATE reply_idem SET state=?, result_status=?, result_json=?, error_until=?
    WHERE key_hash=? AND lease=?
  `).run(fields.state, fields.result_status, fields.result_json, fields.error_until, keyHash, lease)
  return info.changes
}

type ReserveOutcome =
  | { kind: 'proceed'; lease: string }
  | { kind: 'mismatch' }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'timeout' }

/**
 * §5.1 step 1 reserve/poll/takeover state machine. Synchronous DB work is
 * plain better-sqlite3 calls (each already atomic); the only asynchronous
 * part is the bounded poll loop for a live `pending` row held by someone else.
 */
async function reserveIdemKey(deps: Deps, keyHash: Buffer, requestDigest: Buffer): Promise<ReserveOutcome> {
  const insertPending = (lease: string, nowIso: string): boolean => {
    const info = deps.db.prepare(`
      INSERT INTO reply_idem(key_hash, request_digest, state, lease, reserved_at)
      VALUES (?, ?, 'pending', ?, ?)
      ON CONFLICT(key_hash) DO NOTHING
    `).run(keyHash, requestDigest, lease, nowIso)
    return info.changes === 1
  }

  const firstLease = newInstanceId()
  if (insertPending(firstLease, deps.now().toISOString())) return { kind: 'proceed', lease: firstLease }

  const deadline = Date.now() + idemPollConfig.timeoutMs
  for (;;) {
    const row = getIdemRow(deps.db, keyHash)
    if (!row) {
      // Row vanished between our failed insert and this read — reply_idem
      // rows are never deleted, so treat this as a fresh slot.
      const lease = newInstanceId()
      if (insertPending(lease, deps.now().toISOString())) return { kind: 'proceed', lease }
      continue
    }
    if (!row.request_digest.equals(requestDigest)) return { kind: 'mismatch' }

    if (row.state === 'committed' || row.state === 'final') {
      const body = JSON.parse(row.result_json!) as Record<string, unknown>
      if (row.state === 'committed') body['fanout'] = 'unknown'
      return { kind: 'replay', status: row.result_status ?? 200, body }
    }

    if (row.state === 'error') {
      const nowIso = deps.now().toISOString()
      const reExecutable = row.error_until != null && row.error_until <= nowIso
      if (!reExecutable) {
        return { kind: 'replay', status: row.result_status ?? 500, body: JSON.parse(row.result_json!) }
      }
      const newLease = newInstanceId()
      const took = deps.db.prepare(`
        UPDATE reply_idem SET state='pending', lease=?, reserved_at=?,
          result_status=NULL, result_json=NULL, error_until=NULL
        WHERE key_hash=? AND lease=? AND state='error'
      `).run(newLease, nowIso, keyHash, row.lease)
      if (took.changes === 1) return { kind: 'proceed', lease: newLease }
      continue // someone else took it over first; re-read
    }

    // state === 'pending'
    const isStale = deps.now().getTime() - new Date(row.reserved_at).getTime() > STALE_PENDING_MS
    if (isStale) {
      const newLease = newInstanceId()
      const took = deps.db.prepare(`
        UPDATE reply_idem SET lease=?, reserved_at=? WHERE key_hash=? AND lease=? AND state='pending'
      `).run(newLease, deps.now().toISOString(), keyHash, row.lease)
      if (took.changes === 1) return { kind: 'proceed', lease: newLease }
      continue // lost the takeover race; re-read
    }
    if (Date.now() >= deadline) return { kind: 'timeout' }
    await sleep(idemPollConfig.intervalMs)
  }
}

// ---------------------------------------------------------------------
// Body shape (§5.1): strictly { in_reply_to, content, meta? } — no to,
// to_filter, fleet_wide, all_sessions, subject.
// ---------------------------------------------------------------------
const ReplyBodySchema = z.object({
  in_reply_to: z.string().refine(isValidMessageId, 'must be a valid message id'),
  content: z.string().refine(
    s => Buffer.byteLength(s, 'utf8') <= MAX_CONTENT_BYTES,
    { message: `content exceeds ${MAX_CONTENT_BYTES} bytes` }
  ),
  meta: MetaSchema.optional(),
}).strict()

const META_STRIP_KEYS = ['local_target', 'instance', 'sender_instance', 'session_id', 'attribution_status', 'ephemeral'] as const

function sanitizeReplyMeta(raw: Record<string, string> | undefined): Record<string, string> {
  const meta = { ...(raw ?? {}) }
  for (const k of META_STRIP_KEYS) delete meta[k]
  for (const k of RESERVED_META_KEYS) delete meta[k]
  return meta
}

function errorBody(
  code: ReplyErrorCode, message: string,
  opts: { retryWithNewKey?: boolean; detail?: Record<string, unknown> } = {}
): { error: string; message: string; retryable: boolean; retry_with_new_key?: true } & Record<string, unknown> {
  return {
    error: code, message, retryable: REPLY_ERROR_RETRYABLE[code],
    ...(opts.retryWithNewKey ? { retry_with_new_key: true as const } : {}),
    ...(opts.detail ?? {}),
  }
}

/**
 * Every status this route returns is spec-fixed (§13), but several are
 * looked up dynamically from `REPLY_ERROR_HTTP_STATUS` or replayed from a
 * stored `result_status` column (both typed `number`) — Hono's `c.json`
 * wants a literal `ContentfulStatusCode`. This cast is the one place that
 * bridges the two; every call site still passes a value that traces back
 * to the same table.
 */
function asStatus(n: number): ContentfulStatusCode {
  return n as ContentfulStatusCode
}

function replyInProgress(c: Context) {
  return c.json(errorBody('reply_in_progress', 'another request holds this idempotency key, or this worker lost its lease'), 409)
}

/** §5.1 step 2: route lookup by id, then by correlation_id alias; expired ⇒ not found. */
function resolveParentRoute(deps: Deps, id: string, nowIso: string): ReplyRoute | null {
  const route = deps.store.getRoute(id) ?? deps.store.getRouteByCorrelation(id)
  if (!route) return null
  if (route.expires_at != null && route.expires_at < nowIso) return null
  return route
}

function isHandleUsable(db: Db, team_id: string, handle: string): boolean {
  const row = db.prepare('SELECT disabled_at FROM human WHERE team_id=? AND handle=?').get(team_id, handle) as
    { disabled_at: string | null } | undefined
  return row !== undefined && row.disabled_at === null
}

/** §5.4: everything that makes a route's original sender unreachable. */
function isRouteAddressable(deps: Deps, route: ReplyRoute): boolean {
  if (route.unaddressable_at != null) return false
  if (route.sender_instance == null) return false
  if (route.return_selector === '~none') return false
  if (!isHandleUsable(deps.db, HANGAR_TEAM_ID, route.from_handle)) return false
  return true
}

type AudienceResult = 'ok' | 'not_a_recipient' | 'legacy_unreplyable'

/** §5.2 audience check, with §5.3 legacy-width applied verbatim when set. */
function checkAudience(
  deps: Deps, route: ReplyRoute, handle: string, instance: string | undefined, selector: string | null
): AudienceResult {
  if (route.legacy_width != null) {
    if (route.legacy_width === 'handle') {
      return handle === route.to_handle ? 'ok' : 'not_a_recipient'
    }
    if (route.legacy_width === 'team-not-sender') {
      return handle !== route.from_handle ? 'ok' : 'not_a_recipient'
    }
    if (route.legacy_width === 'unreplyable') {
      return 'legacy_unreplyable'
    }
    if (route.legacy_width.startsWith('repo:')) {
      if (instance === undefined) return 'not_a_recipient'
      const repoName = route.legacy_width.slice('repo:'.length)
      const snap = deps.presence.get(HANGAR_TEAM_ID, handle)
      const session = snap?.sessions.find(s => s.instance === instance)
      const matches = session != null && (session.repo === repoName || (session.repos?.includes(repoName) ?? false))
      return matches ? 'ok' : 'not_a_recipient'
    }
    return 'not_a_recipient' // unknown width, fail closed
  }
  if (instance === undefined) return 'not_a_recipient'
  if (deps.store.hasGrant(route.msg_id, handle, instance, '')) return 'ok'
  if (selector != null && selector !== '' && selector !== '~none' && deps.store.hasGrant(route.msg_id, handle, instance, selector)) {
    return 'ok'
  }
  return 'not_a_recipient'
}

/** `x-hangar-instance` on `/v1/replies` additionally accepts the literal `~cli` (§6.5). */
function parseReplyInstanceHeader(raw: string | null | undefined): { ok: true; instance: string | undefined } | { ok: false } {
  if (raw === RESERVED_CLI_INSTANCE) return { ok: true, instance: RESERVED_CLI_INSTANCE }
  return parseInstanceHeader(raw)
}

function audienceReport(matched: Array<{ handle: string; instance?: string | undefined }>, durable: string[]) {
  return {
    live: matched.map(m => `${m.handle}#${m.instance ?? ''}`),
    durable,
    matched: matched.length,
  }
}

class FencedOutError extends Error {}

export function repliesRoute(deps: Deps) {
  const app = new Hono<{ Variables: AuthContext }>()
  app.use('*', bearerAuth(deps.db))
  app.use('*', rateLimit({ windowMs: 60_000, max: 120, key: c => `replies:${c.get('token').id}` }))
  const limiter = new ReplyLimiter(deps.db)

  app.post('/', async c => {
    const peer = c.get('peer')

    const idemKeyRaw = c.req.header('idempotency-key')
    if (idemKeyRaw === undefined) {
      return c.json(errorBody('idempotency_key_required', 'the Idempotency-Key header is required on /v1/replies'), asStatus(REPLY_ERROR_HTTP_STATUS.idempotency_key_required!))
    }
    if (!IDEMPOTENCY_KEY_REGEX.test(idemKeyRaw)) {
      return c.json(errorBody('idempotency_key_invalid', 'Idempotency-Key must be 1-64 chars of [A-Za-z0-9_-]'), asStatus(REPLY_ERROR_HTTP_STATUS.idempotency_key_invalid!))
    }

    const parsedInstance = parseReplyInstanceHeader(c.req.header('x-hangar-instance'))
    if (!parsedInstance.ok) return c.json({ error: 'invalid_instance_header' }, 400)
    const declaredInstance = parsedInstance.instance

    const returnSelectorParse = parseReturnSelectorHeader(c.req.header('x-hangar-return-selector'))
    if (!returnSelectorParse.ok) {
      return c.json({
        error: 'invalid_return_selector',
        message: "x-hangar-return-selector must be '<name>@<ULID>' or the literal '~none'",
        retryable: false,
      }, 400)
    }
    const declaredSelector = returnSelectorParse.value

    const raw = await c.req.json().catch(() => null)
    const parsed = ReplyBodySchema.safeParse(raw)
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400)
    }
    const data = parsed.data
    const rawMeta = (data.meta ?? {}) as Record<string, string>

    const keyHash = computeIdemKeyHash(HANGAR_TEAM_ID, peer.handle, idemKeyRaw)
    const requestDigest = computeRequestDigest({ in_reply_to: data.in_reply_to, content: data.content, meta: rawMeta })

    const reserve = await reserveIdemKey(deps, keyHash, requestDigest)
    if (reserve.kind === 'mismatch') {
      return c.json(
        errorBody('idempotency_mismatch', 'the same Idempotency-Key was used with a different request', { retryWithNewKey: true }),
        asStatus(REPLY_ERROR_HTTP_STATUS.idempotency_mismatch!)
      )
    }
    if (reserve.kind === 'timeout') return replyInProgress(c)
    if (reserve.kind === 'replay') return c.json(reserve.body, asStatus(reserve.status))
    const myLease = reserve.lease

    /** §5.1 steps 2-4/5 refusal: write reply_idem -> error under the fence (with an optional atomic tombstone), respond. */
    function writeRefusal(
      code: ReplyErrorCode, status: number, message: string, tombstoneMsgId?: string
    ): Response {
      const body = errorBody(code, message, { retryWithNewKey: true })
      const json = JSON.stringify(body)
      if (tombstoneMsgId === undefined) {
        const changes = fencedIdemUpdate(deps.db, keyHash, myLease, { state: 'error', result_status: status, result_json: json, error_until: null })
        if (changes === 0) return replyInProgress(c)
        return c.json(body, asStatus(status))
      }
      let fenced = false
      deps.db.transaction((): void => {
        const changes = fencedIdemUpdate(deps.db, keyHash, myLease, { state: 'error', result_status: status, result_json: json, error_until: null })
        if (changes === 0) { fenced = true; return }
        deps.db.prepare('UPDATE reply_route SET unaddressable_at=? WHERE msg_id=? AND unaddressable_at IS NULL')
          .run(deps.now().toISOString(), tombstoneMsgId)
      })()
      if (fenced) return replyInProgress(c)
      return c.json(body, asStatus(status))
    }

    const nowIso = deps.now().toISOString()
    const route = resolveParentRoute(deps, data.in_reply_to, nowIso)
    if (!route) {
      return writeRefusal('unknown_parent', REPLY_ERROR_HTTP_STATUS.unknown_parent!, 'no route for in_reply_to (never existed, expired, or a zero-match dispatch)')
    }

    const audience = checkAudience(deps, route, peer.handle, declaredInstance, declaredSelector)
    if (audience === 'not_a_recipient') {
      return writeRefusal('not_a_recipient', REPLY_ERROR_HTTP_STATUS.not_a_recipient!, 'you are not in this route\'s grants')
    }
    if (audience === 'legacy_unreplyable') {
      return writeRefusal('legacy_unreplyable', REPLY_ERROR_HTTP_STATUS.legacy_unreplyable!, 'this backfilled row carried a to_filter and cannot be replied to')
    }

    if (!isRouteAddressable(deps, route)) {
      return writeRefusal(
        'parent_unaddressable', REPLY_ERROR_HTTP_STATUS.parent_unaddressable!,
        'the parent has no sender_instance, return_selector is ~none, or from_handle is disabled/removed',
        route.msg_id
      )
    }

    const legacyParent = route.legacy_width != null
    const replyId = newMessageId()
    const meta = sanitizeReplyMeta(rawMeta)
    if (declaredInstance !== undefined) meta['sender_instance'] = declaredInstance

    if (route.sender_instance === RESERVED_CLI_INSTANCE) {
      // ── mailbox branch (§5.1 step 6, §8.2) ──────────────────────────
      const envelope: Envelope = EnvelopeSchema.parse({
        id: replyId, v: PROTOCOL_VERSION, team: HANGAR_TEAM_ID,
        from: peer.handle, to: `@mailbox:${route.from_handle}`, subject: null,
        in_reply_to: route.msg_id, thread_root: route.thread_root,
        kind: 'chat', content: data.content, meta,
        to_filter: null, sent_at: nowIso, delivered_at: null,
      })
      const newRoute: ReplyRouteInput = {
        msg_id: replyId, team_id: HANGAR_TEAM_ID, from_handle: peer.handle,
        sender_instance: declaredInstance ?? null, return_selector: declaredSelector,
        to_handle: envelope.to, to_filter_json: null,
        thread_root: route.thread_root, correlation_id: null,
        created_at: nowIso, expires_at: null,
      }
      const grants: ReplyGrantInput[] = [{ handle: route.from_handle, instance: RESERVED_CLI_INSTANCE, selector: '' }]
      const durable = [`${route.from_handle}${RESERVED_CLI_INSTANCE}`]
      const report = { ...audienceReport([], durable), ...(legacyParent ? { legacy_parent: true as const } : {}) }
      // Stored + returned body includes the envelope: a replayed idempotent
      // response must be byte-identical to the original, not just the report.
      const body = { ...envelope, ...report }
      const json = JSON.stringify(body)

      let outcome: 'ok' | 'storm' | 'fenced'
      let stormBody: ReturnType<typeof errorBody> | null = null
      try {
        outcome = deps.db.transaction((): 'ok' | 'storm' => {
          const acquire = limiter.tryAcquire(route.thread_root, peer.handle, deps.now().getTime())
          if (!acquire.ok) {
            stormBody = errorBody('reply_storm', 'reply limit reached for this thread', {
              retryWithNewKey: true, detail: { retry_after_s: acquire.retry_after_s },
            })
            const errorUntil = new Date(deps.now().getTime() + acquire.retry_after_s * 1000).toISOString()
            const changes = fencedIdemUpdate(deps.db, keyHash, myLease, {
              state: 'error', result_status: REPLY_ERROR_HTTP_STATUS.reply_storm!,
              result_json: JSON.stringify(stormBody), error_until: errorUntil,
            })
            if (changes === 0) throw new FencedOutError()
            return 'storm'
          }
          const committedChanges = fencedIdemUpdate(deps.db, keyHash, myLease, { state: 'committed', result_status: 200, result_json: json, error_until: null })
          if (committedChanges === 0) throw new FencedOutError()
          deps.store.insertRoute(newRoute)
          deps.store.insertGrants(newRoute.msg_id, grants)
          deps.store.persist(envelope, null)
          fencedIdemUpdate(deps.db, keyHash, myLease, { state: 'final', result_status: 200, result_json: json, error_until: null })
          return 'ok'
        })()
      } catch (err) {
        if (err instanceof FencedOutError) return replyInProgress(c)
        throw err
      }
      if (outcome === 'storm') return c.json(stormBody, asStatus(REPLY_ERROR_HTTP_STATUS.reply_storm!))
      return c.json(body, 200)
    }

    // ── session branch (§5.1 step 6, the normal case) ────────────────
    if (route.return_selector) meta['local_target'] = route.return_selector
    const envelope: Envelope = EnvelopeSchema.parse({
      id: replyId, v: PROTOCOL_VERSION, team: HANGAR_TEAM_ID,
      from: peer.handle, to: route.from_handle, subject: null,
      in_reply_to: route.msg_id, thread_root: route.thread_root,
      kind: 'chat', content: data.content, meta,
      to_filter: { instance: route.sender_instance! },
      sent_at: nowIso, delivered_at: null,
    })
    const snap = deps.fanout.snapshotDetailed(envelope)
    const grants = grantsFromSnapshot(snap)
    const newRoute: ReplyRouteInput = {
      msg_id: replyId, team_id: HANGAR_TEAM_ID, from_handle: peer.handle,
      sender_instance: declaredInstance ?? null, return_selector: declaredSelector,
      to_handle: envelope.to, to_filter_json: envelope.to_filter ? JSON.stringify(envelope.to_filter) : null,
      thread_root: route.thread_root, correlation_id: null,
      created_at: nowIso, expires_at: new Date(deps.now().getTime() + EPHEMERAL_ROUTE_TTL_MS).toISOString(),
    }
    const durable = durableReport(envelope, false, undefined)
    // Stored + returned body includes the envelope: a replayed idempotent
    // response must be byte-identical to the original, not just the report.
    const committedBody = {
      ...envelope,
      ...audienceReport(snap.matched, durable),
      sender_state: snap.matched.length > 0 ? 'live' as const : 'offline' as const,
      ...(legacyParent ? { legacy_parent: true as const } : {}),
    }

    let txOutcome: 'ok' | 'storm'
    let stormBody: ReturnType<typeof errorBody> | null = null
    try {
      txOutcome = deps.db.transaction((): 'ok' | 'storm' => {
        const acquire = limiter.tryAcquire(route.thread_root, peer.handle, deps.now().getTime())
        if (!acquire.ok) {
          stormBody = errorBody('reply_storm', 'reply limit reached for this thread', {
            retryWithNewKey: true, detail: { retry_after_s: acquire.retry_after_s },
          })
          const errorUntil = new Date(deps.now().getTime() + acquire.retry_after_s * 1000).toISOString()
          const changes = fencedIdemUpdate(deps.db, keyHash, myLease, {
            state: 'error', result_status: REPLY_ERROR_HTTP_STATUS.reply_storm!,
            result_json: JSON.stringify(stormBody), error_until: errorUntil,
          })
          if (changes === 0) throw new FencedOutError()
          return 'storm'
        }
        const changes = fencedIdemUpdate(deps.db, keyHash, myLease, {
          state: 'committed', result_status: 200, result_json: JSON.stringify(committedBody), error_until: null,
        })
        if (changes === 0) throw new FencedOutError()
        deps.store.insertRoute(newRoute)
        deps.store.insertGrants(newRoute.msg_id, grants)
        return 'ok'
      })()
    } catch (err) {
      if (err instanceof FencedOutError) return replyInProgress(c)
      throw err
    }
    if (txOutcome === 'storm') return c.json(stormBody, asStatus(REPLY_ERROR_HTTP_STATUS.reply_storm!))

    const delivery = deps.fanout.deliverDetailed(envelope, snap)
    const finalBody = {
      ...envelope,
      ...audienceReport(delivery.matched, durable),
      sender_state: delivery.matched.length > 0 ? 'live' as const : 'offline' as const,
      ...(legacyParent ? { legacy_parent: true as const } : {}),
    }
    // Best-effort: a fence loss here (vanishingly unlikely — same lease,
    // no other writer could have taken over mid-transaction-to-here) leaves
    // the row at `committed`, which §5.1 calls "the honest state".
    fencedIdemUpdate(deps.db, keyHash, myLease, { state: 'final', result_status: 200, result_json: JSON.stringify(finalBody), error_until: null })
    return c.json(finalBody, 200)
  })

  return app
}
