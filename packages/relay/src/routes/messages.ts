import { Hono } from 'hono'
import {
  HANGAR_TEAM_ID,
  OutboundMessageSchema,
  RESERVED_META_KEYS,
  newMessageId,
  TEAM_BROADCAST_HANDLE,
  EPHEMERAL_ROUTE_TTL_MS,
  type Envelope,
} from '@hangar-bridge/shared'
import { loadOwnedSet, ownsNamespace } from '../acl.ts'
import { isValidMessageId, isValidInstanceId } from '@hangar-bridge/shared'
import { bearerAuth, type AuthContext } from '../auth/middleware.ts'
import { hashToken } from '../auth/hash.ts'
import { rateLimit } from '../middleware/rate-limit.ts'
import { parseInstanceHeader } from '../presence/label.ts'
import type { Deps } from '../deps.ts'
import type { ReplyRouteInput, ReplyGrantInput } from '../messages/store.ts'
import type { SnapshotDetail } from '../fanout.ts'

/** chat, task_dispatch — the only kinds §3.1/§3.2 give a reply_route. */
function isUserAuthoredKind(kind: Envelope['kind']): kind is 'chat' | 'task_dispatch' {
  return kind === 'chat' || kind === 'task_dispatch'
}

/**
 * One grant per snapshot entry that actually carries an instance (§3.2 step
 * 3 / §4). A legacy match (no instance — the subscriber predates
 * x-hangar-instance) cannot be granted: `reply_grant.instance` is NOT NULL,
 * and there is no address to positively route a reply to anyway.
 */
function grantsFromSnapshot(snap: SnapshotDetail): ReplyGrantInput[] {
  return snap.matched
    .filter((m): m is { handle: string; instance: string } => m.instance !== undefined)
    .map(m => ({ handle: m.handle, instance: m.instance, selector: '' }))
}

const DEFAULT_INBOX_LIMIT = 100
const MAX_INBOX_LIMIT = 1000

// §8.1 return-selector grammar: `<name>@<ULID>` or the literal `~none`.
const RETURN_SELECTOR_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export type ReturnSelectorParse = { ok: true; value: string | null } | { ok: false }

/**
 * Parse + syntax-check `x-hangar-return-selector` (§8.1): grammar
 * `<name>@<ULID>` (a courier's pasted-into pane) or the literal `~none`.
 * Absent/empty -> ok, null (no selector — the overwhelming common case: an
 * ordinary bridge session or a `~cli` caller). Malformed -> ok:false, which
 * the caller maps to 400 `invalid_return_selector` (not in the §13 table,
 * so it reuses the §13 response shape rather than a §13 code).
 */
export function parseReturnSelectorHeader(raw: string | null | undefined): ReturnSelectorParse {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null }
  if (raw === '~none') return { ok: true, value: raw }
  const at = raw.indexOf('@')
  if (at <= 0) return { ok: false }
  const name = raw.slice(0, at)
  const ulid = raw.slice(at + 1)
  if (!RETURN_SELECTOR_NAME_REGEX.test(name)) return { ok: false }
  if (!isValidInstanceId(ulid)) return { ok: false }
  return { ok: true, value: raw }
}

