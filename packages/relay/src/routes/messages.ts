import { Hono } from 'hono'
import {
  HANGAR_TEAM_ID,
  OutboundMessageSchema,
  RESERVED_META_KEYS,
  newMessageId,
  TEAM_BROADCAST_HANDLE,
  type Envelope,
} from '@hangar-bridge/shared'
import { loadOwnedSet, ownsNamespace } from '../acl.ts'
import { isValidMessageId } from '@hangar-bridge/shared'
import { bearerAuth, type AuthContext } from '../auth/middleware.ts'
import { hashToken } from '../auth/hash.ts'
import { rateLimit } from '../middleware/rate-limit.ts'
import { parseInstanceHeader } from '../presence/label.ts'
import type { Deps } from '../deps.ts'

const DEFAULT_INBOX_LIMIT = 100
const MAX_INBOX_LIMIT = 1000

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

    const handle = c.get('peer').handle
    const owned = loadOwnedSet(deps.db, HANGAR_TEAM_ID, handle)
    const rows = deps.store.fetchInboxSince(HANGAR_TEAM_ID, handle, since ?? '', limit)
    const messages = rows.filter(e => e.subject === null || ownsNamespace(e.subject, owned))
    // The cursor advances over EVERY row read, not only the deliverable ones, so
    // a page full of gated rows can never wedge the caller below the live edge.
    const next_cursor = rows.length > 0 ? rows[rows.length - 1]!.id : (since ?? null)
    return c.json({ messages, next_cursor })
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
    // trusted for the instance header. Therefore instance is observability and
    // negative self-exclusion only; it is never authorization or positive routing.
    // `instance` identifies the sending PROCESS; it is what fanout uses to keep a
    // direct message from echoing back into the session that sent it.
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
      const { matched } = deps.fanout.deliverDetailed(built)
      let deliveredAt: string | null = null
      if (matched.length > 0) {
        deliveredAt = deps.now().toISOString()
        // Only task_dispatch is persisted (with delivered_at stamped so it never
        // becomes a pending row); directed chat is delivered live and never stored.
        if (built.kind === 'task_dispatch') deps.store.persist(built, deliveredAt)
      }
      // Project chat persists whether or not anyone was connected — matched:0 is
      // precisely the case durability exists for, and it leaves a pending row the
      // drain delivers when a project member reconnects. Unlike task_dispatch a
      // stored chat cannot cause a double execution, so there is no zombie-replay
      // reason to withhold it.
      if (isProjectChat) deps.store.persist(built, deliveredAt)
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
    let envelope: Envelope
    try {
      envelope = deps.store.insert(HANGAR_TEAM_ID, peer.handle, data)
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      return c.json({ error: 'invalid_message', message }, 400)
    }

    deps.fanout.deliver(envelope)
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

    const responseJson = JSON.stringify(envelope)
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

/** Record a subject-ACL denial (not silent — the authoritative denial trail). */
function auditEvent(
  deps: Deps, actorHumanId: string, event: string, detail: Record<string, string>
): void {
  deps.db.prepare(
    'INSERT INTO audit_log(team_id,at,actor_human_id,event,detail_json) VALUES (?,?,?,?,?)'
  ).run(HANGAR_TEAM_ID, deps.now().toISOString(), actorHumanId, event, JSON.stringify(detail))
}