export function messagesRoute(deps: Deps) {
  const app = new Hono<{ Variables: AuthContext }>()
  app.use('*', bearerAuth(deps.db))
  app.use('*', rateLimit({ windowMs: 60_000, max: 120, key: c => `msg:${c.get('token').id}` }))

  /**
   * Durable inbox PEEK (poll_inbox, P2 §2.4). The pull mainline for harnesses
   * that render no server notifications, and for a Claude turn that is busy.
   *
   * Read-only by contract: it never stamps delivered_at. Same fail-closed
   * subject gate as the SSE stream, so a peek can never leak a namespace the
   * caller does not own.
   */
  app.get('/', c => {
    const since = c.req.query('since')
    if (since !== undefined && !isValidMessageId(since)) {
      return c.json({ error: 'invalid_since' }, 400)
    }
    const rawLimit = c.req.query('limit')
    let limit = DEFAULT_INBOX_LIMIT
    if (rawLimit !== undefined) {
      if (!/^[0-9]+$/.test(rawLimit)) return c.json({ error: 'invalid_limit' }, 400)
      limit = Number(rawLimit)
      if (limit < 1 || limit > MAX_INBOX_LIMIT) return c.json({ error: 'invalid_limit' }, 400)
    }

    // §4/item 7: the poller's declared instance is what this peek's grant
    // (below) and the D2 self-exclusion in fetchInboxSince key on.
    const parsedInstance = parseInstanceHeader(c.req.header('x-hangar-instance'))
    if (!parsedInstance.ok) return c.json({ error: 'invalid_instance_header' }, 400)
    const pollerInstance = parsedInstance.instance
    if (pollerInstance === undefined && (deps.addressRules ?? 'off') === 'on') {
      return c.json({
        error: 'instance_required',
        message: 'a poll without x-hangar-instance cannot be granted and cannot be answered',
        retryable: false,
      }, 400)
    }

    const handle = c.get('peer').handle
    const owned = loadOwnedSet(deps.db, HANGAR_TEAM_ID, handle)
    const rows = deps.store.fetchInboxSince(HANGAR_TEAM_ID, handle, since ?? '', limit, pollerInstance)
    const messages = rows.filter(e => e.subject === null || ownsNamespace(e.subject, owned))
    if (pollerInstance !== undefined) {
      // §4: grant BEFORE responding — same invariant as every other
      // presentation path. Idempotent; a route may be missing for a pre-v8
      // backfill-skipped row, tolerated (present it, no grant) not thrown.
      for (const m of messages) {
        if (deps.store.getRoute(m.id) !== null) {
          deps.store.insertGrants(m.id, [{ handle, instance: pollerInstance, selector: '' }])
        }
      }
    }
    // The cursor advances over EVERY row read, not only the deliverable ones, so
    // a page full of gated rows can never wedge the caller below the live edge.
    const next_cursor = rows.length > 0 ? rows[rows.length - 1]!.id : (since ?? null)
    // Flag off + no instance: this poll's OWN inability to grant is reported
    // at the RESPONSE level, not stamped onto each envelope's meta —
    // `meta.attribution_status` is the SENDER-stamped field (set only via
    // x-hangar-attribution: v1 on the original send) and a poll must never
    // overwrite it; the two describe different things (who sent it vs.
    // whether THIS presentation could be granted).
    return c.json({
      messages, next_cursor,
      ...(pollerInstance === undefined ? { attribution_status: 'unverifiable' } : {}),
    })
  })

  app.post('/', async c => {
    const idemKey = c.req.header('idempotency-key')
    const tokenId = c.get('token').id
    if (idemKey) {
      const row = deps.db.prepare(
        "SELECT response_json FROM idempotency_key WHERE key_hash=? AND token_id=?"
      ).get(hashToken(`${tokenId}:${idemKey}`), tokenId) as { response_json: string } | undefined
      if (row) return c.body(row.response_json, 201, { 'content-type': 'application/json' })
    }

    const raw = await c.req.json().catch(() => null)
    const parsed = OutboundMessageSchema.safeParse(raw)
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400)
    }
    const data = parsed.data
    const peer = c.get('peer')

    // B1: strip reserved meta keys (subject, kind) so a sender can NEVER forge a
    // relay signal into a channel notification. The only subject a receiver sees is
    // the relay-stamped envelope field (surfaced as `gated_subject`), never sender
    // meta. (task_kind is intentionally NOT reserved — a benign display label.)
    if (data.meta) {
      for (const k of RESERVED_META_KEYS) delete (data.meta as Record<string, string>)[k]
    }

    // P4'a attribution. The 8/22 incident was a thread of mutually-denying messages
    // behind one handle: every "that wasn't me" was sincere, but nobody could tell
    // WHICH session spoke. These keys are stamped here from request headers instead
    // of sender-declared message meta, and client-supplied values are dropped first —
    // same chokepoint treatment as B1. A handle's bearer authenticates the HANDLE,
    // not an individual process: sibling processes sharing that bearer are mutually
    // trusted for the instance header. `instance` identifies the sending PROCESS;
    // fanout uses it for negative self-exclusion (keeping a direct message from
    // echoing back into the session that sent it) — that part is unchanged.
    // REPLY_ROUTING_SPEC.md §3.2/§10 additionally stamps the sender's instance and
    // return selector onto this send's `reply_route` row, and the grants recorded
    // from the delivery snapshot steer where an automatic reply/continuation lands:
    // that IS positive routing for replies, under same-bearer mutual trust; never
    // authorization — the grant check (§5.2/§7) keeps a different handle's bearer
    // out of a thread it was never a party to, but a same-handle sibling can already
    // subscribe or send under any of its own instance ids, so it can already steer
    // its own siblings' replies. Nothing here widens what a bearer can reach.
    // A peer's own Claude session id cannot be verified by the relay at all, so it may
    // only travel under a name that says so (`peer_session_claim`), never as `session_id`.
    const stampedInstance = parseInstanceHeader(c.req.header('x-hangar-instance'))
    if (!stampedInstance.ok) {
      return c.json({ error: 'invalid_instance_header' }, 400)
    }
    const attributionVersion = c.req.header('x-hangar-attribution')
    if (attributionVersion !== undefined && attributionVersion !== 'v1') {
      return c.json({ error: 'invalid_attribution_header' }, 400)
    }
    const meta = (data.meta ?? {}) as Record<string, string>
    delete meta['instance']
    delete meta['session_id']
    delete meta['sender_instance']
    delete meta['attribution_status']
    // `ephemeral` is a relay-only signal (directed-chat: "not persisted, reply via
    // correlation_id"). Strip any sender-supplied one so it cannot be forged; the
    // relay re-stamps it below for directed chat. Handled like instance (delete +
    // relay-set), NOT reserved — reserved keys are dropped from notifications, but
    // this one must reach the receiver.
    delete meta['ephemeral']
    if (stampedInstance.instance !== undefined) {
      meta['instance'] = stampedInstance.instance
      // fanout reads this to exclude the sending process (never to address one).
      meta['sender_instance'] = stampedInstance.instance
    }
    if (attributionVersion === 'v1') {
      meta['attribution_status'] = stampedInstance.instance === undefined
        ? 'unverifiable'
        : 'stamped'
    }
    if (Object.keys(meta).length > 0) data.meta = meta

    // §8.1 return-selector: parsed here (relay chokepoint) so it can be
    // stored verbatim on the route this send creates (item 2/4, below).
    const returnSelectorParse = parseReturnSelectorHeader(c.req.header('x-hangar-return-selector'))
    if (!returnSelectorParse.ok) {
      return c.json({
        error: 'invalid_return_selector',
        message: "x-hangar-return-selector must be '<name>@<ULID>' or the literal '~none'",
        retryable: false,
      }, 400)
    }
    const returnSelector = returnSelectorParse.value

    // §7 thread continuation (not a reply, NOT flag-controlled): `thread_root`
    // names a route the caller SENT or holds a GRANT on; on success the send
    // canonicalises to that route's effective root. This is the only
    // sanctioned path to a wider audience inside a thread.
    let continuationRoot: string | null = null
    if (data.thread_root !== undefined) {
      const resolved = resolveThreadContinuation(
        deps, data.thread_root, peer.handle, stampedInstance.instance, returnSelector
      )
      if (!resolved.ok) {
        return c.json({
          error: 'not_in_thread',
          message: 'thread_root names a route you neither sent nor were granted; '
            + 'it must be a message you sent or one you received',
          retryable: false,
        }, 403)
      }
      continuationRoot = resolved.canonicalRoot
    }

    // §6.1-6.3 address refusals, gated behind addressRules (default 'off' —
    // byte-identical to today until an operator opts in). reserved_address /
    // reserved_instance (§6.5) are NOT gated: they already 400 above, from
    // the shared OutboundMessageSchema/ToFilterSchema refinements (D1).
    if ((deps.addressRules ?? 'off') === 'on' && isUserAuthoredKind(data.kind)) {
      if (data.in_reply_to != null) {
        return c.json({
          error: 'use_reply_verb',
          message: "use `fleet reply <msg_id>`; to continue the thread for a different "
            + "audience send a new message with `thread_root`",
          retryable: false,
        }, 400)
      }
      if (stampedInstance.instance === undefined) {
        return c.json({ error: 'sender_instance_required', message: 'x-hangar-instance is required', retryable: false }, 400)
      }
      if (data.kind === 'chat' && data.to !== TEAM_BROADCAST_HANDLE && data.to_filter == null && data.all_sessions !== true) {
        const liveInstances = Array.from(deps.fanout.instanceCounts(HANGAR_TEAM_ID, data.to as string).keys())
          .filter(i => i !== '')
        return c.json({
          error: 'handle_needs_all_sessions',
          message: 'a bare-handle chat is durable and reaches every sibling that connects '
            + 'later; resend with all_sessions: true to acknowledge that',
          retryable: false,
          live_instances: liveInstances,
        }, 400)
      }
      if (data.kind === 'task_dispatch' && data.to_filter == null) {
        return c.json({
          error: 'dispatch_needs_instance',
          message: 'task_dispatch must target exactly one instance via to_filter.instance '
            + '(a host-wide command is not supported)',
          retryable: false,
        }, 400)
      }
    }

    // Fail-closed namespace ACL — gate on SUBJECT PRESENCE, not a kind allow-list.
    // A non-null subject is only meaningful on a command-carrying kind; a subjected
    // reactive/system kind (presence_update/permission_*/task_result) is rejected
    // outright, else a non-owner could smuggle a gated_subject via e.g. a subjected
    // presence_update and bypass the ownership check entirely.
    // #3: subject!=null ⇒ `to` is a concrete handle EXCEPT for a subjected @team `chat`
    // (subject-scoped coordination broadcast). The schema already rejects a subjected
    // @team of any non-chat kind (task_dispatch etc.) → 400 (R1: commands stay direct).
    if (data.subject != null) {
      if (data.kind !== 'chat' && data.kind !== 'task_dispatch') {
        return c.json({ error: 'invalid_message', message: 'subject_not_allowed_for_kind' }, 400)
      }
      const ownedPub = loadOwnedSet(deps.db, HANGAR_TEAM_ID, peer.handle)
      if (!ownsNamespace(data.subject, ownedPub)) {
        auditEvent(deps, peer.id, 'subject.publish_denied', { subject: data.subject, handle: peer.handle })
        return c.json({ error: 'forbidden_subject' }, 403)
      }
      // Recipient-ownership applies only to a DIRECT subjected message (one concrete
      // recipient). A subjected @team broadcast has no single recipient — each SSE
      // subscriber is independently gated by its own owned-set + interest in the stream
      // `deliverable` filter — so this check is skipped for @team (it would 409 anyway
      // since @team owns no namespace). Publisher-ownership above still fully gates who
      // may broadcast on the namespace.
      if (data.to !== TEAM_BROADCAST_HANDLE) {
        const ownedRcpt = loadOwnedSet(deps.db, HANGAR_TEAM_ID, data.to as string)
        if (!ownsNamespace(data.subject, ownedRcpt)) {
          auditEvent(deps, peer.id, 'subject.recipient_denied', { subject: data.subject, to: data.to as string })
          return c.json({ error: 'recipient_not_owner' }, 409)
        }
      }
    }

    // ── unqualified fleet-wide broadcast gate ───────────────────────────────
    // The relay is the only chokepoint every sender must pass: a source-side
    // guard has to be installed per host, per user, per harness, and the
    // harnesses that cannot load one (codex, grok) are exactly the ones nobody
    // can gate. Measured on 2026-08-31: of 91 broadcasts in 12 hours, a
    // client-side gate on one host stopped 26.
    //
    // `fleet_wide: true` is the act of will that says this really is for every
    // session on every host. It is advisory by construction — any client that
    // can set it can always set it — so enforcement is really the audit trail
    // plus the recipient count returned to the sender. That is the honest
    // ceiling for a fleet where every client holds an operator-issued token,
    // and building anything stronger would mean building an auth system.
    //
    // Restricted to chat: ask_team routes permission_request to @team
    // (approval-routing.ts), and blocking that would silently kill the
    // permission flow rather than reduce noise.
    //
    // Modes: 'warn' records and delivers (default, for a migration window where
    // senders still speak the old vocabulary); 'enforce' refuses with a message
    // that teaches the alternative — the clients here are models, so a 400
    // carrying the fix IS the migration mechanism.
    if (
      data.to === TEAM_BROADCAST_HANDLE
      && data.kind === 'chat'
      && data.subject == null
      && data.to_filter == null
      && data.fleet_wide !== true
    ) {
      auditEvent(deps, peer.id, 'message.unqualified_broadcast', {
        handle: peer.handle,
        mode: deps.broadcastGate ?? 'warn',
      })
      if ((deps.broadcastGate ?? 'warn') === 'enforce') {
        return c.json({
          error: 'unqualified_broadcast',
          message:
            'This would reach every session on every host, and most would read and answer it. '
            + 'Omit `to` to reach the sessions working on your project, name a handle for one host, '
            + 'or pass to_filter.instance for exactly one session. '
            + 'If it truly concerns the whole fleet, resend with fleet_wide: true.',
        }, 400)
      }
    }

    // ── to_filter routing (presence-narrowed, online-only) ──────────────────
    // Filtered delivery is relay-side: the stream `deliverable` gate lets ONLY
    // matching sessions receive it (non-matching connections get no event). By
    // kind: directed CHAT is never persisted (isolation — a stored row is
    // poll_inbox-visible to same-handle siblings; also matches online-only); a
    // directed task_dispatch{instance} persists ONLY when delivered (reply/
    // task_result chain), and matched=0 leaves NO row (no zombie redelivery /
    // double-exec). Response carries matched count + hit list.
    if (data.to_filter != null) {
      // A project-scoped broadcast is not a private message: @team + {repo} is a
      // half-public call to whoever is working on that project, so the isolation
      // argument that keeps directed chat ephemeral (a stored row is poll_inbox-
      // visible to same-handle siblings) does not apply — its poll exposure is
      // exactly today's @team, no worse. It must be durable for the opposite
      // reason: this is about to become the DEFAULT way to reach people, and a
      // default that silently drops anything not connected at that instant trades
      // a noise problem for a lost-mail problem. Durable also restores in_reply_to
      // for project threads and lets an offline member catch up on reconnect
      // (the SSE cold-start drain re-applies the same presence filter).
      const isProjectChat = data.to === TEAM_BROADCAST_HANDLE
        && data.kind === 'chat'
        && data.to_filter.repo !== undefined
        && data.to_filter.instance === undefined
      if (data.kind === 'chat' && !isProjectChat) {
        // Tell the receiver this message has no durable row → reply via
        // meta.correlation_id, not in_reply_to (which would 400 on unknown parent).
        // An ephemeral message has no durable row, so in_reply_to would 400 on an
        // unknown parent. The receiver needs SOMETHING to echo, and it cannot be a
        // sender-supplied correlation_id — those are stripped above as anti-forgery.
        // So the relay mints one here, authoritative by construction; without it the
        // documented reply path exists only in this comment and the channel is
        // one-way (reported first-hand by a peer that hit the 400).
        const m = (data.meta ??= {} as Record<string, string>)
        m['ephemeral'] = '1'
        m['correlation_id'] = newMessageId()
      }
      // Self-target: narrowing to one's own instance can only self-exclude → 0.
      // Report it explicitly instead of a silent matched:0 (§2.7c).
      const selfTargeted = data.to_filter.instance !== undefined
        && data.to === peer.handle
        && data.to_filter.instance === stampedInstance.instance
      let built: Envelope
      try {
        built = deps.store.buildEnvelope(HANGAR_TEAM_ID, peer.handle, data)
      } catch (err) {
        return c.json({ error: 'invalid_message', message: err instanceof Error ? err.message : '' }, 400)
      }
      // §7: a validated thread continuation overrides the wire envelope's
      // thread_root with the canonical root, same as a reply's already does.
      if (continuationRoot !== null) built = { ...built, thread_root: continuationRoot }

      // §3.2 write order: snapshot the live match BEFORE anything is
      // committed, so the transaction below (route + grants + message row)
      // binds to the exact set fanout will deliver to, and a session that
      // subscribes in between is not delivered to live (no grant — a durable
      // row grants it on drain instead, §4/item 7).
      const snap = deps.fanout.snapshotDetailed(built)
      const matched = snap.matched
      let deliveredAt: string | null = null
      // Only task_dispatch is persisted (with delivered_at stamped so it never
      // becomes a pending row); directed chat is delivered live and never stored.
      let persistMessage = false
      if (matched.length > 0) {
        deliveredAt = deps.now().toISOString()
        if (built.kind === 'task_dispatch') persistMessage = true
      }
      // Project chat persists whether or not anyone was connected — matched:0 is
      // precisely the case durability exists for, and it leaves a pending row the
      // drain delivers when a project member reconnects. Unlike task_dispatch a
      // stored chat cannot cause a double execution, so there is no zombie-replay
      // reason to withhold it.
      if (isProjectChat) persistMessage = true

      // §3.2/item 2: a directed task_dispatch matching nobody gets no route,
      // same as today's no-row rule. Directed chat always gets a route (even
      // 0 matches) since the relay already minted+advertised a
      // correlation_id above for the receiver to reply with.
      const getsRoute = built.kind === 'chat' || (built.kind === 'task_dispatch' && matched.length > 0)
      const route: ReplyRouteInput | null = getsRoute ? {
        msg_id: built.id, team_id: HANGAR_TEAM_ID, from_handle: peer.handle,
        sender_instance: stampedInstance.instance ?? null, return_selector: returnSelector,
        to_handle: built.to, to_filter_json: built.to_filter ? JSON.stringify(built.to_filter) : null,
        thread_root: continuationRoot ?? built.thread_root ?? built.id,
        correlation_id: built.meta['correlation_id'] ?? null,
        created_at: deps.now().toISOString(),
        expires_at: persistMessage ? null : new Date(deps.now().getTime() + EPHEMERAL_ROUTE_TTL_MS).toISOString(),
      } : null
      let routeInsertFailed = false
      try {
        deps.store.writeRouteAndMessage({
          route, grants: route ? grantsFromSnapshot(snap) : [], envelope: built, persistMessage, deliveredAt,
        })
      } catch {
        routeInsertFailed = true
      }
      if (routeInsertFailed) return c.json({ error: 'internal_error', message: 'route insert failed' }, 500)

      deps.fanout.deliverDetailed(built, snap)
      auditEvent(deps, peer.id, 'message.to_filter_routed', {
        kind: built.kind,
        to: built.to,
        matched: String(matched.length),
        persisted: String(built.kind === 'task_dispatch' && matched.length > 0),
      })
      const responseJson = JSON.stringify({
        ...built,
        delivered_at: deliveredAt,
        matched: matched.length,
        matched_sessions: matched,
        live: matched.map(m => `${m.handle}#${m.instance ?? ''}`),
        durable: durableReport(built, persistMessage, data.to_filter?.repo),
        ...(selfTargeted ? { note: 'self_target: to_filter.instance is your own session' } : {}),
      })
      if (idemKey) {
        deps.db.prepare(`
          INSERT OR IGNORE INTO idempotency_key(key_hash, token_id, response_json, created_at)
          VALUES (?, ?, ?, ?)
        `).run(hashToken(`${tokenId}:${idemKey}`), tokenId, responseJson, deps.now().toISOString())
      }
      return c.body(responseJson, 201, { 'content-type': 'application/json' })
    }

    // Layer 2 (sender-stamp anti-spoof): `from` is the bearer-authenticated
    // peer handle from middleware. Client-supplied `from` (if any) is ignored.
    let built: Envelope
    try {
      built = deps.store.buildEnvelope(HANGAR_TEAM_ID, peer.handle, data)
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      return c.json({ error: 'invalid_message', message }, 400)
    }
    // §7: a validated thread continuation overrides the wire envelope's
    // thread_root with the canonical root, same as a reply's already does.
    if (continuationRoot !== null) built = { ...built, thread_root: continuationRoot }

    // §3.2 write order: snapshot (read-only) BEFORE the transaction, then
    // deliver from that FROZEN snapshot (not a fresh live match) — see the
    // to_filter branch above for the full rationale. Taking the snapshot for
    // every kind (not only chat/task_dispatch) is behaviour-preserving for
    // protocol kinds too: nothing can subscribe/unsubscribe between this
    // synchronous snapshot and the deliverDetailed call below, so the matched
    // set is identical to what a live `deliver()` would have computed — it
    // only adds the §11 audience-report numbers, unchanged from today's
    // delivery outcome.
    const snap = deps.fanout.snapshotDetailed(built)
    // Protocol kinds (task_result, permission_*, presence_update) get NO
    // route (§6.4) — they are request-id/correlation_id keyed and never
    // reply parents.
    const route: ReplyRouteInput | null = isUserAuthoredKind(built.kind) ? {
      msg_id: built.id, team_id: HANGAR_TEAM_ID, from_handle: peer.handle,
      sender_instance: stampedInstance.instance ?? null, return_selector: returnSelector,
      to_handle: built.to, to_filter_json: built.to_filter ? JSON.stringify(built.to_filter) : null,
      thread_root: continuationRoot ?? built.thread_root ?? built.id,
      correlation_id: built.meta['correlation_id'] ?? null,
      created_at: deps.now().toISOString(),
      expires_at: null, // this branch always persists a durable message row
    } : null
    let routeInsertFailed = false
    try {
      deps.store.writeRouteAndMessage({
        route, grants: route ? grantsFromSnapshot(snap) : [], envelope: built, persistMessage: true,
      })
    } catch {
      routeInsertFailed = true
    }
    if (routeInsertFailed) return c.json({ error: 'internal_error', message: 'route insert failed' }, 500)

    let envelope: Envelope = built
    deps.fanout.deliverDetailed(built, snap)
    // Delivered-tracking (B4/R4): for SUBJECTED messages the stream write loop is
    // the sole authority (marks delivered_at only AFTER a successful writeSSE), so
    // do NOT stamp on enqueue here — else a stream abort between enqueue and write
    // silently loses a single-copy message. null-subject keeps the online optimisation.
    // Self-exclusion note (P4'b): when the sender is the ONLY subscriber on the
    // recipient handle, fanout delivers to nobody — but `isOnline` is still true, so
    // the row IS marked delivered. That is the wanted behaviour, not an oversight:
    // leaving it pending would park the message in the durable buffer until a later
    // cold start on this handle drained the sender its own old message back. Do not
    // "fix" this into a delivered-count check without re-reading
    // tests/integration/attribution.test.ts § self-excluded delivery accounting.
    if (envelope.subject === null) {
      const isDelivered = envelope.to === TEAM_BROADCAST_HANDLE
        ? deps.fanout.onlineHandles(envelope.team).some(h => h !== envelope.from)
        : deps.fanout.isOnline(envelope.team, envelope.to)
      if (isDelivered) {
        deps.store.markDelivered(envelope.id)
        envelope = { ...envelope, delivered_at: deps.now().toISOString() }
      }
    }

    const responseJson = JSON.stringify({
      ...envelope,
      live: snap.matched.map(m => `${m.handle}#${m.instance ?? ''}`),
      durable: durableReport(envelope, true, undefined),
      matched: snap.matched.length,
    })
    if (idemKey) {
      deps.db.prepare(`
        INSERT OR IGNORE INTO idempotency_key(key_hash, token_id, response_json, created_at)
        VALUES (?, ?, ?, ?)
      `).run(hashToken(`${tokenId}:${idemKey}`), tokenId, responseJson, deps.now().toISOString())
    }
    return c.body(responseJson, 201, { 'content-type': 'application/json' })
  })

  return app
}

/**
 * §7 thread continuation predicate: "sent OR granted". `sent` is
 * `route.from_handle = caller handle AND route.sender_instance = caller
 * instance AND (return_selector IS NULL OR IN ('', '~none') OR = caller
 * selector)`; a legacy route (`legacy_width` not NULL) counts as sent on the
 * handle alone. `granted` is a `reply_grant` row for `(msg_id, handle,
 * instance)` with selector `''` or the caller's selector. On success,
 * canonicalises to the route's OWN `thread_root` (never recomputed).
 */
function resolveThreadContinuation(
  deps: Deps,
  threadRootId: string,
  callerHandle: string,
  callerInstance: string | undefined,
  callerSelector: string | null
): { ok: true; canonicalRoot: string } | { ok: false } {
  const route = deps.store.getRoute(threadRootId) ?? deps.store.getRouteByCorrelation(threadRootId)
  if (!route) return { ok: false }

  const sent = route.legacy_width != null
    ? route.from_handle === callerHandle
    : route.from_handle === callerHandle
      // Null-normalise: route.sender_instance is SQL NULL (JS null) for a
      // route stamped with no x-hangar-instance; callerInstance is
      // undefined when this request also carries none. `null === undefined`
      // is false in JS, which would otherwise 403 the sender of its own
      // no-instance route continuing its own thread.
      && (route.sender_instance ?? undefined) === callerInstance
      && (
        route.return_selector == null
        || route.return_selector === ''
        || route.return_selector === '~none'
        || route.return_selector === callerSelector
      )

  const granted = callerInstance !== undefined && (
    deps.store.hasGrant(route.msg_id, callerHandle, callerInstance, '')
    || (callerSelector !== null && deps.store.hasGrant(route.msg_id, callerHandle, callerInstance, callerSelector))
  )

  if (!sent && !granted) return { ok: false }
  return { ok: true, canonicalRoot: route.thread_root }
}

/**
 * §11 audience report `durable` field: `[]` when the send has/will have no
 * durable `message` row; `['team']` for an unfiltered `@team`; `['repo:<name>']`
 * for a project-chat `to_filter{repo}`; `['<handle>']` otherwise.
 */
function durableReport(built: Envelope, persisted: boolean, repo: string | undefined): string[] {
  if (!persisted) return []
  if (built.to === TEAM_BROADCAST_HANDLE) return repo !== undefined ? [`repo:${repo}`] : ['team']
  return [built.to]
}

/** Record a subject-ACL denial (not silent — the authoritative denial trail). */
function auditEvent(
  deps: Deps, actorHumanId: string, event: string, detail: Record<string, string>
): void {
  deps.db.prepare(
    'INSERT INTO audit_log(team_id,at,actor_human_id,event,detail_json) VALUES (?,?,?,?,?)'
  ).run(HANGAR_TEAM_ID, deps.now().toISOString(), actorHumanId, event, JSON.stringify(detail))
}
